import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { test } from 'vitest'
import {
  AuthError, MemoryOAuthTokenStore, createOAuthCredentialResolver, resolveApiKey,
  resolveNativeAuth, resolveOAuthCredential,
  type AuthScope, type OAuthTokenSet, type CredentialSource,
} from '../src/auth/index.js'

const scope: AuthScope = { route: 'chat', provider: 'example', scope: 'tenant-a' }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function seed(store: MemoryOAuthTokenStore, value: OAuthTokenSet, key = scope) {
  await store.withLock(key, tx => tx.set(value))
}
async function read(store: MemoryOAuthTokenStore, key = scope) {
  return store.withLock(key, tx => tx.get())
}
const code = (expected: string) => (error: unknown) => error instanceof AuthError && error.code === expected

test('literal and async resolver receive explicit frozen binding; snapshots hide secrets from diagnostics', async () => {
  const key = 'sk-private-literal'
  const literal = await resolveApiKey(` ${key} `, scope)
  assert.equal(literal.apiKey, key)
  assert.equal(literal.scope, 'tenant-a')
  assert.ok(Object.isFrozen(literal))
  assert.ok(!JSON.stringify(literal).includes(key))
  assert.ok(!inspect(literal).includes(key))
  const resolved = await resolveApiKey(async context => {
    assert.deepEqual(context, { ...scope, signal: undefined })
    assert.ok(Object.isFrozen(context))
    return 'resolved-key'
  }, scope)
  assert.equal(resolved.apiKey, 'resolved-key')
})

test('missing, blank, invalid credentials and resolver errors reject without ambient fallback or secret diagnostics', async () => {
  const sources: unknown[] = [undefined, null, '', '   ', async () => undefined, async () => null, async () => '', async () => ' \t ']
  for (const source of sources) await assert.rejects(resolveApiKey(source as CredentialSource, scope), code('AUTH_CREDENTIAL_MISSING'))
  await assert.rejects(resolveApiKey('bad\nsecret', scope), code('AUTH_CREDENTIAL_INVALID'))
  const secret = 'sk-secret-in-upstream-error'
  await assert.rejects(resolveApiKey(async () => { throw new Error(secret, { cause: secret }) }, scope), error => {
    assert.ok(error instanceof AuthError)
    assert.ok(!inspect(error).includes(secret))
    assert.ok(!JSON.stringify(error).includes(secret))
    return error.code === 'AUTH_RESOLVER_FAILED'
  })
})

test('route provider and scope are all mandatory', async () => {
  for (const field of ['route', 'provider', 'scope'] as const) {
    await assert.rejects(resolveApiKey('key', { ...scope, [field]: '' }), code('AUTH_SCOPE_INVALID'))
  }
})

test('resolver cancellation rejects locally, discards late completion and does not contaminate another call', async () => {
  const gate = deferred<string>()
  const controller = new AbortController()
  const resolver = async () => gate.promise
  const first = resolveApiKey(resolver, { ...scope, signal: controller.signal })
  const second = resolveApiKey(resolver, scope)
  const rejection = assert.rejects(first, error => {
    assert.ok(!inspect(error).includes('abort-secret'))
    return code('AUTH_ABORTED')(error)
  })
  controller.abort(new Error('abort-secret'))
  gate.resolve('shared-key')
  await rejection
  assert.equal((await second).apiKey, 'shared-key')
  assert.equal((await resolveApiKey('later-key', scope)).apiKey, 'later-key')
})

test('pre-aborted calls do not invoke resolvers', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(resolveApiKey(async () => { calls++; return 'key' }, { ...scope, signal: controller.signal }), code('AUTH_ABORTED'))
  assert.equal(calls, 0)
})

test('concurrent OAuth calls hold the lock across network refresh and refresh exactly once', async () => {
  const store = new MemoryOAuthTokenStore()
  await seed(store, { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 10 })
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const resolver = createOAuthCredentialResolver({ store, clock: () => 100, refreshSkewMs: 0, refresh: async (previous, key) => {
    calls++
    assert.equal(previous.refreshToken, 'old-refresh')
    assert.deepEqual(key, scope)
    entered.resolve()
    await release.promise
    return { accessToken: 'fresh-access', refreshToken: 'rotated-refresh', expiresAt: 1_000 }
  } })
  const first = resolver(scope)
  await entered.promise
  const rest = Array.from({ length: 20 }, () => resolver(scope))
  let lockEntered = false
  const observer = store.withLock(scope, async () => { lockEntered = true })
  await Promise.resolve()
  assert.equal(lockEntered, false)
  assert.equal(calls, 1)
  release.resolve()
  assert.deepEqual(await Promise.all([first, ...rest]), Array(21).fill('fresh-access'))
  await observer
  assert.equal(calls, 1)
  assert.deepEqual(await read(store), { accessToken: 'fresh-access', refreshToken: 'rotated-refresh', expiresAt: 1_000 })
})

test('route, provider, and scope partition credentials and locks independently', async () => {
  const store = new MemoryOAuthTokenStore()
  const keys = [scope, { ...scope, scope: 'tenant-b' }, { ...scope, route: 'other-route' }, { ...scope, provider: 'other-provider' }]
  for (const [index, key] of keys.entries()) await seed(store, { accessToken: `key-${index}` }, key)
  const gate = deferred()
  const entered = deferred()
  const blocked = store.withLock(scope, async () => { entered.resolve(); await gate.promise })
  await entered.promise
  const resolver = createOAuthCredentialResolver({ store, refresh: async () => { throw new Error('not needed') } })
  assert.deepEqual(await Promise.all(keys.slice(1).map(key => resolver(key))), ['key-1', 'key-2', 'key-3'])
  gate.resolve()
  await blocked
  assert.equal(await resolver(scope), 'key-0')
})

test('refresh failure leaves a still valid old token and refresh token unchanged', async () => {
  const store = new MemoryOAuthTokenStore()
  const old = { accessToken: 'still-valid-secret', refreshToken: 'refresh-secret', expiresAt: 200 }
  await seed(store, old)
  const resolver = createOAuthCredentialResolver({ store, clock: () => 100, refreshSkewMs: 150, refresh: async previous => {
    assert.ok(Object.isFrozen(previous))
    throw new Error(`${previous.accessToken} ${previous.refreshToken}`)
  } })
  await assert.rejects(resolver(scope), error => {
    assert.ok(!inspect(error).includes('secret'))
    return code('AUTH_REFRESH_FAILED')(error)
  })
  assert.deepEqual(await read(store), old)
  const noRefresh = createOAuthCredentialResolver({ store, clock: () => 100, refreshSkewMs: 0, refresh: async () => { throw new Error('unused') } })
  assert.equal(await noRefresh(scope), old.accessToken)
})

test('invalid refreshed credentials never overwrite old store; lock is released for retry', async () => {
  const store = new MemoryOAuthTokenStore()
  const old = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 }
  await seed(store, old)
  const resolver = createOAuthCredentialResolver({ store, clock: () => 100, refresh: async () => ({ accessToken: '', expiresAt: 200 }) })
  await assert.rejects(resolver(scope), code('AUTH_REFRESH_FAILED'))
  assert.deepEqual(await read(store), old)
  await seed(store, { accessToken: 'recovered' })
  assert.equal(await resolver(scope), 'recovered')
})

test('omitted refresh token preserves previous rotation value; explicit empty rejects', async () => {
  const store = new MemoryOAuthTokenStore()
  await seed(store, { accessToken: 'old', refreshToken: 'keep-refresh', expiresAt: 0 })
  const resolver = createOAuthCredentialResolver({ store, clock: () => 100, refresh: async () => ({ accessToken: 'new', expiresAt: 99_999 }) })
  assert.equal(await resolver(scope), 'new')
  assert.equal((await read(store))?.refreshToken, 'keep-refresh')
  await seed(store, { accessToken: 'old', refreshToken: 'keep-refresh', expiresAt: 0 })
  const invalid = createOAuthCredentialResolver({ store, clock: () => 100, refresh: async () => ({ accessToken: 'new', refreshToken: '' }) })
  await assert.rejects(invalid(scope), code('AUTH_REFRESH_FAILED'))
  assert.equal((await read(store))?.accessToken, 'old')
})

test('OAuth cancellation does not cancel shared refresh or lose the rotated refresh token', async () => {
  const store = new MemoryOAuthTokenStore()
  await seed(store, { accessToken: 'old', refreshToken: 'rotate-me', expiresAt: 0 })
  const entered = deferred()
  const gate = deferred()
  const controller = new AbortController()
  let calls = 0
  const resolver = createOAuthCredentialResolver({ store, clock: () => 100, refresh: async (_previous, key) => {
    assert.equal('signal' in key, false)
    calls++
    entered.resolve()
    await gate.promise
    return { accessToken: 'new', refreshToken: 'rotated', expiresAt: 99_999 }
  } })
  const first = resolver({ ...scope, signal: controller.signal })
  await entered.promise
  const second = resolver(scope)
  const rejected = assert.rejects(first, code('AUTH_ABORTED'))
  controller.abort('secret-abort-reason')
  await rejected
  gate.resolve()
  assert.equal(await second, 'new')
  assert.equal(calls, 1)
  assert.equal((await read(store))?.refreshToken, 'rotated')
  assert.equal((await resolveOAuthCredential(resolver, scope)).kind, 'oauth')
})

test('missing OAuth store credentials never run refresh or fall back', async () => {
  const store = new MemoryOAuthTokenStore()
  let calls = 0
  const resolver = createOAuthCredentialResolver({ store, refresh: async () => { calls++; return { accessToken: 'unexpected' } } })
  await assert.rejects(resolver(scope), code('AUTH_CREDENTIAL_MISSING'))
  assert.equal(calls, 0)
  assert.equal(await read(store), undefined)
})

test('store failures do not expose custom error messages or causes', async () => {
  const resolver = createOAuthCredentialResolver({ store: { withLock: async () => { throw new Error('store-secret') } }, refresh: async () => ({ accessToken: 'unused' }) })
  await assert.rejects(resolver(scope), error => {
    assert.ok(!inspect(error).includes('store-secret'))
    return code('AUTH_STORE_FAILED')(error)
  })
})

test('failed persistence of refreshed credentials preserves the old store and hides storage diagnostics', async () => {
  const memory = new MemoryOAuthTokenStore()
  const old = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 }
  await seed(memory, old)
  const resolver = createOAuthCredentialResolver({
    store: {
      withLock: (key, operation) => memory.withLock(key, tx => operation({
        ...tx,
        set: async () => { throw new Error('rotated-refresh-secret could not be saved') },
      })),
    },
    clock: () => 100,
    refresh: async () => ({ accessToken: 'fresh-access', refreshToken: 'rotated-refresh-secret', expiresAt: 99_999 }),
  })
  await assert.rejects(resolver(scope), error => {
    assert.ok(!inspect(error).includes('rotated-refresh-secret'))
    return code('AUTH_STORE_FAILED')(error)
  })
  assert.deepEqual(await read(memory), old)
})

test('memory store copies tokens, rejects leaked transaction handles and hides inspection', async () => {
  const store = new MemoryOAuthTokenStore()
  const original = { accessToken: 'hidden-store-secret' }
  await seed(store, original)
  original.accessToken = 'changed'
  assert.equal((await read(store))?.accessToken, 'hidden-store-secret')
  assert.ok(!inspect(store).includes('hidden-store-secret'))
  const escaped = await store.withLock(scope, async tx => tx)
  await assert.rejects(escaped.set({ accessToken: 'bad' }), code('AUTH_STORE_FAILED'))
  assert.equal((await read(store))?.accessToken, 'hidden-store-secret')
})

test('native auth injection validates and copies header secrets without exposing diagnostics', async () => {
  const material = { headers: { Authorization: 'Bearer native-secret' } }
  const result = await resolveNativeAuth(async () => material, scope)
  material.headers.Authorization = 'changed'
  assert.equal(result.headers.authorization, 'Bearer native-secret')
  assert.ok(Object.isFrozen(result.headers))
  assert.ok(!JSON.stringify(result).includes('native-secret'))
  assert.ok(!inspect(result).includes('native-secret'))
  await assert.rejects(resolveNativeAuth(async () => ({ headers: { Authorization: 'bad\r\nsecret' } }), scope), code('AUTH_NATIVE_INVALID'))
  await assert.rejects(resolveNativeAuth(async () => ({}), scope), code('AUTH_NATIVE_INVALID'))
  await assert.rejects(resolveNativeAuth(async () => { throw new Error('native-secret') }, scope), code('AUTH_RESOLVER_FAILED'))
})
