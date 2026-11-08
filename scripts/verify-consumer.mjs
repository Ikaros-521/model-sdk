import { mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(join(tmpdir(), 'model-sdk-consumer-'))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run through npm run test:consumer')
function runNpm(args, cwd) { return execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }) }
runNpm(['run', 'build'], root)
runNpm(['pack', '--pack-destination', temp, '--json'], root)
const tarball = (await readdir(temp)).find(name => name.endsWith('.tgz'))
assert(tarball)
await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, tarball)], temp)
const installed = join(temp, 'node_modules/@ai-employee/model-sdk')
execFileSync(process.execPath, [join(installed, 'examples/run.mjs'), '--check'], { cwd: temp, stdio: 'pipe' })
const manifest = JSON.parse(await readFile(join(installed, 'dist/pi-ai-patch-manifest.json'), 'utf8'))
const bundled = join(installed, 'node_modules/@earendil-works/pi-ai')
assert.equal(JSON.parse(await readFile(join(bundled, 'package.json'), 'utf8')).version, '1.3.0')
for (const [file, hash] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(await readFile(join(bundled, file))).digest('hex'), hash, `Installed patch mismatch ${file}`)
}
assert.equal(Object.keys(manifest.files).length, 6)
// Core remains independently loadable when the bundled provider library is absent.
await rename(bundled, bundled + '.disabled')
try {
  execFileSync(process.execPath, ['--input-type=module', '-e', "const { ModelRuntime } = await import('@ai-employee/model-sdk/core'); if (!new ModelRuntime()) process.exit(1)"], { cwd: temp, stdio: 'pipe' })
} finally { await rename(bundled + '.disabled', bundled) }
await writeFile(join(temp, 'consumer.ts'), `
import { ModelRuntime, type ModelProvider, type StreamChunk } from '@ai-employee/model-sdk/core'
import { createPiAiProvider, defineModel, catalogProviders } from '@ai-employee/model-sdk/providers/pi-ai'
import { createDeepSeekProvider } from '@ai-employee/model-sdk/providers/deepseek'
import { MemoryAttachmentStore } from '@ai-employee/model-sdk/attachments'
import { MemoryOAuthTokenStore, resolveApiKey } from '@ai-employee/model-sdk/auth'
import { createOpenAIEmbeddingAdapter } from '@ai-employee/model-sdk/embeddings'
import { withRetry } from '@ai-employee/model-sdk/retry'
import * as OAuthCompatibility from '@ai-employee/model-sdk/auth/oauth'
void OAuthCompatibility
const runtime = new ModelRuntime()
const model = defineModel({ id: 'fixture', api: 'openai-completions', baseUrl: 'http://localhost/v1' })
runtime.register(withRetry(createPiAiProvider({ id: 'local', api: 'openai-completions', apiKey: 'test', models: [model] })))
const deepseek = createDeepSeekProvider({ apiKey: 'test' })
const images = new MemoryAttachmentStore(); const tokens = new MemoryOAuthTokenStore()
const embedding = createOpenAIEmbeddingAdapter({ baseURL: 'http://localhost/v1', apiKey: 'test', model: 'fixture' })
void [runtime, deepseek, images, tokens, embedding, resolveApiKey, catalogProviders]
`)
await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', strict: true, skipLibCheck: true, noEmit: true }, files: ['consumer.ts'] }))
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(temp, 'tsconfig.json')], { cwd: temp, stdio: 'pipe' })
await writeFile(join(temp, 'fixture.mjs'), `
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ModelRuntime } from '@ai-employee/model-sdk'
import { createPiAiProvider, defineModel, catalogProviders } from '@ai-employee/model-sdk/providers/pi-ai'
import { createOpenAIEmbeddingAdapter } from '@ai-employee/model-sdk/embeddings'
let calls = 0
const server = createServer(async (req, res) => {
  const body = []; for await (const piece of req) body.push(piece)
  const payload = JSON.parse(Buffer.concat(body).toString() || '{}')
  assert.equal(req.headers.authorization, 'Bearer fixture-key')
  calls++
  if (req.url === '/v1/embeddings') {
    assert.deepEqual(payload.input, ['one'])
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.5, 1] }], usage: { prompt_tokens: 1, total_tokens: 1 } })); return
  }
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(payload.messages[0].content, 'hello')
  res.setHeader('content-type', 'text/event-stream')
  res.write('data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'packed-ok' }, finish_reason: null }] }) + '\\n\\n')
  res.write('data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\\n\\n')
  res.end('data: [DONE]\\n\\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/v1'
  const runtime = new ModelRuntime()
  runtime.register(createPiAiProvider({ id: 'packed', api: 'openai-completions', apiKey: 'fixture-key', models: [defineModel({ id: 'fixture', api: 'openai-completions', baseUrl: baseURL })] }))
  const result = await runtime.generate({ provider: 'packed', model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], timeoutMs: 5000 })
  assert.equal(result.text, 'packed-ok'); assert.equal(result.finish.kind, 'stop'); assert.equal(result.usage.totalTokens, 5)
  assert.equal(result.message.source.replayState.response.provider, 'packed')
  const embedding = await createOpenAIEmbeddingAdapter({ baseURL, apiKey: 'fixture-key', model: 'fixture', dimensions: 2 }).embed(['one'])
  assert.equal(calls, 2); assert.ok(catalogProviders().includes('openai'))
  console.log(JSON.stringify({ text: result.text, finish: result.finish.kind, calls, embedding, catalog: catalogProviders().length }))
} finally { await new Promise(resolve => server.close(resolve)) }
`)
const output = execFileSync(process.execPath, [join(temp, 'fixture.mjs')], { cwd: temp, encoding: 'utf8', maxBuffer: 1024 * 1024 })
console.log(output.trim())
console.log(JSON.stringify({ consumer: temp, tarball: join(temp, tarball), installedPatchFiles: 6, coreWithoutPiAi: true, types: 'passed', fixture: 'passed' }, null, 2))
