import type { CredentialSource } from '../../auth/index.js'
import type { AttachmentStore } from '../../attachments/index.js'
import type { ImageAttachmentAccessResolver, ModelProvider, LlmModelInfo, ModelModality, SystemPromptUpdate, ToolUpdate } from '../../core/index.js'
import type { DeepSeekFilePolicy } from './file-store.js'

export interface DeepSeekModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ModelModality[]
  imagePixelBudget?: number | 'low'
  imageMaxBytes?: number
  systemPromptUpdate?: SystemPromptUpdate
  toolUpdate?: ToolUpdate
}
export type DeepSeekCatalogModel = DeepSeekModel
export interface DeepSeekProviderOptions {
  id?: string
  /** Explicit API key or caller-owned auth resolver. No ambient credentials are read. */
  apiKey: CredentialSource
  authScope?: string
  baseURL?: string
  attachments?: AttachmentStore
  resolveImageAccess?: ImageAttachmentAccessResolver
  models?: readonly DeepSeekModel[]
  maxTokens?: number
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  files?: { enabled?: boolean; expiresAfterSeconds?: number; timeoutMs?: number; refreshMarginSeconds?: number }
  maxRequestFilesBytes?: number
  maxInlineRequestImageBytes?: number
  maxImagesPerRequest?: number
  discoveryTimeoutMs?: number
  fetch?: typeof fetch
  onReplayDegrade?: (reason: string) => void
}
export interface DeepSeekConnectionOptions {
  baseURL: string
  models: readonly DeepSeekModel[]
  defaults: Pick<DeepSeekProviderOptions, 'thinking' | 'reasoningEffort'>
  maxTokens: number
  maxRequestFilesBytes: number
  maxInlineRequestImageBytes: number
  maxImagesPerRequest: number
  imageOffloadByteQuantum: number
  inlineImageOffloadByteQuantum: number
  imageOffloadCountQuantum: number
  filesApiTimeoutMs: number
  filePolicy: DeepSeekFilePolicy
}
export interface DeepSeekProvider extends ModelProvider {
  /** Explicit network discovery; successful results update this instance's local catalog. */
  discoverModels(options?: { signal?: AbortSignal }): Promise<readonly LlmModelInfo[]>
}
