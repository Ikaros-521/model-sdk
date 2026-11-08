import type { Api, Model } from '@earendil-works/pi-ai'
import type { LlmResolvedModelInfo } from '../../core/index.js'

/**
 * Resolve transcript update modes from the exact model's protocol capabilities.
 * @param model - Materialized pi-ai model, including catalog compatibility flags.
 * @returns Update modes consumed by prompt admission and tool-history projection.
 */
export function conversationUpdates(model: Model<Api>): Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'toolUpdate'> {
  const compat = model.compat
  if (compat === undefined || !('supportsMidConvoSystemMessages' in compat)
    || !compat.supportsMidConvoSystemMessages) return {}
  const updates: Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'toolUpdate'> = { systemPromptUpdate: 'in-history' }
  if (model.api === 'anthropic-messages'
    && 'supportsMidConvoToolChanges' in compat && compat.supportsMidConvoToolChanges) {
    updates.toolUpdate = 'in-history'
  } else if (model.api === 'openai-completions'
    && 'supportsMidConvoToolAdditions' in compat && compat.supportsMidConvoToolAdditions) {
    updates.toolUpdate = 'addition-only'
  } else if ((model.api === 'openai-responses' || model.api === 'azure-openai-responses' || model.api === 'openai-codex-responses')
    && (('supportsAdditionalTools' in compat && compat.supportsAdditionalTools)
      || ('supportsToolSearch' in compat && compat.supportsToolSearch))) {
    updates.toolUpdate = 'addition-only'
  }
  return updates
}
