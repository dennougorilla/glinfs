import { describe, expect, it } from 'vitest';
import {
  deleteCachedFile,
  deleteDownloadedModel,
  isModelCached,
  listDownloadedModels,
} from '../../../src/features/ai-cutout/model-cache.js';
import {
  MODEL_CACHE_NAME,
  MODEL_REGISTRY,
} from '../../../src/features/ai-cutout/model-registry.js';

const BASE = 'https://example.test/glinfs/editor';
const ANIME = /** @type {(typeof MODEL_REGISTRY)[number]} */ (
  MODEL_REGISTRY.find((e) => e.id === 'anime')
);
const GENERAL = /** @type {(typeof MODEL_REGISTRY)[number]} */ (
  MODEL_REGISTRY.find((e) => e.id === 'general')
);
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
    const { models, oldFiles, cachedBytes } = await listDownloadedModels({
      cacheStorage: storage,
      ...DEPS,
    });
    expect(models.map((m) => [m.id, m.cached])).toEqual([
      ['general', true],
      ['portrait', false],
      ['anime', false],
      ['click', false],
    ]);
    expect(models[0]).toMatchObject({
      label: 'General',
      modelName: 'ISNet (general-use)',
      bytes: 90_448_072,
      license: { name: 'Apache-2.0' },
      licenseNote: { linkLabel: 'DIS repository', url: 'https://github.com/xuebinqin/DIS' },
      updateAvailable: false,
    });
    expect(models[0].licenseNote.text).toMatch(/DIS5K.*non-commercial/);
    expect(models[1]).toMatchObject({
      label: 'Portrait',
      modelName: 'MODNet',
      bytes: 12_987_022,
      license: { name: 'Apache-2.0' },
      licenseNote: null,
    });
    expect(oldFiles).toEqual([]);
    expect(cachedBytes).toBe(GENERAL.bytes);
  });

  it('marks a model with only an older pin as update available; other files are old files', async () => {
    const stalePin = `${MODELS}/${ANIME.fileName}?sha256=${'0'.repeat(64)}`;
    const { storage } = fakeCaches({
      [FP32_KEY]: 176_069_933,
      [stalePin]: null,
      [GENERAL_KEY]: GENERAL.bytes,
    });
    const { models, oldFiles, cachedBytes } = await listDownloadedModels({
      cacheStorage: storage,
      ...DEPS,
    });
    // A stale pin of the anime file is not the anime model, but an update
    expect(models.map((m) => [m.id, m.cached, m.updateAvailable])).toEqual([
      ['general', true, false],
      ['portrait', false, false],
      ['anime', false, true],
      ['click', false, false],
    ]);
    expect(models[2].staleUrls).toEqual([stalePin]);
    expect(oldFiles).toEqual([{ url: FP32_KEY, fileName: 'isnetis.onnx', bytes: 176_069_933 }]);
    // Without a Content-Length the body's size (3) is used
    expect(cachedBytes).toBe(GENERAL.bytes + 176_069_933 + 3);
  });

  it('matches the pin the loader keys by (a DEV override of the hash)', async () => {
    const { storage } = fakeCaches({ [`${MODELS}/${ANIME.fileName}?sha256=stub`]: 170 });
    const { models, oldFiles } = await listDownloadedModels({
      cacheStorage: storage,
      ...DEPS,
      getSha256: (id) => (id === 'anime' ? 'stub' : GENERAL.sha256),
    });
    expect(models.find((m) => m.id === 'anime')?.cached).toBe(true);
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

describe('a model of two files (Click to select)', () => {
  const CLICK = /** @type {any} */ (MODEL_REGISTRY.find((e) => e.id === 'click'));
  const [ENCODER, DECODER] = CLICK.files;
  const ENCODER_KEY = `${MODELS}/${ENCODER.fileName}?sha256=${ENCODER.sha256}`;
  const DECODER_KEY = `${MODELS}/${DECODER.fileName}?sha256=${DECODER.sha256}`;

  it('is downloaded only with both files; one file alone still counts as used space', async () => {
    const { storage } = fakeCaches({ [ENCODER_KEY]: ENCODER.bytes });
    const deps = { cacheStorage: storage, ...DEPS };
    let listing = await listDownloadedModels(deps);
    const click = listing.models.find((m) => m.id === 'click');
    expect(click).toMatchObject({ label: 'Click to select', cached: false, bytes: CLICK.bytes });
    expect(listing.oldFiles).toEqual([]);
    expect(listing.cachedBytes).toBe(ENCODER.bytes);
    await expect(isModelCached('click', deps)).resolves.toBe(false);

    const both = fakeCaches({ [ENCODER_KEY]: ENCODER.bytes, [DECODER_KEY]: DECODER.bytes });
    const bothDeps = { cacheStorage: both.storage, ...DEPS };
    listing = await listDownloadedModels(bothDeps);
    expect(listing.models.find((m) => m.id === 'click')?.cached).toBe(true);
    expect(listing.cachedBytes).toBe(CLICK.bytes);
    await expect(isModelCached('click', bothDeps)).resolves.toBe(true);
  });

  it('marks an older pin of either file as an update, and deletes both files', async () => {
    const stale = `${MODELS}/${DECODER.fileName}?sha256=${'0'.repeat(64)}`;
    const { storage, buckets } = fakeCaches({ [ENCODER_KEY]: 1, [stale]: 1, [ANIME_KEY]: 1 });
    const deps = { cacheStorage: storage, ...DEPS };
    const { models, oldFiles } = await listDownloadedModels(deps);
    expect(models.find((m) => m.id === 'click')).toMatchObject({
      cached: false,
      updateAvailable: true,
      staleUrls: [stale],
    });
    expect(oldFiles).toEqual([]);
    await expect(deleteDownloadedModel('click', deps)).resolves.toBe(true);
    expect([...(buckets.get(MODEL_CACHE_NAME)?.keys() ?? [])]).toEqual([ANIME_KEY]);
  });

  it('keys each file by the hash getFiles gives (the DEV override of the stubs)', async () => {
    const { storage } = fakeCaches({
      [`${MODELS}/${ENCODER.fileName}?sha256=e`]: 1,
      [`${MODELS}/${DECODER.fileName}?sha256=d`]: 1,
    });
    const deps = {
      cacheStorage: storage,
      ...DEPS,
      getFiles: (/** @type {string} */ id) =>
        id === 'click'
          ? [
              { url: `/glinfs/models/${ENCODER.fileName}`, sha256: 'e' },
              { url: `/glinfs/models/${DECODER.fileName}`, sha256: 'd' },
            ]
          : [{ url: '/glinfs/models/x.onnx', sha256: 'x' }],
    };
    await expect(isModelCached('click', deps)).resolves.toBe(true);
    const { models, oldFiles } = await listDownloadedModels(deps);
    expect(models.find((m) => m.id === 'click')?.cached).toBe(true);
    expect(oldFiles).toEqual([]);
  });
});

describe('deleteDownloadedModel / deleteCachedFile', () => {
  it('deletes the model’s file (current and older pins) and nothing else', async () => {
    const { storage, buckets } = fakeCaches({
      [GENERAL_KEY]: 1,
      [`${MODELS}/${GENERAL.fileName}?sha256=${'0'.repeat(64)}`]: 1,
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

describe('isModelCached', () => {
  it('checks the current key only', async () => {
    const { storage } = fakeCaches({ [GENERAL_KEY]: 1 });
    await expect(isModelCached('general', { cacheStorage: storage, ...DEPS })).resolves.toBe(true);
    await expect(isModelCached('anime', { cacheStorage: storage, ...DEPS })).resolves.toBe(false);
    await expect(isModelCached('anime', { cacheStorage: undefined })).resolves.toBe(false);
  });
});
