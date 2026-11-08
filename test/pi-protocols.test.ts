/** Real pi-ai serializers/parsers over loopback HTTP; no provider-stream doubles. */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BlockAssembler, ModelRuntime, createToolResultMessage, createUserMessage,
  type Message, type StreamChunk, type ToolSchema,
} from '../src/core/index.js'
import { createPiAiProvider, defineModel, type PiProtocol } from '../src/providers/pi-ai/index.js'

const apis: PiProtocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

type Json = Record<string, any>
type Frame = string | Json
interface Reply { frames?: Frame[]; status?: number; headers?: Record<string, string> }
interface WireRequest { path: string; method: string; headers: IncomingHttpHeaders; body: Json }
async function fixture(replies: Reply[]) {
  const requests: WireRequest[] = []
  const errors: unknown[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({ path: request.url ?? '', method: request.method ?? '', headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      const reply = replies[requests.length - 1]
      if (!reply) { response.writeHead(500); response.end('fixture exhausted'); return }
      response.writeHead(reply.status ?? 200, { 'content-type': reply.status ? 'application/json' : 'text/event-stream', ...reply.headers })
      if (reply.status) { response.end(JSON.stringify({ error: { message: 'fixture rejected request' } })); return }
      response.flushHeaders()
      for (const frame of reply.frames ?? []) {
        const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
        // Anthropic dispatches by named SSE event; the others dispatch by JSON payload.
        response.write(`${typeof frame === 'object' && frame.type ? `event: ${frame.type}\n` : ''}data: ${data}\n\n`)
      }
      response.end()
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture error') }
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  return { url: `http://127.0.0.1:${address.port}`, requests, errors }
}

const patch = '*** Begin Patch\n*** Update File: 示例.ts\n@@\n-old\n+new "quoted" \\path\n*** End Patch'
const args = { patch, nested: { enabled: true, count: 2 }, names: ['alpha', '中文'] }
const rawArgs = JSON.stringify(args)
const tool: ToolSchema = { name: 'apply_patch', description: 'Apply a source patch.', parameters: {
  type: 'object', properties: { patch: { type: 'string' }, nested: { type: 'object' }, names: { type: 'array', items: { type: 'string' } } }, required: ['patch'],
} }
const signatures = { thinking: 'dGhpbmtpbmctc2lnbmF0dXJl', text: 'dGV4dC1zaWduYXR1cmU=', tool: 'dG9vbC1zaWduYXR1cmU=' }
const prompt = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Apply the patch.' }] })

/** Deltas exercise incremental arguments; Responses done is authoritative. */
function frames(api: PiProtocol, tools = false, raw = rawArgs, stopAtLimit = false): Frame[] {
  const fragments = raw.match(/.{1,11}/gs) ?? []
  if (api === 'openai-completions') return [
    { choices: [{ index: 0, delta: { role: 'assistant', ...(tools ? { reasoning_content: 'source reasoning' } : {}), content: 'hel' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    ...tools ? [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_patch', type: 'function', function: { name: tool.name, arguments: '' }, extra_content: { google: { thought_signature: signatures.tool } } }] }, finish_reason: null }] },
      ...fragments.map(fragment => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] }, finish_reason: null }] })),
    ] : [],
    { choices: [{ index: 0, delta: {}, finish_reason: stopAtLimit ? 'length' : tools ? 'tool_calls' : 'stop' }], usage: {
      prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 2 },
    } }, '[DONE]',
  ]
  if (api === 'anthropic-messages') {
    const blocks: Frame[] = []
    let index = 0
    if (tools) {
      blocks.push(
        { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'source reasoning' } },
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signatures.thinking } },
        { type: 'content_block_stop', index },
      )
      index++
    }
    blocks.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      ...['hel', 'lo'].map(text => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
      { type: 'content_block_stop', index })
    if (tools) {
      index++
      blocks.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call_patch', name: tool.name, input: {} } },
        ...fragments.map(partial_json => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
        { type: 'content_block_stop', index })
    }
    return [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2 } } },
      ...blocks,
      { type: 'message_delta', delta: { stop_reason: stopAtLimit ? 'max_tokens' : tools ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
  }
  if (api === 'openai-responses') {
    const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'encrypted-fixture', summary: [{ type: 'summary_text', text: 'source reasoning' }] }
    const message = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
    const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_patch', name: tool.name, arguments: raw }
    const textIndex = tools ? 1 : 0
    const callIndex = 2
    return [
      { type: 'response.created', response: { id: 'resp_fixture' } },
      ...tools ? [
        { type: 'response.output_item.added', output_index: 0, item: reasoning },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
      ] : [],
      { type: 'response.output_item.added', output_index: textIndex, item: { ...message, content: [] } },
      { type: 'response.content_part.added', output_index: textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      ...['hel', 'lo'].map(delta => ({ type: 'response.output_text.delta', output_index: textIndex, content_index: 0, delta })),
      { type: 'response.output_item.done', output_index: textIndex, item: message },
      ...tools ? [
        { type: 'response.output_item.added', output_index: callIndex, item: { ...call, arguments: '' } },
        ...fragments.map(delta => ({ type: 'response.function_call_arguments.delta', output_index: callIndex, delta })),
        { type: 'response.function_call_arguments.done', output_index: callIndex, arguments: raw },
        { type: 'response.output_item.done', output_index: callIndex, item: call },
      ] : [],
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [...tools ? [reasoning] : [], message, ...tools ? [call] : []],
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 2 } } } },
    ]
  }
  return [
    ...tools ? [{ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'source reasoning', thoughtSignature: signatures.thinking }] } }] }] : [],
    { candidates: [{ content: { role: 'model', parts: [{ text: 'hel', thoughtSignature: signatures.text }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] } }] },
    ...tools ? [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_patch', name: tool.name, args: JSON.parse(raw) }, thoughtSignature: signatures.tool }] } }] }] : [],
    { responseId: 'google_fixture', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, cachedContentTokenCount: 2, totalTokenCount: 17 } },
  ]
}
function register(runtime: ModelRuntime, id: string, api: PiProtocol, baseURL: string) {
  runtime.register(createPiAiProvider({ id, api, apiKey: 'test', baseURL,
    models: [defineModel({ id: 'fixture', api, baseUrl: baseURL, reasoning: true })],
    streamOptions: { cacheRetention: 'none' },
  }))
}
function options(provider: string, messages: Message[] = [prompt()]) {
  return { provider, model: 'fixture', system: 'Fixture system instruction.', messages, tools: [tool], maxTokens: 128, temperature: 0.2, timeoutMs: 5000 }
}
function history(request: WireRequest, api: PiProtocol): Json[] {
  return request.body[api === 'openai-responses' ? 'input' : api === 'google-generative-ai' ? 'contents' : 'messages']
}
function assertToolRoundtrip(request: WireRequest, api: PiProtocol) {
  const messages = history(request, api)
  if (api === 'openai-responses') {
    const call = messages.find(m => m.type === 'function_call')!
    expect(JSON.parse(call.arguments)).toEqual(args)
    expect(messages.find(m => m.type === 'function_call_output')).toMatchObject({ call_id: call.call_id, output: 'patch applied' })
  } else if (api === 'openai-completions') {
    const call = messages.flatMap(m => m.tool_calls ?? [])[0]
    expect(JSON.parse(call.function.arguments)).toEqual(args)
    expect(messages.find(m => m.role === 'tool')).toMatchObject({ tool_call_id: call.id, content: 'patch applied' })
  } else if (api === 'anthropic-messages') {
    const blocks = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    const call = blocks.find(b => b.type === 'tool_use')!
    expect(call).toMatchObject({ name: tool.name, input: args })
    const result = blocks.find(b => b.type === 'tool_result')!
    expect(result.tool_use_id).toBe(call.id)
    expect(JSON.stringify(result.content)).toContain('patch applied')
  } else {
    const parts = messages.flatMap(m => m.parts ?? [])
    expect(parts.find(p => p.functionCall)?.functionCall).toMatchObject({ name: tool.name, args })
    expect(parts.find(p => p.functionResponse)?.functionResponse).toMatchObject({ name: tool.name, response: { output: 'patch applied' } })
  }
}
function assertNativeReplay(request: WireRequest, api: PiProtocol) {
  const wire = history(request, api)
  if (api === 'openai-responses') {
    expect(wire).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_fixture', encrypted_content: 'encrypted-fixture' }))
    expect(wire).toContainEqual(expect.objectContaining({ type: 'function_call', id: 'fc_fixture' }))
  } else if (api === 'anthropic-messages') {
    expect(wire.flatMap(m => m.content)).toContainEqual({ type: 'thinking', thinking: 'source reasoning', signature: signatures.thinking })
  } else if (api === 'openai-completions') {
    expect(wire.flatMap(m => m.tool_calls ?? [])[0]).toMatchObject({ extra_content: { google: { thought_signature: signatures.tool } } })
  } else {
    const parts = wire.flatMap(m => m.parts ?? [])
    expect(parts).toContainEqual({ thought: true, text: 'source reasoning', thoughtSignature: signatures.thinking })
    expect(parts).toContainEqual({ text: 'hello', thoughtSignature: signatures.text })
    expect(parts.find(p => p.functionCall)).toMatchObject({ thoughtSignature: signatures.tool })
  }
}

// Every call traverses ModelRuntime -> createPiAiProvider -> installed pi-ai -> HTTP.
describe('pi-ai real HTTP protocols', () => {
  it.each(apis)('%s sends native wire/auth/body and streams text plus disjoint usage', async api => {
    const server = await fixture([{ frames: frames(api) }])
    const runtime = new ModelRuntime()
    register(runtime, 'route', api, server.url)
    const chunks: StreamChunk[] = []
    for await (const chunk of runtime.stream(options('route'))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.filter(c => c.type === 'finish')).toHaveLength(1)
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('hello')
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 17 } })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } })
    expect(server.errors).toEqual([])
    expect(server.requests).toHaveLength(1)
    const request = server.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.headers['content-type']).toContain('application/json')
    expect(JSON.stringify(request.body)).toContain('Fixture system instruction.')
    expect(JSON.stringify(request.body)).toContain('Apply the patch.')
    if (api === 'google-generative-ai') {
      expect(request.path).toBe('/models/fixture:streamGenerateContent?alt=sse')
      expect(request.headers['x-goog-api-key']).toBe('test')
      expect(request.body.generationConfig).toMatchObject({ maxOutputTokens: 128, temperature: 0.2 })
      expect(request.body.tools[0].functionDeclarations[0]).toMatchObject({ name: tool.name })
    } else {
      expect(request.body.model).toBe('fixture')
      expect(request.body.stream).toBe(true)
      if (api === 'anthropic-messages') {
        expect(request.path).toBe('/v1/messages?beta=true')
        expect(request.headers['x-api-key']).toBe('test')
        expect(request.headers['anthropic-version']).toBe('2023-06-01')
        expect(request.body).toMatchObject({ max_tokens: 128, temperature: 0.2 })
        expect(request.body.tools[0]).toMatchObject({ name: tool.name, input_schema: tool.parameters })
      } else {
        expect(request.path).toBe(api === 'openai-responses' ? '/responses' : '/chat/completions')
        expect(request.headers.authorization).toBe('Bearer test')
        const declaration = api === 'openai-responses' ? request.body.tools[0] : request.body.tools[0].function
        expect(declaration).toMatchObject({ name: tool.name, parameters: tool.parameters })
      }
    }
  })

  it.each(apis)('%s generates native tool calls, executes a host tool and replays its result', async api => {
    const server = await fixture([{ frames: frames(api, true) }, { frames: frames(api) }])
    const runtime = new ModelRuntime()
    register(runtime, 'route', api, server.url)
    const first = await runtime.generate(options('route'))
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    expect(first.text).toBe('hello')
    expect(first.message.content).toContainEqual({ type: 'reasoning', text: 'source reasoning' })
    const calls = first.message.content.filter(b => b.type === 'tool-call')
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.name).toBe(tool.name)
    // Host execution consumes the exact JSON produced by the real native parser.
    const execute = (input: typeof args) => { expect(input).toEqual(args); return 'patch applied' }
    const output = execute(JSON.parse(call.arguments))
    const messages: Message[] = JSON.parse(JSON.stringify([prompt(), first.message, createToolResultMessage({
      callId: call.id, content: [{ type: 'text', text: output }], isError: false,
    })]))
    const saved = JSON.stringify(messages)
    const second = await runtime.generate(options('route', messages))
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(second.text).toBe('hello')
    expect(JSON.stringify(messages)).toBe(saved)
    expect(server.requests).toHaveLength(2)
    assertToolRoundtrip(server.requests[1]!, api)
    assertNativeReplay(server.requests[1]!, api)
    expect(server.errors).toEqual([])
  })

  it.each(apis.flatMap(a => apis.filter(b => b !== a).map(b => ({ a, b }))))('$a → $b → $a keeps durable reasoning/signatures and restores native replay', async ({ a, b }) => {
    const source = await fixture([{ frames: frames(a, true) }, { frames: frames(a) }, { frames: frames(a) }])
    const target = await fixture([{ frames: frames(b) }])
    const runtime = new ModelRuntime()
    register(runtime, 'route-a', a, source.url)
    register(runtime, 'route-b', b, target.url)
    const first = await runtime.generate(options('route-a'))
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const call = first.message.content.find(c => c.type === 'tool-call')!
    let messages: Message[] = JSON.parse(JSON.stringify([prompt(), first.message, createToolResultMessage({
      callId: call.id, content: [{ type: 'text', text: 'patch applied' }], isError: false,
    })]))
    const saved = JSON.stringify(messages)
    expect((await runtime.generate(options('route-a', messages))).finish).toEqual({ kind: 'stop' })
    const baseline = history(source.requests[1]!, a)
    assertNativeReplay(source.requests[1]!, a)
    const foreign = await runtime.generate(options('route-b', messages))
    expect(foreign.finish).toEqual({ kind: 'stop' })
    assertToolRoundtrip(target.requests[0]!, b)
    for (const signature of [...Object.values(signatures), 'encrypted-fixture']) expect(JSON.stringify(target.requests[0]!.body)).not.toContain(signature)
    expect(JSON.stringify(messages)).toBe(saved)
    messages = JSON.parse(JSON.stringify([...messages, foreign.message, prompt()]))
    expect((await runtime.generate(options('route-a', messages))).finish).toEqual({ kind: 'stop' })
    expect(history(source.requests[2]!, a).slice(0, baseline.length)).toEqual(baseline)
    expect(JSON.stringify(messages.slice(0, -2))).toBe(saved)
    assertNativeReplay(source.requests[2]!, a)
    expect(source.errors).toEqual([])
    expect(target.errors).toEqual([])
  })

  it.each(apis.slice(0, 3))('%s streams fragmented patch arguments verbatim and assembles the completed object', async api => {
    const server = await fixture([{ frames: frames(api, true) }])
    const runtime = new ModelRuntime()
    register(runtime, 'route', api, server.url)
    const chunks: StreamChunk[] = []
    const assembler = new BlockAssembler()
    for await (const chunk of runtime.stream(options('route'))) { chunks.push(chunk); assembler.push(chunk) }
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    const deltas = chunks.filter(c => c.type === 'tool-call-delta')
    expect(deltas.length).toBeGreaterThan(10)
    expect(deltas.map(c => c.argumentsDelta).join('')).toBe(rawArgs)
    const call = assembler.blocks().find(b => b.type === 'tool-call')!
    expect(call.name).toBe('apply_patch')
    expect(JSON.parse(call.arguments)).toEqual(args)
    expect(chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call')).toHaveLength(1)
    expect(server.requests).toHaveLength(1)
  })

  it('Responses authoritative final arguments replace an incomplete streamed prefix', async () => {
    const events = frames('openai-responses', true)
    const withoutArgumentDeltas = events.filter(f => typeof f !== 'object' || f.type !== 'response.function_call_arguments.delta')
    const added = withoutArgumentDeltas.findIndex(f => typeof f === 'object' && f.type === 'response.function_call_arguments.done')
    withoutArgumentDeltas.splice(added, 0, { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"patch":' })
    const server = await fixture([{ frames: withoutArgumentDeltas }])
    const runtime = new ModelRuntime()
    register(runtime, 'route', 'openai-responses', server.url)
    const result = await runtime.generate(options('route'))
    expect(result.finish).toEqual({ kind: 'tool-calls' })
    const call = result.message.content.find(b => b.type === 'tool-call')!
    expect(JSON.parse(call.arguments)).toEqual(args)
  })

  it.each(apis.slice(0, 3))('%s rejects malformed completed tool arguments through the real parser', async api => {
    const server = await fixture([{ frames: frames(api, true, '{"patch":"unfinished') }])
    const runtime = new ModelRuntime()
    register(runtime, 'route', api, server.url)
    const chunks: StreamChunk[] = []
    const assembler = new BlockAssembler()
    for await (const chunk of runtime.stream(options('route'))) { chunks.push(chunk); assembler.push(chunk) }
    expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
    expect(chunks.filter(c => c.type === 'finish')).toHaveLength(1)
    expect(chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call')).toBe(false)
    expect(assembler.replayState).toBeUndefined()
    expect(server.requests).toHaveLength(1)
  })

  it.each(['openai-completions', 'anthropic-messages'] as const)('%s retains max-token finish and prunes incomplete tool arguments', async api => {
    const server = await fixture([{ frames: frames(api, true, '{"patch":', true) }])
    const runtime = new ModelRuntime()
    register(runtime, 'route', api, server.url)
    const result = await runtime.generate(options('route'))
    expect(result.finish).toEqual({ kind: 'max-tokens' })
    expect(result.text).toBe('hello')
    expect(result.message.content.some(b => b.type === 'tool-call')).toBe(false)
    expect(result.message.source.replayState).toMatchObject({ blocks: [{ type: 'reasoning' }, { type: 'text' }] })
  })
})
