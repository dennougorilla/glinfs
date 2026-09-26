/**
 * Downloaded models in Cache Storage (main thread, Settings)
 * @module features/ai-cutout/model-cache
 *
 * The segmentation worker keeps each verified model in Cache Storage under
 * `<model URL>?sha256=<pinned hash>` (see model-loader.js). Settings lists
 * which models are there and deletes them. Entries are matched by URL with
 * the query ignored, so a copy kept under an older pin (or under a DEV
 * test override) is found and deleted too.
 *
 * Every browser API is injectable for unit tests.
 */

import { getModelUrl } from './model-config.js';
import { MODEL_CACHE_NAME, MODEL_REGISTRY } from './model-registry.js';

/**
 * @typedef {Object} DownloadedModelInfo
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {number} bytes - Pinned size of the model file
 * @property {{ name: string, url: string }} license
 * @property {string} upstream
 * @property {boolean | null} cached - In Cache Storage (null: unknown, Cache Storage unavailable)
 */

/**
 * @typedef {Object} ModelCacheDeps
 * @property {CacheStorage | undefined} [cacheStorage] - Default: globalThis.caches
 * @property {string} [baseHref] - Resolves the model URLs (default: location.href)
 * @property {string} [baseUrl] - App base path (default: Vite's BASE_URL)
 */

/**
 * @param {ModelCacheDeps} deps
 * @returns {{ cacheStorage: CacheStorage | undefined, baseHref: string, baseUrl: string | undefined }}
 */
function resolveDeps(deps) {
  return {
    cacheStorage: 'cacheStorage' in deps ? deps.cacheStorage : globalThis.caches,
    baseHref: deps.baseHref ?? globalThis.location?.href ?? 'http://localhost/',
    baseUrl: deps.baseUrl,
  };
}

/**
 * Absolute URL (without query) the worker fetched a model from.
 * @param {string} modelId
 * @param {string} baseHref
 * @param {string | undefined} baseUrl
 * @returns {string}
 */
function modelHref(modelId, baseHref, baseUrl) {
  return new URL(getModelUrl(modelId, baseUrl), baseHref).href;
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
 * Every registered model and whether it is in Cache Storage.
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<DownloadedModelInfo[]>}
 */
export async function listDownloadedModels(deps = {}) {
  const { cacheStorage, baseHref, baseUrl } = resolveDeps(deps);
  const cache = await openExistingCache(cacheStorage);
  return Promise.all(
    MODEL_REGISTRY.map(async (entry) => {
      /** @type {boolean | null} */
      let cached = cacheStorage ? false : null;
      if (cache) {
        try {
          const hit = await cache.match(modelHref(entry.id, baseHref, baseUrl), {
            ignoreSearch: true,
          });
          cached = Boolean(hit);
        } catch {
          cached = null;
        }
      }
      return {
        id: entry.id,
        label: entry.label,
        description: entry.description,
        bytes: entry.bytes,
        license: entry.license,
        upstream: entry.upstream,
        cached,
      };
    }),
  );
}

/**
 * Delete every Cache Storage copy of a model.
 * @param {string} modelId
 * @param {ModelCacheDeps} [deps]
 * @returns {Promise<boolean>} Something was deleted
 */
export async function deleteDownloadedModel(modelId, deps = {}) {
  const { cacheStorage, baseHref, baseUrl } = resolveDeps(deps);
  const cache = await openExistingCache(cacheStorage);
  if (!cache) return false;
  // With ignoreSearch, Cache.delete removes every entry of that URL (one
  // per pinned hash)
  try {
    return await cache.delete(modelHref(modelId, baseHref, baseUrl), { ignoreSearch: true });
  } catch {
    return false;
  }
}
