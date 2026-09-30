import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadModelToCache,
  evictCachedModel,
  isModelIntact,
  loadModelBytes,
  looksLikeHtml,
  modelCacheKey,
  toHex,
  verifyModelBytes,
} from '../../../src/features/ai-cutout/model-loader.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';

const subtle = /** @type {SubtleCrypto} */ (webcrypto.subtle);
const BASE = 'https://example.test/glinfs/';

/** @param {Uint8Array} bytes */
function specFor(bytes, overrides = {}) {
  return {
    url: '/glinfs/models/isnetis-fp16.onnx',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    inputName: 'img',
    outputName: 'mask',
    inputSize: 1024,
    ...overrides,
  };
}

/** A response whose body arrives in `chunks` pieces. */
function chunkedResponse(bytes, chunks = 3, init = {}) {
  const size = Math.ceil(bytes.byteLength / chunks);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.byteLength; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

/** Minimal in-memory Cache Storage. */
function createFakeCaches() {
  /** @type {Map<string, Uint8Array>} */
  const entries = new Map();
  const cache = {
    match: vi.fn(async (key) => {
      const bytes = entries.get(key);
      return bytes ? new Response(bytes.slice()) : undefined;
    }),
    put: vi.fn(async (key, response) => {
      entries.set(key, new Uint8Array(await response.arrayBuffer()));
    }),
    delete: vi.fn(async (key) => entries.delete(typeof key === 'string' ? key : key.url)),
    keys: vi.fn(async (request, options) => {
      const strip = (/** @type {string} */ url) => url.split('?')[0];
      return [...entries.keys()]
        .filter((key) =>
          request === undefined
            ? true
            : options?.ignoreSearch
              ? strip(key) === strip(request)
              : key === request,
        )
        .map((url) => ({ url }));
    }),
  };
  return {
    entries,
    cache,
    storage: /** @type {CacheStorage} */ (
      /** @type {unknown} */ ({ open: vi.fn(async () => cache) })
    ),
  };
}

const MODEL = new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));

describe('toHex / modelCacheKey', () => {
  it('hex-encodes digests', () => {
    expect(toHex(new Uint8Array([0, 15, 255]).buffer)).toBe('000fff');
  });

  it('keys the cache by absolute URL plus the expected hash', () => {
    const spec = specFor(MODEL);
    expect(modelCacheKey(spec, BASE)).toBe(
      `https://example.test/glinfs/models/isnetis-fp16.onnx?sha256=${spec.sha256}`,
    );
  });
});

describe('verifyModelBytes', () => {
  it('accepts the pinned bytes', async () => {
    await expect(verifyModelBytes(MODEL, specFor(MODEL), subtle)).resolves.toBeUndefined();
  });

  it('rejects a size mismatch before hashing', async () => {
    const digest = vi.fn();
    const error = await verifyModelBytes(MODEL.slice(1), specFor(MODEL), {
      digest,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.HASH_MISMATCH);
    expect(error.message).toContain('999 bytes');
    expect(digest).not.toHaveBeenCalled();
  });

  it('rejects a hash mismatch', async () => {
    const error = await verifyModelBytes(
      MODEL,
      specFor(MODEL, { sha256: 'ab'.repeat(32) }),
      subtle,
    ).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.HASH_MISMATCH);
    expect(error.message).toContain('SHA-256');
  });
});

describe('loadModelBytes', () => {
  it('downloads with progress, verifies and caches', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    const fetchImpl = vi.fn(async () => chunkedResponse(MODEL, 4));
    const onProgress = vi.fn();

    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      onProgress,
    });

    expect(Array.from(result.bytes)).toEqual(Array.from(MODEL));
    expect(result.fromCache).toBe(false);
    expect(result.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(spec.url, { cache: 'no-store', signal: undefined });
    const phases = onProgress.mock.calls.map(([p]) => `${p.phase}:${p.loadedBytes}`);
    expect(phases).toEqual([
      'downloading:0',
      'downloading:250',
      'downloading:500',
      'downloading:750',
      'downloading:1000',
      'verifying:1000',
    ]);
    expect(entries.has(modelCacheKey(spec, BASE))).toBe(true);
  });

  it('removes older pins of the same model after a verified download, and nothing else', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    const stale = `https://example.test/glinfs/models/isnetis-fp16.onnx?sha256=${'0'.repeat(64)}`;
    const other = 'https://example.test/glinfs/models/isnet-general-fp16.onnx?sha256=abc';
    entries.set(stale, new Uint8Array(3));
    entries.set(other, new Uint8Array(3));
    await loadModelBytes(spec, {
      fetchImpl: vi.fn(async () => chunkedResponse(MODEL)),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    });
    expect([...entries.keys()].sort()).toEqual([modelCacheKey(spec, BASE), other].sort());
  });

  it('keeps older pins when the download fails verification', async () => {
    const spec = specFor(MODEL, { sha256: 'ab'.repeat(32) });
    const { storage, entries } = createFakeCaches();
    const stale = `https://example.test/glinfs/models/isnetis-fp16.onnx?sha256=${'0'.repeat(64)}`;
    entries.set(stale, new Uint8Array(3));
    const error = await loadModelBytes(spec, {
      fetchImpl: vi.fn(async () => chunkedResponse(MODEL)),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.HASH_MISMATCH);
    expect([...entries.keys()]).toEqual([stale]);
  });

  it('serves a cached copy without fetching and without hashing it again', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    entries.set(modelCacheKey(spec, BASE), MODEL.slice());
    const fetchImpl = vi.fn();
    const onProgress = vi.fn();
    const digest = vi.fn();

    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle: /** @type {any} */ ({ digest }),
      baseHref: BASE,
      onProgress,
    });
    expect(result).toMatchObject({ fromCache: true, cached: true });
    expect(Array.from(result.bytes)).toEqual(Array.from(MODEL));
    expect(fetchImpl).not.toHaveBeenCalled();
    // Verified before it was stored under a key that carries its SHA-256
    expect(digest).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'downloading',
      loadedBytes: 1000,
      totalBytes: 1000,
      fromCache: true,
    });
  });

  it('evicts a cached copy of the wrong size (truncated) and downloads again', async () => {
    const spec = specFor(MODEL);
    const { storage, entries, cache } = createFakeCaches();
    const key = modelCacheKey(spec, BASE);
    entries.set(key, MODEL.slice(0, 600));
    const fetchImpl = vi.fn(async () => chunkedResponse(MODEL));

    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    });
    expect(cache.delete).toHaveBeenCalledWith(key);
    expect(result.fromCache).toBe(false);
    expect(Array.from(entries.get(key) ?? [])).toEqual(Array.from(MODEL));
  });

  it('cacheOnly never downloads: MODEL_NOT_CACHED without a cached copy', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    const fetchImpl = vi.fn();
    const error = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      cacheOnly: true,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.MODEL_NOT_CACHED);
    expect(fetchImpl).not.toHaveBeenCalled();

    entries.set(modelCacheKey(spec, BASE), MODEL.slice());
    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      cacheOnly: true,
    });
    expect(result.fromCache).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skipCache downloads (and verifies) a fresh copy over a cached one', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    const key = modelCacheKey(spec, BASE);
    const corrupt = MODEL.slice();
    corrupt[10] ^= 0xff;
    entries.set(key, corrupt);
    const fetchImpl = vi.fn(async () => chunkedResponse(MODEL));
    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      skipCache: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fromCache: false, cached: true });
    expect(Array.from(entries.get(key) ?? [])).toEqual(Array.from(MODEL));
  });

  it('evicts a cached copy whose body cannot be read and downloads again', async () => {
    const spec = specFor(MODEL);
    const { storage, entries, cache } = createFakeCaches();
    const key = modelCacheKey(spec, BASE);
    entries.set(key, MODEL.slice());
    cache.match.mockImplementationOnce(async () => ({
      arrayBuffer: () => Promise.reject(new DOMException('blob gone', 'NotReadableError')),
    }));
    const fetchImpl = vi.fn(async () => chunkedResponse(MODEL));

    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    });
    expect(cache.delete).toHaveBeenCalledWith(key);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(Array.from(result.bytes)).toEqual(Array.from(MODEL));
    expect(Array.from(entries.get(key) ?? [])).toEqual(Array.from(MODEL));
  });

  it('works without Cache Storage', async () => {
    const result = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => chunkedResponse(MODEL),
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
    });
    expect(result).toMatchObject({ fromCache: false, cached: false });
  });

  it('still returns the model when caching fails (quota)', async () => {
    const { storage, cache } = createFakeCaches();
    cache.put.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const result = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => chunkedResponse(MODEL),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    });
    expect(result).toMatchObject({ fromCache: false, cached: false });
  });

  it('ignores a Cache Storage that cannot be opened', async () => {
    const storage = /** @type {CacheStorage} */ (
      /** @type {unknown} */ ({ open: () => Promise.reject(new Error('SecurityError')) })
    );
    const result = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => chunkedResponse(MODEL),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    });
    expect(result.cached).toBe(false);
  });

  it('reports HTTP errors as download failures, and 404 as a missing model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = (/** @type {() => Promise<Response>} */ fetchImpl) =>
      loadModelBytes(specFor(MODEL), {
        fetchImpl,
        cacheStorage: undefined,
        subtle,
        baseHref: BASE,
      }).catch((e) => e);

    const server = await load(async () => new Response('oops', { status: 503 }));
    expect(server.code).toBe(SegmentationErrorCode.DOWNLOAD_FAILED);
    expect(server.message).toContain('HTTP 503');

    const missing = await load(async () => new Response('missing', { status: 404 }));
    expect(missing.code).toBe(SegmentationErrorCode.MODEL_NOT_FOUND);
    expect(missing.message).toContain('HTTP 404');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm run models:fetch'));
    warn.mockRestore();
  });

  it('a web page served instead of the model (SPA fallback) is a missing model, not damage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = '<!DOCTYPE html><html><head></head><body></body></html>';
    const load = (/** @type {() => Promise<Response>} */ fetchImpl) =>
      loadModelBytes(specFor(MODEL), {
        fetchImpl,
        cacheStorage: undefined,
        subtle,
        baseHref: BASE,
      }).catch((e) => e);

    const typed = await load(
      async () => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    );
    expect(typed.code).toBe(SegmentationErrorCode.MODEL_NOT_FOUND);
    const untyped = await load(
      async () =>
        new Response(new TextEncoder().encode(`\n  ${page}`), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    );
    expect(untyped.code).toBe(SegmentationErrorCode.MODEL_NOT_FOUND);
    warn.mockRestore();
  });

  it('looksLikeHtml tells pages from model bytes', () => {
    const enc = (/** @type {string} */ t) => new TextEncoder().encode(t);
    expect(looksLikeHtml(enc('<!doctype html><html>'))).toBe(true);
    expect(looksLikeHtml(enc('  <HTML lang="en">'))).toBe(true);
    expect(looksLikeHtml(MODEL)).toBe(false);
    expect(looksLikeHtml(new Uint8Array(0))).toBe(false);
  });

  it('reports network errors as download failures', async () => {
    const error = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.DOWNLOAD_FAILED);
    expect(error.message).toContain('Failed to fetch');
  });

  it('reports an interrupted stream as a download failure', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(MODEL.slice(0, 10));
        controller.error(new Error('connection reset'));
      },
    });
    const error = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => new Response(body),
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.DOWNLOAD_FAILED);
    expect(error.message).toContain('interrupted');
  });

  it('rejects a body larger than the pinned size without buffering it', async () => {
    const bigger = new Uint8Array(1500);
    const error = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => chunkedResponse(bigger, 3),
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.HASH_MISMATCH);
    expect(error.message).toContain('larger');
  });

  it('rejects a short body and a wrong hash, and caches neither', async () => {
    const { storage, entries } = createFakeCaches();
    const short = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => chunkedResponse(MODEL.slice(0, 900)),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(short.code).toBe(SegmentationErrorCode.HASH_MISMATCH);

    const wrong = await loadModelBytes(specFor(MODEL, { sha256: '00'.repeat(32) }), {
      fetchImpl: async () => chunkedResponse(MODEL),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(wrong.code).toBe(SegmentationErrorCode.HASH_MISMATCH);
    expect(entries.size).toBe(0);
  });

  it('reads a body-less response in one piece', async () => {
    const response = /** @type {Response} */ (
      /** @type {unknown} */ ({
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => MODEL.slice().buffer,
      })
    );
    const result = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => response,
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
    });
    expect(result.bytes.byteLength).toBe(1000);
  });

  it('stops a download when its signal aborts: AbortError, nothing cached', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => chunkedResponse(MODEL, 4));
    const error = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.loadedBytes >= 250) controller.abort();
      },
    }).catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
    expect(entries.size).toBe(0);
  });

  it('reports a fetch aborted by its signal as an AbortError, not a download failure', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    const error = await loadModelBytes(specFor(MODEL), {
      fetchImpl,
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
      signal: controller.signal,
    }).catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(typeof error.code).not.toBe('string'); // not a SegmentationError code
  });

  it('does nothing for an already-aborted signal, and drops a cached copy read after an abort', async () => {
    const spec = specFor(MODEL);
    const fetchImpl = vi.fn();
    const aborted = AbortSignal.abort();
    await expect(
      loadModelBytes(spec, { fetchImpl, cacheStorage: undefined, subtle, signal: aborted }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const { storage, entries } = createFakeCaches();
    entries.set(modelCacheKey(spec, BASE), MODEL.slice());
    const controller = new AbortController();
    const error = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }).catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(fetchImpl).not.toHaveBeenCalled();
    // A cancelled load is not a corrupt entry: the cached copy stays
    expect(entries.has(modelCacheKey(spec, BASE))).toBe(true);
  });

  it('refuses to run without crypto.subtle', async () => {
    const error = await loadModelBytes(specFor(MODEL), {
      fetchImpl: vi.fn(),
      cacheStorage: undefined,
      subtle: /** @type {any} */ (null),
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.DOWNLOAD_FAILED);
  });
});

describe('downloadModelToCache / evictCachedModel / isModelIntact', () => {
  it('downloads, verifies and stores without reading the cache', async () => {
    const spec = specFor(MODEL);
    const { storage, entries, cache } = createFakeCaches();
    const onProgress = vi.fn();
    const result = await downloadModelToCache(spec, {
      fetchImpl: async () => chunkedResponse(MODEL),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      onProgress,
    });
    expect(result.cached).toBe(true);
    expect(cache.match).not.toHaveBeenCalled();
    expect(entries.has(modelCacheKey(spec, BASE))).toBe(true);
    expect(onProgress.mock.calls.at(-1)?.[0].phase).toBe('verifying');
  });

  it('never stores bytes that fail verification', async () => {
    const spec = specFor(MODEL, { sha256: 'ab'.repeat(32) });
    const { storage, entries } = createFakeCaches();
    const error = await downloadModelToCache(spec, {
      fetchImpl: async () => chunkedResponse(MODEL),
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.HASH_MISMATCH);
    expect(entries.size).toBe(0);
  });

  it('evicts the current copy only', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    const other = 'https://example.test/glinfs/models/other.onnx?sha256=00';
    entries.set(modelCacheKey(spec, BASE), MODEL.slice());
    entries.set(other, MODEL.slice());
    expect(await evictCachedModel(spec, { cacheStorage: storage, baseHref: BASE })).toBe(true);
    expect([...entries.keys()]).toEqual([other]);
    expect(await evictCachedModel(spec, { cacheStorage: undefined })).toBe(false);
  });

  it('tells intact bytes from damaged ones', async () => {
    const spec = specFor(MODEL);
    const damaged = MODEL.slice();
    damaged[3] ^= 1;
    expect(await isModelIntact(MODEL, spec, { subtle })).toBe(true);
    expect(await isModelIntact(damaged, spec, { subtle })).toBe(false);
  });
});
