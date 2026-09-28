/**
 * Downloaded models in Cache Storage (main thread, Settings)
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
 * @property {string} label
 * @property {string} description
 * @property {number} bytes - Pinned size of the model file
 * @property {{ name: string, url: string }} license
 * @property {string} upstream
 * @property {boolean | null} cached - Its current file is in Cache Storage (null: unknown)
 */

/**
 * A file in the model bucket that no registered model loads.
 * @typedef {Object} OldModelFile
 * @property {string} url - Its exact Cache Storage key
 * @property {string} fileName - Last path segment of the URL
 * @property {number | null} bytes - Its size (null: unknown)
 */

/**
 * @typedef {Object} DownloadedModelsListing
 * @property {DownloadedModelInfo[]} models - Every registered model
 * @property {OldModelFile[]} oldFiles - Every other file in the bucket
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
  const models = MODEL_REGISTRY.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    bytes: entry.bytes,
    license: entry.license,
    upstream: entry.upstream,
    cached: urls ? urls.has(/** @type {string} */ (keys.get(entry.id))) : null,
  }));
  const current = new Set(keys.values());
  const oldUrls = cache && urls ? [...urls].filter((url) => !current.has(url)) : [];
  const oldFiles = await Promise.all(
    oldUrls.map(async (url) => ({
      url,
      fileName: fileNameOf(url),
      bytes: await cachedFileSize(/** @type {Cache} */ (cache), url),
    })),
  );
  return { models, oldFiles };
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
 * Delete a model's current file from Cache Storage (old copies are
 * listed and deleted as old files).
 * @param {string} modelId
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<boolean>} Something was deleted
 */
export function deleteDownloadedModel(modelId, deps = {}) {
  return deleteEntry(currentKey(modelId, resolveDeps(deps)), deps);
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
