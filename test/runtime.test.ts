import { describe, it, expect, vi } from 'vitest'
import { ModelRuntime, LlmError, ToolCallId, createUserMessage } from '../src/core/index.js'
import type { CallOptions, ModelProvider, StreamChunk } from '../src/core/index.js'
import { withRetry, retryDelay } from '../src/retry/index.js'
const input: CallOptions = { provider: 'a', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
const text: StreamChunk = { type: 'text-delta', index: 0, text: 'hello' }
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const fail: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { message: 'try later', code: 'RATE_LIMIT' } } }
function provider(stream: (signal: AbortSignal) => AsyncIterable<StreamChunk>): ModelProvider {
  return { id: 'a', prepareCall: () => ({ stream }) }
}
function runtime(...chunks: StreamChunk[]): ModelRuntime {
  const r = new ModelRuntime(); r.register(provider(async function* () { yield* chunks })); return r
}
const hang = () => new Promise<never>(() => {})
describe('standalone runtime contract', () => {
  it('generate assembles the same streaming protocol and stores opaque replay', async () => {
    const replay = { response: { opaque: 'signature' }, blocks: [{ secretSignature: 'abc' }] }
    const result = await runtime(text, { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 3, totalTokens: 6 } }, { type: 'finish', reason: { kind: 'stop' }, replayState: replay }).generate(input)
    expect(result.text).toBe('hello'); expect(result.usage?.inputTokens).toBe(2)
    expect(result.message.source.replayState).toEqual(replay)
    expect(Object.isFrozen(result.message)).toBe(true)
  })
  it('captures provider generation/input once and dispatches once after registry replacement', async () => {
    const r = new ModelRuntime(); let observed: Readonly<CallOptions> | undefined; const dispatched = vi.fn()
    const dispose = r.register({ id: 'a', prepareCall(options) { observed = options; return { async *stream() { dispatched(); yield text; yield stop } } } })
    const source = structuredClone(input); const prepared = await r.prepareCall(source)
    source.messages[0]!.content[0] = { type: 'text', text: 'changed' }
    r.register(provider(async function* () { throw new Error('replacement') })); dispose()
    expect((observed!.messages[0]!.content[0] as { text: string }).text).toBe('hello')
    expect(Object.isFrozen(observed!.messages[0])).toBe(true)
    expect((await prepared.generate()).text).toBe('hello'); expect(dispatched).toHaveBeenCalledTimes(1)
    expect(() => prepared.stream()).toThrow(/already/); expect(r.listProviders()).toEqual(['a'])
  })
  it('normalizes missing finish/EOF into one failure', async () => {
    const result = await runtime(text).generate(input)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'STREAM_CLOSED' } }); expect(result.text).toBe('hello')
  })
  it('normalizes thrown transport facts without losing status/requestId/retry delay', async () => {
    const r = new ModelRuntime(); r.register(provider(async function* () { throw new LlmError('limited', 'RATE_LIMIT', { status: 429, requestId: 'r' as never, providerRetryAfterMs: 2000 }) }))
    expect((await r.generate(input)).finish).toMatchObject({ kind: 'error', failure: { status: 429, requestId: 'r', providerRetryAfterMs: 2000 } })
  })
  it.each([
    [{ type: 'finish', reason: { kind: 'pending' } }],
    [stop, text],
    [stop, stop],
    [{ type: 'text-delta', index: -1, text: 'x' }],
    [{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }, text],
    [{ type: 'usage', usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } }],
  ])('rejects malformed terminal/lifecycle/usage %#', async (...chunks) => {
    const result = await runtime(...chunks as StreamChunk[]).generate(input)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
  })
  it('drops all tools on interrupted response while retaining partial text', async () => {
    const result = await runtime(text, { type: 'tool-call-delta', index: 1, id: ToolCallId('t'), name: 'danger', argumentsDelta: '{' }, fail).generate(input)
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }]); expect(result.message.source.replayState).toBeUndefined()
  })
  it('cancels a provider ignoring its signal and leaves caller AbortSignal usable', async () => {
    const controller = new AbortController(); const r = new ModelRuntime()
    r.register(provider(async function* () { yield text; await hang() }))
    const result = r.generate({ ...input, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    expect((await result).finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } }); expect(Object.isFrozen(controller.signal)).toBe(false)
  })
  it.each(['timeoutMs', 'idleTimeoutMs'] as const)('enforces %s even if provider ignores cancellation', async key => {
    const r = new ModelRuntime(); r.register(provider(async function* () { await hang() }))
    expect((await r.generate({ ...input, [key]: 10 })).finish).toMatchObject({ kind: 'error', failure: { code: key === 'timeoutMs' ? 'TIMEOUT' : 'IDLE_TIMEOUT' } })
  })
  it('total timeout includes credential/preparation awaits', async () => {
    const r = new ModelRuntime(); r.register({ id: 'a', prepareCall: () => hang() })
    expect((await r.generate({ ...input, timeoutMs: 10 })).finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
  })
  it('propagates consumer early return to transport signal', async () => {
    let transportSignal: AbortSignal | undefined
    const r = new ModelRuntime(); r.register(provider(async function* (signal) { transportSignal = signal; yield text; await hang() }))
    for await (const chunk of r.stream(input)) { expect(chunk).toEqual(text); break }
    expect(transportSignal!.aborted).toBe(true)
  })
  it('does not dispatch an already aborted caller', async () => {
    const prepare = vi.fn(); const r = new ModelRuntime(); r.register({ id: 'a', prepareCall: prepare })
    const controller = new AbortController(); controller.abort()
    expect((await r.generate({ ...input, signal: controller.signal })).finish.kind).toBe('aborted'); expect(prepare).not.toHaveBeenCalled()
  })
})
describe('opt-in retry', () => {
  it('retries only failures before exposing response content and honors bounded backoff', async () => {
    let attempts = 0; const onRetry = vi.fn(); const r = new ModelRuntime()
    r.register(withRetry(provider(async function* () { attempts++; if (attempts === 1) yield fail; else { yield text; yield stop } }), { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0, onRetry }))
    expect((await r.generate(input)).text).toBe('hello'); expect(attempts).toBe(2); expect(onRetry).toHaveBeenCalledOnce()
    expect(retryDelay(10, { initialDelayMs: 2, maxDelayMs: 10, jitterRatio: 0 })).toBe(10)
    expect(retryDelay(1, {}, 12345)).toBe(12345)
  })
  it('retries premature EOF before content without leaking failed-attempt chunks', async () => {
    let attempts = 0; const r = new ModelRuntime()
    r.register(withRetry(provider(async function* () { attempts++; if (attempts === 1) yield { type: 'block-start', index: 7, blockType: 'text' }; else { yield text; yield stop } }), { initialDelayMs: 0, jitterRatio: 0 }))
    const result = await r.generate(input)
    expect(result.text).toBe('hello'); expect(result.finish.kind).toBe('stop'); expect(attempts).toBe(2)
  })
  it('never retries after text/reasoning/tool deltas escape', async () => {
    let attempts = 0; const r = new ModelRuntime(); r.register(withRetry(provider(async function* () { attempts++; yield text; yield fail }), { initialDelayMs: 0 }))
    expect((await r.generate(input)).finish.kind).toBe('error'); expect(attempts).toBe(1)
  })
  it('does not shorten a Retry-After beyond policy limit', async () => {
    let attempts = 0; const r = new ModelRuntime(); r.register(withRetry(provider(async function* () { attempts++; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'wait', providerRetryAfterMs: 3000 } } } }), { initialDelayMs: 1, maxDelayMs: 2 }))
    expect((await r.generate(input)).finish.kind).toBe('error'); expect(attempts).toBe(1)
  })
  it('cancels during retry wait promptly', async () => {
    const r = new ModelRuntime(); r.register(withRetry(provider(async function* () { yield fail }), { initialDelayMs: 10000 }))
    const controller = new AbortController(); const result = r.generate({ ...input, signal: controller.signal }); setTimeout(() => controller.abort(), 10)
    expect((await result).finish.kind).toBe('aborted')
  })
})
