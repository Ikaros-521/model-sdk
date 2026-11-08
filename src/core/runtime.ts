import { BlockAssembler } from './assembler.js'
import { createAssistantMessage } from './message.js'
import { LlmError } from './llm-error.js'
import { normalizeLlmFailure } from './adapter-failure.js'
import { deepFreeze } from './values.js'
import type { AssistantMessage, ModelMessageSource } from './message.js'
import type { GenerateOptions, StreamChunk, LlmModelInfo, LlmResolvedModelInfo } from './types.js'

export interface CallOptions extends GenerateOptions<string> {
  timeoutMs?: number
  idleTimeoutMs?: number
}
/** Snapshot is prepared once; the runtime dispatches it at most once. */
export interface PreparedProviderCall {
  stream(signal: AbortSignal): AsyncIterable<StreamChunk>
}
export interface ModelProvider {
  readonly id: string
  listModels?(): readonly LlmModelInfo[] | Promise<readonly LlmModelInfo[]>
  resolveModel?(model: string): LlmResolvedModelInfo | undefined | Promise<LlmResolvedModelInfo | undefined>
  prepareCall(options: Readonly<CallOptions>): PreparedProviderCall | Promise<PreparedProviderCall>
}
export interface GenerateResult {
  message: AssistantMessage
  usage: BlockAssembler['usage']
  finish: BlockAssembler['finish']
  text: string
}
export interface PreparedCall {
  readonly provider: string
  readonly model: string
  readonly generation: number
  readonly options: Readonly<CallOptions>
  stream(): AsyncIterable<StreamChunk>
  generate(): Promise<GenerateResult>
}
export async function assemble(stream: AsyncIterable<StreamChunk>, source: ModelMessageSource): Promise<GenerateResult> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const interrupted = assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted'
  const replay = interrupted ? undefined : assembler.replayState
  const { kind: _kind, replayState: _priorReplay, ...attribution } = source
  const message = createAssistantMessage({
    content: interrupted ? assembler.interruptedBlocks() : assembler.blocks(),
    source: { ...attribution, ...(replay ? { replayState: replay } : {}) },
  })
  return { message, usage: assembler.usage, finish: assembler.finish,
    text: message.content.filter(b => b.type === 'text').map(b => b.text).join('') }
}
function snapshot(options: CallOptions): Readonly<CallOptions> {
  const { signal, ...json } = options
  return deepFreeze({ ...structuredClone(json), ...(signal ? { signal } : {}) })
}
function timeoutError(code: string): LlmError {
  return new LlmError(code === 'IDLE_TIMEOUT' ? 'Model stream exceeded idle timeout' : 'Model call exceeded total timeout', code)
}
/** Abort-aware wait also handles providers which ignore their signal. */
async function nextOrAbort<T>(next: Promise<IteratorResult<T>>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([next, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })])
  } finally { signal.removeEventListener('abort', onAbort) }
}

export class ModelRuntime {
  private registry = new Map<string, { provider: ModelProvider; generation: number }>()
  private generation = 0
  register(provider: ModelProvider): () => void {
    if (!provider.id.trim()) throw new LlmError('Provider id is required', 'INVALID_REQUEST')
    const entry = { provider, generation: ++this.generation }
    this.registry.set(provider.id, entry)
    return () => { if (this.registry.get(provider.id) === entry) this.registry.delete(provider.id) }
  }
  listProviders(): string[] { return [...this.registry.keys()] }
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = this.registry.get(provider)
    if (!entry) throw new LlmError(`Unknown provider ${provider}`, 'NO_ADAPTER')
    return await entry.provider.listModels?.() ?? []
  }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo | undefined> {
    const entry = this.registry.get(provider)
    if (!entry) throw new LlmError(`Unknown provider ${provider}`, 'NO_ADAPTER')
    return entry.provider.resolveModel ? entry.provider.resolveModel(model) : (await entry.provider.listModels?.())?.find(item => item.id === model)
  }
  async prepareCall(input: CallOptions): Promise<PreparedCall> {
    const options = snapshot(input)
    for (const value of [options.timeoutMs, options.idleTimeoutMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2147483647)) {
        throw new LlmError('Timeout must be a positive finite timer duration', 'INVALID_REQUEST')
      }
    }
    options.signal?.throwIfAborted()
    const entry = this.registry.get(options.provider)
    if (!entry) throw new LlmError(`Unknown provider ${options.provider}`, 'NO_ADAPTER')
    const started = Date.now()
    const preparation = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, preparation.signal]) : preparation.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    if (options.timeoutMs) timer = setTimeout(() => preparation.abort(timeoutError('TIMEOUT')), options.timeoutMs)
    let call: PreparedProviderCall
    try {
      const result = await nextOrAbort(Promise.resolve(entry.provider.prepareCall({ ...options, signal })).then(value => ({ done: false, value } as const)), signal)
      call = result.value!
    } finally { clearTimeout(timer) }
    let used = false
    const stream = (): AsyncIterable<StreamChunk> => {
      if (used) throw new LlmError('Prepared call has already been dispatched', 'CALL_ALREADY_DISPATCHED')
      used = true
      const remaining = options.timeoutMs === undefined ? undefined : options.timeoutMs - (Date.now() - started)
      if (remaining !== undefined && remaining <= 0) return (async function* () { yield failureChunk(timeoutError('TIMEOUT')) })()
      return run(call, { ...options, ...(remaining === undefined ? {} : { timeoutMs: remaining }) })
    }
    return Object.freeze({ provider: options.provider, model: options.model, generation: entry.generation, options, stream,
      generate: () => assemble(stream(), { kind: 'model', provider: options.provider, model: options.model }) })
  }
  async *stream(options: CallOptions): AsyncGenerator<StreamChunk> {
    let prepared: PreparedCall
    try { prepared = await this.prepareCall(options) }
    catch (error) { yield failureChunk(error, options.signal); return }
    yield* prepared.stream()
  }
  async generate(options: CallOptions): Promise<GenerateResult> {
    return assemble(this.stream(options), { kind: 'model', provider: options.provider, model: options.model })
  }
}
export { ModelRuntime as LlmRuntime }
function failureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const reason = signal?.aborted ? signal.reason : error
  const failure = normalizeLlmFailure(reason)
  const cancelled = signal?.aborted && failure.code !== 'TIMEOUT' && failure.code !== 'IDLE_TIMEOUT'
  return { type: 'finish', reason: cancelled
    ? { kind: 'aborted', failure: { ...failure, code: 'ABORTED' } }
    : { kind: 'error', failure } }
}
async function* run(call: PreparedProviderCall, options: Readonly<CallOptions>): AsyncGenerator<StreamChunk> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason ?? new LlmError('Call cancelled', 'ABORTED'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  let total: ReturnType<typeof setTimeout> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let iterator: AsyncIterator<StreamChunk> | undefined
  let terminal: Extract<StreamChunk, { type: 'finish' }> | undefined
  let settled = false
  const blocks = new Map<number, { type: string; closed: boolean }>()
  const armIdle = () => {
    clearTimeout(idle)
    if (options.idleTimeoutMs) idle = setTimeout(() => controller.abort(timeoutError('IDLE_TIMEOUT')), options.idleTimeoutMs)
  }
  if (options.timeoutMs) total = setTimeout(() => controller.abort(timeoutError('TIMEOUT')), options.timeoutMs)
  try {
    controller.signal.throwIfAborted()
    iterator = call.stream(controller.signal)[Symbol.asyncIterator]()
    armIdle()
    while (true) {
      const result = await nextOrAbort(Promise.resolve(iterator.next()), controller.signal)
      if (result.done) break
      if (terminal) throw new LlmError('Provider emitted data after terminal finish', 'MALFORMED_RESPONSE')
      const chunk = result.value
      validateChunk(chunk)
      if ('index' in chunk) {
        const prior = blocks.get(chunk.index)
        const type = chunk.type === 'block-start' ? chunk.blockType : chunk.type === 'block-end' ? chunk.block.type
          : chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call'
        if (prior?.closed || (prior && prior.type !== type) || (prior && chunk.type === 'block-start')) {
          throw new LlmError('Invalid block lifecycle', 'MALFORMED_RESPONSE')
        }
        blocks.set(chunk.index, { type, closed: chunk.type === 'block-end' })
      }
      armIdle()
      if (chunk.type === 'finish') terminal = chunk
      else yield chunk
    }
    if (!terminal) throw new LlmError('Provider stream ended without finish', 'STREAM_CLOSED')
    settled = true
    yield terminal
  } catch (error) { settled = true; yield failureChunk(error, controller.signal) }
  finally {
    clearTimeout(total); clearTimeout(idle)
    options.signal?.removeEventListener('abort', onAbort)
    if (!settled) controller.abort(new LlmError('Stream consumer stopped', 'ABORTED'))
    if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {})
  }
}
function validateChunk(chunk: StreamChunk): void {
  if (chunk.type === 'finish') {
    if (!['stop', 'max-tokens', 'tool-calls', 'error', 'aborted'].includes(chunk.reason.kind)) {
      throw new LlmError('Provider returned invalid terminal state', 'MALFORMED_RESPONSE')
    }
  } else if (chunk.type === 'usage') {
    const counts = [chunk.usage.inputTokens, chunk.usage.outputTokens, chunk.usage.totalTokens, chunk.usage.cacheReadTokens, chunk.usage.cacheWriteTokens]
    if (counts.some(v => v !== undefined && (!Number.isFinite(v) || v < 0))) throw new LlmError('Invalid token usage', 'MALFORMED_RESPONSE')
  } else if (!Number.isInteger(chunk.index) || chunk.index < 0) {
    throw new LlmError('Invalid stream block index', 'MALFORMED_RESPONSE')
  }
}
