import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { discoverModels, type DiscoverModelsOptions } from '../src/providers/pi-ai/discovery.js'
import { LlmError } from '../src/core/index.js'

const key = 'discovery-key-secret'
const headerSecret = 'custom-header-secret'
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  return { baseURL: `http://127.0.0.1:${address.port}`,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
const options = (baseURL: string, extra: Partial<DiscoverModelsOptions> = {}): DiscoverModelsOptions => ({
  api: 'openai-completions', baseURL, apiKey: key, headers: { 'x-custom-secret': headerSecret }, ...extra,
})
async function rejected(promise: Promise<unknown>, code: string, status?: number) {
  const error = await promise.then(() => { throw new Error('Expected failure') }, error => error)
  expect(error).toBeInstanceOf(LlmError)
  expect(error.code).toBe(code)
  if (status !== undefined) expect(error.failure.status).toBe(status)
  const text = JSON.stringify(error) + String(error.stack)
  expect(text).not.toContain(key)
  expect(text).not.toContain(headerSecret)
  expect(error.cause).toBeUndefined()
}

describe('protocol-aware remote model discovery', () => {
  it.each(['openai-completions', 'openai-responses'] as const)('%s uses bearer and retains gateway prefix', async api => {
    let observed: { url?: string; auth?: string; header?: string } = {}
    const server = await fixture((req, res) => {
      observed = { url: req.url, auth: req.headers.authorization, header: req.headers['x-custom-secret'] as string }
      res.end(JSON.stringify({ data: [{ id: 'alpha', display_name: 'Alpha' }, { id: 'alpha' }, null, 2, {},
        { id: '', name: 'bad' }, { id: 'beta', architecture: { input_modalities: ['text', 'image', 'image', 'audio'] } }],
        models: { ignored: {} } }))
    })
    try {
      expect(await discoverModels(options(server.baseURL + '/gateway/v1///', { api }))).toEqual([
        { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'beta', inputModalities: ['text', 'image'] },
      ])
      expect(observed).toEqual({ url: '/gateway/v1/models', auth: `Bearer ${key}`, header: headerSecret })
    } finally { await server.close() }
  })

  it.each(['', '/v1/', '/proxy', '/proxy/v1///'])('anthropic normalizes root %s and uses native auth', async suffix => {
    let observed: unknown
    const server = await fixture((req, res) => {
      observed = { url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], auth: req.headers.authorization }
      res.end('{"data":[{"id":"claude","display_name":"Claude"}]}')
    })
    try {
      expect(await discoverModels(options(server.baseURL + suffix, { api: 'anthropic-messages' })))
        .toEqual([{ id: 'claude', name: 'Claude' }])
      expect(observed).toEqual({ url: `${suffix.startsWith('/proxy') ? '/proxy' : ''}/v1/models?limit=1000`,
        key, version: '2023-06-01', auth: undefined })
    } finally { await server.close() }
  })

  it.each([['', '/v1beta'], ['/v1', '/v1'], ['/v1beta/', '/v1beta'], ['/proxy/v1alpha', '/proxy/v1alpha'],
    ['/proxy', '/proxy/v1beta'], ['/v1beta1', '/v1beta1']])('google preserves or supplies API version %s', async (suffix, expected) => {
    let observed: unknown
    const server = await fixture((req, res) => {
      observed = { url: req.url, key: req.headers['x-goog-api-key'], auth: req.headers.authorization }
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-test', displayName: 'Gemini', inputModalities: ['TEXT', 'IMAGE'] },
        { name: 'models/gemini-test' }, null, {}, { name: 'models/' }] }))
    })
    try {
      expect(await discoverModels(options(server.baseURL + suffix, { api: 'google-generative-ai' })))
        .toEqual([{ id: 'gemini-test', name: 'Gemini', inputModalities: ['text', 'image'] }])
      expect(observed).toEqual({ url: `${expected}/models?pageSize=1000`, key, auth: undefined })
    } finally { await server.close() }
  })

  it('supports enriched model maps with alias precedence, malformed entries and id fallback', async () => {
    const server = await fixture((_req, res) => res.end(JSON.stringify({ models: {
      alias: { id: 'canonical', displayName: 'Friendly', input_modalities: ['image'] },
      '': { id: 'fallback' }, scalar: 42, array: [], null: null, ' ': { id: 'fallback' },
    } })))
    try {
      expect(await discoverModels(options(server.baseURL))).toEqual([
        { id: 'alias', name: 'Friendly', inputModalities: ['image'] }, { id: 'fallback', name: 'fallback' },
      ])
    } finally { await server.close() }
  })

  it('supports unauthenticated servers and custom deployment authorization', async () => {
    let auth: string | undefined
    const server = await fixture((req, res) => { auth = req.headers.authorization; res.end('{"data":[]}') })
    try {
      expect(await discoverModels(options(server.baseURL, { apiKey: undefined, headers: {} }))).toEqual([])
      expect(auth).toBeUndefined()
      await discoverModels(options(server.baseURL, { apiKey: undefined, headers: { Authorization: `Token ${headerSecret}` } }))
      expect(auth).toBe(`Token ${headerSecret}`)
    } finally { await server.close() }
  })

  it.each([[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER']] as const)
  ('HTTP %s has safe status and no retries or echoed secrets', async (status, code) => {
    let calls = 0
    const server = await fixture((_req, res) => {
      calls++; res.writeHead(status, { 'x-request-id': key, 'x-error': headerSecret }); res.end(key + headerSecret)
    })
    try { await rejected(discoverModels(options(server.baseURL)), code, status); expect(calls).toBe(1) }
    finally { await server.close() }
  })

  it('refuses redirects without leaking either auth or custom headers', async () => {
    let leaks = 0
    const destination = await fixture((_req, res) => { leaks++; res.end('{"data":[]}') })
    const server = await fixture((_req, res) => { res.writeHead(307, { Location: destination.baseURL }); res.end() })
    try { await rejected(discoverModels(options(server.baseURL)), 'DISCOVERY_FAILED', 307); expect(leaks).toBe(0) }
    finally { await server.close(); await destination.close() }
  })

  it.each([false, true])('times out with stalled headers/body (headers=%s)', async headers => {
    const server = await fixture((_req, res) => { if (headers) { res.writeHead(200); res.flushHeaders(); res.write('{') } })
    try { await rejected(discoverModels(options(server.baseURL, { timeoutMs: 60 })), 'TIMEOUT', headers ? 200 : undefined) }
    finally { await server.close() }
  })

  it.each([false, true])('cancels stalled headers/body (headers=%s) and discards caller reason', async headers => {
    const controller = new AbortController()
    const server = await fixture((_req, res) => {
      if (headers) { res.writeHead(200); res.flushHeaders(); res.write('{') }
      const timer = setTimeout(() => controller.abort(key + headerSecret), 30)
      res.once('close', () => clearTimeout(timer))
    })
    try { await rejected(discoverModels(options(server.baseURL, { signal: controller.signal })), 'ABORTED') }
    finally { await server.close() }
  })

  it('pre-abort dispatches nothing; abort/timeout races fetch even if it ignores signal', async () => {
    let calls = 0
    const controller = new AbortController(); controller.abort(key)
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Promise(() => {}) }
    await rejected(discoverModels(options('http://localhost:1', { fetch, signal: controller.signal })), 'ABORTED')
    expect(calls).toBe(0)
    await rejected(discoverModels(options('http://localhost:1', { fetch, timeoutMs: 30 })), 'TIMEOUT')
    expect(calls).toBe(1)
  })

  it('keeps one deadline across headers and body instead of restarting after headers', async () => {
    const server = await fixture((_req, res) => {
      const first = setTimeout(() => {
        res.writeHead(200); res.flushHeaders(); res.write('{"data":')
      }, 60)
      const second = setTimeout(() => res.end('[]}'), 200)
      res.once('close', () => { clearTimeout(first); clearTimeout(second) })
    })
    try { await rejected(discoverModels(options(server.baseURL, { timeoutMs: 140 })), 'TIMEOUT', 200) }
    finally { await server.close() }
  })

  it('cancels a custom body that ignores the request signal without waiting for stream cleanup', async () => {
    const controller = new AbortController()
    let bodyCancelled = false
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{'))
        setTimeout(() => controller.abort(headerSecret), 20)
      },
      cancel() { bodyCancelled = true; return new Promise(() => {}) },
    }))
    await rejected(discoverModels(options('http://localhost:1', { fetch, signal: controller.signal })), 'ABORTED', 200)
    expect(bodyCancelled).toBe(true)
  })

  it.each([true, false])('bounds actual response bytes (content-length=%s)', async length => {
    const server = await fixture((_req, res) => {
      res.setHeader(length ? 'content-length' : 'transfer-encoding', length ? '1000' : 'chunked')
      res.end('x'.repeat(1000))
    })
    try { await rejected(discoverModels(options(server.baseURL, { maxResponseBytes: 100 })), 'RESPONSE_TOO_LARGE', 200) }
    finally { await server.close() }
  })

  it.each(['not-json', '{}', 'null', '{"data":{}}'])('rejects invalid listing %s with safe errors', async value => {
    const server = await fixture((_req, res) => res.end(value))
    try { await rejected(discoverModels(options(server.baseURL)), 'MALFORMED_RESPONSE', 200) }
    finally { await server.close() }
  })

  it('does not copy untrusted transport errors, even LlmError instances', async () => {
    await rejected(discoverModels(options('http://localhost:1', { fetch: async () => {
      throw new LlmError(key + headerSecret, key, { cause: new Error(headerSecret) })
    } })), 'TRANSPORT')
  })

  it('validates endpoint, key, headers and limits without echoing secrets or dispatching', async () => {
    let calls = 0
    const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error() }
    for (const patch of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxResponseBytes: -1 },
      { maxResponseBytes: 65 * 1024 * 1024 }, { baseURL: 'ftp://invalid' },
      { baseURL: `https://example.test/?key=${key}` }, { baseURL: `https://u:${key}@example.test` },
      { apiKey: key + '\n' + headerSecret }, { headers: { 'bad header': headerSecret } }]) {
      await rejected(discoverModels(options('http://localhost:1', { fetch, ...patch })), 'INVALID_REQUEST')
    }
    expect(calls).toBe(0)
  })
})
