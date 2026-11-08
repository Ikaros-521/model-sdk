import { readFile } from 'node:fs/promises'
import { ModelRuntime, createToolResultMessage } from '@ai-employee/model-sdk'
import { createPiAiProvider, defineModel, catalogModels } from '@ai-employee/model-sdk/providers/pi-ai'
import { createDeepSeekProvider } from '@ai-employee/model-sdk/providers/deepseek'
import { MemoryAttachmentStore } from '@ai-employee/model-sdk/attachments'
import { createOpenAIEmbeddingAdapter } from '@ai-employee/model-sdk/embeddings'
import { withRetry } from '@ai-employee/model-sdk/retry'

const modes = ['text', 'stream', 'tools', 'reasoning', 'replay', 'image', 'deepseek-image', 'custom', 'embedding', 'discovery', 'cancel', 'retry']
const mode = process.argv[2] ?? '--help'
if (mode === '--help' || mode === '--check') {
  console.log('Usage: node examples/run.mjs <mode>')
  console.log(`Modes: ${modes.join(', ')}`)
  console.log('Set MODEL_PROVIDER, MODEL_ID and MODEL_API_KEY; see examples/README.md.')
  if (mode === '--check') console.log('All SDK example imports resolved. No network request was made.')
} else {
  if (!modes.includes(mode)) throw new Error(`Unknown mode: ${mode}`)
  await run(mode)
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name} before running this example`)
  return value
}
function user(text) { return { role: 'user', content: [{ type: 'text', text }] } }
function inspect(result) {
  console.log(JSON.stringify(result, null, 2))
  if (result.finish.kind === 'error' || result.finish.kind === 'aborted') process.exitCode = 1
}
function providerConfig(prefix = 'MODEL_') {
  const provider = process.env[`${prefix}PROVIDER`] ?? 'openai'
  const model = required(`${prefix}ID`)
  const apiKey = required(`${prefix}API_KEY`)
  const baseURL = process.env[`${prefix}BASE_URL`]
  const api = process.env[`${prefix}PROTOCOL`] ?? 'openai-completions'
  const id = prefix === 'MODEL_' ? 'example' : 'example-b'
  const options = baseURL
    ? { id, api, apiKey, baseURL, models: [defineModel({ id: model, api, baseUrl: baseURL,
        input: ['text', 'image'], reasoning: true, maxTokens: 2048 })] }
    : { id, catalogProvider: provider, apiKey }
  return { model, provider: createPiAiProvider(options) }
}
async function run(mode) {
  if (mode === 'embedding') {
    const config = {
      baseURL: process.env.EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: required('MODEL_API_KEY'), model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
      ...(process.env.EMBEDDING_DIMENSIONS ? { dimensions: Number(process.env.EMBEDDING_DIMENSIONS) } : {}),
    }
    const result = await createOpenAIEmbeddingAdapter(config).embed(['A small model SDK', 'An independent application'])
    console.log({ model: result.model, dimensions: result.embeddings.map(v => v.length), usage: result.usage })
    return
  }
  if (mode === 'deepseek-image') {
    const attachments = await imageStore()
    const runtime = new ModelRuntime()
    runtime.register(createDeepSeekProvider({ id: 'deepseek', apiKey: required('MODEL_API_KEY'), attachments: attachments.store }))
    inspect(await runtime.generate({ provider: 'deepseek', model: required('MODEL_ID'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the image.' }, { type: 'image', attachment: attachments.ref }] }],
      timeoutMs: 60000 }))
    return
  }
  if (mode === 'custom' && !process.env.MODEL_BASE_URL) throw new Error('custom mode requires MODEL_BASE_URL')
  const { provider, model } = providerConfig()
  const runtime = new ModelRuntime()
  runtime.register(mode === 'retry' ? withRetry(provider, { maxRetries: 2, initialDelayMs: 250, maxDelayMs: 5000, jitterRatio: 0.1 }) : provider)
  const request = { provider: provider.id, model, messages: [user('Reply with a short greeting.')], timeoutMs: 60000, idleTimeoutMs: 20000 }
  if (mode === 'discovery') {
    console.log('Configured models:', await runtime.listModels(provider.id))
    console.log('Resolved model:', await runtime.resolveModel(provider.id, model))
    console.log('Endpoint discovery:', await provider.discoverModels({ timeoutMs: 10000 }))
  } else if (mode === 'stream') {
    for await (const event of runtime.stream(request)) {
      if (event.type === 'text-delta') process.stdout.write(event.text)
      if (event.type === 'finish') console.log('\nFinish:', event.reason)
    }
  } else if (mode === 'tools') {
    const tools = [{ name: 'get_local_time', description: 'Read the current example host time; no arguments.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    const messages = [user('Use get_local_time, then tell me the returned time.')]
    for (let step = 0; step < 4; step++) {
      const result = await runtime.generate({ ...request, messages, tools })
      messages.push(result.message)
      if (['error', 'aborted', 'max-tokens'].includes(result.finish.kind)) { inspect(result); return }
      const calls = result.message.content.filter(b => b.type === 'tool-call')
      if (!calls.length) { inspect(result); return }
      for (const call of calls) {
        const args = JSON.parse(call.arguments)
        if (call.name !== 'get_local_time' || !args || Array.isArray(args) || Object.keys(args).length) throw new Error('Example rejected an unauthorized tool or arguments')
        messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: new Date().toISOString() }] }))
      }
    }
    throw new Error('Example reached its four-step tool budget')
  } else if (mode === 'reasoning') {
    inspect(await runtime.generate({ ...request, reasoningEffort: process.env.MODEL_REASONING_EFFORT ?? 'high',
      messages: [user('Explain why the sum of the first n odd positive integers is n squared.')] }))
  } else if (mode === 'replay') {
    const first = await runtime.generate(request)
    if (['error', 'aborted'].includes(first.finish.kind)) { inspect(first); return }
    const persisted = JSON.parse(JSON.stringify(first.message))
    const b = providerConfig('MODEL_B_')
    runtime.register(b.provider)
    const messages = [...request.messages, persisted, user('Restate that greeting in one word.')]
    const second = await runtime.generate({ ...request, provider: b.provider.id, model: b.model, messages })
    if (['error', 'aborted'].includes(second.finish.kind)) { inspect(second); return }
    inspect(await runtime.generate({ ...request, messages: [...messages, second.message, user('What was your original greeting?')] }))
  } else if (mode === 'image') {
    const images = await imageStore()
    const options = process.env.MODEL_BASE_URL
      ? { id: provider.id, api: process.env.MODEL_PROTOCOL ?? 'openai-completions', baseURL: process.env.MODEL_BASE_URL,
          models: [defineModel({ id: model, api: process.env.MODEL_PROTOCOL ?? 'openai-completions', baseUrl: process.env.MODEL_BASE_URL, input: ['text', 'image'] })] }
      : { id: provider.id, catalogProvider: process.env.MODEL_PROVIDER ?? 'openai' }
    if (!process.env.MODEL_BASE_URL && !catalogModels(process.env.MODEL_PROVIDER ?? 'openai').find(m => m.id === model)?.input.includes('image')) throw new Error('Choose an image-capable model')
    runtime.register(createPiAiProvider({ ...options, apiKey: required('MODEL_API_KEY'), attachments: images.store }))
    inspect(await runtime.generate({ ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the image.' }, { type: 'image', attachment: images.ref }] }] }))
  } else if (mode === 'cancel') {
    const controller = new AbortController()
    controller.abort()
    const result = await runtime.generate({ ...request, signal: controller.signal })
    console.log('Already-cancelled calls make no model request:', result.finish)
  } else {
    inspect(await runtime.generate(request))
  }
}
async function imageStore() {
  const store = new MemoryAttachmentStore()
  const width = Number(required('IMAGE_WIDTH'))
  const height = Number(required('IMAGE_HEIGHT'))
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new Error('Image dimensions must be positive integers matching the actual file')
  const ref = store.addImage({ data: await readFile(required('IMAGE_PATH')), mediaType: process.env.IMAGE_MEDIA_TYPE ?? 'image/png', width, height })
  return { store, ref }
}
