import { LlmError, ProviderRequestId } from '../../core/index.js'

export const MAX_ERROR_BODY_BYTES = 16 * 1024
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024
/** Read at most a bounded prefix. Cancellation also closes indefinitely long error bodies. */
export async function readBoundedText(response: Response, limit = MAX_ERROR_BODY_BYTES, truncate = true): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  let exceeded = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const available = limit - bytes
      if (next.value.byteLength > available) exceeded = true
      const part = next.value.subarray(0, available)
      parts.push(part)
      bytes += part.byteLength
      if (exceeded || bytes === limit) {
        void reader.cancel().catch(() => {})
        break
      }
    }
  } finally { reader.releaseLock() }
  if (exceeded && !truncate) throw new LlmError('DeepSeek response body exceeds the supported size', 'INVALID_RESPONSE')
  const data = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) { data.set(part, offset); offset += part.byteLength }
  return new TextDecoder().decode(data)
}
function credentialValues(headers: Readonly<Record<string, string>>): string[] {
  return Object.values(headers).flatMap(value => [value, value.replace(/^Bearer\s+/iu, '')]).filter(Boolean)
}
/** Credential values, including JSON and URL encodings, never become public diagnostics. */
export function redactText(value: string, headers: Readonly<Record<string, string>> = {}, maxLength = 1000): string {
  let result = value
  const secrets = credentialValues(headers).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]')
  return result.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, maxLength)
}
/** Keep known public facts and discard arbitrary provider/transport Error causes. */
export function publicError(error: unknown, headers: Readonly<Record<string, string>> = {}): LlmError {
  if (!(error instanceof LlmError)) {
    const authCode = error instanceof Error && error.name === 'AuthError' && 'code' in error && typeof error.code === 'string' && /^AUTH_[A-Z_]+$/u.test(error.code) ? error.code : undefined
    return new LlmError(authCode ?? 'DeepSeek transport failed', authCode ?? 'TRANSPORT')
  }
  const facts = error.failure
  const requestId = facts.requestId === undefined ? undefined : redactText(facts.requestId, headers, 200)
  return new LlmError(redactText(error.message, headers) || 'DeepSeek request failed', error.code, {
    ...(facts.status === undefined ? {} : { status: facts.status }),
    ...(facts.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: facts.providerRetryAfterMs }),
    ...(facts.offloadImages === undefined ? {} : { offloadImages: facts.offloadImages }),
    ...(requestId ? { requestId: ProviderRequestId(requestId) } : {}),
  })
}
