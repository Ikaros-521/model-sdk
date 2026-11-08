import { LlmError } from '../../core/index.js'

/** Operation-local deadline; disposing releases both timer and abort forwarding. */
export function deadline(parent: AbortSignal | undefined, timeoutMs: number, code = 'TIMEOUT') {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new LlmError('DeepSeek operation timed out', code)), timeoutMs)
  return {
    signal: controller.signal,
    [Symbol.dispose]() { clearTimeout(timer); parent?.removeEventListener('abort', abort) },
  }
}
