import type { OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import { deepFreeze } from '../../core/values.js'

/** Protocols SDK presets route through pi-ai adapters. */
export type SdkPresetProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'

export interface SdkProviderPreset {
  id: string
  api: SdkPresetProtocol
  baseUrl: string
  /** Suggested chat model IDs only, never an authoritative catalog or capability claim. */
  modelIds: readonly string[]
  /** Endpoint-level chat-completions quirks applied to every suggested model. */
  compat?: OpenAICompletionsCompat
  /** When false the endpoint has no usable /models listing; discovery returns the local list. */
  discovery?: boolean
  /** Attach Authorization Bearer alongside the protocol credential header for proxy authentication. */
  bearerAuth?: boolean
}

/** SDK-owned routes supplement, rather than alias, pi-ai's native account catalogs. */
export const sdkProviderPresets = deepFreeze<readonly SdkProviderPreset[]>([
  {
    id: 'dashscope',
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // Suggested public IDs only, not an exhaustive catalog and not an embedding/image/reasoning
    // capability claim: every entry keeps the honest text-only placeholder defaults from
    // defineModel, and callers may replace the models for their account's actual offerings.
    modelIds: ['qwen-plus', 'qwen-plus-latest', 'qwen-max', 'qwen-max-latest', 'qwen-turbo', 'qwen-turbo-latest',
      'qwen-long', 'qwen3-max', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-vl-plus', 'qwen3-omni-flash',
      'qwen2.5-7b-instruct', 'qwen2.5-14b-instruct', 'qwen2.5-32b-instruct', 'qwen2.5-72b-instruct',
      'deepseek-v3', 'deepseek-r1'],
    compat: {
      maxTokensField: 'max_tokens',
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    } satisfies OpenAICompletionsCompat,
  },
  {
    // DashScope's Claude Code compatible proxy speaks Anthropic Messages; the proxy root is the
    // Anthropic SDK baseURL (the SDK appends /v1/messages). The proxy authenticates with the same
    // key as Bearer, and does not expose a /models listing.
    id: 'dashscope-anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy',
    modelIds: ['qwen3-coder-plus', 'qwen-plus', 'qwen-max'],
    discovery: false,
    bearerAuth: true,
  },
])
