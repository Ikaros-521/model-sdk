# Standalone Model SDK

A single MIT npm package for Node.js 22.19+ and TypeScript. It contains the mature DeepSeek Harness message/stream/replay conversions and pi-ai **exactly 1.3.0**, with the Harness patch bundled in the published artifact. It does not import the AI Employee OS application, Cordis, settings, sessions, a database, or a tool executor. Original source and commit are recorded in [NOTICE](./NOTICE).

```sh
npm install @ai-employee/model-sdk
```

Runnable CLI examples for text, stream, tools, reasoning/replay, images, embeddings, discovery, cancellation and retry are in [examples/README.md](./examples/README.md). `node examples/run.mjs --check` checks imports offline without calling a model.

## Local browser playground

Run `npm run build` then `npm run playground` and open <http://127.0.0.1:4318>. The [local test UI](./playground/README.md) supports provider/custom endpoint configuration, model discovery, streaming/non-streaming chat, cancellation, token usage and diagnostics. Keys stay in page memory and are never persisted by the local server. It is loopback-only and must not be exposed as a public service.

ESM entry points are isolated:

| Import | Purpose |
| --- | --- |
| `@ai-employee/model-sdk` or `/core` | Runtime, message factories, chunks, assembler, failure vocabulary; no provider implementation imported |
| `/providers/pi-ai` | Catalog/native providers and explicit custom protocols |
| `/providers/deepseek` | DeepSeek Messages protocol, image Files API upload/cache/fallback |
| `/auth` | API key/native credential ports, immutable secret snapshots, OAuth token refresh/store |
| `/auth/oauth` | pi-ai OAuth compatibility types; actual login flows belong to native provider implementations |
| `/attachments` | Image references, in-memory image bytes, optional host storage port |
| `/embeddings` | Independent OpenAI-compatible embedding client |
| `/retry` | Opt-in bounded retry decorator |

## Text and streaming

Minimal use requires only a provider key. Choose a model from the installed catalog; use your provider's current model id.

```ts
import { ModelRuntime } from '@ai-employee/model-sdk'
import { createPiAiProvider, catalogModels } from '@ai-employee/model-sdk/providers/pi-ai'

const runtime = new ModelRuntime()
const provider = createPiAiProvider({
  catalogProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
})
runtime.register(provider)
const model = catalogModels('openai')[0]!.id
const request = {
  provider: 'openai', model,
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
  timeoutMs: 60_000,
  idleTimeoutMs: 20_000,
}
const result = await runtime.generate(request)
console.log(result.text, result.usage, result.finish)

for await (const chunk of runtime.stream(request)) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
  if (chunk.type === 'reasoning-delta') console.log('reasoning:', chunk.text)
  if (chunk.type === 'finish') console.log(chunk.reason)
}
```

`generate()` consumes exactly the runtime's stream through the same Harness `BlockAssembler`. It returns `{message,text,usage,finish}`. Provider errors, missing terminal events, cancellation and timeout become a single `finish` with `error` or `aborted`; inspect the terminal reason rather than assuming an empty result succeeded. Setup failures from an explicit `prepareCall()` reject its promise. HTTP status, opaque request id and Retry-After survive when exposed by the native transport. Credentials are redacted from provider failures.

`inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens` are disjoint: input excludes cached reads/writes, reasoning is already within output. Keep provider `totalTokens` as reported; do not add cache counts to a provider-inclusive input again.

## Native tools, host results and replay

SDK tools are JSON-schema declarations. Your application validates arguments, authorizes and executes tools, then appends results. There is no automatic execution or embedded business prompt.

```ts
import { createToolResultMessage, type RequestMessage } from '@ai-employee/model-sdk/core'

const tools = [{ name: 'lookup', description: 'Look up a record',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }]
const first = await runtime.generate({ ...request, tools })
const history: RequestMessage[] = [...request.messages, first.message]
for (const block of first.message.content) {
  if (block.type !== 'tool-call') continue
  const args = JSON.parse(block.arguments) // validate/authorize in your application
  const hostResult = { id: args.id, status: 'available' } // your tool's actual result
  history.push(createToolResultMessage({ callId: block.id,
    content: [{ type: 'text', text: JSON.stringify(hostResult) }] }))
}
const next = await runtime.generate({ ...request, messages: history, tools })
```

The returned assistant message contains opaque `source.replayState`: signed/encrypted reasoning, native text/tool signatures, response ids and block metadata. Persist the **whole message** as JSON and return it unchanged in future history. Display `reasoning` blocks without reconstructing native signatures from their text. Interrupted calls expose text/reasoning only and never executable partial tool calls. Max-token completion prunes incomplete tool calls with matching replay metadata.

For A → B → A, keep the same history and change the request's `provider`/`model`. The adapter projects foreign messages for B without overwriting original A envelopes. Returning to A restores usable native replay metadata. Unsupported or stale replay versions degrade through provider-neutral content and can be observed with `onReplayDegrade`. `toolHistory`, developer `tool-addition`/`tool-removal` events and model compatibility metadata preserve supported native declaration updates.

## Custom endpoints and discovery

```ts
import { createPiAiProvider, defineModel, catalogProviders } from '@ai-employee/model-sdk/providers/pi-ai'

const baseURL = 'http://127.0.0.1:8080/v1'
const local = createPiAiProvider({ id: 'local', api: 'openai-completions', baseURL,
  apiKey: 'local-key', models: [defineModel({ id: 'my-model', api: 'openai-completions', baseUrl: baseURL })] })
runtime.register(local)
console.log(catalogProviders())                     // installed offline catalog
console.log(await runtime.listModels('local'))       // configured offline models
console.log(await runtime.resolveModel('local', 'my-model'))
console.log(await local.discoverModels({ timeoutMs: 5000 })) // explicit network listing
```

Custom protocols: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`. Native catalog providers retain their own APIs and authentication, including native AWS/Vertex/OAuth ports when supplied. Catalog availability is metadata, not evidence of a live-service test. Custom `defineModel` defaults to text input, no reasoning and configured placeholder capacities/pricing; supply exact model metadata for production. Discovered unknown models do not silently become executable model configurations.

Endpoint discovery reads one bounded page (up to 1000 requested items for Anthropic/Google), uses protocol-specific authentication, rejects redirects, bounds response bytes and has a total deadline. Google defaults to `/v1beta/models`; Anthropic uses `/v1/models`. The installed Google/Vertex SDK cannot inject a custom `fetch` for inference; those routes use the SDK's native HTTP client and explicitly reject unsupported custom-fetch options. Other transports expose their own native capabilities. HTTP response facts and redirect behavior remain native when the upstream SDK does not provide hooks.

## Images and DeepSeek Files API

```ts
import { readFile } from 'node:fs/promises'
import { MemoryAttachmentStore } from '@ai-employee/model-sdk/attachments'
import { createDeepSeekProvider } from '@ai-employee/model-sdk/providers/deepseek'

const images = new MemoryAttachmentStore()
const image = images.addImage({ data: await readFile('picture.png'),
  mediaType: 'image/png', width: 640, height: 480 })
const deepseek = createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY!,
  attachments: images, files: { enabled: true } })
runtime.register(deepseek)
const answer = await runtime.generate({ provider: 'deepseek', model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe this image' }, { type: 'image', attachment: image },
  ] }], timeoutMs: 60_000 })
```

Image input requires an image-capable configured model. `MemoryAttachmentStore` copies bytes and verifies reference consistency but does not decode/resize/validate claimed dimensions or transcode images. Supply correctly encoded, prepared images within route budgets. A host needing durable storage or resizing implements only `AttachmentStore.readImageRequest(ref,target,signal)` and may provide an access-path resolver.

DeepSeek uploads prepared image variants through its Files API. The per-provider in-memory cache includes endpoint, credential scope, credential identity, variant and expiry. Concurrent equivalent uploads coalesce; expiry refreshes; quota errors or rejected/deleted file ids use bounded inline fallback. `files: {enabled:false}` selects inline images. No shared home directory or platform database is touched. General file blocks project to textual file handles; the SDK does not claim arbitrary PDF/office/audio/video native input or output support.

## API keys, native auth and OAuth ports

```ts
import { MemoryOAuthTokenStore, createOAuthCredentialResolver } from '@ai-employee/model-sdk/auth'

const store = new MemoryOAuthTokenStore()
const apiKey = createOAuthCredentialResolver({ store,
  refresh: async (oldTokens, scope) => {
    // Run your authorized provider token refresh and return accessToken/expiresAt.
    return refreshThroughYourOAuthClient(oldTokens, scope)
  } })
const authenticated = createPiAiProvider({ catalogProvider: 'openai',
  apiKey, authScope: 'account-42' })
```

Initialize a token store with your authorized login result before using its resolver. `withLock` encloses the full refresh transaction so concurrent callers cannot double-use rotated refresh tokens. In-memory storage is the default convenience, not durable persistence. Credential resolver context is `{route,provider,scope,signal}`; native auth resolvers may return `{apiKey,headers}`. Explicit missing or invalid keys fail instead of silently falling back to ambient credentials. Secret snapshots do not expose secret fields through JSON or inspection.

For full provider-native auth, pass pi-ai `auth: {credentials,authContext}` ports on a catalog provider, or supply `nativeAuth`. The SDK does not implement a generic browser OAuth authorization flow; provider login methods and application UI/consent belong to the host. No login was performed during fixture testing.

## Cancellation, prepared calls and retries

```ts
import { withRetry } from '@ai-employee/model-sdk/retry'
const dispose = runtime.register(withRetry(local, { maxRetries: 2,
  initialDelayMs: 250, maxDelayMs: 5000, jitterRatio: 0.2 }))
const cancel = new AbortController()
const prepared = await runtime.prepareCall({ ...request, signal: cancel.signal, timeoutMs: 30000 })
// Routing generation, request data, credential and headers are captured once.
const pending = prepared.generate()
cancel.abort()
const cancelled = await pending
dispose() // unregisters only this registration; cannot dispose a later replacement
```

A prepared call dispatches once. Replacing a registry entry affects subsequent preparations; an in-flight snapshot keeps its original provider/configuration. Total timeout covers preparation through stream completion. A prepared call's deadline continues while it waits to dispatch. Idle timeout means **time without an SDK output chunk**, including a pending first chunk; raw SSE comments/heartbeats are not output. Cancellation settles promptly even when an injected provider ignores its signal. Stopping iteration aborts the transport.

Retries are disabled by default (native SDK retry count is zero). `withRetry` retries selected transient failures only before exposing text, reasoning, tool deltas or completed content. It never repeats an exposed partial response. Retry-After is respected; a delay above the configured maximum returns the error instead of shortening the server's wait. All attempts remain inside the runtime deadline/cancellation.

## Embeddings

```ts
import { createOpenAIEmbeddingAdapter } from '@ai-employee/model-sdk/embeddings'
const embeddings = createOpenAIEmbeddingAdapter({
  baseURL: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', dimensions: 1536, batchSize: 64, timeoutMs: 30000,
})
const vectors = await embeddings.embed(['first', 'second'], { signal: cancel.signal })
console.log(vectors)
```

Embeddings have their own HTTP implementation and error type. They restore response index ordering, reject missing/duplicate/out-of-range rows and non-finite/wrong-dimension vectors, batch input and aggregate usage. They do not route embedding models through the chat API.

## Build and verification

From this directory, independently of the parent workspace:

```sh
npm install --workspaces=false
npm run build
npm test
npm run test:consumer
npm pack
```

`build`/`prepack` verify and apply the original six-file Harness patch against exact pi-ai 1.3.0. `bundleDependencies` ships the complete patched published SDK and its runtime dependencies; consumers can install with `--ignore-scripts` and require no pnpm patch configuration. The installed dependency hashes are recorded in `dist/pi-ai-patch-manifest.json`.

Tests include migrated Harness pure-core/context/replay/property tests, real local HTTP fixtures for Completions/Responses/Messages/Google, native tool round trips, all twelve A → B → A protocol combinations, final-only tool-argument parsing, malformed/EOF/timeout/cancellation cases, Files upload caching/fallback, auth refresh locking and independent embeddings. `test:consumer` packs, installs into an OS temporary directory outside the repository, verifies all six installed patch hashes, imports core with pi-ai temporarily unavailable, type-checks every public subpath and performs actual local HTTP text/embedding calls. No real external model request is made. Catalog coverage and fixture coverage must be reported separately from live provider/account validation.
