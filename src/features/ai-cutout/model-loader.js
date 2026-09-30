/**
 * Model download, verification and caching
 * @module features/ai-cutout/model-loader
 *
 * The model is fetched same-origin with streaming progress, its size and
 * SHA-256 are checked against the pinned values, and only then are the
 * bytes kept in Cache Storage, under a key that carries the pinned SHA-256
 * (see modelCacheKey): nothing unverified is ever stored. Storing a
 * verified download removes the same model's copies under earlier pins.
 *
 * A cached copy is therefore NOT hashed again on every load (about 90 MB of
 * SHA-256 per model per visit): its key says which bytes were verified
 * before they were stored, so a load only checks its size. A copy that
 * nevertheless cannot become a session (the disk flipped a bit, a browser
 * bug) is handled by the segmentation worker: it hashes that copy, and when
 * it no longer matches evicts it and downloads a fresh, fully verified one
 * (see evictCachedModel and the worker's initialize()).
 *
 * The segmentation worker loads models through loadModelBytes; Settings
 * downloads one ahead of use through downloadModelToCache on the main
 * thread — the same download, verification and storage code.
 *
 * Every browser API is injectable so the logic is unit-tested without a
 * browser.
 */

import { MODEL_CACHE_NAME } from './model-config.js';
import { createAbortError, SegmentationError, SegmentationErrorCode } from './protocol.js';

/** @typedef {import('./model-config.js').ModelSpec} ModelSpec */

/**
 * Load progress. A copy read from Cache Storage reports one 'downloading'
 * step with `fromCache: true` (the UI says "Loading the model from this
 * browser's cache").
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
 * @property {AbortSignal} [signal] - Aborting stops the download and rejects
 *   with an AbortError (the model was unloaded while it loaded)
 * @property {boolean} [cacheOnly] - Never download: reject with
 *   MODEL_NOT_CACHED when no cached copy exists (preloading)
 * @property {boolean} [skipCache] - Ignore any cached copy and download a
 *   fresh one (after a cached copy failed to load)
 */

/**
 * @typedef {Object} LoadedModel
 * @property {Uint8Array} bytes - Model bytes: just verified (downloaded), or a
 *   cached copy that was verified before it was stored
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

/** HTTP statuses that mean the model file is not on the server */
const NOT_FOUND_STATUSES = new Set([404, 410]);

/**
 * Whether bytes are a text page (HTML) rather than a model: a server that
 * has no model file often answers with its index.html (SPA fallback) and a
 * 200, which would otherwise read as a damaged download
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function looksLikeHtml(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head');
}

/**
 * The MODEL_NOT_FOUND error for a model URL. A local build without the
 * model files hits this: say how to fetch them in the console.
 * @param {ModelSpec} spec
 * @param {string} reason
 * @returns {SegmentationError}
 */
function modelNotFound(spec, reason) {
  console.warn(
    `[ai-cutout] The model file ${spec.url} was not found (${reason}). In a local build, run \`npm run models:fetch\` to download the models.`,
  );
  return new SegmentationError(
    SegmentationErrorCode.MODEL_NOT_FOUND,
    `The model file was not found: ${reason}`,
  );
}

/**
 * Classify a download response that cannot be the model: not found (HTTP
 * 404/410, or an HTML page) or another HTTP failure. Null when it may be
 * the model.
 * @param {Response} response
 * @param {ModelSpec} spec
 * @returns {SegmentationError | null}
 */
export function classifyModelResponse(response, spec) {
  if (NOT_FOUND_STATUSES.has(response.status)) {
    return modelNotFound(spec, `HTTP ${response.status}`);
  }
  if (!response.ok) {
    return new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      `The model download failed: HTTP ${response.status}`,
    );
  }
  const type = response.headers?.get('content-type') ?? '';
  if (/^text\/html\b/i.test(type)) return modelNotFound(spec, 'the server sent a web page');
  return null;
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
 * @param {AbortSignal} [signal] - Stops reading (a fetch abort already
 *   fails the read; this also covers bodies that ignore it)
 * @returns {Promise<Uint8Array>}
 */
async function readBody(response, expectedBytes, onChunk, signal) {
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
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw createAbortError('Model load cancelled');
    }
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
 * Delete every entry of the same model URL whose key is not `key` (the
 * same file under an earlier SHA-256 pin). Failures are ignored: a stale
 * entry is only wasted space, and Settings can still delete it.
 * @param {Cache} cache
 * @param {string} key - The current key (URL with its `sha256` parameter)
 * @returns {Promise<void>}
 */
async function removeOlderPins(cache, key) {
  try {
    const url = new URL(key);
    url.search = '';
    const requests = await cache.keys(url.href, { ignoreSearch: true });
    await Promise.all(
      requests
        .filter((request) => request.url !== key)
        .map((request) => cache.delete(request).catch(() => false)),
    );
  } catch {
    // Listing is not essential
  }
}

/**
 * Resolve the injectable dependencies.
 * @param {ModelLoaderDeps} deps
 */
function resolveDeps(deps) {
  return {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    cacheStorage: 'cacheStorage' in deps ? deps.cacheStorage : globalThis.caches,
    subtle: 'subtle' in deps ? deps.subtle : globalThis.crypto?.subtle,
    baseHref: deps.baseHref ?? globalThis.location?.href ?? 'http://localhost/',
    cacheName: deps.cacheName ?? MODEL_CACHE_NAME,
    onProgress: deps.onProgress,
    signal: deps.signal,
  };
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError('Model load cancelled');
}

/**
 * The SubtleCrypto that verifies downloads, or DOWNLOAD_FAILED.
 * @param {SubtleCrypto | undefined | null} subtle
 * @returns {SubtleCrypto}
 */
function requireSubtle(subtle) {
  if (!subtle) {
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      'This page cannot verify the model (crypto.subtle needs a secure context)',
    );
  }
  return subtle;
}

/**
 * Download a model, verify its size and SHA-256 and store the verified
 * bytes in Cache Storage (removing its copies under earlier pins). Never
 * reads the cache: callers check it first.
 * @param {ModelSpec} spec
 * @param {ModelLoaderDeps} [deps]
 * @returns {Promise<{ bytes: Uint8Array, cached: boolean }>} cached: the
 *   verified copy is in Cache Storage now
 */
export async function downloadModelToCache(spec, deps = {}) {
  const { fetchImpl, cacheStorage, baseHref, cacheName, onProgress, signal, subtle } =
    resolveDeps(deps);
  throwIfAborted(signal);
  const verifier = requireSubtle(subtle);

  let response;
  try {
    // no-store: the verified copy lives in Cache Storage; keeping a second
    // copy of the model (about 90 MB) in the HTTP cache would only waste disk
    response = await fetchImpl(spec.url, { cache: 'no-store', signal });
  } catch (error) {
    throwIfAborted(signal);
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      `The model download failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  const rejected = classifyModelResponse(response, spec);
  if (rejected) throw rejected;

  onProgress?.({ phase: 'downloading', loadedBytes: 0, totalBytes: spec.bytes, fromCache: false });
  let bytes;
  try {
    bytes = await readBody(
      response,
      spec.bytes,
      (loaded) =>
        onProgress?.({
          phase: 'downloading',
          loadedBytes: loaded,
          totalBytes: spec.bytes,
          fromCache: false,
        }),
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
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
  // A page instead of the model (no content type to tell): not found, not
  // a damaged download
  if (bytes.byteLength !== spec.bytes && looksLikeHtml(bytes)) {
    throw modelNotFound(spec, 'the server sent a web page');
  }
  await verifyModelBytes(bytes, spec, verifier);
  throwIfAborted(signal);

  let cached = false;
  const cache = await openCache(cacheStorage, cacheName);
  if (cache) {
    const key = modelCacheKey(spec, baseHref);
    // Copies of this model under earlier pins can never load again: drop
    // them before storing the new one (it also frees the quota for it)
    await removeOlderPins(cache, key);
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
  return { bytes, cached };
}

/**
 * Delete a model's cached copy (under its current key).
 * @param {ModelSpec} spec
 * @param {ModelLoaderDeps} [deps]
 * @returns {Promise<boolean>} Something was deleted
 */
export async function evictCachedModel(spec, deps = {}) {
  const { cacheStorage, cacheName, baseHref } = resolveDeps(deps);
  const cache = await openCache(cacheStorage, cacheName);
  if (!cache) return false;
  return cache.delete(modelCacheKey(spec, baseHref)).catch(() => false);
}

/**
 * Whether bytes (a cached copy that failed to load) still have the pinned
 * size and SHA-256.
 * @param {Uint8Array} bytes
 * @param {ModelSpec} spec
 * @param {ModelLoaderDeps} [deps]
 * @returns {Promise<boolean>}
 */
export async function isModelIntact(bytes, spec, deps = {}) {
  const subtle = requireSubtle(resolveDeps(deps).subtle);
  try {
    await verifyModelBytes(bytes, spec, subtle);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the model: from Cache Storage when a copy is there (verified before
 * it was stored: only its size is checked), otherwise from the network
 * (verified, then cached).
 * @param {ModelSpec} spec
 * @param {ModelLoaderDeps} [deps]
 * @returns {Promise<LoadedModel>}
 * @throws {SegmentationError} MODEL_NOT_CACHED with `cacheOnly` and no cached copy
 */
export async function loadModelBytes(spec, deps = {}) {
  const { cacheStorage, baseHref, cacheName, onProgress, signal, subtle } = resolveDeps(deps);
  throwIfAborted(signal);
  // Checked before anything else: a download could not be verified
  requireSubtle(subtle);

  const cache = deps.skipCache ? null : await openCache(cacheStorage, cacheName);
  if (cache) {
    const key = modelCacheKey(spec, baseHref);
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      try {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        throwIfAborted(signal);
        // Verified before it was stored; a truncated entry fails this cheap check
        if (bytes.byteLength !== spec.bytes) {
          throw new Error(`The cached model has ${bytes.byteLength} bytes`);
        }
        onProgress?.({
          phase: 'downloading',
          loadedBytes: bytes.byteLength,
          totalBytes: spec.bytes,
          fromCache: true,
        });
        throwIfAborted(signal);
        return { bytes, fromCache: true, cached: true };
      } catch {
        throwIfAborted(signal);
        // Unreadable or truncated entry: drop it and download a fresh copy
        await cache.delete(key).catch(() => false);
      }
    }
  }

  if (deps.cacheOnly) {
    throw new SegmentationError(
      SegmentationErrorCode.MODEL_NOT_CACHED,
      'The model is not downloaded',
    );
  }
  const { bytes, cached } = await downloadModelToCache(spec, deps);
  return { bytes, fromCache: false, cached };
}
