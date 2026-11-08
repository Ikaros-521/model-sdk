import { builtinModels, getBuiltinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { Api, Model, ProviderStreams, SimpleStreamOptions, CreateModelsOptions, ModelAuth, ProviderEnv, ThinkingLevel } from '@earendil-works/pi-ai'
import { resolveApiKey, resolveNativeAuth } from '../../auth/index.js'
import type { CredentialSource, NativeAuthResolver } from '../../auth/index.js'
import { LlmError, ProviderRequestId, projectToolUpdates, projectFilesToText, projectImagesForTextModel } from '../../core/index.js'
import type { CallOptions, ModelProvider, PreparedProviderCall, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, ImageAttachmentAccessResolver } from '../../core/index.js'
import type { AttachmentStore } from '../../attachments/index.js'
import { deepFreeze } from '../../core/values.js'
import { toPiContext } from './context.js'
import { toStreamChunks } from './stream.js'
import { conversationUpdates } from './models.js'
import { discoverModels as discoverEndpoint } from './discovery.js'
import { sdkProviderPresets } from './presets.js'
export { discoverModels } from './discovery.js'
export type { DiscoverModelsOptions, DiscoveredModel } from './discovery.js'
export { toPiContext, requestImageTarget } from './context.js'
export { toPiReplayState, toPiAssistant } from './replay.js'
export { toStreamChunks, mapUsage, mapStopReason } from './stream.js'
export type { Api, Model, CreateModelsOptions } from '@earendil-works/pi-ai'

export type PiProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'
export interface PiAiProviderOptions {
  id?: string
  /** SDK preset or installed native catalog provider. SDK presets require explicit credentials. */
  catalogProvider?: string
  /** Explicit custom endpoint protocol; custom models must also be supplied. */
  api?: PiProtocol
  baseURL?: string
  apiKey?: CredentialSource
  nativeAuth?: NativeAuthResolver
  authScope?: string
  /** pi-ai's native OAuth store and ambient credential ports. */
  auth?: CreateModelsOptions
  models?: readonly Model<Api>[]
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
  attachments?: AttachmentStore
  resolveImageAccess?: ImageAttachmentAccessResolver
  onReplayDegrade?: (reason: string) => void
  /** A pure hook; copied header output is frozen for this prepared call. */
  prepareHeaders?: (context: { provider: string; model: string }, headers: Headers) => Headers | Promise<Headers>
  maxTokens?: number
  streamOptions?: Omit<SimpleStreamOptions, 'signal' | 'apiKey' | 'headers' | 'fetch'>
}
export interface PiAiProvider extends ModelProvider {
  discoverModels(options?: { signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number }): Promise<readonly LlmModelInfo[]>
}
async function protocol(api: PiProtocol): Promise<ProviderStreams> {
  switch (api) {
    case 'openai-completions': return (await import('@earendil-works/pi-ai/api/openai-completions.lazy')).openAICompletionsApi()
    case 'openai-responses': return (await import('@earendil-works/pi-ai/api/openai-responses.lazy')).openAIResponsesApi()
    case 'anthropic-messages': return (await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')).anthropicMessagesApi()
    case 'google-generative-ai': return (await import('@earendil-works/pi-ai/api/google-generative-ai.lazy')).googleGenerativeAIApi()
    default: throw new LlmError(`Unsupported custom protocol ${api}`, 'INVALID_REQUEST')
  }
}
function modelInfo(model: Model<Api>, provider: string): LlmModelInfo {
  return { id: model.id, name: model.name, provider, inputModalities: [...model.input] }
}
/** Custom model with text-only, non-reasoning defaults. Zero costs and 128000/4096 token
 * capacities are SDK placeholders, not verified pricing/limits; override for the target model. */
export function defineModel(input: Pick<Model<Api>, 'id' | 'api' | 'baseUrl'> & Partial<Model<Api>>): Model<Api> {
  return { name: input.id, provider: 'custom', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, ...input } as Model<Api>
}
export function catalogProviders(): readonly string[] {
  return [...new Set([...sdkProviderPresets.map(preset => preset.id), ...getBuiltinProviders()])]
}
export function catalogModels(provider: string): readonly Model<Api>[] {
  const preset = sdkProviderPresets.find(preset => preset.id === provider)
  if (preset) return preset.modelIds.map(id => defineModel({ id, provider: preset.id, api: preset.api,
    baseUrl: preset.baseUrl, ...(preset.compat ? { compat: structuredClone(preset.compat) } : {}) }))
  if (!getBuiltinProviders().includes(provider as never)) return []
  return structuredClone(getBuiltinModels(provider as never))
}
export function createPiAiProvider(config: PiAiProviderOptions): PiAiProvider {
  const id = config.id ?? config.catalogProvider ?? 'pi-ai'
  const { onPayload, onResponse, onProviderStreamEvent, ...streamConfig } = config.streamOptions ?? {}
  const options = { ...config, headers: { ...config.headers },
    streamOptions: { ...structuredClone(streamConfig), onPayload, onResponse, onProviderStreamEvent } }
  const preset = sdkProviderPresets.find(preset => preset.id === options.catalogProvider)
  // SDK presets supply route defaults; explicit api/baseURL/models options still win.
  if (preset) {
    options.api ??= preset.api
    options.baseURL ??= preset.baseUrl
  }
  const native = builtinModels(options.auth)
  const base = options.catalogProvider && !preset ? native.getProvider(options.catalogProvider) : undefined
  if (options.catalogProvider && !preset && !base) throw new LlmError(`Unknown catalog provider ${options.catalogProvider}`, 'NO_ADAPTER')
  if (!preset && !base && (!options.api || !options.models?.length)) throw new LlmError('Custom provider requires api and models', 'INVALID_REQUEST')
  let descriptors = deepFreeze(structuredClone(options.models ?? (preset ? catalogModels(preset.id) : base?.getModels()) ?? []).map(model => ({ ...model, provider: id,
    ...(options.api ? { api: options.api } : {}), ...(options.baseURL ? { baseUrl: options.baseURL } : {}) })))
  const listed = () => descriptors.map(model => modelInfo(model, id))
  const resolveAuth = async (signal?: AbortSignal): Promise<ModelAuth & { env?: ProviderEnv }> => {
    const context = { route: id, provider: options.catalogProvider ?? id, scope: options.authScope ?? id, signal }
    // Claude Code compatible proxies authenticate with Bearer on top of the protocol credential header.
    const withBearer = (result: ModelAuth & { env?: ProviderEnv }): ModelAuth & { env?: ProviderEnv } => {
      if (!preset?.bearerAuth || !result.apiKey
        || Object.keys(result.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) return result
      return { ...result, headers: { ...result.headers, authorization: `Bearer ${result.apiKey}` } }
    }
    if (options.apiKey !== undefined) return withBearer({ apiKey: (await resolveApiKey(options.apiKey, context)).apiKey })
    if (options.nativeAuth) {
      const credential = await resolveNativeAuth(options.nativeAuth, context)
      return withBearer({ apiKey: credential.apiKey, headers: credential.headers })
    }
    if (base) {
      const result = await native.getAuth(base.id, { signal })
      if (!result) throw new LlmError(`Provider ${base.id} is not configured`, 'MISSING_CREDENTIAL')
      return { ...result.auth, env: result.env }
    }
    throw new LlmError('Provider requires apiKey or nativeAuth', 'MISSING_CREDENTIAL')
  }
  return {
    id, listModels: listed,
    resolveModel(modelId): LlmResolvedModelInfo | undefined {
      const model = descriptors.find(m => m.id === modelId)
      if (!model) return undefined
      const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
      const supported = levels.filter(level => level === 'off' || (model.reasoning && model.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined)))
      return { ...modelInfo(model, id), context: { contextWindow: model.contextWindow }, defaultMaxTokens: options.maxTokens ?? model.maxTokens,
        ...conversationUpdates(model), reasoning: { efforts: supported.map(level => ({ id: level as import('../../core/brand.js').ReasoningEffortId, name: level })) } }
    },
    async discoverModels({ signal, timeoutMs = 30000, maxResponseBytes } = {}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new LlmError('Invalid model discovery timeout', 'INVALID_REQUEST')
      // Presets without a listing endpoint (e.g. Claude Code proxies) never touch /models.
      if (preset?.discovery === false) return listed()
      if (!options.baseURL) return listed()
      const operation = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
      const auth = await resolveAuth(operation)
      const headers = new Headers(options.headers)
      for (const [key, value] of Object.entries(auth.headers ?? {})) if (value !== null) headers.set(key, value)
      const endpoint = options.baseURL
      const models = await discoverEndpoint({ api: options.api ?? descriptors[0]?.api as PiProtocol,
        baseURL: endpoint, apiKey: auth.apiKey, headers: Object.fromEntries(headers.entries()),
        fetch: options.fetch, signal: operation, timeoutMs, maxResponseBytes })
      // Discovered IDs become callable with honest route-level placeholders; existing entries,
      // including their compatibility flags, are preserved (same pattern as the DeepSeek adapter).
      const known = new Set(descriptors.map(model => model.id))
      const additions = models.filter(entry => !known.has(entry.id)).map(entry => defineModel({
        id: entry.id, provider: id, api: (options.api ?? descriptors[0]?.api ?? 'openai-completions') as PiProtocol,
        baseUrl: endpoint, ...(preset?.compat ? { compat: structuredClone(preset.compat) } : {}),
        ...(entry.name && entry.name !== entry.id ? { name: entry.name } : {}) }))
      if (additions.length > 0) descriptors = deepFreeze([...descriptors, ...additions])
      return models.map(model => ({ ...model, name: model.name ?? model.id, provider: id }))
    },
    async prepareCall(request: Readonly<CallOptions>): Promise<PreparedProviderCall> {
      const model = descriptors.find(model => model.id === request.model)
      if (!model) throw new LlmError(`Unknown model ${request.model}`, 'MODEL_NOT_FOUND')
      if ((model.api === 'google-generative-ai' || model.api === 'google-vertex') && options.fetch && options.fetch !== globalThis.fetch) throw new LlmError('Google native SDK cannot inject a custom fetch; use an HTTP fixture endpoint or native auth', 'UNSUPPORTED_TRANSPORT')
      const auth = await resolveAuth(request.signal)
      const initial = new Headers()
      for (const [key, value] of Object.entries({ ...options.headers, ...auth.headers })) if (value !== null) initial.set(key, value)
      const headers = Object.fromEntries((await options.prepareHeaders?.({ provider: id, model: model.id }, initial) ?? initial).entries())
      const copiedHeaders = Object.freeze({ ...headers })
      const api = options.api ? await protocol(options.api) : preset ? await protocol(model.api as PiProtocol) : base
      if (!api) throw new LlmError('Provider protocol unavailable', 'NO_ADAPTER')
      const supportsMid = model.compat && 'supportsMidConvoSystemMessages' in model.compat && !!model.compat.supportsMidConvoSystemMessages
      const mode = conversationUpdates(model).toolUpdate
      const projected = projectToolUpdates(request.messages, request.tools, mode, request.toolHistory)
      const messages = model.input.includes('image') ? projected.messages : projectImagesForTextModel(projected.messages)
      const history = { ...request, messages: [...projectFilesToText(messages, () => undefined)], tools: projected.tools ? [...projected.tools] : undefined }
      // Preserve original durable replay envelopes, even after another route handles a turn.
      const context = options.attachments
        ? await toPiContext(history, { attachments: options.attachments, resolveImageAccess: options.resolveImageAccess ?? (() => undefined) }, options.onReplayDegrade, supportsMid)
        : toPiContext(history, undefined, options.onReplayDegrade, supportsMid)
      const transcript = normalizeContext(context)
      const frozenModel = deepFreeze({ ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) })
      return {
        async *stream(signal) {
          let responseFacts: { status?: number; requestId?: string; retryAfter?: number } = {}
          let transportError: unknown
          const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
            try {
              const response = await (options.fetch ?? globalThis.fetch)(input, { ...init, redirect: 'manual' })
              const retry = response.headers.get('retry-after')
              const seconds = retry === null ? NaN : Number(retry)
              const retryAfter = retry === null ? undefined : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now()
              responseFacts = { status: response.status, requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
                ...(retryAfter !== undefined && retryAfter > 0 ? { retryAfter } : {}) }
              return response
            } catch (error) { transportError = error; throw error }
          }
          const events = api.streamSimple(frozenModel, transcript, { ...options.streamOptions,
            apiKey: auth.apiKey, headers: copiedHeaders, ...('env' in auth ? { env: auth.env } : {}),
            ...((model.api === 'google-generative-ai' || model.api === 'google-vertex') ? {} : { fetch: wrappedFetch }), signal, maxRetries: 0, maxTokens: request.maxTokens ?? options.maxTokens ?? model.maxTokens,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.reasoningEffort === undefined ? {} : { reasoning: request.reasoningEffort === 'off' ? undefined : request.reasoningEffort as ThinkingLevel }),
            ...(request.stop ? { samplingParams: { ...options.streamOptions?.samplingParams, stop: [...request.stop] } } : {}) })
          for await (const chunk of toStreamChunks(events, model.contextWindow, signal, request.model)) {
            if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
              const original = chunk.reason.failure
              const secrets = [auth.apiKey, ...Object.values(auth.headers ?? {}), ...Object.values(copiedHeaders)].filter((s): s is string => typeof s === 'string' && s.length > 0)
              const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text)
              const f = { ...original, message: redact(original.message) }
              // The observed status outranks the message text: a gateway can word a
              // rejection as "not found" while answering 400 (OpenRouter routes an
              // unroutable model id that way), and an in-band error can ride a 200.
              // 400 stays with the text classifier, which reads context overflow and
              // quota wording that no status number carries.
              const code = responseFacts.status === 401 || responseFacts.status === 403 ? 'AUTH'
                : responseFacts.status === 402 ? 'QUOTA'
                : responseFacts.status === 404 ? 'ENDPOINT_NOT_FOUND'
                : responseFacts.status === 408 ? 'TIMEOUT'
                : responseFacts.status === 413 || responseFacts.status === 422 ? 'INVALID_REQUEST'
                : responseFacts.status === 429 ? 'RATE_LIMIT'
                : responseFacts.status && responseFacts.status >= 500 ? 'SERVER'
                // A 400 keeps the text verdict so context-overflow and quota wording
                // survives; only its unclassified fallback is promoted to a body rejection.
                : responseFacts.status === 400 && (f.code === 'PI_AI_ERROR' || f.code === 'ENDPOINT_NOT_FOUND') ? 'INVALID_REQUEST'
                : transportError ? 'TRANSPORT' : f.code
              yield { ...chunk, reason: { ...chunk.reason, failure: { ...f, code,
                ...(responseFacts.status ? { status: responseFacts.status } : {}),
                ...(responseFacts.requestId ? { requestId: ProviderRequestId(redact(responseFacts.requestId)) } : {}),
                ...(responseFacts.retryAfter ? { providerRetryAfterMs: responseFacts.retryAfter } : {}) } } } as StreamChunk
            } else yield chunk
          }
        },
      }
    },
  }
}
