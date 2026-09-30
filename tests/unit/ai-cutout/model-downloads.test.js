import { describe, expect, it, vi } from 'vitest';
import { createModelDownloads } from '../../../src/features/ai-cutout/model-downloads.js';
import { createAbortError } from '../../../src/features/ai-cutout/protocol.js';

const spec = (/** @type {string} */ id) => /** @type {any} */ ({ id, url: `/m/${id}`, bytes: 100 });

describe('createModelDownloads', () => {
  it('reports progress, then persists storage once the verified copy is cached', async () => {
    /** @type {(value: { bytes: Uint8Array, cached: boolean }) => void} */
    let finish = () => undefined;
    /** @type {any} */
    let options;
    const download = vi.fn(
      (_spec, opts) =>
        new Promise((resolve) => {
          options = opts;
          finish = resolve;
        }),
    );
    const persist = vi.fn(async () => true);
    let t = 0;
    const downloads = createModelDownloads({
      download: /** @type {any} */ (download),
      resolveSpec: spec,
      persist,
      now: () => (t += 1000),
    });
    const listener = vi.fn();
    downloads.subscribe(listener);
    const result = downloads.start('anime');
    // A second start joins the running download
    expect(downloads.start('anime')).toBe(result);
    expect(download).toHaveBeenCalledTimes(1);
    expect(downloads.get('anime')).toEqual({
      phase: 'downloading',
      loadedBytes: 0,
      totalBytes: 100,
    });
    options.onProgress({ phase: 'downloading', loadedBytes: 40, totalBytes: 100 });
    expect(downloads.get('anime')?.loadedBytes).toBe(40);
    expect(downloads.active).toBe(true);
    finish({ bytes: new Uint8Array(), cached: true });
    await expect(result).resolves.toEqual({ outcome: 'done', cached: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(downloads.get('anime')).toBeNull();
    expect(downloads.active).toBe(false);
    expect(listener).toHaveBeenCalled();
  });

  it('does not ask for persistence when nothing was cached, or on failure', async () => {
    const persist = vi.fn();
    const downloads = createModelDownloads({
      download: /** @type {any} */ (async () => ({ bytes: new Uint8Array(), cached: false })),
      resolveSpec: spec,
      persist,
    });
    await expect(downloads.start('general')).resolves.toMatchObject({ outcome: 'done' });
    const failing = createModelDownloads({
      download: async () => {
        throw new Error('HASH_MISMATCH');
      },
      resolveSpec: spec,
      persist,
    });
    const failed = await failing.start('general');
    expect(failed.outcome).toBe('failed');
    expect(persist).not.toHaveBeenCalled();
  });

  it('downloads the files of a two-file model one after the other as one download', async () => {
    const files = [
      { role: 'encoder', url: '/m/enc', bytes: 60, sha256: 'e' },
      { role: 'decoder', url: '/m/dec', bytes: 40, sha256: 'd' },
    ];
    /** @type {any[]} */
    const seen = [];
    const downloads = createModelDownloads({
      download: /** @type {any} */ (
        async (/** @type {any} */ file, /** @type {any} */ opts) => {
          opts.onProgress({ phase: 'downloading', loadedBytes: file.bytes / 2, totalBytes: 1 });
          seen.push([file.url, downloads.get('click')?.loadedBytes]);
          return { bytes: new Uint8Array(), cached: true };
        }
      ),
      isCached: async () => false,
      resolveSpec: () => /** @type {any} */ ({ id: 'click', bytes: 100, files }),
      persist: async () => true,
    });
    await expect(downloads.start('click')).resolves.toEqual({ outcome: 'done', cached: true });
    // Progress counts both files: the decoder's half is 60 + 20 of 100
    expect(seen).toEqual([
      ['/m/enc', 30],
      ['/m/dec', 80],
    ]);
  });

  it('skips a file of a two-file model that is already cached', async () => {
    const files = [
      { role: 'encoder', url: '/m/enc', bytes: 60, sha256: 'e' },
      { role: 'decoder', url: '/m/dec', bytes: 40, sha256: 'd' },
    ];
    const download = vi.fn(async () => ({ bytes: new Uint8Array(), cached: true }));
    const downloads = createModelDownloads({
      download: /** @type {any} */ (download),
      isCached: async (/** @type {any} */ file) => file.url === '/m/enc',
      resolveSpec: () => /** @type {any} */ ({ id: 'click', bytes: 100, files }),
      persist: async () => true,
    });
    await expect(downloads.start('click')).resolves.toMatchObject({ outcome: 'done' });
    expect(download).toHaveBeenCalledTimes(1);
    expect(/** @type {any} */ (download.mock.calls[0])[0].url).toBe('/m/dec');
  });

  it('cancel aborts the download', async () => {
    const downloads = createModelDownloads({
      download: /** @type {any} */ (
        (_spec, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(createAbortError()));
          })
      ),
      resolveSpec: spec,
      persist: vi.fn(),
    });
    const result = downloads.start('anime');
    downloads.cancel('anime');
    await expect(result).resolves.toEqual({ outcome: 'cancelled' });
  });
});
