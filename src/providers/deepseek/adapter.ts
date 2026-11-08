/* Adapter integration derived from DeepSeek Harness adapter.ts, Copyright (c) 2026 DeepSeek, MIT.
 * Full upstream MIT license is preserved in serialize.ts and the package LICENSE.
 */
import { resolveApiKey } from '../../auth/index.js'
import { attributionHeaders, LlmError, projectFilesToText, projectToolUpdates } from '../../core/index.js'
import type { CallOptions, LlmModelInfo, StreamChunk } from '../../core/index.js'
import { DeepSeekFileStore } from './file-store.js'
import { FileResolutionFailure, RequestFiles } from './request-files.js'
import { inlineImages, prepareFileIds, prepareImages } from './images.js'
import { serialize } from './serialize.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'
import { providerError, providerErrorDetail } from './transport.js'
import { messagesApiRoot, MESSAGES_FILES_BETA, MESSAGES_TOOL_CHANGES_BETA } from './messages-api.js'
import { modelListingURL, requestModelListing } from './listing.js'
import { DEFAULT_MODELS } from './models.js'
import { deadline } from './deadline.js'
import { readBoundedText, publicError } from './diagnostics.js'
import { modelInfo } from './model-info.js'
import type { DeepSeekConnectionOptions, DeepSeekModel, DeepSeekProvider, DeepSeekProviderOptions } from './types.js'

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new LlmError(`${name} must be a positive safe integer`, 'INVALID_REQUEST')
  return result
}
function timer(value: number | undefined, fallback: number, name: string): number {
  const result = positive(value, fallback, name)
  if (result > 2147483647) throw new LlmError(`${name} exceeds timer limit`, 'INVALID_REQUEST')
  return result
}
function catalog(models: readonly DeepSeekModel[]): DeepSeekModel[] {
  const result = structuredClone([...models])
  const ids = new Set<string>()
  for (const model of result) {
    if (typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) throw new LlmError('Model catalog ids must be nonempty and unique', 'INVALID_REQUEST')
    ids.add(model.id)
    if (model.maxTokens !== undefined) positive(model.maxTokens, 1, 'model.maxTokens')
    if (model.contextWindow !== undefined) positive(model.contextWindow, 1, 'model.contextWindow')
    if (model.imagePixelBudget !== undefined && model.imagePixelBudget !== 'low') positive(model.imagePixelBudget, 1, 'model.imagePixelBudget')
    if (model.imageMaxBytes !== undefined) positive(model.imageMaxBytes, 1, 'model.imageMaxBytes')
    if (model.inputModalities?.some(value => value !== 'text' && value !== 'image')) throw new LlmError('Unsupported model modality', 'INVALID_REQUEST')
  }
  return result
}

/** Instance-local Messages provider. No Cordis container, home directory or business services. */
export function createDeepSeekProvider(input: DeepSeekProviderOptions): DeepSeekProvider {
  const options = { ...input, files: { ...input.files } }
  const id = options.id ?? 'deepseek'
  if (!id.trim()) throw new LlmError('Provider id is required', 'INVALID_REQUEST')
  const url = new URL(options.baseURL ?? 'https://api.deepseek.com/anthropic')
  if (!['http:', 'https:'].includes(url.protocol) || /^https?:\/\/[^/]*@/u.test(url.href) || url.search || url.hash) throw new LlmError('Invalid DeepSeek endpoint', 'INVALID_REQUEST')
  const authScope = options.authScope ?? id
  if (!authScope.trim()) throw new LlmError('Auth scope is required', 'INVALID_REQUEST')
  const baseURL = url.href.replace(/\/+$/u, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const files = new DeepSeekFileStore({ fetch: fetchImpl })
  let models = catalog(options.models ?? DEFAULT_MODELS)
  const expiresAfterSeconds = positive(options.files?.expiresAfterSeconds, 86400, 'files.expiresAfterSeconds')
  const refreshMarginSeconds = options.files?.refreshMarginSeconds ?? 300
  if (expiresAfterSeconds < 3600 || expiresAfterSeconds > 2592000 || !Number.isSafeInteger(refreshMarginSeconds) || refreshMarginSeconds < 0 || refreshMarginSeconds >= expiresAfterSeconds) throw new LlmError('Invalid Files expiry or refresh margin', 'INVALID_REQUEST')
  const connection: DeepSeekConnectionOptions = {
    baseURL, models,
    defaults: { thinking: options.thinking, reasoningEffort: options.reasoningEffort },
    maxTokens: positive(options.maxTokens, 32768, 'maxTokens'),
    maxRequestFilesBytes: positive(options.maxRequestFilesBytes, 128 * 1024 * 1024, 'maxRequestFilesBytes'),
    maxInlineRequestImageBytes: positive(options.maxInlineRequestImageBytes, 20 * 1024 * 1024, 'maxInlineRequestImageBytes'),
    maxImagesPerRequest: positive(options.maxImagesPerRequest, 600, 'maxImagesPerRequest'),
    imageOffloadByteQuantum: 1, inlineImageOffloadByteQuantum: 1, imageOffloadCountQuantum: 1,
    filesApiTimeoutMs: timer(options.files?.timeoutMs, 30000, 'files.timeoutMs'),
    // This standalone adapter never deletes pre-existing remote resources on quota failures.
    filePolicy: { expiresAfterSeconds, refreshMarginSeconds, quotaCleanupBatch: 0 },
  }
  const discoveryTimeoutMs = timer(options.discoveryTimeoutMs, 30000, 'discoveryTimeoutMs')
  const access = options.resolveImageAccess ?? (() => undefined)
  const auth = async (signal?: AbortSignal) => {
    const key = await resolveApiKey(options.apiKey, { route: id, provider: 'deepseek', scope: authScope, signal })
    return { authorization: `Bearer ${key.apiKey}` }
  }
  const listModels = (): LlmModelInfo[] => models.map(model => ({ provider: id, id: model.id, name: model.name ?? model.id,
    ...(model.description ? { description: model.description } : {}), inputModalities: [...model.inputModalities ?? ['text']] }))
  return {
    id,
    listModels,
    resolveModel(model) { return modelInfo({ ...connection, models }, id, model) },
    async discoverModels(operation = {}) {
      using limit = deadline(operation.signal, discoveryTimeoutMs)
      const listing = await requestModelListing(modelListingURL(baseURL), await auth(limit.signal), limit.signal, fetchImpl)
      const next: DeepSeekModel[] = listing.entries.map(entry => {
        const previous = models.find(model => model.id === entry.id)
        const facts = entry.capabilities.usable ? entry.capabilities.facts : undefined
        return { ...previous, id: entry.id, name: entry.name ?? previous?.name ?? entry.id,
          ...(facts ? { inputModalities: [...facts.inputModalities], contextWindow: facts.contextWindow, maxTokens: facts.maxOutputTokens,
            systemPromptUpdate: facts.systemPromptUpdate === 'in-history' ? 'in-history' as const : undefined,
            toolUpdate: facts.toolUpdate === 'in-history' || facts.toolUpdate === 'addition-only' ? facts.toolUpdate : undefined } : {}) }
      })
      models = catalog(next)
      return listModels()
    },
    prepareCall(call: Readonly<CallOptions>) {
      if (call.provider !== id || !call.model.trim()) throw new LlmError('Invalid DeepSeek route or model', 'INVALID_REQUEST')
      if (call.maxTokens !== undefined) positive(call.maxTokens, 1, 'maxTokens')
      // Bind this operation's catalog and message snapshot before discovery can replace it.
      const { signal: _signal, ...body } = call
      const snapshot: CallOptions = structuredClone(body)
      const current = { ...connection, models }
      const projected = projectToolUpdates(snapshot.messages, snapshot.tools, models.find(model => model.id === snapshot.model)?.toolUpdate, snapshot.toolHistory)
      snapshot.messages = projectFilesToText(projected.messages, () => undefined).map(message => {
        if (message.role !== 'assistant' || message.source.provider === id) return message
        const { replayState: _replay, ...source } = message.source
        return { ...message, source }
      })
      snapshot.tools = projected.tools === undefined ? undefined : [...projected.tools]
      return { stream: signal => request(snapshot, current, signal) }
    },
  }

  async function* request(call: CallOptions, current: DeepSeekConnectionOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    let headers: Readonly<Record<string, string>> = {}
    try {
      signal.throwIfAborted()
      const { messages, versions } = await prepareImages(call.messages, current, call.model, options.attachments, access, signal)
      headers = await auth(signal)
      const requestFiles = new RequestFiles(files, { baseURL, headers }, current.filePolicy, current.filesApiTimeoutMs, signal, () => {})
      let inline = options.files?.enabled === false
      while (true) {
        signal.throwIfAborted()
        requestFiles.beginAttempt()
        let fileIds: Awaited<ReturnType<typeof prepareFileIds>> | undefined
        if (!inline) {
          try { fileIds = await prepareFileIds(messages, versions, requestFiles) }
          catch (error) {
            if (!(error instanceof FileResolutionFailure)) throw error
            inline = true
            continue
          }
        }
        const history = inline ? inlineImages(messages, versions, current) : messages
        const body = serialize(call, current, history, versions, access, options.onReplayDegrade, fileIds)
        const betas = [
          ...(fileIds && fileIds.size > 0 ? [MESSAGES_FILES_BETA] : []),
          ...(body.messages.some(message => message.content.some(block => block.type === 'tool_addition' || block.type === 'tool_removal')) ? [MESSAGES_TOOL_CHANGES_BETA] : []),
        ]
        const response = await fetchImpl(`${messagesApiRoot(baseURL)}/messages`, {
          method: 'POST', signal, redirect: 'error', body: JSON.stringify(body),
          headers: { ...attributionHeaders(), ...headers, 'content-type': 'application/json', accept: 'text/event-stream',
            'anthropic-version': '2023-06-01', ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}) },
        })
        if (!response.ok) {
          const text = await readBoundedText(response)
          let raw: unknown
          try { raw = JSON.parse(text) } catch { /* HTTP status remains authoritative. */ }
          const detail = providerErrorDetail(raw)
          if (await requestFiles.retry(detail)) continue
          const failure = providerError(raw, response.status, response.headers)
          throw new LlmError(requestFiles.errorMessage(response.status, failure.message, detail), failure.code, failure.failure)
        }
        if (!response.body) throw new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE')
        yield* translate(parseSse(response.body, () => {}), call.model)
        return
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw publicError(error, headers)
    }
  }
}
