import { describe, expect, it } from 'vitest';
import {
  deleteDownloadedModel,
  listDownloadedModels,
} from '../../../src/features/ai-cutout/model-cache.js';
import { MODEL_CACHE_NAME } from '../../../src/features/ai-cutout/model-registry.js';

const BASE = 'https://example.test/glinfs/editor';

/**
 * Minimal Cache Storage: URL keys, `ignoreSearch` like the real one.
 * @param {string[]} [urls] - Entries of the model cache (it exists when given)
 */
function fakeCaches(urls) {
  /** @type {Map<string, Set<string>>} */
  const buckets = new Map();
  if (urls) buckets.set(MODEL_CACHE_NAME, new Set(urls));
  /** @param {string} url */
  const stripSearch = (url) => url.split('?')[0];
  const opened = [];
  const storage = {
    has: async (/** @type {string} */ name) => buckets.has(name),
    open: async (/** @type {string} */ name) => {
      opened.push(name);
      let entries = buckets.get(name);
      if (!entries) {
        entries = new Set();
        buckets.set(name, entries);
      }
      const set = entries;
      /** @param {string} url @param {{ ignoreSearch?: boolean }} [options] */
      const matching = (url, options) =>
        [...set].filter((key) =>
          options?.ignoreSearch ? stripSearch(key) === stripSearch(url) : key === url,
        );
      return {
        match: async (/** @type {string} */ url, /** @type {any} */ options) =>
          matching(url, options).length > 0 ? new Response('x') : undefined,
        delete: async (/** @type {string} */ url, /** @type {any} */ options) => {
          const hits = matching(url, options);
          for (const key of hits) set.delete(key);
          return hits.length > 0;
        },
      };
    },
  };
  return { storage: /** @type {any} */ (storage), buckets, opened };
}

describe('listDownloadedModels', () => {
  it('lists every model with size and license, and which ones are cached', async () => {
    const { storage } = fakeCaches([
      // a copy under an older pin (or a test override) still counts
      'https://example.test/glinfs/models/isnet-general-use.onnx?sha256=old',
    ]);
    const models = await listDownloadedModels({
      cacheStorage: storage,
      baseHref: BASE,
      baseUrl: '/glinfs/',
    });
    expect(models.map((m) => [m.id, m.cached])).toEqual([
      ['anime', false],
      ['general', true],
    ]);
    expect(models[1]).toMatchObject({
      label: 'General',
      bytes: 178_648_008,
      license: { name: 'Apache-2.0' },
    });
  });

  it('never creates the cache just to look into it', async () => {
    const { storage, buckets, opened } = fakeCaches();
    const models = await listDownloadedModels({ cacheStorage: storage, baseHref: BASE });
    expect(models.every((m) => m.cached === false)).toBe(true);
    expect(opened).toEqual([]);
    expect(buckets.size).toBe(0);
  });

  it('reports unknown (null) without Cache Storage', async () => {
    const models = await listDownloadedModels({ cacheStorage: undefined, baseHref: BASE });
    expect(models.every((m) => m.cached === null)).toBe(true);
  });

  it('reports unknown when a lookup throws', async () => {
    const storage = /** @type {any} */ ({
      has: async () => true,
      open: async () => ({
        match: async () => {
          throw new Error('SecurityError');
        },
      }),
    });
    const models = await listDownloadedModels({ cacheStorage: storage, baseHref: BASE });
    expect(models.every((m) => m.cached === null)).toBe(true);
  });
});

describe('deleteDownloadedModel', () => {
  it('deletes every copy of that model and nothing else', async () => {
    const { storage, buckets } = fakeCaches([
      'https://example.test/models/isnet-general-use.onnx?sha256=a',
      'https://example.test/models/isnetis.onnx?sha256=b',
    ]);
    await expect(
      deleteDownloadedModel('general', { cacheStorage: storage, baseHref: BASE, baseUrl: '/' }),
    ).resolves.toBe(true);
    expect([...(buckets.get(MODEL_CACHE_NAME) ?? [])]).toEqual([
      'https://example.test/models/isnetis.onnx?sha256=b',
    ]);
    await expect(
      deleteDownloadedModel('general', { cacheStorage: storage, baseHref: BASE, baseUrl: '/' }),
    ).resolves.toBe(false);
  });

  it('returns false without a cache or when deleting throws', async () => {
    await expect(deleteDownloadedModel('anime', { cacheStorage: undefined })).resolves.toBe(false);
    const { storage } = fakeCaches();
    await expect(deleteDownloadedModel('anime', { cacheStorage: storage })).resolves.toBe(false);
    const throwing = /** @type {any} */ ({
      has: async () => true,
      open: async () => ({
        delete: async () => {
          throw new Error('nope');
        },
      }),
    });
    await expect(deleteDownloadedModel('anime', { cacheStorage: throwing })).resolves.toBe(false);
  });
});
