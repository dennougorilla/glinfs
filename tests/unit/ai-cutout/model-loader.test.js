import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  loadModelBytes,
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
    url: '/glinfs/models/isnetis.onnx',
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
    delete: vi.fn(async (key) => entries.delete(key)),
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
      `https://example.test/glinfs/models/isnetis.onnx?sha256=${spec.sha256}`,
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
    expect(fetchImpl).toHaveBeenCalledWith(spec.url, { cache: 'no-store' });
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

  it('serves a verified cached copy without fetching', async () => {
    const spec = specFor(MODEL);
    const { storage, entries } = createFakeCaches();
    entries.set(modelCacheKey(spec, BASE), MODEL.slice());
    const fetchImpl = vi.fn();
    const onProgress = vi.fn();

    const result = await loadModelBytes(spec, {
      fetchImpl,
      cacheStorage: storage,
      subtle,
      baseHref: BASE,
      onProgress,
    });
    expect(result.fromCache).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'verifying',
      loadedBytes: 1000,
      totalBytes: 1000,
      fromCache: true,
    });
  });

  it('evicts a corrupt cached copy and downloads again', async () => {
    const spec = specFor(MODEL);
    const { storage, entries, cache } = createFakeCaches();
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
    });
    expect(cache.delete).toHaveBeenCalledWith(key);
    expect(result.fromCache).toBe(false);
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

  it('reports HTTP errors as download failures', async () => {
    const error = await loadModelBytes(specFor(MODEL), {
      fetchImpl: async () => new Response('missing', { status: 404 }),
      cacheStorage: undefined,
      subtle,
      baseHref: BASE,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.DOWNLOAD_FAILED);
    expect(error.message).toContain('HTTP 404');
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
