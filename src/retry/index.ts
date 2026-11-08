import { LlmError, normalizeLlmFailure } from '../core/index.js'
import type { ModelProvider, StreamChunk, LlmFailure } from '../core/index.js'
export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  retryableCodes?: readonly string[]
  random?: () => number
  onRetry?: (event: { retry: number; delayMs: number; failure: LlmFailure }) => void
}
/** Harness exponential backoff and symmetric jitter, without session persistence. */
export function retryDelay(retry: number, options: RetryOptions = {}, providerRetryAfterMs?: number): number {
  const initial = options.initialDelayMs ?? 250
  const maximum = options.maxDelayMs ?? 30000
  const jitter = options.jitterRatio ?? 0.2
  const exponential = Math.min(initial * 2 ** Math.min(retry - 1, 1024), maximum)
  return Math.max(providerRetryAfterMs ?? 0, Math.min(exponential * (1 - jitter + 2 * jitter * (options.random ?? Math.random)()), maximum))
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}
function visible(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta' || chunk.type === 'block-end'
}
/** Opt-in retries before any content is exposed. Never duplicates a partial response.
 * All attempts share the outer runtime's total/idle timeout and cancellation.
 */
export function withRetry(provider: ModelProvider, options: RetryOptions = {}): ModelProvider {
  const policy = { maxRetries: 2, initialDelayMs: 250, maxDelayMs: 30000, jitterRatio: 0.2, ...options }
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0
    || !Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0
    || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs || policy.maxDelayMs > 2147483647
    || !Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) throw new LlmError('Invalid retry policy', 'INVALID_REQUEST')
  const codes = new Set(options.retryableCodes ?? ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT'])
  return {
    id: provider.id,
    listModels: provider.listModels?.bind(provider),
    resolveModel: provider.resolveModel?.bind(provider),
    async prepareCall(request) {
      const first = await provider.prepareCall(request)
      return { async *stream(signal) {
        for (let attempt = 0; ; attempt++) {
          let exposed = false
          let pending: StreamChunk[] = []
          let failure: LlmFailure | undefined
          let terminal = false
          try {
            const call = attempt === 0 ? first : await provider.prepareCall({ ...request, signal })
            for await (const chunk of call.stream(signal)) {
              if (chunk.type === 'finish') terminal = true
              if (chunk.type === 'finish' && chunk.reason.kind === 'error') { failure = chunk.reason.failure; break }
              if (visible(chunk)) exposed = true
              if (exposed) { for (const item of pending) yield item; pending = []; yield chunk }
              else pending.push(chunk)
            }
            if (!terminal && !failure) failure = { message: 'Provider stream ended without finish', code: 'STREAM_CLOSED' }
            if (!failure) { for (const chunk of pending) yield chunk; return }
          } catch (error) { failure = normalizeLlmFailure(error) }
          const delay = retryDelay(attempt + 1, policy, failure.providerRetryAfterMs)
          if (signal.aborted || exposed || attempt >= policy.maxRetries || !codes.has(failure.code) || delay > policy.maxDelayMs) {
            for (const chunk of pending) yield chunk
            yield { type: 'finish', reason: { kind: signal.aborted ? 'aborted' : 'error', failure } }
            return
          }
          policy.onRetry?.({ retry: attempt + 1, delayMs: delay, failure })
          await wait(delay, signal)
        }
      } }
    },
  }
}
