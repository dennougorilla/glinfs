import { describe, expect, it } from 'vitest';
import {
  deleteCachedFile,
  deleteDownloadedModel,
  listDownloadedModels,
} from '../../../src/features/ai-cutout/model-cache.js';
import {
  MODEL_CACHE_NAME,
  MODEL_REGISTRY,
} from '../../../src/features/ai-cutout/model-registry.js';

const BASE = 'https://example.test/glinfs/editor';
const [ANIME, GENERAL] = MODEL_REGISTRY;
const MODELS = 'https://example.test/glinfs/models';
const ANIME_KEY = `${MODELS}/${ANIME.fileName}?sha256=${ANIME.sha256}`;
const GENERAL_KEY = `${MODELS}/${GENERAL.fileName}?sha256=${GENERAL.sha256}`;
/** The fp32 anime model the first AI cutout release (#138) cached */
const FP32_KEY = `${MODELS}/isnetis.onnx?sha256=f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99`;
const DEPS = { baseHref: BASE, baseUrl: '/glinfs/' };

/**
 * Minimal Cache Storage: exact URL keys (plus `ignoreSearch` like the real
 * one), `keys()`, and responses with an optional Content-Length.
 * @param {Record<string, number | null>} [entries] - URL → Content-Length
 *   (null: no header) of the model cache; it exists when given
 */
function fakeCaches(entries) {
  /** @type {Map<string, Map<string, number | null>>} */
  const buckets = new Map();
  if (entries) buckets.set(MODEL_CACHE_NAME, new Map(Object.entries(entries)));
  /** @param {string} url */
  const stripSearch = (url) => url.split('?')[0];
  const opened = [];
  const storage = {
    has: async (/** @type {string} */ name) => buckets.has(name),
    open: async (/** @type {string} */ name) => {
      opened.push(name);
      let bucket = buckets.get(name);
      if (!bucket) {
        bucket = new Map();
        buckets.set(name, bucket);
      }
      const map = bucket;
      /** @param {string | { url: string }} request @param {{ ignoreSearch?: boolean }} [options] */
      const matching = (request, options) => {
        const url = typeof request === 'string' ? request : request.url;
        return [...map.keys()].filter((key) =>
          options?.ignoreSearch ? stripSearch(key) === stripSearch(url) : key === url,
        );
      };
      return {
        keys: async () => [...map.keys()].map((url) => ({ url })),
        match: async (/** @type {any} */ request, /** @type {any} */ options) => {
          const [hit] = matching(request, options);
          if (hit === undefined) return undefined;
          const length = map.get(hit);
          const headers = length === null ? {} : { 'Content-Length': String(length) };
          return new Response('abc', { headers });
        },
        delete: async (/** @type {any} */ request, /** @type {any} */ options) => {
          const hits = matching(request, options);
          for (const key of hits) map.delete(key);
          return hits.length > 0;
        },
      };
    },
  };
  return { storage: /** @type {any} */ (storage), buckets, opened };
}

describe('listDownloadedModels', () => {
  it('lists every model with size and license, and which ones are cached', async () => {
    const { storage } = fakeCaches({ [GENERAL_KEY]: GENERAL.bytes });
    const { models, oldFiles } = await listDownloadedModels({ cacheStorage: storage, ...DEPS });
    expect(models.map((m) => [m.id, m.cached])).toEqual([
      ['anime', false],
      ['general', true],
    ]);
    expect(models[1]).toMatchObject({
      label: 'General',
      bytes: 90_448_072,
      license: { name: 'Apache-2.0' },
    });
    expect(oldFiles).toEqual([]);
  });

  it('lists every other file of the bucket as an old file: stale pins and the fp32 model', async () => {
    const stalePin = `${MODELS}/${ANIME.fileName}?sha256=${'0'.repeat(64)}`;
    const { storage } = fakeCaches({
      [FP32_KEY]: 176_069_933,
      [stalePin]: null,
      [GENERAL_KEY]: GENERAL.bytes,
    });
    const { models, oldFiles } = await listDownloadedModels({ cacheStorage: storage, ...DEPS });
    // A stale pin of the anime file is not the anime model
    expect(models.map((m) => [m.id, m.cached])).toEqual([
      ['anime', false],
      ['general', true],
    ]);
    expect(oldFiles).toEqual([
      { url: FP32_KEY, fileName: 'isnetis.onnx', bytes: 176_069_933 },
      // Without a Content-Length the body's size is used
      { url: stalePin, fileName: ANIME.fileName, bytes: 3 },
    ]);
  });

  it('matches the pin the loader keys by (a DEV override of the hash)', async () => {
    const { storage } = fakeCaches({ [`${MODELS}/${ANIME.fileName}?sha256=stub`]: 170 });
    const { models, oldFiles } = await listDownloadedModels({
      cacheStorage: storage,
      ...DEPS,
      getSha256: (id) => (id === 'anime' ? 'stub' : GENERAL.sha256),
    });
    expect(models[0].cached).toBe(true);
    expect(oldFiles).toEqual([]);
  });

  it('never creates the cache just to look into it', async () => {
    const { storage, buckets, opened } = fakeCaches();
    const { models, oldFiles } = await listDownloadedModels({ cacheStorage: storage, ...DEPS });
    expect(models.every((m) => m.cached === false)).toBe(true);
    expect(oldFiles).toEqual([]);
    expect(opened).toEqual([]);
    expect(buckets.size).toBe(0);
  });

  it('reports unknown (null) without Cache Storage', async () => {
    const { models, oldFiles } = await listDownloadedModels({ cacheStorage: undefined, ...DEPS });
    expect(models.every((m) => m.cached === null)).toBe(true);
    expect(oldFiles).toEqual([]);
  });

  it('reports unknown when listing the bucket throws', async () => {
    const storage = /** @type {any} */ ({
      has: async () => true,
      open: async () => ({
        keys: async () => {
          throw new Error('SecurityError');
        },
      }),
    });
    const { models } = await listDownloadedModels({ cacheStorage: storage, ...DEPS });
    expect(models.every((m) => m.cached === null)).toBe(true);
  });
});

describe('deleteDownloadedModel / deleteCachedFile', () => {
  it('deletes the model’s current file and nothing else', async () => {
    const { storage, buckets } = fakeCaches({
      [GENERAL_KEY]: 1,
      [ANIME_KEY]: 1,
      [FP32_KEY]: 1,
    });
    await expect(
      deleteDownloadedModel('general', { cacheStorage: storage, ...DEPS }),
    ).resolves.toBe(true);
    expect([...(buckets.get(MODEL_CACHE_NAME)?.keys() ?? [])]).toEqual([ANIME_KEY, FP32_KEY]);
    await expect(
      deleteDownloadedModel('general', { cacheStorage: storage, ...DEPS }),
    ).resolves.toBe(false);
  });

  it('deletes one old file by its exact URL', async () => {
    const { storage, buckets } = fakeCaches({ [ANIME_KEY]: 1, [FP32_KEY]: 1 });
    await expect(deleteCachedFile(FP32_KEY, { cacheStorage: storage })).resolves.toBe(true);
    expect([...(buckets.get(MODEL_CACHE_NAME)?.keys() ?? [])]).toEqual([ANIME_KEY]);
    await expect(deleteCachedFile(FP32_KEY, { cacheStorage: storage })).resolves.toBe(false);
  });

  it('returns false without a cache or when deleting throws', async () => {
    await expect(deleteDownloadedModel('anime', { cacheStorage: undefined })).resolves.toBe(false);
    await expect(deleteCachedFile(FP32_KEY, { cacheStorage: undefined })).resolves.toBe(false);
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
    await expect(deleteCachedFile(FP32_KEY, { cacheStorage: throwing })).resolves.toBe(false);
  });
});
