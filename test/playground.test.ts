/** Playground integration tests use installed pi-ai over loopback HTTP, never real providers. */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TCP listener required')
  return `http://127.0.0.1:${address.port}`
}
async function playground() {
  const { createPlaygroundServer } = await import('../playground/server.mjs')
  const server = createPlaygroundServer({ port: 0 })
  expect(server.listening).toBe(false)
  return { server, url: await listen(server) }
}
function post(url: string, path: string, body: unknown, extra: RequestInit = {}) {
  return fetch(url + path, { method: 'POST', headers: { origin: url,
    'x-model-sdk-playground': '1', 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra })
}
const frames = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
]
async function provider(options: { error?: boolean; hold?: boolean; redirect?: string; responses?: boolean } = {}) {
  const requests: any[] = []
  let disconnected = false
  const url = await listen(createServer(async (req, res) => {
    const buffers: Buffer[] = []
    for await (const buffer of req) buffers.push(Buffer.from(buffer))
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined
    requests.push({ method: req.method, path: req.url, headers: req.headers, body })
    res.on('close', () => { disconnected = true })
    if (options.redirect) { res.writeHead(307, { location: options.redirect }); res.end(); return }
    if (options.error) {
      const key = req.headers.authorization?.replace('Bearer ', '') ?? ''
      res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': `echo-${encodeURIComponent(key)}` })
      res.end(JSON.stringify({ error: { message: `Rejected ${key} ${encodeURIComponent(key)} ${Buffer.from(key).toString('base64')}` } }))
      return
    }
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'fixture', name: 'Fixture', input_modalities: ['text'] }] }))
      return
    }
    if (req.url?.endsWith('/embeddings')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'fixture', data: body.input.map((_: string, index: number) => ({ index, embedding: [0.25, 0.5, 0.75] })), usage: { prompt_tokens: 2, total_tokens: 2 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-encrypted-signature', summary: [{ type: 'summary_text', text: 'fixture reasoning' }] }
    const message = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
    const responseFrames = [
      { type: 'response.created', response: { id: 'resp_fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } },
      { type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 1, item: message },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [reasoning, message], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } } },
    ]
    for (const frame of (options.responses ? responseFrames : options.hold ? frames.slice(0, 1) : frames)) res.write(`data: ${JSON.stringify(frame)}\n\n`)
    if (!options.hold) res.end('data: [DONE]\n\n')
  }))
  return { url, requests, get disconnected() { return disconnected } }
}
function config(baseURL: string) {
  return { mode: 'custom', provider: 'fixture-route', protocol: 'openai-completions', baseURL, model: 'fixture', apiKey: 'fixture-secret+/=' }
}
const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello fixture' }] }]

describe('standalone local model playground', () => {
  it('imports without listening and serves only the exact three public files', async () => {
    const { url } = await playground()
    for (const path of ['/', '/index.html', '/style.css', '/app.js']) {
      const response = await fetch(url + path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }
    for (const path of ['/server.mjs', '/README.md', '/public/app.js', '/%2e%2e/package.json', '/app.js?key=secret', '/api/catalog?apiKey=secret']) {
      expect((await fetch(url + path)).status).toBe(404)
    }
  })
  it('returns offline catalog metadata and the four custom protocols without credentials', async () => {
    const { url } = await playground()
    const result = await (await fetch(url + '/api/catalog')).json()
    expect(result.protocols).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'])
    expect(result.providers).toContainEqual(expect.objectContaining({ id: 'openai', models: expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: expect.any(String) })]) }))
    expect(JSON.stringify(result)).not.toMatch(/apiKey|authorization/)
  })
  it('rejects Origin, Host, custom header, content type, unsupported methods and credentials on GET', async () => {
    const { url } = await playground()
    const normal = { origin: url, 'content-type': 'application/json', 'x-model-sdk-playground': '1' }
    for (const headers of [
      { ...normal, origin: 'https://evil.example' }, { ...normal, origin: 'null' },
      { ...normal, origin: url + '/' }, { ...normal, origin: undefined },
      { ...normal, 'x-model-sdk-playground': undefined }, { ...normal, 'content-type': 'text/plain' },
    ]) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)) as Record<string, string>
      expect((await post(url, '/api/generate', {}, { headers: clean })).status).toBeGreaterThanOrEqual(400)
    }
    const ambient = await fetch(url + '/api/catalog', { headers: { authorization: 'Bearer secret' } })
    expect(ambient.status).toBe(400)
    expect(await ambient.json()).toMatchObject({ error: { code: 'AMBIENT_CREDENTIALS_REJECTED', rejectedHeaders: ['authorization'] } })
    // A browser shares cookies across every port of one host, and no cookie can reach a
    // provider here, so cookies must not lock the page out of the playground.
    expect((await fetch(url + '/api/catalog', { headers: { cookie: 'key=secret' } })).status).toBe(200)
    for (const method of ['PUT', 'DELETE', 'OPTIONS']) expect((await fetch(url + '/api/generate', { method })).status).toBe(405)
    expect((await post(url, '/api/catalog', {})).status).toBe(405)
    const status = await new Promise<number>(resolve => {
      const req = httpRequest(url + '/api/catalog', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode!) })
      req.end()
    })
    expect(status).toBe(403)
    const wrongPort = await new Promise<number>(resolve => {
      const req = httpRequest(url + '/api/generate', { method: 'POST', headers: { ...normal, host: 'localhost:1' } }, res => { res.resume(); resolve(res.statusCode!) })
      req.end('{}')
    })
    expect(wrongPort).toBe(403)
  })
  it('bounds and validates JSON, endpoint URLs, request messages and extra business fields', async () => {
    const { url } = await playground()
    expect((await post(url, '/api/generate', { prompt: 'x'.repeat(256 * 1024) })).status).toBe(413)
    expect((await post(url, '/api/generate', {}, { body: '{' })).status).toBe(400)
    for (const baseURL of ['file:///etc/passwd', 'https://u:p@example.com', 'https://example.com?q=secret', 'https://example.com#secret']) {
      expect((await post(url, '/api/generate', { config: config(baseURL), messages })).status).toBe(400)
    }
    for (const bad of [
      { messages: [{ role: 'system', content: [] }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'ok', permissions: ['admin'] }] }] },
      { messages: Array.from({ length: 101 }, () => messages[0]) },
      { messages, teamId: 'tenant' },
    ]) expect((await post(url, '/api/generate', { config: config('http://127.0.0.1:1'), ...bad })).status).toBe(400)
  })
  it('generates with the real SDK using exactly one provider call and preserves full assistant replay for the next turn', async () => {
    const fixture = await provider()
    const { url } = await playground()
    const result = await (await post(url, '/api/generate', { config: config(fixture.url), messages, system: 'test system', stream: false, maxTokens: 128 })).json()
    expect(result).toMatchObject({ text: 'hello', finish: { kind: 'stop' }, usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 }, message: { role: 'assistant', source: { kind: 'model', provider: 'fixture-route', model: 'fixture', replayState: expect.any(Object) } } })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0].headers.authorization).toBe('Bearer fixture-secret+/=')
    expect(fixture.requests[0].body.messages).toContainEqual({ role: 'system', content: 'test system' })
    expect(fixture.requests[0].body.max_tokens ?? fixture.requests[0].body.max_completion_tokens).toBe(128)
    const next = await post(url, '/api/generate', { config: config(fixture.url), messages: [...messages, result.message, ...messages] })
    expect(next.status).toBe(200)
    expect((await next.json()).text).toBe('hello')
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1].body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'hello' }))
  })
  it('streams start, verbatim SDK chunks, then a result assembled from that very same call', async () => {
    const fixture = await provider()
    const { url } = await playground()
    const response = await post(url, '/api/generate', { config: config(fixture.url), messages, stream: true })
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const chunks = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(chunks[0]).toEqual({ type: 'start' })
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('hello')
    expect(chunks.at(-2)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: expect.any(Object) })
    expect(chunks.at(-1)).toMatchObject({ type: 'result', result: { text: 'hello', message: { source: { replayState: chunks.at(-2).replayState } } } })
    expect(fixture.requests).toHaveLength(1)
  })
  it('keeps Responses encrypted reasoning and replays native source history losslessly', async () => {
    const fixture = await provider({ responses: true })
    const { url } = await playground()
    const cfg = { ...config(fixture.url), protocol: 'openai-responses' }
    const response = await post(url, '/api/generate', { config: cfg, messages, stream: true })
    const chunks = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    const result = chunks.at(-1).result
    expect(result.text).toBe('hello')
    expect(JSON.stringify(result.message.source.replayState)).toContain('opaque-encrypted-signature')
    const next = await post(url, '/api/generate', { config: cfg, messages: [...messages, result.message, ...messages], stream: false })
    expect((await next.json()).finish).toEqual({ kind: 'stop' })
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1].body.input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque-encrypted-signature', id: 'rs_fixture' }))
  })
  it('cancels the provider HTTP connection when a streaming browser disconnects', async () => {
    const fixture = await provider({ hold: true })
    const { url } = await playground()
    const cancel = new AbortController()
    const response = await post(url, '/api/generate', { config: config(fixture.url), messages, stream: true }, { signal: cancel.signal })
    const reader = response.body!.getReader()
    while (fixture.requests.length === 0) await reader.read()
    cancel.abort()
    await reader.cancel().catch(() => {})
    await expect.poll(() => fixture.disconnected, { timeout: 4000 }).toBe(true)
    expect(fixture.requests).toHaveLength(1)
  })
  it('reports timeout as terminal finish plus result rather than losing the partial text', async () => {
    const fixture = await provider({ hold: true })
    const { url } = await playground()
    const response = await post(url, '/api/generate', { config: config(fixture.url), messages, stream: true, timeoutMs: 250 })
    const chunks = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(chunks.at(-2)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } })
    expect(chunks.at(-1)).toMatchObject({ type: 'result', result: { text: 'hel', finish: { kind: 'error' } } })
  })
  it('discovers only on explicit POST {config} and sends credentials to that endpoint once', async () => {
    const fixture = await provider()
    const { url } = await playground()
    await fetch(url + '/api/catalog')
    expect(fixture.requests).toHaveLength(0)
    const response = await post(url, '/api/discover', { config: config(fixture.url) })
    expect(await response.json()).toEqual({ models: [{ id: 'fixture', name: 'Fixture', inputModalities: ['text'] }] })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]).toMatchObject({ method: 'GET', path: '/models' })
    expect((await post(url, '/api/discover', config(fixture.url))).status).toBe(400)
  })
  it('sends a catalog model outside the suggested snapshot using that route protocol and compat', async () => {
    const fixture = await provider()
    const { url } = await playground()
    const catalog = (model: string) => ({ mode: 'catalog', provider: 'dashscope', baseURL: fixture.url, model, apiKey: 'fixture-secret+/=' })
    expect((await post(url, '/api/generate', { config: catalog('qwen3.8-flash'), messages, stream: false })).status).toBe(200)
    expect(fixture.requests[0].body).toMatchObject({ model: 'qwen3.8-flash' })
    expect(fixture.requests[0].path).toBe('/chat/completions')
    expect(fixture.requests[0].headers.authorization).toBe('Bearer fixture-secret+/=')
    expect(fixture.requests[0].body).not.toHaveProperty('store')
    const known = await post(url, '/api/generate', { config: catalog('qwen-plus'), messages, stream: false })
    expect((await known.json()).text).toBe('hello')
    expect(fixture.requests[1].body).toMatchObject({ model: 'qwen-plus' })
  })
  it('redacts raw and encoded credentials from provider terminal failures, discovery errors and headers without stacks', async () => {
    const fixture = await provider({ error: true })
    const { url } = await playground()
    for (const [path, body] of [
      ['/api/generate', { config: config(fixture.url), messages, stream: false }],
      ['/api/generate', { config: config(fixture.url), messages, stream: true }],
      ['/api/discover', { config: config(fixture.url) }],
    ] as const) {
      const response = await post(url, path, body)
      const text = await response.text()
      for (const secret of ['fixture-secret+/=', encodeURIComponent('fixture-secret+/='), Buffer.from('fixture-secret+/=').toString('base64')]) expect(text).not.toContain(secret)
      expect(text).not.toContain('stack')
      expect(text).not.toContain('server.mjs:')
    }
  })
  it('does not follow a discovery redirect with credentials', async () => {
    const target = await provider()
    const fixture = await provider({ redirect: target.url + '/models' })
    const { url } = await playground()
    expect((await post(url, '/api/discover', { config: config(fixture.url) })).status).toBe(502)
    expect(target.requests).toHaveLength(0)
  })
  it('accepts neutral assistant history without source and rejects ambient API-key headers', async () => {
    const fixture = await provider()
    const { url } = await playground()
    const response = await post(url, '/api/generate', { config: config(fixture.url), messages: [...messages,
      { role: 'assistant', content: [{ type: 'text', text: 'previous response' }] }, ...messages] })
    expect(response.status).toBe(200)
    expect((await response.json()).text).toBe('hello')
    expect(fixture.requests[0].body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'previous response' }))
    expect((await fetch(url + '/api/catalog', { headers: { 'x-api-key': 'secret' } })).status).toBe(400)
  })
  it('only binds loopback and accepts matching localhost origins', async () => {
    const { createPlaygroundServer } = await import('../playground/server.mjs')
    const server = createPlaygroundServer({ port: 0 })
    expect(() => server.listen(0, '0.0.0.0')).toThrow(/127.0.0.1/)
    const url = await listen(server)
    expect(server.address()).toMatchObject({ address: '127.0.0.1' })
    const address = new URL(url)
    const host = `localhost:${address.port}`
    const status = await new Promise<number>(resolve => {
      const req = httpRequest(url + '/api/discover', { method: 'POST', headers: {
        host, origin: `http://${host}`, 'x-model-sdk-playground': '1', 'content-type': 'application/json',
      } }, res => { res.resume(); resolve(res.statusCode!) })
      req.end(JSON.stringify({ config: { mode: 'catalog', provider: 'openai', apiKey: '' } }))
    })
    expect(status).toBe(200)
  })
  it('rejects chunked oversized bodies and nested prototype keys before contacting a provider', async () => {
    const { url } = await playground()
    const status = await new Promise<number>(resolve => {
      const req = httpRequest(url + '/api/generate', { method: 'POST', headers: { origin: url,
        'x-model-sdk-playground': '1', 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      }, res => { res.resume(); resolve(res.statusCode!) })
      req.on('error', () => resolve(0))
      req.write('{"prompt":"')
      req.write('x'.repeat(256 * 1024))
      req.end('"}')
    })
    expect(status).toBe(413)
    const response = await post(url, '/api/generate', {}, { body: '{"config":{"__proto__":{"apiKey":"secret"}}}' })
    expect(response.status).toBe(400)
  })
  it('uses the independent embedding endpoint and returns only vector previews plus usage', async () => {
    const fixture = await provider()
    const { url } = await playground()
    const response = await post(url, '/api/embed', { config: config(fixture.url), input: ['first', 'second'], dimensions: 3 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ model: 'fixture', vectors: [
      { index: 0, dimensions: 3, preview: [0.25, 0.5, 0.75] }, { index: 1, dimensions: 3, preview: [0.25, 0.5, 0.75] },
    ], usage: { promptTokens: 2, totalTokens: 2 } })
    expect(fixture.requests[0].path).toBe('/embeddings')
  })
})
