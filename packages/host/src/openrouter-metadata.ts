import {createHash} from 'node:crypto';
import {strictMetadataJson} from '../../contracts/src/wire.js';

const METADATA_LIMIT = 4 * 1024 * 1024;
const METADATA_DEADLINE_MS = 15_000;
const MODEL = /^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*(?![\s\S])/;
const INTERRUPTED = Symbol('openrouter_metadata_interrupted');

export interface OpenRouterMetadataObservation {
  readonly kind: 'model_endpoints' | 'zdr_preview';
  readonly model?: string;
  readonly url: string;
  /** Caller-owned private snapshot. Uint8Array remains mutable; evidence
   * producers must verify sha256 again immediately before consuming it. */
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface OpenRouterMetadataResult {
  readonly state: 'observed' | 'invalid_request' | 'unavailable' | 'interrupted';
  readonly observations: readonly OpenRouterMetadataObservation[];
  readonly runtimeQualified: false;
  readonly executionAuthorized: false;
}

function result(
  state: OpenRouterMetadataResult['state'],
  observations: readonly OpenRouterMetadataObservation[] = [],
): OpenRouterMetadataResult {
  return Object.freeze({
    state,
    observations: Object.freeze([...observations]),
    runtimeQualified: false,
    executionAuthorized: false,
  });
}

function isJson(contentType: string | null): boolean {
  return typeof contentType === 'string'
    && contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function boundedMetadataBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  let rejectInterrupted: (reason: typeof INTERRUPTED) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const abort = () => {
    void reader.cancel().catch(() => {});
    rejectInterrupted(INTERRUPTED);
  };
  signal.addEventListener('abort', abort, {once: true});
  try {
    if (signal.aborted) abort();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const pending = reader.read();
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await Promise.race([pending, interrupted]);
      } catch (error) {
        if (error === INTERRUPTED) await pending.catch(() => {});
        throw error;
      }
      if (signal.aborted) throw INTERRUPTED;
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)
          || part.value.buffer instanceof SharedArrayBuffer) throw Error('OPENROUTER_METADATA_BYTES');
      total += part.value.byteLength;
      if (total > METADATA_LIMIT) throw Error('OPENROUTER_METADATA_LIMIT');
      chunks.push(new Uint8Array(part.value));
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

async function fixedGet(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  if (signal.aborted) throw INTERRUPTED;
  let claimed = false;
  const request = fetcher(url, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    headers: {Accept: 'application/json'},
    signal,
  });
  request.then(response => {
    if (signal.aborted && !claimed) cancelBody(response);
  }, () => {});
  let rejectInterrupted: (reason: typeof INTERRUPTED) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const abort = () => rejectInterrupted(INTERRUPTED);
  signal.addEventListener('abort', abort, {once: true});
  try {
    if (signal.aborted) abort();
    const response = await Promise.race([request, interrupted]);
    claimed = true;
    if (signal.aborted) {
      cancelBody(response);
      throw INTERRUPTED;
    }
    if (response.redirected || response.status !== 200 || !isJson(response.headers.get('content-type')) || !response.body) {
      cancelBody(response);
      throw Error('OPENROUTER_METADATA_RESPONSE');
    }
    const bytes = await boundedMetadataBody(response.body, signal);
    if (!strictMetadataJson(bytes).ok) throw Error('OPENROUTER_METADATA_JSON');
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Fixed, credential-free OpenRouter public metadata boundary. */
export async function fetchOpenRouterMetadata(
  models: readonly string[],
  stop: AbortSignal,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<OpenRouterMetadataResult> {
  if (!Array.isArray(models) || models.length < 1 || models.length > 16
      || models.some(model => typeof model !== 'string' || model.length > 200 || !MODEL.test(model))
      || new Set(models).size !== models.length
      || !stop || typeof stop.aborted !== 'boolean'
      || typeof stop.addEventListener !== 'function' || typeof stop.removeEventListener !== 'function') {
    return result('invalid_request');
  }
  if (stop.aborted) return result('interrupted');
  const snapshot = [...models];
  const observedAt = clock();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return result('unavailable');
  const controller = new AbortController();
  const abort = () => controller.abort();
  stop.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(abort, METADATA_DEADLINE_MS);
  const observations: OpenRouterMetadataObservation[] = [];
  try {
    for (const model of snapshot) {
      const url = `https://openrouter.ai/api/v1/models/${model}/endpoints`;
      const bytes = await fixedGet(url, controller.signal, fetcher);
      observations.push(Object.freeze({
        kind: 'model_endpoints',
        model,
        url,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        observedAt,
      }));
    }
    const url = 'https://openrouter.ai/api/v1/endpoints/zdr';
    const bytes = await fixedGet(url, controller.signal, fetcher);
    observations.push(Object.freeze({
      kind: 'zdr_preview',
      url,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      observedAt,
    }));
    if (controller.signal.aborted) return result('interrupted');
    return result('observed', observations);
  } catch (error) {
    return result(error === INTERRUPTED || controller.signal.aborted ? 'interrupted' : 'unavailable');
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', abort);
    controller.abort();
  }
}
