import { inspect } from 'node:util'
export type {
  OAuthAuthInfo, OAuthCredentials, OAuthDeviceCodeInfo, OAuthLoginCallbacks,
  OAuthPrompt, OAuthSelectOption, OAuthSelectPrompt,
} from './oauth.js'

/** All credential lookups require an explicit route, provider and caller-owned scope. */
export interface AuthScope {
  readonly route: string
  readonly provider: string
  readonly scope: string
}
export interface CredentialContext extends AuthScope { readonly signal?: AbortSignal }
export type CredentialResolver = (context: CredentialContext) => Promise<string | null | undefined>
export type CredentialSource = string | CredentialResolver
export type AuthErrorCode = 'AUTH_SCOPE_INVALID' | 'AUTH_CREDENTIAL_MISSING' | 'AUTH_CREDENTIAL_INVALID' | 'AUTH_RESOLVER_FAILED' | 'AUTH_ABORTED' | 'AUTH_REFRESH_FAILED' | 'AUTH_STORE_FAILED' | 'AUTH_NATIVE_INVALID'

/** Messages and diagnostic fields never contain resolver errors, abort reasons or credentials. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code)
    this.name = 'AuthError'
  }
}

export interface CredentialSnapshot extends AuthScope {
  readonly kind: 'api-key' | 'oauth' | 'native'
  readonly resolvedAt: number
  /** Secret: explicitly read to pass to transport. Omitted from JSON and inspection. */
  readonly apiKey: string
}
export interface NativeAuthMaterial {
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
}
export interface NativeAuthSnapshot extends AuthScope {
  readonly kind: 'native'
  readonly resolvedAt: number
  readonly apiKey?: string
  readonly headers: Readonly<Record<string, string>>
}
export type NativeAuthResolver = (context: CredentialContext) => Promise<NativeAuthMaterial | null | undefined>

function binding(context: AuthScope): Readonly<AuthScope> {
  if (!context || [context.route, context.provider, context.scope].some(v => typeof v !== 'string' || !v.trim())) {
    throw new AuthError('AUTH_SCOPE_INVALID')
  }
  return Object.freeze({ route: context.route, provider: context.provider, scope: context.scope })
}
function secret(value: unknown): string {
  if (value == null || value === '') throw new AuthError('AUTH_CREDENTIAL_MISSING')
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value.trim())) {
    throw new AuthError(typeof value === 'string' && !value.trim() ? 'AUTH_CREDENTIAL_MISSING' : 'AUTH_CREDENTIAL_INVALID')
  }
  return value.trim()
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthError('AUTH_ABORTED')
}
/** Cancellation is local to this waiter, and never retains or forwards an abort reason. */
function wait<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new AuthError('AUTH_ABORTED')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
function snapshot<T extends object>(metadata: T, secrets: object): Readonly<T & typeof secrets> {
  const result = { ...metadata }
  for (const [key, value] of Object.entries(secrets)) Object.defineProperty(result, key, { value, enumerable: false })
  Object.defineProperty(result, inspect.custom, { value: () => ({ ...metadata, credentials: '[REDACTED]' }) })
  return Object.freeze(result) as Readonly<T & typeof secrets>
}

/** Never reads environment variables, home directories or provider ambient auth. */
export async function resolveApiKey(source: CredentialSource, context: CredentialContext): Promise<CredentialSnapshot> {
  const scope = binding(context)
  checkAbort(context.signal)
  let value: unknown
  try {
    value = typeof source === 'function'
      ? await wait(Promise.resolve().then(() => source(Object.freeze({ ...scope, signal: context.signal }))), context.signal)
      : source
  } catch {
    if (context.signal?.aborted) throw new AuthError('AUTH_ABORTED')
    throw new AuthError('AUTH_RESOLVER_FAILED')
  }
  checkAbort(context.signal)
  return snapshot({ ...scope, kind: 'api-key' as const, resolvedAt: Date.now() }, { apiKey: secret(value) }) as CredentialSnapshot
}

/** Native provider auth is injected explicitly; the SDK does not discover credentials. */
export async function resolveNativeAuth(resolver: NativeAuthResolver, context: CredentialContext): Promise<NativeAuthSnapshot> {
  const scope = binding(context)
  checkAbort(context.signal)
  let material: NativeAuthMaterial | null | undefined
  try {
    material = await wait(Promise.resolve().then(() => resolver(Object.freeze({ ...scope, signal: context.signal }))), context.signal)
  } catch {
    throw new AuthError(context.signal?.aborted ? 'AUTH_ABORTED' : 'AUTH_RESOLVER_FAILED')
  }
  checkAbort(context.signal)
  if (!material || typeof material !== 'object') throw new AuthError('AUTH_CREDENTIAL_MISSING')
  const headers: Record<string, string> = Object.create(null)
  try {
    for (const [key, value] of Object.entries(material.headers ?? {})) {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || typeof value !== 'string' || /[^\x20-\x7e\t]/.test(value)) {
        throw new AuthError('AUTH_NATIVE_INVALID')
      }
      const normalized = key.toLowerCase()
      if (normalized in headers) throw new AuthError('AUTH_NATIVE_INVALID')
      headers[normalized] = value
    }
    const apiKey = material.apiKey === undefined ? undefined : secret(material.apiKey)
    if (!apiKey && !Object.keys(headers).length) throw new AuthError('AUTH_CREDENTIAL_MISSING')
    return snapshot({ ...scope, kind: 'native' as const, resolvedAt: Date.now() }, { apiKey, headers: Object.freeze(headers) }) as NativeAuthSnapshot
  } catch {
    throw new AuthError('AUTH_NATIVE_INVALID')
  }
}

export interface OAuthTokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  /** Unix epoch milliseconds. Missing means no known expiration. */
  readonly expiresAt?: number
}
export interface OAuthTokenTransaction {
  get(): Promise<OAuthTokenSet | undefined>
  set(tokens: OAuthTokenSet): Promise<void>
  delete(): Promise<void>
}
/** Implementations must hold the exclusive lock until the entire async operation settles.
 * Transaction handles must not escape the callback; calls for one scope are serialized.
 * A failed set must leave the previous stored value intact. */
export interface OAuthTokenStore {
  withLock<T>(scope: AuthScope, operation: (transaction: OAuthTokenTransaction) => Promise<T>): Promise<T>
}
function tokens(value: OAuthTokenSet): OAuthTokenSet {
  if (!value || typeof value !== 'object') throw new AuthError('AUTH_CREDENTIAL_INVALID')
  const accessToken = secret(value.accessToken)
  const refreshToken = value.refreshToken === undefined ? undefined : secret(value.refreshToken)
  if (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt < 0)) throw new AuthError('AUTH_CREDENTIAL_INVALID')
  return Object.freeze({ accessToken, ...(refreshToken === undefined ? {} : { refreshToken }), ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }) })
}

/** Process-local store. Independent instances intentionally do not share credentials. */
export class MemoryOAuthTokenStore implements OAuthTokenStore {
  #values = new Map<string, OAuthTokenSet>()
  #tails = new Map<string, Promise<void>>()
  async withLock<T>(scope: AuthScope, operation: (transaction: OAuthTokenTransaction) => Promise<T>): Promise<T> {
    const checked = binding(scope)
    const key = JSON.stringify([checked.route, checked.provider, checked.scope])
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    this.#tails.set(key, tail)
    await previous
    let active = true
    const assertActive = () => { if (!active) throw new AuthError('AUTH_STORE_FAILED') }
    try {
      return await operation({
        get: async () => { assertActive(); const value = this.#values.get(key); return value ? tokens(value) : undefined },
        set: async value => { assertActive(); const copy = tokens(value); this.#values.set(key, copy) },
        delete: async () => { assertActive(); this.#values.delete(key) },
      })
    } finally {
      active = false
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
  [inspect.custom]() { return { type: 'MemoryOAuthTokenStore', credentials: '[REDACTED]' } }
}
export interface OAuthCredentialOptions {
  readonly store: OAuthTokenStore
  /** Shared refresh deliberately receives no individual caller's AbortSignal. */
  readonly refresh: (previous: OAuthTokenSet, scope: AuthScope) => Promise<OAuthTokenSet>
  readonly clock?: () => number
  readonly refreshSkewMs?: number
}

/** Rechecks the store inside the lock, so concurrent callers refresh only once.
 * Refresh failure never deletes or mutates the old store. Successful refresh is saved even
 * when a waiting caller cancels: rotated refresh tokens must not be lost. */
export function createOAuthCredentialResolver(options: OAuthCredentialOptions): CredentialResolver {
  const skew = options.refreshSkewMs ?? 30_000
  if (!Number.isFinite(skew) || skew < 0) throw new AuthError('AUTH_CREDENTIAL_INVALID')
  return async context => {
    const scope = binding(context)
    checkAbort(context.signal)
    const operation = Promise.resolve().then(() => options.store.withLock(scope, async transaction => {
      const previous = await transaction.get()
      if (!previous) throw new AuthError('AUTH_CREDENTIAL_MISSING')
      const old = tokens(previous)
      const now = (options.clock ?? Date.now)()
      if (!Number.isFinite(now)) throw new AuthError('AUTH_CREDENTIAL_INVALID')
      if (old.expiresAt === undefined || old.expiresAt > now + skew) return old.accessToken
      if (!old.refreshToken) throw new AuthError('AUTH_CREDENTIAL_MISSING')
      let next: OAuthTokenSet
      try {
        const refreshed = tokens(await options.refresh(old, scope))
        // Providers may omit an unchanged refresh token; an explicit empty token is rejected.
        next = tokens({ ...refreshed, refreshToken: refreshed.refreshToken ?? old.refreshToken })
        if (next.expiresAt !== undefined && next.expiresAt <= (options.clock ?? Date.now)()) throw new AuthError('AUTH_REFRESH_FAILED')
      } catch {
        throw new AuthError('AUTH_REFRESH_FAILED')
      }
      await transaction.set(next)
      return next.accessToken
    })).catch(error => {
      // Never propagate arbitrary store/network messages, including their causes.
      if (error instanceof AuthError && ['AUTH_CREDENTIAL_MISSING', 'AUTH_CREDENTIAL_INVALID', 'AUTH_REFRESH_FAILED'].includes(error.code)) {
        throw new AuthError(error.code)
      }
      throw new AuthError('AUTH_STORE_FAILED')
    })
    return wait(operation, context.signal)
  }
}

export async function resolveOAuthCredential(resolver: CredentialResolver, context: CredentialContext): Promise<CredentialSnapshot> {
  const resolved = await resolveApiKey(resolver, context)
  return snapshot({ ...binding(context), kind: 'oauth' as const, resolvedAt: resolved.resolvedAt }, { apiKey: resolved.apiKey }) as CredentialSnapshot
}
