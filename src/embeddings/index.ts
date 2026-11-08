export type EmbeddingErrorCode =
  | 'EMBEDDING_INPUT_INVALID' | 'EMBEDDING_CONFIGURATION_INVALID'
  | 'EMBEDDING_TIMEOUT' | 'EMBEDDING_CANCELLED' | 'EMBEDDING_NETWORK_ERROR'
  | 'EMBEDDING_HTTP_ERROR' | 'EMBEDDING_INVALID_RESPONSE' | 'EMBEDDING_RESPONSE_TOO_LARGE';

export interface EmbeddingErrorDetails {
  status?: number;
  requestId?: string;
  /** Provider Retry-After header, in seconds or HTTP-date form; never triggers retries. */
  retryAfter?: string;
}

/** Does not retain provider bodies, transport errors, credentials or caller abort reasons. */
export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfter?: string;
  constructor(code: EmbeddingErrorCode, details: EmbeddingErrorDetails = {}) {
    super(code);
    this.name = 'EmbeddingError';
    this.code = code;
    this.status = details.status;
    this.requestId = details.requestId;
    this.retryAfter = details.retryAfter;
  }
}

export interface OpenAIEmbeddingOptions {
  /** API root, e.g. https://api.openai.com/v1 (not the /embeddings endpoint). */
  baseURL: string;
  /** Resolved once per embed call, within the total timeout. */
  apiKey: string | ((options: { signal: AbortSignal }) => string | Promise<string>);
  model: string;
  /** Omitted by default for compatibility with models that reject dimensions. */
  dimensions?: number;
  /** 1..64. Defaults to 10 for text-embedding-vN models, otherwise 64. */
  batchSize?: number;
  /** Total deadline across credential resolution, batches, headers and bodies. Default 60s. */
  timeoutMs?: number;
  /** Per-response byte limit, including error bodies. Default 8 MiB, maximum 64 MiB. */
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}
export interface EmbeddingCallOptions { signal?: AbortSignal }
export interface EmbeddingUsage { promptTokens?: number; totalTokens?: number }
export interface EmbeddingResult {
  embeddings: number[][];
  /** Provider-reported model, or configured model if omitted by the provider. */
  model: string;
  /** A field is omitted if any batch omits that usage field. No usage is estimated. */
  usage?: EmbeddingUsage;
}
export interface EmbeddingAdapter {
  embed(input: readonly string[], options?: EmbeddingCallOptions): Promise<EmbeddingResult>;
}

function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE'); }

/** Sequential batching preserves provider limits and performs no retries. */
export function createOpenAIEmbeddingAdapter(options: OpenAIEmbeddingOptions): EmbeddingAdapter {
  // Snapshot config so mutation by a caller cannot redirect a later batch with a resolved key.
  const config = { ...options };
  const batchSize = config.batchSize ?? (/^text-embedding-v\d+$/.test(config.model) ? 10 : 64);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const maxBytes = config.maxResponseBytes ?? 8 * 1024 * 1024;
  let endpoint: string;
  try {
    const url = new URL(config.baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, '') + '/embeddings';
    endpoint = url.toString();
  } catch { throw new EmbeddingError('EMBEDDING_CONFIGURATION_INVALID'); }
  const transport = config.fetch ?? globalThis.fetch;
  if (typeof config.model !== 'string' || !config.model.trim() ||
      !(typeof config.apiKey === 'function' || typeof config.apiKey === 'string' && config.apiKey.trim()) ||
      config.dimensions !== undefined && !positive(config.dimensions) ||
      !positive(batchSize, 64) || !positive(timeoutMs, 2_147_483_647) ||
      !positive(maxBytes, 64 * 1024 * 1024) || typeof transport !== 'function')
    throw new EmbeddingError('EMBEDDING_CONFIGURATION_INVALID');

  return {
    async embed(input, call = {}) {
      if (!Array.isArray(input) || input.length === 0 ||
          Array.from(input).some(value => typeof value !== 'string' || !value.trim()))
        throw new EmbeddingError('EMBEDDING_INPUT_INVALID');
      const texts = [...input];
      const controller = new AbortController();
      const signal = controller.signal;
      let cancellation: EmbeddingError | undefined;
      let rejectAborted!: (error: EmbeddingError) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      // Every awaited operation races cancellation even when an injected implementation ignores signal.
      const abort = (code: 'EMBEDDING_TIMEOUT' | 'EMBEDDING_CANCELLED') => {
        if (cancellation) return;
        cancellation = new EmbeddingError(code);
        rejectAborted(cancellation);
        controller.abort();
      };
      const onAbort = () => abort('EMBEDDING_CANCELLED');
      const race = <T>(work: PromiseLike<T>): Promise<T> => Promise.race([work, aborted]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let details: EmbeddingErrorDetails = {};
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let activeResponse: Response | undefined;
      try {
        // Attach a rejection handler before observing an already-cancelled caller signal.
        void aborted.catch(() => {});
        call.signal?.addEventListener('abort', onAbort, { once: true });
        if (call.signal?.aborted) onAbort();
        if (cancellation) throw cancellation;
        timer = setTimeout(() => abort('EMBEDDING_TIMEOUT'), timeoutMs);
        const key = await race(Promise.resolve().then(() => typeof config.apiKey === 'function'
          ? config.apiKey({ signal }) : config.apiKey));
        if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
          throw new EmbeddingError('EMBEDDING_CONFIGURATION_INVALID');
        const safeHeader = (value: string | null) => {
          if (!value) return undefined;
          // Never expose any header containing a credential, including common encoded forms.
          const secrets = [key, encodeURIComponent(key)];
          if (secrets.some(secret => value.includes(secret))) return '[REDACTED]';
          return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256);
        };
        const embeddings: number[][] = [];
        let dimensions = config.dimensions;
        let model: string | undefined;
        let promptTokens: number | undefined = 0;
        let totalTokens: number | undefined = 0;
        for (let offset = 0; offset < texts.length; offset += batchSize) {
          if (cancellation) throw cancellation;
          details = {};
          const batch = texts.slice(offset, offset + batchSize);
          const pending = Promise.resolve().then(() => transport(endpoint, {
            method: 'POST', redirect: 'manual', signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: config.model, input: batch, encoding_format: 'float',
              ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }) }),
          })).then(response => {
            if (signal.aborted) { void response.body?.cancel().catch(() => {}); }
            return response;
          });
          const response = activeResponse = await race(pending);
          details = {
            status: response.status,
            requestId: safeHeader(response.headers.get('x-request-id') ?? response.headers.get('request-id')),
            retryAfter: safeHeader(response.headers.get('retry-after')),
          };
          // Do not read untrusted error bodies or follow redirects with authorization.
          if (!response.ok) throw new EmbeddingError('EMBEDDING_HTTP_ERROR', details);
          const length = response.headers.get('content-length');
          if (length && Number(length) > maxBytes)
            throw new EmbeddingError('EMBEDDING_RESPONSE_TOO_LARGE', details);
          if (!response.body) invalid();
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const chunk = await race(reader.read());
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) throw new EmbeddingError('EMBEDDING_RESPONSE_TOO_LARGE', details);
            chunks.push(chunk.value);
          }
          reader.releaseLock();
          reader = undefined;
          activeResponse = undefined;
          const bytes = new Uint8Array(size);
          let position = 0;
          for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
          let data: unknown;
          try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { invalid(); }
          if (!record(data) || !Array.isArray(data.data) || data.data.length !== batch.length) invalid();
          const currentModel = data.model === undefined ? config.model : data.model;
          if (typeof currentModel !== 'string' || !currentModel.trim() || model !== undefined && currentModel !== model) invalid();
          model = currentModel;
          const ordered = new Array<number[]>(batch.length);
          for (const entry of data.data) {
            if (!record(entry) || typeof entry.index !== 'number' || !Number.isInteger(entry.index) ||
                entry.index < 0 || entry.index >= batch.length || ordered[entry.index] !== undefined) invalid();
            const vector = entry.embedding;
            if (!Array.isArray(vector) || !vector.length ||
                vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) invalid();
            dimensions ??= vector.length;
            if (vector.length !== dimensions) invalid();
            ordered[entry.index] = vector;
          }
          for (let index = 0; index < batch.length; index++) if (!ordered[index]) invalid();
          embeddings.push(...ordered);
          const usage = data.usage;
          if (usage !== undefined && !record(usage)) invalid();
          const addUsage = (sum: number | undefined, name: string): number | undefined => {
            const value = record(usage) ? usage[name] : undefined;
            if (value === undefined) return undefined;
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
            if (sum === undefined) return undefined;
            if (!Number.isSafeInteger(sum + value)) invalid();
            return sum + value;
          };
          promptTokens = addUsage(promptTokens, 'prompt_tokens');
          totalTokens = addUsage(totalTokens, 'total_tokens');
        }
        if (cancellation) throw cancellation;
        return { embeddings, model: model!,
          ...(promptTokens === undefined && totalTokens === undefined ? {} : {
            usage: { ...(promptTokens === undefined ? {} : { promptTokens }),
              ...(totalTokens === undefined ? {} : { totalTokens }) },
          }) };
      } catch (error) {
        if (cancellation) throw new EmbeddingError(cancellation.code, details);
        if (error instanceof EmbeddingError)
          throw new EmbeddingError(error.code, {
            status: error.status ?? details.status,
            requestId: error.requestId ?? details.requestId,
            retryAfter: error.retryAfter ?? details.retryAfter,
          });
        throw new EmbeddingError('EMBEDDING_NETWORK_ERROR', details);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        call.signal?.removeEventListener('abort', onAbort);
        if (reader) { void reader.cancel().catch(() => {}); }
        else if (activeResponse?.body) { void activeResponse.body.cancel().catch(() => {}); }
        controller.abort();
      }
    },
  };
}

export function embed(config: OpenAIEmbeddingOptions, input: readonly string[], options?: EmbeddingCallOptions) {
  return createOpenAIEmbeddingAdapter(config).embed(input, options);
}
