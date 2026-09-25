/**
 * Model download, verification and caching (runs in the segmentation worker)
 * @module features/ai-cutout/model-loader
 *
 * The model is fetched same-origin with streaming progress, its size and
 * SHA-256 are checked against the pinned values, and the verified bytes are
 * kept in Cache Storage so later visits skip the download. A cached copy is
 * re-verified on every load and evicted when it no longer matches, so a
 * corrupt entry can never wedge the feature.
 *
 * Every browser API is injectable so the logic is unit-tested without a
 * browser.
 */

import { MODEL_CACHE_NAME } from './model-config.js';
import { SegmentationError, SegmentationErrorCode } from './protocol.js';

/** @typedef {import('./model-config.js').ModelSpec} ModelSpec */

/**
 * @typedef {Object} LoadProgress
 * @property {'downloading' | 'verifying'} phase
 * @property {number} loadedBytes
 * @property {number} totalBytes
 * @property {boolean} fromCache
 */

/**
 * @typedef {Object} ModelLoaderDeps
 * @property {typeof fetch} [fetchImpl]
 * @property {CacheStorage | undefined} [cacheStorage] - Omit/undefined to skip caching
 * @property {SubtleCrypto} [subtle]
 * @property {string} [baseHref] - Resolves a relative model URL (worker location)
 * @property {string} [cacheName]
 * @property {(progress: LoadProgress) => void} [onProgress]
 */

/**
 * @typedef {Object} LoadedModel
 * @property {Uint8Array} bytes - Verified model bytes
 * @property {boolean} fromCache - Served from Cache Storage
 * @property {boolean} cached - A verified copy is in Cache Storage now
 */

/**
 * Lowercase hex encoding of a digest.
 * @param {ArrayBuffer} digest
 * @returns {string}
 */
export function toHex(digest) {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Cache Storage key for a model. The expected hash is part of the key so a
 * new pinned model never matches an old cached one.
 * @param {ModelSpec} spec
 * @param {string} baseHref
 * @returns {string}
 */
export function modelCacheKey(spec, baseHref) {
  const url = new URL(spec.url, baseHref);
  url.searchParams.set('sha256', spec.sha256);
  return url.href;
}

/**
 * Throw HASH_MISMATCH unless `bytes` has the pinned size and SHA-256.
 * @param {Uint8Array} bytes
 * @param {ModelSpec} spec
 * @param {SubtleCrypto} subtle
 * @returns {Promise<void>}
 */
export async function verifyModelBytes(bytes, spec, subtle) {
  if (bytes.byteLength !== spec.bytes) {
    throw new SegmentationError(
      SegmentationErrorCode.HASH_MISMATCH,
      `The downloaded model has ${bytes.byteLength} bytes, expected ${spec.bytes}`,
    );
  }
  const actual = toHex(await subtle.digest('SHA-256', bytes));
  if (actual !== spec.sha256) {
    throw new SegmentationError(
      SegmentationErrorCode.HASH_MISMATCH,
      `The downloaded model's SHA-256 is ${actual}, expected ${spec.sha256}`,
    );
  }
}

/**
 * Stream a response body into one buffer of the expected size.
 * @param {Response} response
 * @param {number} expectedBytes
 * @param {(loaded: number) => void} onChunk
 * @returns {Promise<Uint8Array>}
 */
async function readBody(response, expectedBytes, onChunk) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onChunk(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(expectedBytes);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > expectedBytes) {
      await reader.cancel();
      throw new SegmentationError(
        SegmentationErrorCode.HASH_MISMATCH,
        `The downloaded model is larger than the expected ${expectedBytes} bytes`,
      );
    }
    buffer.set(value, loaded);
    loaded += value.byteLength;
    onChunk(loaded);
  }
  return loaded === expectedBytes ? buffer : buffer.slice(0, loaded);
}

/**
 * Open the model cache, or null when Cache Storage is unavailable.
 * @param {CacheStorage | undefined} cacheStorage
 * @param {string} cacheName
 * @returns {Promise<Cache | null>}
 */
async function openCache(cacheStorage, cacheName) {
  if (!cacheStorage) return null;
  try {
    return await cacheStorage.open(cacheName);
  } catch {
    return null;
  }
}

/**
 * Load the model: from Cache Storage when a verified copy is there,
 * otherwise from the network (then cached).
 * @param {ModelSpec} spec
 * @param {ModelLoaderDeps} [deps]
 * @returns {Promise<LoadedModel>}
 */
export async function loadModelBytes(spec, deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cacheStorage = globalThis.caches,
    subtle = globalThis.crypto?.subtle,
    baseHref = globalThis.location?.href ?? 'http://localhost/',
    cacheName = MODEL_CACHE_NAME,
    onProgress,
  } = deps;
  if (!subtle) {
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      'This page cannot verify the model (crypto.subtle needs a secure context)',
    );
  }

  const cache = await openCache(cacheStorage, cacheName);
  const key = modelCacheKey(spec, baseHref);

  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onProgress?.({
        phase: 'verifying',
        loadedBytes: bytes.byteLength,
        totalBytes: spec.bytes,
        fromCache: true,
      });
      try {
        await verifyModelBytes(bytes, spec, subtle);
        return { bytes, fromCache: true, cached: true };
      } catch {
        // Corrupt or stale entry: drop it and download a fresh copy
        await cache.delete(key).catch(() => false);
      }
    }
  }

  let response;
  try {
    // no-store: the verified copy lives in Cache Storage; keeping a second
    // 176 MB copy in the HTTP cache would only waste disk
    response = await fetchImpl(spec.url, { cache: 'no-store' });
  } catch (error) {
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      `The model download failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!response.ok) {
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      `The model download failed: HTTP ${response.status}`,
    );
  }

  onProgress?.({ phase: 'downloading', loadedBytes: 0, totalBytes: spec.bytes, fromCache: false });
  let bytes;
  try {
    bytes = await readBody(response, spec.bytes, (loaded) =>
      onProgress?.({
        phase: 'downloading',
        loadedBytes: loaded,
        totalBytes: spec.bytes,
        fromCache: false,
      }),
    );
  } catch (error) {
    if (error instanceof SegmentationError) throw error;
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      `The model download was interrupted: ${error instanceof Error ? error.message : error}`,
    );
  }

  onProgress?.({
    phase: 'verifying',
    loadedBytes: bytes.byteLength,
    totalBytes: spec.bytes,
    fromCache: false,
  });
  await verifyModelBytes(bytes, spec, subtle);

  let cached = false;
  if (cache) {
    try {
      await cache.put(
        key,
        new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.byteLength),
          },
        }),
      );
      cached = true;
    } catch {
      // Quota exceeded or storage disabled: the model still works this visit
    }
  }
  return { bytes, fromCache: false, cached };
}
