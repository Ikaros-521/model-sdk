import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { createDeepSeekProvider, DeepSeekFilesClient } from '../src/providers/deepseek/index.js'
import type { DeepSeekProviderOptions } from '../src/providers/deepseek/index.js'
import { MemoryAttachmentStore } from '../src/attachments/index.js'
import { ModelRuntime, createMessage, ToolCallId, ReasoningEffortId } from '../src/core/index.js'
import type { CallOptions, RequestMessage } from '../src/core/index.js'

interface Request { url: string; headers: IncomingHttpHeaders; raw: Buffer; body: any }
let server: Server
let baseURL: string
let requests: Request[]
let handler: (req: Request, response: ServerResponse) => void | Promise<void>
const event = (value: object) => `event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`
const start = (usage: object = { input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }) => ({ type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [], usage } })
function textEvents(text = 'Hello 世界', stop = 'end_turn'): object[] {
  return [start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 7 } }, { type: 'message_stop' }]
}
function toolEvents(): object[] {
  return [start(),
    { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'Need lookup' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'opaque-' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '"abc"}' } },
    { type: 'content_block_stop', index: 9 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } },
    { type: 'message_stop' }]
}
function sse(res: ServerResponse, events = textEvents()) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(event).join(''))
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}
function runtime(options: Partial<DeepSeekProviderOptions> = {}) {
  const runtime = new ModelRuntime()
  const provider = createDeepSeekProvider({ apiKey: 'test-secret', baseURL, ...options })
  runtime.register(provider)
  return { runtime, provider }
}
const call = (extra: Partial<CallOptions> = {}): CallOptions => ({ provider: 'deepseek', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], ...extra })
const toolResult = () => createMessage({ role: 'tool' as const, source: { kind: 'tool' as const, callId: ToolCallId('call-1') }, toolCallId: ToolCallId('call-1'), content: [{ type: 'text' as const, text: 'found' }] })
function imageInput(store = new MemoryAttachmentStore()) {
  const attachment = store.addImage({ data: Buffer.from('fixture-image-bytes'), mediaType: 'image/png', width: 2, height: 2, name: 'red.png' })
  const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'image', attachment }] }]
  return { store, attachment, messages }
}
function uploaded(req: Request, res: ServerResponse, id = 'file-1') {
  expect(req.headers['anthropic-version']).toBe('2023-06-01')
  expect(req.headers['anthropic-beta']).toContain('files-api')
  expect(req.headers['content-type']).toContain('multipart/form-data')
  expect(req.raw.toString()).toContain('expires_after[seconds]')
  expect(req.raw.toString()).toContain('fixture-image-bytes')
  json(res, { id, type: 'file', mime_type: 'image/png', size_bytes: 19, filename: 'fixture.png', created_at: new Date().toISOString() })
}

beforeEach(async () => {
  requests = []
  handler = (_req, res) => sse(res)
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks)
      let body: any
      try { body = JSON.parse(raw.toString()) } catch { /* Multipart and GET. */ }
      const request = { url: req.url!, headers: req.headers, raw, body }
      requests.push(request)
      await handler(request, res)
    } catch (error) { res.destroy(error as Error) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  baseURL = `http://127.0.0.1:${address.port}/anthropic`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('DeepSeek Messages runtime integration', () => {
  it('sends exact Messages headers/body and assembles disjoint cumulative usage', async () => {
    const { runtime } = runtimeFactory()
    const result = await runtime.generate(call({ system: 'Be concise', maxTokens: 123, temperature: 0.4,
      reasoningEffort: ReasoningEffortId('low'), stop: ['END'], tools: [{ name: 'lookup', description: 'Search', parameters: { type: 'object' } }] }))
    expect(result.text).toBe('Hello 世界')
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 22 })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/anthropic/v1/messages')
    expect(requests[0].headers).toMatchObject({ authorization: 'Bearer test-secret', 'anthropic-version': '2023-06-01', accept: 'text/event-stream', 'content-type': 'application/json' })
    expect(requests[0].headers['user-agent']).toContain('model-sdk')
    expect(requests[0].headers['x-deepseek-harness-user-id']).toBeUndefined()
    expect(requests[0].body).toEqual({ model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      max_tokens: 123, thinking: { type: 'enabled' }, output_config: { effort: 'low' }, system: 'Be concise', temperature: 0.4, stop_sequences: ['END'],
      tools: [{ name: 'lookup', description: 'Search', input_schema: { type: 'object' } }] })
  })

  it('replays fragmented tool calls and reasoning signatures through a second tool round', async () => {
    let count = 0
    handler = (_req, res) => sse(res, ++count === 1 ? toolEvents() : textEvents('The answer'))
    const { runtime } = runtimeFactory()
    const first = await runtime.generate(call())
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    expect(first.message.content).toEqual([{ type: 'reasoning', text: 'Need lookup' }, { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q":"abc"}' }])
    expect(first.message.source.replayState).toMatchObject({ blocks: [{ type: 'reasoning', signature: 'opaque-signature' }, { type: 'tool-call' }] })
    const second = await runtime.generate(call({ messages: [...call().messages, first.message, toolResult()] }))
    expect(second.text).toBe('The answer')
    expect(requests[1].body.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Need lookup', signature: 'opaque-signature' }, { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'abc' } }] })
    expect(requests[1].body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'found' }] }] })
  })

  it('drops native signatures when crossing models or provider routes', async () => {
    handler = (_req, res) => sse(res, toolEvents())
    const { runtime } = runtimeFactory()
    const first = await runtime.generate(call())
    handler = (_req, res) => sse(res)
    await runtime.generate(call({ model: 'other-model', messages: [...call().messages, first.message, toolResult()] }))
    expect(requests[1].body.messages[1].content[0].signature).toBeUndefined()
    const foreign = { ...first.message, source: { ...first.message.source, provider: 'foreign' } }
    await runtime.generate(call({ messages: [...call().messages, foreign, toolResult()] }))
    expect(requests[2].body.messages[1].content[0].signature).toBeUndefined()
  })

  it('degrades malformed replay metadata without leaking its contents to diagnostics', async () => {
    handler = (_req, res) => sse(res, toolEvents())
    const onReplayDegrade = vi.fn()
    const { runtime } = runtimeFactory({ onReplayDegrade })
    const first = await runtime.generate(call())
    const broken = { ...first.message, source: { ...first.message.source, replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-flash' }, blocks: [] } } }
    handler = (_req, res) => sse(res)
    const result = await runtime.generate(call({ messages: [...call().messages, broken, toolResult()] }))
    expect(result.finish?.kind).toBe('stop')
    expect(onReplayDegrade).toHaveBeenCalledWith('DeepSeek Messages replay: block count mismatch')
    expect(requests[1].body.messages[1].content[0].signature).toBeUndefined()
  })

  it('snapshots prepared catalog defaults and caller messages', async () => {
    const models = [{ id: 'deepseek-flash', maxTokens: 77 }]
    const { runtime } = runtimeFactory({ models })
    const input = call()
    const prepared = await runtime.prepareCall(input)
    input.messages[0] = { role: 'user', content: [{ type: 'text', text: 'mutated' }] }
    models[0].maxTokens = 88
    await prepared.generate()
    expect(requests[0].body.max_tokens).toBe(77)
    expect(requests[0].body.messages[0].content[0].text).toBe('Hi')
  })

  it('rejects unmatched tool results before network I/O', async () => {
    const { runtime } = runtimeFactory()
    const result = await runtime.generate(call({ messages: [toolResult()] }))
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST' } })
    expect(requests).toHaveLength(0)
  })

  it.each(['STREAM_CLOSED', 'MALFORMED_RESPONSE', 'EMPTY_RESPONSE'])('reports %s for incomplete or invalid SSE', async code => {
    handler = (_req, res) => {
      if (code === 'STREAM_CLOSED') sse(res, textEvents().slice(0, -1))
      else if (code === 'EMPTY_RESPONSE') sse(res, [start(), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }])
      else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {broken}\n\n') }
    }
    const { runtime } = runtimeFactory()
    const chunks = await Array.fromAsync(runtime.stream(call()))
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
  })

  it('handles byte-fragmented UTF8 and CRLF framing', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const data = Buffer.from(': heartbeat\r\n\r\n' + textEvents().map(event).join('').replaceAll('\n', '\r\n'))
      for (const byte of data) res.write(Buffer.from([byte]))
      res.end()
    }
    const { runtime } = runtimeFactory()
    expect((await runtime.generate(call())).text).toBe('Hello 世界')
  })

  it('maps HTTP retry/request facts and in-band failures', async () => {
    handler = (_req, res) => { res.setHeader('retry-after', '2'); res.setHeader('request-id', 'req-123'); json(res, { error: { type: 'rate_limit_error', message: 'Slow down' } }, 429) }
    const { runtime } = runtimeFactory()
    expect((await runtime.generate(call())).finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2000, requestId: 'req-123' } })
    handler = (_req, res) => sse(res, [{ type: 'error', error: { type: 'authentication_error', message: 'Bad key' } }])
    expect((await runtime.generate(call())).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
  })

  it.each(['timeoutMs', 'idleTimeoutMs'] as const)('enforces %s while the upstream stalls', async timeout => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(event(start())) }
    const { runtime } = runtimeFactory()
    const result = await runtime.generate(call({ [timeout]: 70 }))
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: timeout === 'timeoutMs' ? 'TIMEOUT' : 'IDLE_TIMEOUT' } })
  })

  it('cancels a pending stream and releases its socket', async () => {
    const controller = new AbortController()
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(event(start())); controller.abort() }
    const { runtime } = runtimeFactory()
    const result = await runtime.generate(call({ signal: controller.signal }))
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('resolves only explicit scoped credentials, refreshing per dispatch', async () => {
    const resolver = vi.fn(async () => 'resolved-key')
    const { runtime } = runtimeFactory({ id: 'custom-route', authScope: 'tenant-A', apiKey: resolver })
    await runtime.generate(call({ provider: 'custom-route' }))
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ route: 'custom-route', provider: 'deepseek', scope: 'tenant-A', signal: expect.any(AbortSignal) }))
    expect(requests[0].headers.authorization).toBe('Bearer resolved-key')
  })

  it('keeps directory listing local until explicit discovery and updates model caps', async () => {
    handler = (req, res) => req.url === '/models' ? json(res, { data: [{ id: 'new-model', name: 'New Model', input_modalities: ['text', 'image'], context_window: 100000, max_output_tokens: 456,
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'addition-only' } } }, { id: 'new-model' }, null] }) : sse(res)
    const { runtime, provider } = runtimeFactory()
    expect(await runtime.listModels('deepseek')).toHaveLength(2)
    expect(requests).toHaveLength(0)
    expect(await provider.discoverModels()).toEqual([{ provider: 'deepseek', id: 'new-model', name: 'New Model', inputModalities: ['text', 'image'] }])
    expect(requests[0].url).toBe('/models')
    expect(requests[0].headers.authorization).toBe('Bearer test-secret')
    await runtime.generate(call({ model: 'new-model' }))
    expect(requests[1].body.max_tokens).toBe(456)
  })

  it.each(['HTTP', 'SSE'])('redacts current credentials from %s failures and request ids', async wire => {
    handler = (_req, res) => {
      if (wire === 'HTTP') {
        res.setHeader('request-id', 'id-test-secret')
        json(res, { error: { type: 'authentication_error', message: 'Rejected test-secret and Bearer test-secret' } }, 401)
      } else sse(res, [{ type: 'error', error: { type: 'authentication_error', message: 'Rejected test-secret and Bearer test-secret' } }])
    }
    const { runtime, provider } = runtimeFactory()
    const result = await runtime.generate(call())
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH', message: expect.stringContaining('[REDACTED]') } })
    expect(JSON.stringify(result.finish)).not.toContain('test-secret')
    const prepared = await provider.prepareCall(call())
    const error = await Array.fromAsync(prepared.stream(new AbortController().signal)).catch(error => error)
    expect(error.code).toBe('AUTH')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('test-secret')
  })

  it('cancels an oversized never-ending HTTP error body at its bounded prefix', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json', 'request-id': 'test-secret' })
      res.write('x'.repeat(1024 * 1024))
      // Deliberately no res.end(): bounded failure handling must settle without EOF.
    }
    const { runtime } = runtimeFactory()
    const result = await runtime.generate(call({ timeoutMs: 1000 }))
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'SERVER', status: 503 } })
    expect(JSON.stringify(result.finish).length).toBeLessThan(2000)
    expect(JSON.stringify(result.finish)).not.toContain('test-secret')
  })

  it('does not retain arbitrary transport errors or credential-bearing causes', async () => {
    const fetch = vi.fn(async () => { throw new Error('test-secret', { cause: { authorization: 'Bearer test-secret' } }) })
    const { provider } = runtimeFactory({ fetch })
    const prepared = await provider.prepareCall(call())
    const error = await Array.fromAsync(prepared.stream(new AbortController().signal)).catch(error => error)
    expect(error.code).toBe('TRANSPORT')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('test-secret')
  })

  it('exposes context, output cap, modalities and update/reasoning capabilities', async () => {
    const { runtime } = runtimeFactory({ models: [{ id: 'vision', name: 'Vision', contextWindow: 9000, maxTokens: 333,
      inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' }] })
    expect(await runtime.resolveModel('deepseek', 'vision')).toMatchObject({ provider: 'deepseek', id: 'vision', name: 'Vision',
      context: { contextWindow: 9000 }, defaultMaxTokens: 333, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
      reasoning: { defaultEffort: 'high', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } })
    const unknown = await runtime.resolveModel('deepseek', 'unknown')
    expect(unknown?.inputModalities).toEqual(['text'])
    expect(unknown?.context).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('bounds discovery and refuses credential-bearing redirects', async () => {
    handler = (_req, _res) => {}
    const { provider } = runtimeFactory({ discoveryTimeoutMs: 50 })
    await expect(provider.discoverModels()).rejects.toMatchObject({ code: 'TIMEOUT' })
    handler = (_req, res) => { res.writeHead(302, { location: '/must-not-follow' }); res.end() }
    await expect(provider.discoverModels()).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(requests.some(req => req.url === '/must-not-follow')).toBe(false)
  })
})
// Alias avoids shadowing the fixture factory with local runtime bindings.
const runtimeFactory = runtime

describe('DeepSeek Files image lifecycle', () => {
  it('uploads multipart once, caches file ids and replays images after a tool result', async () => {
    let messages = 0
    handler = (req, res) => req.url.endsWith('/files') ? uploaded(req, res) : sse(res, ++messages === 1 ? toolEvents() : textEvents())
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store })
    const first = await runtime.generate(call({ messages: image.messages }))
    expect(first.finish?.kind).toBe('tool-calls')
    const second = await runtime.generate(call({ messages: [...image.messages, first.message, toolResult()] }))
    expect(second.finish?.kind).toBe('stop')
    expect(requests.filter(req => req.url.endsWith('/files'))).toHaveLength(1)
    const wires = requests.filter(req => req.url.endsWith('/messages'))
    expect(wires).toHaveLength(2)
    for (const req of wires) {
      expect(req.headers['anthropic-beta']).toContain('files-api')
      expect(req.body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'file', file_id: 'file-1' } })
    }
    expect(wires[1].body.messages[1].content[0].signature).toBe('opaque-signature')
  })

  it('deduplicates concurrent uploads while calls retain independent cancellation', async () => {
    let uploadStarted!: () => void
    const uploading = new Promise<void>(resolve => { uploadStarted = resolve })
    let finishUpload!: () => void
    handler = (req, res) => {
      if (req.url.endsWith('/files')) { uploadStarted(); finishUpload = () => uploaded(req, res); return }
      sse(res)
    }
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store })
    const controller = new AbortController()
    const first = runtime.generate(call({ messages: image.messages, signal: controller.signal }))
    const second = runtime.generate(call({ messages: image.messages }))
    await uploading
    // The second caller has already joined the shared upload's waiters before transport arrives.
    controller.abort()
    finishUpload()
    const results = await Promise.all([first, second])
    expect(results[0].finish?.kind).toBe('aborted')
    expect(results[1].finish?.kind).toBe('stop')
    expect(requests.filter(req => req.url.endsWith('/files'))).toHaveLength(1)
  })

  it('falls back request-wide to inline bytes when upload fails', async () => {
    handler = (req, res) => req.url.endsWith('/files') ? json(res, { error: { message: 'unavailable' } }, 503) : sse(res)
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store })
    expect((await runtime.generate(call({ messages: image.messages }))).finish?.kind).toBe('stop')
    const wire = requests.find(req => req.url.endsWith('/messages'))!
    expect(wire.headers['anthropic-beta']).toBeUndefined()
    expect(wire.body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('fixture-image-bytes').toString('base64') } })
  })

  it('falls back after the file operation deadline while the model call stays live', async () => {
    handler = (req, res) => { if (!req.url.endsWith('/files')) sse(res) }
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store, files: { timeoutMs: 50 } })
    expect((await runtime.generate(call({ messages: image.messages, timeoutMs: 1000 }))).finish?.kind).toBe('stop')
    expect(requests.at(-1)?.body.messages[0].content[1].source.type).toBe('base64')
  })

  it('enforces inline byte budgets without silently dropping image content', async () => {
    handler = (req, res) => req.url.endsWith('/files') ? json(res, { error: { message: 'unavailable' } }, 503) : sse(res)
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store, maxInlineRequestImageBytes: 8 })
    expect((await runtime.generate(call({ messages: image.messages }))).finish).toMatchObject({ kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 } })
    expect(requests.some(req => req.url.endsWith('/messages'))).toBe(false)
  })

  it('invalidates rejected ids and reuploads at most once per call', async () => {
    let uploads = 0
    let messages = 0
    handler = (req, res) => {
      if (req.url.endsWith('/files')) return uploaded(req, res, `file-${++uploads}`)
      if (++messages === 1) return json(res, { error: { type: 'invalid_request_error', message: 'file_id file-1 expired' } }, 400)
      sse(res)
    }
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store })
    expect((await runtime.generate(call({ messages: image.messages }))).finish?.kind).toBe('stop')
    expect(uploads).toBe(2)
    expect(requests.at(-1)?.body.messages[0].content[1].source.file_id).toBe('file-2')
    handler = (req, res) => req.url.endsWith('/files') ? uploaded(req, res, `file-${++uploads}`) : json(res, { error: { message: 'file_id invalid, file not found' } }, 400)
    const result = await runtime.generate(call({ messages: image.messages }))
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST' } })
    expect(uploads).toBe(3)
  })

  it('isolates upload caches across provider instances', async () => {
    let uploads = 0
    handler = (req, res) => req.url.endsWith('/files') ? uploaded(req, res, `file-${++uploads}`) : sse(res)
    const image = imageInput()
    const one = runtimeFactory({ attachments: image.store })
    const two = runtimeFactory({ attachments: image.store })
    await one.runtime.generate(call({ messages: image.messages }))
    await two.runtime.generate(call({ messages: image.messages }))
    expect(uploads).toBe(2)
  })

  it('redacts Files API errors and bounds a never-ending failed upload response', async () => {
    handler = (_req, res) => json(res, { error: { message: 'test-secret echoed by Files', code: 'test-secret' } }, 503)
    const client = new DeepSeekFilesClient({ baseURL, headers: { authorization: 'Bearer test-secret' } })
    const input = { data: Buffer.from('fixture-image-bytes'), mediaType: 'image/png' as const, filename: 'image.png', expiresAfterSeconds: 3600 }
    const error = await client.upload(input).catch(error => error)
    expect(error.code).toBe('SERVER')
    expect(error.message).toContain('[REDACTED]')
    expect(error.detail).toContain('[REDACTED]')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('test-secret')
    handler = (_req, res) => { res.writeHead(503); res.write('x'.repeat(1024 * 1024)) }
    await expect(client.upload({ ...input, signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: 'SERVER', failure: { status: 503 } })
  })

  it('reuses no upload across a resolved credential rotation', async () => {
    let uploads = 0
    let key = 'first-key'
    handler = (req, res) => req.url.endsWith('/files') ? uploaded(req, res, `file-${++uploads}`) : sse(res)
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store, apiKey: async () => key })
    await runtime.generate(call({ messages: image.messages }))
    key = 'rotated-key'
    await runtime.generate(call({ messages: image.messages }))
    expect(uploads).toBe(2)
    expect(requests.at(-1)?.headers.authorization).toBe('Bearer rotated-key')
  })

  it('replays inline image bytes and signatures through tool rounds after upload failures', async () => {
    let messages = 0
    handler = (req, res) => req.url.endsWith('/files') ? json(res, { error: { message: 'unavailable' } }, 503) : sse(res, ++messages === 1 ? toolEvents() : textEvents())
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store })
    const first = await runtime.generate(call({ messages: image.messages }))
    const second = await runtime.generate(call({ messages: [...image.messages, first.message, toolResult()] }))
    expect(second.finish?.kind).toBe('stop')
    for (const req of requests.filter(req => req.url.endsWith('/messages'))) {
      expect(req.body.messages[0].content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: Buffer.from('fixture-image-bytes').toString('base64') })
    }
    expect(requests.at(-1)?.body.messages[1].content[0].signature).toBe('opaque-signature')
  })

  it('supports opt-out from Files and durable offloaded-image placeholders', async () => {
    const image = imageInput()
    const { runtime } = runtimeFactory({ attachments: image.store, files: { enabled: false } })
    await runtime.generate(call({ messages: image.messages }))
    expect(requests).toHaveLength(1)
    expect(requests[0].body.messages[0].content[1].source.type).toBe('base64')
    const offloaded: RequestMessage[] = [{ role: 'user', content: [{ type: 'image', attachment: image.attachment, offloaded: true }] }]
    await runtime.generate(call({ messages: offloaded }))
    expect(requests[1].body.messages[0].content).toEqual([{ type: 'text', text: expect.stringContaining('image omitted to fit request image limits') }])
  })
})
