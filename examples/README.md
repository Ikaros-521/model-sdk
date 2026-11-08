# Runnable SDK examples

Run `npm ci --workspaces=false` and `npm run build` from the SDK directory. Then run:

```sh
node examples/run.mjs --check
node examples/run.mjs --help
```

`--check` resolves the SDK public imports without credentials or network calls. The other modes below call the model service you configure (except `cancel`, which demonstrates a pre-aborted request). They may incur provider charges. Never put keys in this repository.

Set `MODEL_PROVIDER` to an installed catalog provider (default `openai`), `MODEL_ID` to an exact model id, and `MODEL_API_KEY` to its credential. Use your shell's environment-variable syntax. The SDK itself accepts direct strings and async credential resolvers; reading these environment variables is an example-host choice.

| Command | Demonstrates |
| --- | --- |
| `node examples/run.mjs text` | Full response and terminal status |
| `node examples/run.mjs stream` | Async text deltas and finish event |
| `node examples/run.mjs tools` | Native tool calls, strict example-host validation, result IDs, bounded four-step loop |
| `node examples/run.mjs reasoning` | Reasoning-capable model; optional `MODEL_REASONING_EFFORT` defaults to `high` |
| `node examples/run.mjs replay` | JSON persistence and A→B→A replay; also requires `MODEL_B_PROVIDER`, `MODEL_B_ID`, `MODEL_B_API_KEY` |
| `node examples/run.mjs custom` | Custom endpoint; requires `MODEL_BASE_URL`, optional `MODEL_PROTOCOL` |
| `node examples/run.mjs discovery` | Configured models, resolved capabilities, explicit endpoint discovery |
| `node examples/run.mjs image` | Catalog or custom image-capable model with an explicit attachment store |
| `node examples/run.mjs deepseek-image` | DeepSeek official Messages/Files image upload path |
| `node examples/run.mjs embedding` | Independent embedding request and dimensions |
| `node examples/run.mjs cancel` | Pre-aborted call, zero inference request |
| `node examples/run.mjs retry` | Explicit bounded retry, no transparent replay of exposed partial content |

Custom protocols are `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`. For replay's B endpoint, equivalent `MODEL_B_BASE_URL` / `MODEL_B_PROTOCOL` variables are available. Example custom-model metadata is illustrative; supply accurate image/reasoning/token capabilities for your server.

Image modes require `IMAGE_PATH`, `IMAGE_WIDTH`, and `IMAGE_HEIGHT` matching the actual encoded file; `IMAGE_MEDIA_TYPE` defaults to `image/png`. The in-memory attachment store does not decode, resize or verify those dimensions.

Embedding uses `MODEL_API_KEY`, optional `EMBEDDING_BASE_URL` (default OpenAI `/v1`), `EMBEDDING_MODEL` (default `text-embedding-3-small`) and optional `EMBEDDING_DIMENSIONS`.

Inspect `result.finish` before adopting results. These examples intentionally execute only a small local time-reading tool; applications own tool authorization, execution and persistence. `npm run test:consumer` performs offline HTTP-fixture verification against the packed artifact without contacting real model services. See the package README for OAuth ports, Google custom-fetch restrictions, output-chunk idle semantics, one-page discovery and in-memory cache limits.
