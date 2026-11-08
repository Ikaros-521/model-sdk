import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createOpenAIEmbeddingAdapter, EmbeddingError, type OpenAIEmbeddingOptions } from '../src/embeddings/index.js';

const secret = 'sk-embedding-fixture-secret';
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>) {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
async function body(req: IncomingMessage) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return JSON.parse(value);
}
function config(baseURL: string, extra: Partial<OpenAIEmbeddingOptions> = {}): OpenAIEmbeddingOptions {
  return { baseURL, model: 'fixture-embedding', apiKey: secret, ...extra };
}
function fails(code: string) {
  return (error: unknown) => {
    assert(error instanceof EmbeddingError);
    assert.equal(error.code, code);
    assert(!String(error.stack).includes(secret));
    assert(!JSON.stringify(error).includes(secret));
    assert.equal((error as Error & { cause?: unknown }).cause, undefined);
    return true;
  };
}

test('batches sequentially, restores indexes, aggregates usage, keeps signal out of JSON', async () => {
  const seen: string[][] = [];
  let resolutions = 0;
  const server = await fixture(async (req, res) => {
    assert.equal(req.url, '/v1/embeddings');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const payload = await body(req);
    assert.equal(payload.signal, undefined);
    assert.equal(payload.dimensions, undefined);
    seen.push(payload.input);
    res.end(JSON.stringify({ model: 'actual-model', usage: { prompt_tokens: 2, total_tokens: 3 },
      data: payload.input.map((text: string, index: number) => ({ index, embedding: [Number(text), 0.25] })).reverse() }));
  });
  try {
    const adapter = createOpenAIEmbeddingAdapter(config(server.baseURL + '/', {
      batchSize: 2, apiKey: async ({ signal }) => { assert(!signal.aborted); resolutions++; return secret; },
    }));
    const result = await adapter.embed(['0', '1', '2', '3', '4'], { signal: new AbortController().signal });
    assert.deepEqual(seen, [['0', '1'], ['2', '3'], ['4']]);
    assert.deepEqual(result, { embeddings: [[0, 0.25], [1, 0.25], [2, 0.25], [3, 0.25], [4, 0.25]],
      model: 'actual-model', usage: { promptTokens: 6, totalTokens: 9 } });
    assert.equal(resolutions, 1);
  } finally { await server.close(); }
});

test('default batch is 64, DashScope model default is 10; explicit dimensions are sent', async () => {
  const sizes: number[] = [];
  const server = await fixture(async (req, res) => {
    const payload = await body(req);
    sizes.push(payload.input.length);
    assert.equal(payload.dimensions, 1);
    res.end(JSON.stringify({ data: payload.input.map((_: string, index: number) => ({ index, embedding: [1] })) }));
  });
  try {
    await createOpenAIEmbeddingAdapter(config(server.baseURL, { dimensions: 1 })).embed(Array(65).fill('x'));
    assert.deepEqual(sizes.splice(0), [64, 1]);
    const result = await createOpenAIEmbeddingAdapter(config(server.baseURL, {
      dimensions: 1, model: 'text-embedding-v4',
    })).embed(Array(21).fill('x'));
    assert.deepEqual(sizes, [10, 10, 1]);
    assert.equal(result.model, 'text-embedding-v4');
    assert.equal(result.usage, undefined);
  } finally { await server.close(); }
});

test('validates configuration and input before dispatch', async () => {
  let calls = 0;
  const base = config('http://127.0.0.1:1/v1', { fetch: async () => { calls++; throw new Error(secret); } });
  for (const patch of [{ dimensions: 0 }, { dimensions: 1.5 }, { dimensions: NaN }, { batchSize: 0 },
    { batchSize: 65 }, { batchSize: 1.1 }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { maxResponseBytes: 0 }, { model: '' }, { apiKey: '' }, { baseURL: 'ftp://example.com' },
    { baseURL: 'https://user:password@example.com' }, { baseURL: 'https://example.com/?key=secret' }]) {
    assert.throws(() => createOpenAIEmbeddingAdapter({ ...base, ...patch }), fails('EMBEDDING_CONFIGURATION_INVALID'));
  }
  const adapter = createOpenAIEmbeddingAdapter(base);
  for (const input of [[], [' '], ['x', ''], [42], Array(1)]) {
    await assert.rejects(adapter.embed(input as string[]), fails('EMBEDDING_INPUT_INVALID'));
  }
  assert.equal(calls, 0);
});

const invalidRows: [string, unknown][] = [
  ['duplicate index', [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }]],
  ['missing row', [{ index: 0, embedding: [1] }]],
  ['out-of-bounds', [{ index: 0, embedding: [1] }, { index: 2, embedding: [2] }]],
  ['negative index', [{ index: -1, embedding: [1] }, { index: 1, embedding: [2] }]],
  ['fractional index', [{ index: 0.5, embedding: [1] }, { index: 1, embedding: [2] }]],
  ['string index', [{ index: '0', embedding: [1] }, { index: 1, embedding: [2] }]],
  ['absent index', [{ embedding: [1] }, { index: 1, embedding: [2] }]],
  ['inconsistent dimensions', [{ index: 0, embedding: [1] }, { index: 1, embedding: [2, 3] }]],
  ['empty vector', [{ index: 0, embedding: [] }, { index: 1, embedding: [2] }]],
  ['non-number', [{ index: 0, embedding: ['1'] }, { index: 1, embedding: [2] }]],
  ['null', [{ index: 0, embedding: [null] }, { index: 1, embedding: [2] }]],
];
for (const [name, data] of invalidRows) {
  test(`rejects ${name}`, async () => {
    const server = await fixture((_req, res) => res.end(JSON.stringify({ data })));
    try { await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL)).embed(['x', 'y']),
      fails('EMBEDDING_INVALID_RESPONSE')); }
    finally { await server.close(); }
  });
}

test('rejects non-finite JSON numbers and mismatched configured dimensions', async () => {
  const server = await fixture((_req, res) => res.end('{"data":[{"index":0,"embedding":[1e999]}]}'));
  try { await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL)).embed(['x']),
    fails('EMBEDDING_INVALID_RESPONSE')); }
  finally { await server.close(); }
  const other = await fixture((_req, res) => res.end('{"data":[{"index":0,"embedding":[1]}]}'));
  try { await assert.rejects(createOpenAIEmbeddingAdapter(config(other.baseURL, { dimensions: 2 })).embed(['x']),
    fails('EMBEDDING_INVALID_RESPONSE')); }
  finally { await other.close(); }
});

test('rejects dimension or model drift across batches', async () => {
  for (const drift of ['dimension', 'model']) {
    let calls = 0;
    const server = await fixture((_req, res) => {
      calls++;
      res.end(JSON.stringify({ model: drift === 'model' ? `m${calls}` : 'm',
        data: [{ index: 0, embedding: drift === 'dimension' && calls === 2 ? [1, 2] : [1] }] }));
    });
    try { await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL, { batchSize: 1 })).embed(['x', 'y']),
      fails('EMBEDDING_INVALID_RESPONSE')); }
    finally { await server.close(); }
  }
});

test('429 includes safe metadata, discards echoed secrets and does not retry', async () => {
  let calls = 0;
  const server = await fixture((_req, res) => {
    calls++;
    res.writeHead(429, { 'x-request-id': 'req-safe', 'retry-after': '12' });
    res.end(JSON.stringify({ error: { message: secret } }));
  });
  try {
    await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL)).embed(['x']), error => {
      fails('EMBEDDING_HTTP_ERROR')(error);
      assert(error instanceof EmbeddingError);
      assert.equal(error.status, 429);
      assert.equal(error.requestId, 'req-safe');
      assert.equal(error.retryAfter, '12');
      return true;
    });
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('redacts credential-bearing metadata and transport/resolver failures', async () => {
  const server = await fixture((_req, res) => {
    res.writeHead(401, { 'x-request-id': secret, 'retry-after': secret });
    res.end(secret);
  });
  try {
    await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL)).embed(['x']), error => {
      fails('EMBEDDING_HTTP_ERROR')(error);
      assert(error instanceof EmbeddingError);
      assert.equal(error.requestId, '[REDACTED]');
      assert.equal(error.retryAfter, '[REDACTED]');
      return true;
    });
    await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL, {
      apiKey: async () => { throw new Error(secret); },
    })).embed(['x']), fails('EMBEDDING_NETWORK_ERROR'));
    await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL, {
      fetch: async () => { throw new Error(secret); },
    })).embed(['x']), fails('EMBEDDING_NETWORK_ERROR'));
  } finally { await server.close(); }
});

test('redirect is manual and cannot leak authorization to a second origin', async () => {
  let leaked = 0;
  const target = await fixture((_req, res) => { leaked++; res.end('{}'); });
  const source = await fixture((_req, res) => {
    res.writeHead(307, { location: target.baseURL }); res.end();
  });
  try {
    await assert.rejects(createOpenAIEmbeddingAdapter(config(source.baseURL)).embed(['x']), fails('EMBEDDING_HTTP_ERROR'));
    assert.equal(leaked, 0);
  } finally { await source.close(); await target.close(); }
});

test('timeout covers delayed headers and stalled success bodies', async () => {
  for (const headers of [false, true]) {
    const server = await fixture((_req, res) => {
      if (headers) { res.writeHead(200); res.flushHeaders(); res.write('{"data":'); }
    });
    try {
      const start = Date.now();
      await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL, { timeoutMs: 60 })).embed(['x']),
        fails('EMBEDDING_TIMEOUT'));
      assert(Date.now() - start < 1500);
    } finally { await server.close(); }
  }
});

test('one total timeout covers all batches rather than resetting per request', async () => {
  let calls = 0;
  const server = await fixture(async (_req, res) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 90));
    res.end('{"data":[{"index":0,"embedding":[1]}]}');
  });
  try {
    await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL, {
      batchSize: 1, timeoutMs: 145,
    })).embed(['x', 'y', 'z']), fails('EMBEDDING_TIMEOUT'));
    assert.equal(calls, 2);
  } finally { await server.close(); }
});

test('pre-cancel makes zero calls; cancellation covers headers and stalled bodies', async () => {
  let calls = 0;
  const cancelled = new AbortController(); cancelled.abort(new Error(secret));
  await assert.rejects(createOpenAIEmbeddingAdapter(config('http://localhost:1', {
    apiKey: () => { calls++; return secret; },
  })).embed(['x'], { signal: cancelled.signal }), fails('EMBEDDING_CANCELLED'));
  assert.equal(calls, 0);
  for (const headers of [false, true]) {
    const controller = new AbortController();
    const server = await fixture((_req, res) => {
      if (headers) { res.writeHead(200); res.flushHeaders(); res.write('{'); }
      const timer = setTimeout(() => controller.abort(new Error(secret)), 20);
      res.once('close', () => clearTimeout(timer));
    });
    try { await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL)).embed(['x'], { signal: controller.signal }),
      fails('EMBEDDING_CANCELLED')); }
    finally { await server.close(); }
  }
});

test('timeout/cancellation works while async resolver or injected fetch ignores signal', async () => {
  for (const phase of ['resolver', 'fetch']) {
    let captured: AbortSignal | undefined;
    const extra: Partial<OpenAIEmbeddingOptions> = phase === 'resolver'
      ? { apiKey: ({ signal }) => { captured = signal; return new Promise(() => {}); } }
      : { fetch: async (_url, init) => { captured = init!.signal as AbortSignal; return new Promise(() => {}); } };
    await assert.rejects(createOpenAIEmbeddingAdapter(config('http://localhost:1', {
      ...extra, timeoutMs: 40,
    })).embed(['x']), fails('EMBEDDING_TIMEOUT'));
    assert(captured?.aborted);
    const controller = new AbortController();
    const pending = createOpenAIEmbeddingAdapter(config('http://localhost:1', extra)).embed(['x'], { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(secret), 20);
    try { await assert.rejects(pending, fails('EMBEDDING_CANCELLED')); }
    finally { clearTimeout(timer); }
  }
});

test('enforces bounded bodies with and without Content-Length and rejects malformed JSON', async () => {
  for (const length of [false, true]) {
    const server = await fixture((_req, res) => {
      if (length) res.setHeader('content-length', '1000');
      else res.setHeader('transfer-encoding', 'chunked');
      res.end('x'.repeat(1000));
    });
    try { await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL, { maxResponseBytes: 100 })).embed(['x']),
      fails('EMBEDDING_RESPONSE_TOO_LARGE')); }
    finally { await server.close(); }
  }
  const server = await fixture((_req, res) => res.end(`not-json-${secret}`));
  try { await assert.rejects(createOpenAIEmbeddingAdapter(config(server.baseURL)).embed(['x']), fails('EMBEDDING_INVALID_RESPONSE')); }
  finally { await server.close(); }
});

test('usage is omitted if unavailable in any batch and invalid reported usage is rejected', async () => {
  let count = 0;
  const server = await fixture((_req, res) => {
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }],
      ...(count++ ? {} : { usage: { prompt_tokens: 1, total_tokens: 1 } }) }));
  });
  try {
    const result = await createOpenAIEmbeddingAdapter(config(server.baseURL, { batchSize: 1 })).embed(['x', 'y']);
    assert.equal(result.usage, undefined);
  } finally { await server.close(); }
  const invalid = await fixture((_req, res) => res.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }],
    usage: { total_tokens: -1 } })));
  try { await assert.rejects(createOpenAIEmbeddingAdapter(config(invalid.baseURL)).embed(['x']), fails('EMBEDDING_INVALID_RESPONSE')); }
  finally { await invalid.close(); }
});
