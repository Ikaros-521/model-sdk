/** pi-ai 1.3.0 exposes OAuth declaration compatibility only, not login/refresh flows.
 * Keep this type-only bridge separate from the SDK's scoped token-store contract. */
export type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectOption,
  OAuthSelectPrompt,
} from '@earendil-works/pi-ai/oauth'
