import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import { ModelRuntime } from '../src/core/index.js'
import type { CredentialResolver } from '../src/auth/index.js'
import { catalogModels, catalogProviders, createPiAiProvider, defineModel } from '../src/providers/pi-ai/index.js'
import { anthropicTextEvents, closeMockServers, mockServer, textEvents } from './mock-server.js'

afterEach(async () => { vi.unstubAllEnvs(); await closeMockServers() })
const request = { provider: 'dashscope', model: 'qwen-plus', system: 'Be helpful.',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], timeoutMs: 5000 }
const proxyRequest = { provider: 'dashscope-anthropic', model: 'qwen3-coder-plus', system: 'Be helpful.',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], timeoutMs: 5000 }

describe('SDK-owned DashScope preset', () => {
  it('merges regular DashScope with every upstream provider without duplicate identities', () => {
    const providers = catalogProviders()
    expect(providers).toContain('dashscope')
    expect(providers).toContain('dashscope-anthropic')
    expect(providers).toEqual(expect.arrayContaining([...getBuiltinProviders()]))
    expect(providers.filter(id => id === 'dashscope')).toHaveLength(1)
    expect(providers.filter(id => id === 'dashscope-anthropic')).toHaveLength(1)
    expect(new Set(providers).size).toBe(providers.length)
    expect(providers).toContain('qwen-token-plan-cn')
  })
  it('offers a suggested DashScope list beyond the legacy trio, all honest text-only placeholders', () => {
    const models = catalogModels('dashscope')
    expect(models.length).toBeGreaterThan(3)
    expect(models.map(model => model.id)).toContain('qwen3-coder-plus')
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining([
      'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-plus-latest', 'qwen-max-latest', 'qwen-turbo-latest',
      'qwen-long', 'qwen3-max', 'qwen3-coder-flash', 'qwen3-vl-plus', 'qwen3-omni-flash', 'deepseek-v3', 'deepseek-r1']))
    for (const model of models) expect(model).toMatchObject({ provider: 'dashscope', api: 'openai-completions',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', input: ['text'], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
      compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false } })
    const provider = createPiAiProvider({ catalogProvider: 'dashscope', apiKey: 'regular-key' })
    expect(provider.resolveModel?.('qwen-plus')).toMatchObject({ inputModalities: ['text'], reasoning: { efforts: [{ id: 'off', name: 'off' }] } })
    expect(provider.resolveModel?.('text-embedding-v4')).toBeUndefined()
  })
  it.each(['dashscope', 'dashscope-anthropic', 'openai'])('returns independent deep catalog snapshots for %s', provider => {
    const before = structuredClone(catalogModels(provider))
    expect(before.length).toBeGreaterThan(0)
    const changed = catalogModels(provider)
    changed[0]!.input.push('image')
    changed[0]!.cost.input = 123456
    changed[0]!.compat = { ...changed[0]!.compat, supportsStore: true }
    changed[0]!.id = 'polluted'
    expect(catalogModels(provider)).toEqual(before)
    const instance = createPiAiProvider({ catalogProvider: provider, apiKey: 'test' })
    expect(instance.listModels()).not.toContainEqual(expect.objectContaining({ id: 'polluted' }))
  })
  it('uses completions, regular credentials, and DashScope compatibility even on a loopback URL', async () => {
    const server = await mockServer([{ events: textEvents }])
    const apiKey = vi.fn<CredentialResolver>(async () => 'regular-key')
    const ambient = vi.fn(async () => 'token-plan-key')
    const runtime = new ModelRuntime()
    runtime.register(createPiAiProvider({ catalogProvider: 'dashscope', apiKey, baseURL: `${server.url}/compatible-mode/v1`,
      auth: { authContext: { env: ambient, fileExists: async () => false } }, streamOptions: { reasoning: 'high' } }))
    expect((await runtime.generate({ ...request, maxTokens: 37 })).text).toBe('hello')
    expect(server.paths).toEqual(['/compatible-mode/v1/chat/completions'])
    expect(server.headers[0]!.authorization).toBe('Bearer regular-key')
    expect(server.requests[0]).toMatchObject({ model: 'qwen-plus', max_tokens: 37, stream: true,
      messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'hi' }] })
    for (const key of ['store', 'max_completion_tokens', 'reasoning_effort', 'enable_thinking']) expect(server.requests[0]).not.toHaveProperty(key)
    expect(apiKey).toHaveBeenCalledOnce()
    expect(apiKey.mock.calls[0]![0]).toMatchObject({ route: 'dashscope', provider: 'dashscope', scope: 'dashscope' })
    expect(ambient).not.toHaveBeenCalled()
  })
  it('honors model, URL and call defaults overrides while snapshotting caller configuration', async () => {
    const server = await mockServer([{ events: textEvents }])
    const apiKey = vi.fn<CredentialResolver>(async () => 'override-key')
    const models = [defineModel({ ...catalogModels('dashscope')[0]!, id: 'qwen-manual', contextWindow: 32000, maxTokens: 64 })]
    const config = { id: 'account-route', catalogProvider: 'dashscope', apiKey, models, baseURL: `${server.url}/override/v1`, maxTokens: 23 }
    const provider = createPiAiProvider(config)
    const runtime = new ModelRuntime(); runtime.register(provider)
    models[0]!.id = 'changed'; models[0]!.compat = { supportsStore: true }; config.baseURL = 'http://127.0.0.1:1'
    expect(provider.listModels()).toEqual([{ id: 'qwen-manual', name: 'qwen-plus', provider: 'account-route', inputModalities: ['text'] }])
    expect(provider.resolveModel?.('qwen-manual')).toMatchObject({ context: { contextWindow: 32000 }, defaultMaxTokens: 23 })
    expect((await runtime.generate({ ...request, provider: 'account-route', model: 'qwen-manual' })).text).toBe('hello')
    expect(server.paths).toEqual(['/override/v1/chat/completions'])
    expect(server.requests[0]).toMatchObject({ model: 'qwen-manual', max_tokens: 23 })
    expect(server.requests[0]).not.toHaveProperty('store')
    expect(apiKey.mock.calls[0]![0]).toMatchObject({ route: 'account-route', provider: 'dashscope', scope: 'account-route' })
  })
  it('never adopts environment or Token Plan credentials for the SDK preset', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'ambient-dashscope-key')
    vi.stubEnv('QWEN_TOKEN_PLAN_CN_API_KEY', 'ambient-token-plan-key')
    const ambient = vi.fn(async () => 'ambient-port-key')
    const server = await mockServer([])
    const provider = createPiAiProvider({ catalogProvider: 'dashscope', baseURL: server.url, auth: { authContext: { env: ambient, fileExists: async () => false } } })
    await expect(provider.prepareCall(request)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    const missing = createPiAiProvider({ catalogProvider: 'dashscope', baseURL: server.url, apiKey: async () => undefined, auth: { authContext: { env: ambient, fileExists: async () => false } } })
    await expect(missing.prepareCall(request)).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_MISSING' })
    expect(ambient).not.toHaveBeenCalled(); expect(server.requests).toHaveLength(0)
  })
  it('merges discovered DashScope IDs into callable descriptors with honest placeholders and kept compat', async () => {
    const server = await mockServer([
      { body: JSON.stringify({ data: [{ id: 'qwen-new-model' }, { id: 'qwen-plus' }, { id: 'qwen3-vl-image' }] }) },
      { events: textEvents },
      { events: textEvents },
    ])
    const provider = createPiAiProvider({ catalogProvider: 'dashscope', apiKey: 'regular-key', baseURL: server.url })
    const discovered = await provider.discoverModels()
    expect(discovered.map(model => model.id)).toEqual(expect.arrayContaining(['qwen-plus', 'qwen-new-model', 'qwen3-vl-image']))
    expect(discovered.filter(model => model.id === 'qwen-plus')).toHaveLength(1)
    expect(provider.resolveModel?.('qwen-new-model')).toMatchObject({ context: { contextWindow: 128000 }, defaultMaxTokens: 4096,
      inputModalities: ['text'], reasoning: { efforts: [{ id: 'off', name: 'off' }] } })
    const runtime = new ModelRuntime(); runtime.register(provider)
    expect((await runtime.generate({ ...request, model: 'qwen-new-model' })).text).toBe('hello')
    expect(server.headers[1]!.authorization).toBe('Bearer regular-key')
    expect(server.requests[1]).toMatchObject({ model: 'qwen-new-model', max_tokens: 4096, stream: true })
    expect(server.requests[1]).not.toHaveProperty('store')
    expect((await runtime.generate(request)).text).toBe('hello')
    expect(server.paths).toEqual(['/models', '/chat/completions', '/chat/completions'])
    expect(server.requests[2]).toMatchObject({ model: 'qwen-plus', max_tokens: 4096 })
    expect(server.requests[2]).not.toHaveProperty('store')
  })
  it('keeps unknown provider and model rejection, even with explicit custom overrides', async () => {
    expect(catalogModels('not-a-provider')).toEqual([])
    expect(() => createPiAiProvider({ catalogProvider: 'not-a-provider', api: 'openai-completions', apiKey: 'key',
      models: [defineModel({ id: 'm', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1' })] })).toThrow(/Unknown catalog provider/)
    const provider = createPiAiProvider({ catalogProvider: 'dashscope', apiKey: 'regular-key' })
    await expect(provider.prepareCall({ ...request, model: 'unknown' })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })
})

describe('SDK-owned DashScope Anthropic proxy preset', () => {
  it('lists the Claude Code proxy route with Anthropic protocol and coder-first suggested models', () => {
    expect(catalogProviders()).toContain('dashscope-anthropic')
    const models = catalogModels('dashscope-anthropic')
    expect(models.map(model => model.id)).toEqual(['qwen3-coder-plus', 'qwen-plus', 'qwen-max'])
    for (const model of models) expect(model).toMatchObject({ provider: 'dashscope-anthropic', api: 'anthropic-messages',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy', input: ['text'], reasoning: false })
    const provider = createPiAiProvider({ catalogProvider: 'dashscope-anthropic', apiKey: 'proxy-key' })
    expect(provider.resolveModel?.('qwen3-coder-plus')).toMatchObject({ inputModalities: ['text'], reasoning: { efforts: [{ id: 'off', name: 'off' }] } })
    expect(provider.resolveModel?.('text-embedding-v4')).toBeUndefined()
  })
  it('sends x-api-key plus Authorization Bearer to the proxy /v1/messages endpoint', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const runtime = new ModelRuntime()
    runtime.register(createPiAiProvider({ catalogProvider: 'dashscope-anthropic', apiKey: 'proxy-key', baseURL: server.url }))
    expect((await runtime.generate({ ...proxyRequest, maxTokens: 37 })).text).toBe('hello')
    expect(server.paths).toEqual(['/v1/messages?beta=true'])
    expect(server.headers[0]).toMatchObject({ 'x-api-key': 'proxy-key', authorization: 'Bearer proxy-key' })
    expect(server.requests[0]).toMatchObject({ model: 'qwen3-coder-plus', max_tokens: 37, stream: true })
  })
  it('returns the local list for discovery instead of calling /models on the proxy', async () => {
    const server = await mockServer([])
    const provider = createPiAiProvider({ catalogProvider: 'dashscope-anthropic', apiKey: 'proxy-key', baseURL: server.url })
    expect((await provider.discoverModels()).map(model => model.id)).toEqual(['qwen3-coder-plus', 'qwen-plus', 'qwen-max'])
    expect(server.paths).toHaveLength(0)
    expect(server.requests).toHaveLength(0)
  })
  it('still honors explicit api, models and baseURL overrides over the proxy preset', async () => {
    const server = await mockServer([{ events: textEvents }])
    const models = [defineModel({ ...catalogModels('dashscope')[0]!, id: 'custom-openai' })]
    const runtime = new ModelRuntime()
    runtime.register(createPiAiProvider({ catalogProvider: 'dashscope-anthropic', apiKey: 'key', api: 'openai-completions',
      baseURL: server.url, models }))
    expect((await runtime.generate({ ...request, provider: 'dashscope-anthropic', model: 'custom-openai' })).text).toBe('hello')
    expect(server.paths).toEqual(['/chat/completions'])
    expect(server.requests[0]).toMatchObject({ model: 'custom-openai' })
    expect(server.requests[0]).not.toHaveProperty('store')
  })
})
