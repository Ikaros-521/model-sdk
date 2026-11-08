import { LlmError } from '../../core/index.js'
import type { ModelModality } from '../../core/index.js'

export interface DiscoverModelsOptions {
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'
  /** API root/prefix. Google defaults to v1beta when no API version is supplied. */
  baseURL: string
  apiKey?: string
  headers?: Readonly<Record<string, string>>
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  /** One deadline for headers and body. Default 30 seconds. */
  timeoutMs?: number
  /** Actual bytes read per listing, default 4 MiB, maximum 64 MiB. */
  maxResponseBytes?: number
}
export interface DiscoveredModel {
  id: string
  name?: string
  inputModalities?: ModelModality[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function label(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}
function listing(body: unknown, google: boolean): DiscoveredModel[] | undefined {
  if (!isObject(body)) return undefined
  let rows: { key?: string; value: unknown }[]
  if (Array.isArray(body.data)) rows = body.data.map(value => ({ value }))
  else if (Array.isArray(body.models)) rows = body.models.map(value => ({ value }))
  else if (isObject(body.models)) rows = Object.entries(body.models).map(([key, value]) => ({ key, value }))
  else return undefined
  const seen = new Set<string>()
  const result: DiscoveredModel[] = []
  for (const { key, value } of rows) {
    if (!isObject(value)) continue
    // Gateway map keys are request-facing aliases; nested ids may name another canonical model.
    let id = label(key, value.id, google ? value.name : undefined)
    if (id === undefined) continue
    if (google) id = id.replace(/^models\//, '')
    if (!id.trim() || seen.has(id)) continue
    seen.add(id)
    const name = google ? label(value.displayName, value.display_name, value.name, id)
      : label(value.name, value.display_name, value.displayName, id)
    const architecture = isObject(value.architecture) ? value.architecture : undefined
    const rawModalities = value.inputModalities ?? value.input_modalities ?? architecture?.input_modalities
    const inputModalities = Array.isArray(rawModalities)
      ? [...new Set(rawModalities.filter((item): item is string => typeof item === 'string')
        .map(item => item.toLowerCase()).filter((item): item is ModelModality => item === 'text' || item === 'image'))]
      : undefined
    result.push({ id, name, ...(inputModalities?.length ? { inputModalities } : {}) })
  }
  return result
}

/** Read one bounded listing page; never follows redirects, paginates, retries or retains secrets in errors. */
export async function discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModel[]> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024
  const positive = (n: number, max: number) => Number.isSafeInteger(n) && n > 0 && n <= max
  if (!positive(timeoutMs, 2_147_483_647) || !positive(maxBytes, 64 * 1024 * 1024))
    throw new LlmError('Invalid model discovery limits', 'INVALID_REQUEST')
  const supported = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
  if (!supported.includes(options.api)) throw new LlmError('Unsupported model discovery protocol', 'DISCOVERY_UNSUPPORTED')
  let url: URL
  let headers: Headers
  try {
    url = new URL(options.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || /^https?:\/\/[^/]*@/.test(url.href) || url.search || url.hash) throw new Error()
    const base = url.pathname.replace(/\/+$/, '')
    if (options.api === 'anthropic-messages') {
      url.pathname = base.replace(/\/v1$/, '') + '/v1/models'
      url.searchParams.set('limit', '1000')
    } else if (options.api === 'google-generative-ai') {
      url.pathname = base + (/\/v\d+(?:beta\d*|alpha\d*)?$/.test(base) ? '' : '/v1beta') + '/models'
      url.searchParams.set('pageSize', '1000')
    } else url.pathname = base + '/models'
    headers = new Headers(options.headers)
    headers.set('accept', 'application/json')
    if (options.api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')
    if (options.apiKey !== undefined) {
      // Validate locally so a header constructor cannot echo malformed credentials in its error.
      if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[^\x21-\x7e]/.test(options.apiKey.trim())) throw new Error()
      const key = options.apiKey.trim()
      if (options.api === 'anthropic-messages') headers.set('x-api-key', key)
      else if (options.api === 'google-generative-ai') headers.set('x-goog-api-key', key)
      else headers.set('authorization', `Bearer ${key}`)
    }
  } catch { throw new LlmError('Invalid model discovery endpoint or headers', 'INVALID_REQUEST') }
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new LlmError('Model discovery requires fetch', 'INVALID_REQUEST')
  const controller = new AbortController()
  let failure: LlmError | undefined
  let cancelled: LlmError | undefined
  let status: number | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let response: Response | undefined
  let rejectAbort!: (error: LlmError) => void
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  void aborted.catch(() => {})
  const race = <T>(work: PromiseLike<T>) => Promise.race([work, aborted])
  const fail = (message: string, code: string): never => {
    failure = new LlmError(message, code, status === undefined ? undefined : { status })
    throw failure
  }
  const abort = (code: 'ABORTED' | 'TIMEOUT') => {
    if (cancelled) return
    cancelled = new LlmError(code === 'TIMEOUT' ? 'Model discovery timed out' : 'Model discovery aborted', code,
      status === undefined ? undefined : { status })
    rejectAbort(cancelled)
    controller.abort()
  }
  const onAbort = () => abort('ABORTED')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    if (cancelled) throw cancelled
    timer = setTimeout(() => abort('TIMEOUT'), timeoutMs)
    const pending = Promise.resolve().then(() => fetcher(url.toString(), {
      method: 'GET', headers, signal: controller.signal, redirect: 'manual',
    })).then(value => {
      if (controller.signal.aborted) void value.body?.cancel().catch(() => {})
      return value
    })
    response = await race(pending)
    status = response.status >= 100 && response.status <= 599 ? response.status : undefined
    if (!response.ok) fail('Model discovery HTTP request failed',
      status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status && status >= 500 ? 'SERVER' : 'DISCOVERY_FAILED')
    if (Number(response.headers.get('content-length')) > maxBytes)
      fail('Model discovery response exceeded byte limit', 'RESPONSE_TOO_LARGE')
    if (!response.body) fail('Invalid model discovery response', 'MALFORMED_RESPONSE')
    reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const part = await race(reader.read())
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) fail('Model discovery response exceeded byte limit', 'RESPONSE_TOO_LARGE')
      chunks.push(part.value)
    }
    reader.releaseLock()
    reader = undefined
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { fail('Model discovery response was not valid JSON', 'MALFORMED_RESPONSE') }
    const models = listing(parsed, options.api === 'google-generative-ai')
    if (models === undefined) fail('Invalid model discovery listing', 'MALFORMED_RESPONSE')
    if (cancelled) throw cancelled
    return models!
  } catch {
    // Neither transport errors, abort reasons, URLs, headers nor response bodies are copied.
    throw cancelled ?? failure ?? new LlmError('Model discovery transport failed', 'TRANSPORT',
      status === undefined ? undefined : { status })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    if (reader) void reader.cancel().catch(() => {})
    else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    controller.abort()
  }
}
