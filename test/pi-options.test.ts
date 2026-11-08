import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRuntime } from '../src/core/index.js'
import type { PiAiProviderOptions } from '../src/providers/pi-ai/index.js'
import { createPiAiProvider, defineModel, catalogModels, catalogProviders } from '../src/providers/pi-ai/index.js'
import { closeMockServers, mockServer, textEvents } from './mock-server.js'
afterEach(closeMockServers)
const request = { provider: 'route', model: 'm', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] }
async function setup(script: Parameters<typeof mockServer>[0], extras: Partial<PiAiProviderOptions> = {}) {
  const server = await mockServer(script)
  const config: PiAiProviderOptions = { id: 'route', api: 'openai-completions', apiKey: 'secret', baseURL: server.url,
    models: [defineModel({ id: 'm', api: 'openai-completions', baseUrl: server.url })], ...extras }
  const provider = createPiAiProvider(config); const runtime = new ModelRuntime(); runtime.register(provider)
  return { server, config, provider, runtime }
}
describe('pi-ai immutable authentication and diagnostics', () => {
  it('captures credential and prepared headers before exactly one dispatch', async () => {
    let key = 'old-key'; let header = 'old-header'; const resolver = vi.fn(async () => key)
    const { server, config, runtime } = await setup([{ events: textEvents }], { apiKey: resolver, authScope: 'account-1', prepareHeaders: (_request, headers) => { headers.set('x-snapshot', header); return headers } })
    const prepared = await runtime.prepareCall(request)
    key = 'new-key'; header = 'new-header'; config.baseURL = 'http://127.0.0.1:1'; config.apiKey = 'changed'
    expect((await prepared.generate()).finish.kind).toBe('stop')
    expect(server.headers[0]!.authorization).toBe('Bearer old-key'); expect(server.headers[0]!['x-snapshot']).toBe('old-header')
    expect(resolver).toHaveBeenCalledOnce(); expect(resolver.mock.calls[0]![0]).toMatchObject({ route: 'route', provider: 'route', scope: 'account-1' })
    expect(() => prepared.stream()).toThrow(/already/)
  })
  it('retains HTTP Retry-After/requestId facts while redacting echoed credentials', async () => {
    const { runtime } = await setup([{ status: 429, body: JSON.stringify({ error: { message: 'bad secret and sensitive-header' } }), headers: { 'retry-after': '3', 'x-request-id': 'request-secret' } }], { headers: { 'x-private': 'sensitive-header' } })
    const result = await runtime.generate(request)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 3000 } })
    expect(JSON.stringify(result.finish)).not.toContain('secret'); expect(JSON.stringify(result.finish)).not.toContain('sensitive-header')
  })
  it('ranks the observed HTTP status above gateway prose when classifying failures', async () => {
    const unroutable = await setup([{ status: 400, body: JSON.stringify({ error: { message: 'No endpoints found for "test/model".' } }) }])
    expect((await unroutable.runtime.generate(request)).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400 } })
    const missing = await setup([{ status: 404, body: JSON.stringify({ error: { message: 'Requested resource is unavailable.' } }) }])
    expect((await missing.runtime.generate(request)).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'ENDPOINT_NOT_FOUND', status: 404 } })
    const billing = await setup([{ status: 402, body: JSON.stringify({ error: { message: 'Add credits to continue.' } }) }])
    expect((await billing.runtime.generate(request)).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'QUOTA', status: 402 } })
    // OpenRouter sends this body without repeating its own status number.
    const proseOnly = await setup([{ status: 400, body: JSON.stringify({ error: { message: 'No endpoints found that support the model.' } }) }])
    expect((await proseOnly.runtime.generate(request)).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400 } })
    const overflow = await setup([{ status: 400, body: JSON.stringify({ error: { message: 'This model\'s maximum context length is 8192 tokens.' } }) }])
    expect((await overflow.runtime.generate(request)).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 } })
  })
  it('freezes models/headers/protocol independently of caller config mutation', async () => {
    const { runtime, config, server } = await setup([{ events: textEvents }], { headers: { 'x-config': 'old' } })
    config.api = 'anthropic-messages'; config.headers!['x-config'] = 'new'; (config.models![0]!).id = 'changed'
    expect((await runtime.generate(request)).text).toBe('hello'); expect(server.paths[0]).toContain('chat/completions'); expect(server.headers[0]!['x-config']).toBe('old')
  })
  it('exposes honest offline model modalities and resolved capacity', async () => {
    const { runtime } = await setup([])
    expect(await runtime.listModels('route')).toEqual([{ id: 'm', name: 'm', provider: 'route', inputModalities: ['text'] }])
    expect(await runtime.resolveModel('route', 'm')).toMatchObject({ context: { contextWindow: 128000 }, defaultMaxTokens: 4096, reasoning: { efforts: [{ id: 'off', name: 'off' }] } })
    expect(catalogProviders()).toContain('openai'); expect(catalogModels('not-a-provider')).toEqual([]); expect(catalogModels('openai').length).toBeGreaterThan(0)
  })
  it('integrates bounded protocol-aware discovery after credential resolution', async () => {
    const { provider, server } = await setup([{ body: JSON.stringify({ data: [{ id: 'listed' }] }) }], { api: 'anthropic-messages' })
    expect(await provider.discoverModels()).toEqual([{ id: 'listed', name: 'listed', provider: 'route' }])
    expect(server.paths[0]).toBe('/v1/models?limit=1000'); expect(server.headers[0]!['x-api-key']).toBe('secret'); expect(server.headers[0]!.authorization).toBeUndefined()
  })
  it('supports native authentication header snapshots', async () => {
    const resolver = vi.fn(async () => ({ apiKey: 'native-secret', headers: { 'x-native': 'yes' } }))
    const { runtime, server } = await setup([{ events: textEvents }], { apiKey: undefined, nativeAuth: resolver })
    expect((await runtime.generate(request)).finish.kind).toBe('stop'); expect(server.headers[0]!.authorization).toBe('Bearer native-secret'); expect(server.headers[0]!['x-native']).toBe('yes')
  })
  it('accepts native SDK lifecycle callbacks and preserves stream defaults', async () => {
    const onPayload = vi.fn(); const onResponse = vi.fn()
    const { runtime, server } = await setup([{ events: textEvents }], { streamOptions: { onPayload, onResponse, temperature: 0.25 } })
    expect((await runtime.generate(request)).finish.kind).toBe('stop')
    expect(onPayload).toHaveBeenCalledOnce(); expect(onResponse).toHaveBeenCalledOnce()
    expect(server.requests[0]).toMatchObject({ temperature: 0.25 })
  })
  it('fails an explicit missing credential without ambient fallback or I/O', async () => {
    const { runtime, server } = await setup([], { apiKey: async () => undefined })
    expect((await runtime.generate(request)).finish.kind).toBe('error'); expect(server.requests).toHaveLength(0)
  })
})
