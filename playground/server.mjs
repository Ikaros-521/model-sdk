#!/usr/bin/env node
/** Local, stateless SDK exerciser. No employee-system imports or credential persistence. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { ModelRuntime, assemble } from '../dist/core/index.js'
import { catalogProviders, catalogModels, createPiAiProvider, defineModel, discoverModels } from '../dist/providers/pi-ai/index.js'
import { createDeepSeekProvider } from '../dist/providers/deepseek/index.js'
import { createOpenAIEmbeddingAdapter } from '../dist/embeddings/index.js'

const BODY_LIMIT = 256 * 1024
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
const AMBIENT_CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-goog-api-key']
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
])
class RequestError extends Error {
  constructor(status, code, headers) { super(code); this.status = status; this.code = code; this.headers = headers }
}
function reject(status = 400, code = 'INVALID_REQUEST', headers) { throw new RequestError(status, code, headers) }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) reject()
}
function text(value, max = 32768, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) reject()
  return value
}
function integer(value, max, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) reject()
  return value
}
function endpoint(value) {
  text(value, 2048)
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value) || /[\x00-\x20\\]/.test(value)) reject()
    return url.href.replace(/\/+$/, '')
  } catch { reject() }
}
function configuration(value, { model = true } = {}) {
  keys(value, ['mode', 'provider', 'protocol', 'baseURL', 'model', 'apiKey'])
  if (!['catalog', 'custom', 'deepseek'].includes(value.mode)) reject()
  if (value.provider !== undefined) text(value.provider, 128)
  if (value.protocol !== undefined && !PROTOCOLS.includes(value.protocol)) reject()
  if (value.baseURL !== undefined && value.baseURL !== '') endpoint(value.baseURL)
  if (model) text(value.model, 256)
  else if (value.model !== undefined) text(value.model, 256, true)
  // Explicit even when empty: never fall back to ambient SDK/OAuth credentials.
  if (value.apiKey !== undefined) text(value.apiKey, 4096, true)
  if (value.mode === 'catalog' && !catalogProviders().includes(value.provider)) reject()
  if (value.mode === 'custom' && (!PROTOCOLS.includes(value.protocol) || !value.baseURL)) reject()
  return { ...value, apiKey: value.apiKey ?? '', ...(value.baseURL ? { baseURL: endpoint(value.baseURL) } : {}) }
}
function makeProvider(config) {
  if (config.mode === 'deepseek') return createDeepSeekProvider({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })
  if (config.mode === 'catalog') {
    const models = adHocCatalogModel(config)
    return createPiAiProvider({ catalogProvider: config.provider, apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}), ...(models ? { models } : {}) })
  }
  return createPiAiProvider({ id: config.provider ?? 'custom', api: config.protocol, baseURL: config.baseURL, apiKey: config.apiKey,
    models: [defineModel({ id: config.model, api: config.protocol, baseUrl: config.baseURL })] })
}
/** A catalog provider's local list is a suggested snapshot, so an ID outside it is still
 * the same endpoint. Borrow that route's protocol and compat instead of refusing, the way
 * the SDK adopts discovered IDs; a fresh provider per request cannot keep discovery state. */
function adHocCatalogModel(config) {
  const listed = catalogModels(config.provider)
  if (listed.some(model => model.id === config.model)) return undefined
  const route = listed[0]
  if (!route) return undefined
  return [...listed, defineModel({ id: config.model, api: route.api, baseUrl: route.baseUrl,
    ...(route.compat ? { compat: structuredClone(route.compat) } : {}) })]
}
function validateJson(value, depth = 0) {
  if (depth > 32) reject()
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1) }
  else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) reject()
      validateJson(item, depth + 1)
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) reject()
}
function history(input, prompt, provider, model) {
  if (input === undefined && prompt !== undefined) input = [{ role: 'user', content: [{ type: 'text', text: text(prompt) }] }]
  if (!Array.isArray(input) || !input.length || input.length > 100) reject()
  for (const message of input) {
    keys(message, ['role', 'id', 'source', 'content'])
    if (!['user', 'assistant'].includes(message.role)) reject()
    if (message.id !== undefined) text(message.id, 256)
    if (!Array.isArray(message.content) || !message.content.length || message.content.length > 128) reject()
    for (const block of message.content) {
      if (block?.type === 'text' || (message.role === 'assistant' && block?.type === 'reasoning')) {
        keys(block, ['type', 'text']); text(block.text, 65536, true)
      } else if (message.role === 'assistant' && block?.type === 'tool-call') {
        keys(block, ['type', 'id', 'name', 'arguments'])
        text(block.id, 256); text(block.name, 256); text(block.arguments, 65536, true)
      } else reject()
    }
    if (message.role === 'assistant') {
      // Neutral hand-written turns are valid too; do not fabricate replay metadata.
      if (message.source === undefined) message.source = { kind: 'model', provider, model }
      keys(message.source, ['kind', 'provider', 'model', 'replayState'])
      if (message.source.kind !== 'model') reject()
      text(message.source.provider, 128); text(message.source.model, 256)
      if (message.source.replayState !== undefined && !record(message.source.replayState)) reject()
    } else if (message.source !== undefined) {
      keys(message.source, ['kind'])
      if (message.source.kind !== 'user') reject()
    }
  }
  return input
}
function generation(body, provider, signal) {
  keys(body, ['config', 'messages', 'prompt', 'system', 'stream', 'maxTokens', 'timeoutMs', 'reasoningEffort'])
  if (body.stream !== undefined && typeof body.stream !== 'boolean') reject()
  if (body.prompt !== undefined) text(body.prompt)
  if (body.system !== undefined) text(body.system, 32768, true)
  if (body.reasoningEffort !== undefined) {
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoningEffort)) reject()
  }
  return { provider: provider.id, model: body.config.model, messages: history(body.messages, body.prompt, provider.id, body.config.model),
    ...(body.system === undefined ? {} : { system: body.system }),
    ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
    maxTokens: integer(body.maxTokens, 131072, 1024), timeoutMs: integer(body.timeoutMs, 300000, 60000), signal }
}
async function readJson(request) {
  if (Number(request.headers['content-length']) > BODY_LIMIT) reject(413, 'BODY_TOO_LARGE')
  const chunks = []
  let size = 0
  // Do not destroy the socket on an oversized body: a useful 413 must still reach the caller.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > BODY_LIMIT) { request.resume(); reject(413, 'BODY_TOO_LARGE') }
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { reject(400, 'INVALID_JSON') }
  validateJson(value)
  if (!record(value)) reject()
  return value
}
function securityHeaders(response) {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('cross-origin-resource-policy', 'same-origin')
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
}
function guard(request) {
  const port = request.socket.localPort
  const host = request.headers.host
  const expected = [`127.0.0.1:${port}`, `localhost:${port}`]
  const remote = request.socket.remoteAddress
  if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(remote) || !expected.includes(host)) reject(403, 'HOST_REJECTED')
  if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length !== 1) reject(403, 'HOST_REJECTED')
  if (!['GET', 'POST'].includes(request.method)) reject(405, 'METHOD_NOT_ALLOWED')
  // Header credentials are refused because they could be mistaken for the caller's
  // model key. Cookies are not on this list: a browser shares them across every port
  // of one host, so refusing them locks the playground behind any other local web app,
  // and no cookie can reach a provider — every credential comes from the request body.
  const ambient = AMBIENT_CREDENTIAL_HEADERS.filter(name => request.headers[name] !== undefined)
  if (ambient.length > 0) reject(400, 'AMBIENT_CREDENTIALS_REJECTED', ambient)
  if (request.method === 'POST') {
    if (request.headers.origin !== `http://${host}` || request.headers['x-model-sdk-playground'] !== '1' ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) reject(403, 'ORIGIN_REJECTED')
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) reject(415, 'JSON_REQUIRED')
  }
}
function json(response, status, value) {
  if (response.destroyed) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
function secretRedactor(config) {
  const raw = config.apiKey?.trim()
  const secrets = raw ? [...new Set([config.apiKey, raw, encodeURIComponent(raw), Buffer.from(raw).toString('base64'), Buffer.from(raw).toString('base64url')])].sort((a, b) => b.length - a.length) : []
  return value => secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), String(value))
}
function safeFailure(failure, redact) {
  const code = typeof failure?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'MODEL_ERROR'
  // A provider can echo bodies or stack traces; never transport arbitrary error messages/causes.
  return { code, message: `Model request failed (${code})`,
    ...(Number.isInteger(failure?.status) ? { status: failure.status } : {}),
    ...(Number.isFinite(failure?.providerRetryAfterMs) ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {}),
    ...(failure?.requestId ? { requestId: redact(failure.requestId).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) } : {}) }
}
function safeFinish(reason, redact) {
  return ['error', 'aborted'].includes(reason.kind) ? { ...reason, failure: safeFailure(reason.failure, redact) } : reason
}
async function writeLine(response, value, signal) {
  signal.throwIfAborted()
  if (!response.write(JSON.stringify(value) + '\n')) await once(response, 'drain', { signal })
}
async function generate(body, config, response, signal) {
  const provider = makeProvider(config)
  const runtime = new ModelRuntime()
  runtime.register(provider)
  const options = generation(body, provider, signal)
  const redact = secretRedactor(config)
  // The exact chunks sent to the browser feed the SDK's canonical assembler. Never generate twice.
  async function* stream() {
    for await (const original of runtime.stream(options)) {
      const chunk = original.type === 'finish' ? { ...original, reason: safeFinish(original.reason, redact) } : original
      if (body.stream) await writeLine(response, chunk, signal)
      yield chunk
    }
  }
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
    await writeLine(response, { type: 'start' }, signal)
  }
  const result = await assemble(stream(), { kind: 'model', provider: provider.id, model: config.model })
  if (body.stream) { await writeLine(response, { type: 'result', result }, signal); response.end() }
  else json(response, 200, result)
}
async function discover(body, config, signal) {
  keys(body, ['config'])
  let models
  if (config.mode === 'custom') {
    models = await discoverModels({ api: config.protocol, baseURL: config.baseURL, apiKey: config.apiKey, signal, timeoutMs: 15000, maxResponseBytes: 1024 * 1024 })
  } else models = await makeProvider(config).discoverModels({ signal, timeoutMs: 15000, maxResponseBytes: 1024 * 1024 })
  return { models: models.map(({ id, name, inputModalities }) => ({ id, ...(name ? { name } : {}), ...(inputModalities ? { inputModalities } : {}) })) }
}
async function embed(body, config, signal) {
  keys(body, ['config', 'input', 'dimensions', 'timeoutMs'])
  if (!Array.isArray(body.input) || !body.input.length || body.input.length > 64) reject()
  body.input.forEach(value => text(value))
  if (!config.baseURL) reject()
  const adapter = createOpenAIEmbeddingAdapter({ baseURL: config.baseURL, model: config.model, apiKey: config.apiKey,
    dimensions: integer(body.dimensions, 65536, undefined), timeoutMs: integer(body.timeoutMs, 300000, 60000), maxResponseBytes: 8 * 1024 * 1024 })
  const result = await adapter.embed(body.input, { signal })
  return { model: result.model, vectors: result.embeddings.map((vector, index) => ({ index, dimensions: vector.length, preview: vector.slice(0, 8) })), ...(result.usage ? { usage: result.usage } : {}) }
}

/** No listen or network call occurs at import. Only an exact static whitelist can read disk. */
export function createPlaygroundHandler() {
  return async function handle(request, response) {
    securityHeaders(response)
    const controller = new AbortController()
    const abort = () => { if (!response.writableFinished) controller.abort() }
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      guard(request)
      const path = request.url
      const knownApi = ['/api/catalog', '/api/generate', '/api/discover', '/api/embed'].includes(path)
      if (!knownApi && !STATIC.has(path)) reject(404, 'NOT_FOUND')
      const expected = path === '/api/catalog' || STATIC.has(path) ? 'GET' : 'POST'
      if (request.method !== expected) reject(405, 'METHOD_NOT_ALLOWED')
      if (STATIC.has(path)) {
        const [name, type] = STATIC.get(path)
        const bytes = await readFile(new URL(`./public/${name}`, import.meta.url))
        response.writeHead(200, { 'content-type': type }); response.end(bytes)
      } else if (path === '/api/catalog') {
        json(response, 200, { providers: catalogProviders().map(id => ({ id, models: catalogModels(id).map(model => ({
          id: model.id, name: model.name, inputModalities: [...model.input], reasoning: model.reasoning,
        })) })), protocols: PROTOCOLS })
      } else {
        const body = await readJson(request)
        const config = configuration(body.config, { model: path !== '/api/discover' })
        if (path === '/api/generate') await generate(body, config, response, controller.signal)
        else if (path === '/api/discover') json(response, 200, await discover(body, config, controller.signal))
        else json(response, 200, await embed(body, config, controller.signal))
      }
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof RequestError ? error.status : 502,
        { error: { code: error instanceof RequestError ? error.code : 'SDK_REQUEST_FAILED', message: error instanceof RequestError ? error.code : 'SDK request failed; check endpoint, credentials and model configuration.',
          // Names only: a browser needs to know which header to look at, never its value.
          ...(error instanceof RequestError && Array.isArray(error.headers) && error.headers.length > 0 ? { rejectedHeaders: error.headers } : {}) } })
      else if (!response.destroyed) response.end()
    } finally {
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
    }
  }
}
function portNumber(value = process.env.MODEL_SDK_PLAYGROUND_PORT ?? 4318) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid playground port')
  return port
}
/** Returns an unstarted node:http Server; listen() defaults to the configured loopback port. */
export function createPlaygroundServer({ port } = {}) {
  const configured = portNumber(port)
  const server = createServer(createPlaygroundHandler())
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.maxRequestsPerSocket = 100
  const listen = server.listen.bind(server)
  server.listen = (value = configured, host, callback) => {
    if (typeof host === 'function') { callback = host; host = undefined }
    if (host !== undefined && host !== '127.0.0.1') throw new Error('Playground listens only on 127.0.0.1')
    if (typeof value !== 'number') throw new Error('Playground listen requires a TCP port')
    return listen(portNumber(value), '127.0.0.1', callback)
  }
  return server
}
const isCLI = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isCLI) {
  try {
    const server = createPlaygroundServer()
    server.on('error', () => { console.error('Playground could not start; check the loopback port.'); process.exitCode = 1 })
    server.listen(undefined, () => {
      console.log(`Model SDK playground: http://127.0.0.1:${server.address().port}`)
    })
  } catch { console.error('Playground could not start; check MODEL_SDK_PLAYGROUND_PORT.'); process.exitCode = 1 }
}
