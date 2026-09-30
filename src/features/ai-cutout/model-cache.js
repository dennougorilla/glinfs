/**
 * AI models in Cache Storage (main thread, Settings)
 * @module features/ai-cutout/model-cache
 *
 * The segmentation worker keeps each verified model in Cache Storage under
 * `<model URL>?sha256=<pinned hash>` (see model-loader.js). Settings lists
 * the whole bucket: a registered model counts as downloaded only under its
 * current key, and every other file in the bucket is an old file — a copy
 * under an earlier pin, or a model this version no longer ships (the fp32
 * isnetis.onnx of the first AI cutout release). Each one can be deleted on
 * its own, so nothing in the bucket is ever out of the user's reach.
 *
 * Every browser API is injectable for unit tests.
 */

import { getModelUrl } from './model-config.js';
import { modelCacheKey } from './model-loader.js';
import { MODEL_CACHE_NAME, MODEL_REGISTRY } from './model-registry.js';

/**
 * @typedef {Object} DownloadedModelInfo
 * @property {string} id
 * @property {string} label - What it is for ("General")
 * @property {string} modelName - The network ("ISNet (general-use)")
 * @property {string} description
 * @property {number} bytes - Pinned size of the model file
 * @property {{ name: string, url: string }} license
 * @property {string} upstream
 * @property {boolean | null} cached - Its current file is in Cache Storage (null: unknown)
 * @property {string[]} staleUrls - Keys of its file under earlier pins
 * @property {boolean} updateAvailable - Not cached under its current pin, but
 *   an older copy of its file is (the pinned file changed since)
 */

/**
 * A file in the model bucket that is no registered model's file.
 * @typedef {Object} OldModelFile
 * @property {string} url - Its exact Cache Storage key
 * @property {string} fileName - Last path segment of the URL
 * @property {number | null} bytes - Its size (null: unknown)
 */

/**
 * @typedef {Object} DownloadedModelsListing
 * @property {DownloadedModelInfo[]} models - Every registered model
 * @property {OldModelFile[]} oldFiles - Every other file in the bucket
 * @property {number} cachedBytes - Size of every model copy in the bucket
 *   (current and older pins of registered models, and old files)
 */

/**
 * @typedef {Object} ModelCacheDeps
 * @property {CacheStorage | undefined} [cacheStorage] - Default: globalThis.caches
 * @property {string} [baseHref] - Resolves the model URLs (default: location.href)
 * @property {string} [baseUrl] - App base path (default: Vite's BASE_URL)
 * @property {(modelId: string) => string} [getSha256] - The hash a model's
 *   key carries (default: its registry pin; the app passes the DEV override)
 */

/**
 * @param {ModelCacheDeps} deps
 */
function resolveDeps(deps) {
  return {
    cacheStorage: 'cacheStorage' in deps ? deps.cacheStorage : globalThis.caches,
    baseHref: deps.baseHref ?? globalThis.location?.href ?? 'http://localhost/',
    baseUrl: deps.baseUrl,
    getSha256:
      deps.getSha256 ??
      ((/** @type {string} */ id) =>
        /** @type {(typeof MODEL_REGISTRY)[number]} */ (MODEL_REGISTRY.find((e) => e.id === id))
          .sha256),
  };
}

/**
 * The Cache Storage key a model's current file is kept under.
 * @param {string} modelId
 * @param {ReturnType<typeof resolveDeps>} deps
 * @returns {string}
 */
function currentKey(modelId, { baseHref, baseUrl, getSha256 }) {
  return modelCacheKey(
    { url: getModelUrl(modelId, baseUrl), sha256: getSha256(modelId) },
    baseHref,
  );
}

/**
 * Open the model cache WITHOUT creating it, or null when it does not exist
 * or Cache Storage is unavailable.
 * @param {CacheStorage | undefined} cacheStorage
 * @returns {Promise<Cache | null>}
 */
async function openExistingCache(cacheStorage) {
  if (!cacheStorage) return null;
  try {
    if (!(await cacheStorage.has(MODEL_CACHE_NAME))) return null;
    return await cacheStorage.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * Size of a cached file: its Content-Length (the loader sets one), else
 * its body's size (a Blob backed by the cache, not read into memory).
 * @param {Cache} cache
 * @param {string} url
 * @returns {Promise<number | null>}
 */
async function cachedFileSize(cache, url) {
  try {
    const response = await cache.match(url);
    if (!response) return null;
    const length = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(length) && length > 0) return length;
    return (await response.blob()).size;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
function withoutSearch(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
function fileNameOf(url) {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
  } catch {
    return url;
  }
}

/**
 * Every registered model and whether its current file is in Cache Storage,
 * plus every other file in the bucket.
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<DownloadedModelsListing>}
 */
export async function listDownloadedModels(deps = {}) {
  const resolved = resolveDeps(deps);
  const cache = await openExistingCache(resolved.cacheStorage);
  // Every key of the bucket; empty when there is no bucket yet, null when
  // unknown (no Cache Storage, or it refused to list)
  /** @type {Set<string> | null} */
  let urls = resolved.cacheStorage ? new Set() : null;
  if (cache) {
    try {
      urls = new Set((await cache.keys()).map((request) => request.url));
    } catch {
      urls = null;
    }
  }
  const keys = new Map(MODEL_REGISTRY.map((entry) => [entry.id, currentKey(entry.id, resolved)]));
  const allUrls = cache && urls ? [...urls] : [];
  const models = MODEL_REGISTRY.map((entry) => {
    const key = /** @type {string} */ (keys.get(entry.id));
    const file = withoutSearch(key);
    const cached = urls ? urls.has(key) : null;
    const staleUrls = allUrls.filter((url) => url !== key && withoutSearch(url) === file);
    return {
      id: entry.id,
      label: entry.label,
      modelName: entry.modelName,
      description: entry.description,
      bytes: entry.bytes,
      license: entry.license,
      upstream: entry.upstream,
      cached,
      staleUrls,
      updateAvailable: cached === false && staleUrls.length > 0,
    };
  });
  const known = new Set(models.flatMap((model) => [keys.get(model.id), ...model.staleUrls]));
  const oldUrls = allUrls.filter((url) => !known.has(url));
  const oldFiles = await Promise.all(
    oldUrls.map(async (url) => ({
      url,
      fileName: fileNameOf(url),
      bytes: await cachedFileSize(/** @type {Cache} */ (cache), url),
    })),
  );
  const staleSizes = await Promise.all(
    models
      .flatMap((model) => model.staleUrls)
      .map((url) => cachedFileSize(/** @type {Cache} */ (cache), url)),
  );
  const cachedBytes =
    models.reduce((sum, model) => sum + (model.cached ? model.bytes : 0), 0) +
    [...staleSizes, ...oldFiles.map((file) => file.bytes)].reduce(
      (/** @type {number} */ sum, size) => sum + (size ?? 0),
      0,
    );
  return { models, oldFiles, cachedBytes };
}

/**
 * Delete one exact entry of the model bucket.
 * @param {string} url
 * @param {ModelCacheDeps} deps
 * @returns {Promise<boolean>} Something was deleted
 */
async function deleteEntry(url, deps) {
  const cache = await openExistingCache(resolveDeps(deps).cacheStorage);
  if (!cache) return false;
  try {
    return await cache.delete(url);
  } catch {
    return false;
  }
}

/**
 * Delete a model's file from Cache Storage: its current copy and its copies
 * under earlier pins (an update that was not downloaded yet).
 * @param {string} modelId
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<boolean>} Something was deleted
 */
export async function deleteDownloadedModel(modelId, deps = {}) {
  const resolved = resolveDeps(deps);
  const cache = await openExistingCache(resolved.cacheStorage);
  if (!cache) return false;
  try {
    return await cache.delete(withoutSearch(currentKey(modelId, resolved)), {
      ignoreSearch: true,
    });
  } catch {
    return false;
  }
}

/**
 * Whether a model's current file is in Cache Storage (false when unknown).
 * @param {string} modelId
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<boolean>}
 */
export async function isModelCached(modelId, deps = {}) {
  const resolved = resolveDeps(deps);
  const cache = await openExistingCache(resolved.cacheStorage);
  if (!cache) return false;
  try {
    return (await cache.match(currentKey(modelId, resolved))) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Delete an old file of the model bucket by its exact key.
 * @param {string} url - `OldModelFile.url`
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<boolean>} Something was deleted
 */
export function deleteCachedFile(url, deps = {}) {
  return deleteEntry(url, deps);
}
