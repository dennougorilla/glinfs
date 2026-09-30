import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';
import {
  deriveModelStatus,
  describeDownloadResult,
  describeStorage,
  renderAiModelsSection,
} from '../../../src/features/settings/downloaded-models.js';

const APACHE = { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' };

/**
 * @param {{ anime?: boolean | null, general?: boolean | null, animeStale?: boolean }} [options]
 * @returns {import('../../../src/features/ai-cutout/model-cache.js').DownloadedModelInfo[]}
 */
function modelInfos({ anime = true, general = false, animeStale = false } = {}) {
  return [
    {
      id: 'general',
      label: 'General',
      modelName: 'ISNet (general-use)',
      description: 'People, pets and objects in live-action video',
      bytes: 90_448_072,
      license: APACHE,
      upstream: 'https://github.com/xuebinqin/DIS',
      cached: general,
      staleUrls: [],
      updateAvailable: false,
    },
    {
      id: 'anime',
      label: 'Anime',
      modelName: 'ISNet (isnet-anime)',
      description: 'Anime and illustrated characters',
      bytes: 88_070_957,
      license: APACHE,
      upstream: 'https://github.com/SkyTNT/anime-segmentation',
      cached: anime,
      staleUrls: animeStale ? [STALE_URL] : [],
      updateAvailable: anime === false && animeStale,
    },
  ];
}

const FP32_URL = 'https://example.test/models/isnetis.onnx?sha256=f156';
const STALE_URL = 'https://example.test/models/isnetis-fp16.onnx?sha256=old';

/**
 * A listing as listDownloadedModels returns it
 * @param {{ anime?: boolean | null, general?: boolean | null, animeStale?: boolean, oldFiles?: import('../../../src/features/ai-cutout/model-cache.js').OldModelFile[] }} [options]
 */
function models({ oldFiles = [], ...cached } = {}) {
  const list = modelInfos(cached);
  return {
    models: list,
    oldFiles,
    cachedBytes: list.reduce((sum, m) => sum + (m.cached ? m.bytes : 0), 0),
  };
}

function fakeManager() {
  /** @type {Set<string>} */
  const busy = new Set();
  /** @type {Set<string>} */
  const loaded = new Set();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const subscribe = (/** @type {() => void} */ listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    busy,
    loaded,
    isModelBusy: (/** @type {string} */ id) => busy.has(id),
    getReadyInfo: (/** @type {string} */ id) => (loaded.has(id) ? { modelId: id } : null),
    onBusyChange: subscribe,
    onModelStateChange: subscribe,
    unloadModel: vi.fn(() => true),
    /** @param {string} id @param {boolean} on */
    setBusy(id, on) {
      if (on) busy.add(id);
      else busy.delete(id);
      for (const listener of listeners) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function fakeDownloads() {
  /** @type {Map<string, { state: any, resolve: (r: any) => void }>} */
  const running = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    running,
    start: vi.fn(
      (/** @type {string} */ id) =>
        new Promise((resolve) => {
          running.set(id, {
            state: { phase: 'downloading', loadedBytes: 0, totalBytes: 100 },
            resolve: (result) => {
              running.delete(id);
              notify();
              resolve(result);
            },
          });
          notify();
        }),
    ),
    cancel: vi.fn((/** @type {string} */ id) => running.get(id)?.resolve({ outcome: 'cancelled' })),
    get: (/** @type {string} */ id) => running.get(id)?.state ?? null,
    subscribe: (/** @type {() => void} */ listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** @param {string} id @param {number} loaded */
    progress(id, loaded) {
      const entry = running.get(id);
      if (entry) entry.state = { ...entry.state, loadedBytes: loaded };
      notify();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

/** @param {HTMLElement} section @param {string} id */
const row = (section, id) =>
  /** @type {HTMLElement} */ (section.querySelector(`[data-model-id="${id}"]`));
/** @param {HTMLElement} section @param {string} attr @param {string} id */
const btn = (section, attr, id) =>
  /** @type {HTMLButtonElement | null} */ (section.querySelector(`[data-model-${attr}="${id}"]`));

describe('Settings → AI models', () => {
  /** @type {Array<() => void>} */
  let cleanups;

  beforeEach(() => {
    cleanups = [];
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });

  /** @param {Partial<import('../../../src/features/settings/downloaded-models.js').DownloadedModelsDeps>} deps */
  function mount(deps = {}) {
    const manager = fakeManager();
    const downloads = fakeDownloads();
    const section = renderAiModelsSection(cleanups, {
      list: async () => models(),
      remove: vi.fn(async () => true),
      manager,
      downloads,
      isPersistent: async () => true,
      estimateUsage: async () => 178_000_000,
      confirm: () => true,
      preloadSetting: { get: () => true, set: vi.fn() },
      ...deps,
    });
    document.body.append(section);
    return { section, manager, downloads };
  }

  it('lists each model purpose first, with name, description, size, license and state', async () => {
    const { section } = mount();
    expect(section.querySelector('h2')?.textContent).toBe('AI models');
    await settle();

    const rows = [...section.querySelectorAll('[data-model-id]')];
    expect(rows.map((r) => r.getAttribute('data-model-id'))).toEqual(['general', 'anime']);
    const anime = row(section, 'anime');
    expect(anime.querySelector('h3')?.textContent).toBe('AnimeISNet (isnet-anime)');
    expect(anime.querySelector('.settings-models-name')?.textContent).toBe('ISNet (isnet-anime)');
    expect(anime.textContent).toContain('Anime and illustrated characters');
    expect(anime.textContent).toContain('88 MB');
    expect(anime.querySelector('a')?.textContent).toBe('Apache-2.0');
    expect(anime.dataset.modelStatus).toBe('downloaded');
    expect(btn(section, 'delete', 'anime')?.disabled).toBe(false);
    expect(btn(section, 'download', 'anime')).toBeNull();

    const general = row(section, 'general');
    expect(general.dataset.modelStatus).toBe('not-downloaded');
    expect(btn(section, 'download', 'general')?.getAttribute('aria-label')).toBe(
      'Download the General model (90 MB)',
    );
    expect(btn(section, 'delete', 'general')).toBeNull();
    expect(section.querySelector('#settings-models-storage')?.textContent).toBe(
      'Storage used: 178 MB · Stored persistently',
    );
    expect(
      /** @type {HTMLButtonElement} */ (section.querySelector('#settings-models-download-all'))
        .disabled,
    ).toBe(false);
  });

  it('downloads with progress and Cancel, then lists the model as downloaded', async () => {
    let cached = false;
    const { section, downloads } = mount({ list: async () => models({ anime: cached }) });
    await settle();
    btn(section, 'download', 'anime')?.click();
    expect(downloads.start).toHaveBeenCalledWith('anime');
    downloads.progress('anime', 42);
    expect(row(section, 'anime').dataset.modelStatus).toBe('downloading');
    expect(row(section, 'anime').textContent).toContain('Downloading 42%');
    expect(
      /** @type {HTMLProgressElement} */ (row(section, 'anime').querySelector('progress')).value,
    ).toBeCloseTo(0.42);
    expect(btn(section, 'cancel', 'anime')).not.toBeNull();

    cached = true;
    downloads.running.get('anime')?.resolve({ outcome: 'done', cached: true });
    await settle();
    expect(row(section, 'anime').dataset.modelStatus).toBe('downloaded');
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      'The Anime model was downloaded.',
    );
  });

  it('cancels a download', async () => {
    const { section, downloads } = mount({ list: async () => models({ anime: false }) });
    await settle();
    btn(section, 'download', 'anime')?.click();
    btn(section, 'cancel', 'anime')?.click();
    expect(downloads.cancel).toHaveBeenCalledWith('anime');
    await settle();
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      'The Anime model download was cancelled.',
    );
    expect(row(section, 'anime').dataset.modelStatus).toBe('not-downloaded');
  });

  it('Download all fetches the missing models one after another', async () => {
    const cached = { general: false, anime: false };
    const { section, downloads } = mount({ list: async () => models(cached) });
    await settle();
    /** @type {HTMLButtonElement} */ (
      section.querySelector('#settings-models-download-all')
    ).click();
    await flush();
    expect(downloads.start.mock.calls.map((c) => c[0])).toEqual(['general']);
    cached.general = true;
    downloads.running.get('general')?.resolve({ outcome: 'done', cached: true });
    await settle();
    expect(downloads.start.mock.calls.map((c) => c[0])).toEqual(['general', 'anime']);
    cached.anime = true;
    downloads.running.get('anime')?.resolve({ outcome: 'done', cached: true });
    await settle();
    expect(
      /** @type {HTMLButtonElement} */ (section.querySelector('#settings-models-download-all'))
        .disabled,
    ).toBe(true);
  });

  it('shows Loaded for a model whose session is in memory', async () => {
    const { section, manager } = mount();
    manager.loaded.add('anime');
    await settle();
    expect(row(section, 'anime').dataset.modelStatus).toBe('loaded');
  });

  it('deletes after confirming, unloads the model and refreshes the list', async () => {
    let cached = true;
    const remove = vi.fn(async () => {
      cached = false;
      return true;
    });
    const confirm = vi.fn(() => false);
    const { section, manager } = mount({
      list: async () => models({ anime: cached }),
      remove,
      confirm,
    });
    await settle();
    btn(section, 'delete', 'anime')?.click();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Delete the Anime model (88 MB)?'),
    );
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    btn(section, 'delete', 'anime')?.focus();
    btn(section, 'delete', 'anime')?.click();
    expect(btn(section, 'delete', 'anime')?.textContent).toBe('Deleting…');
    await settle();
    expect(remove).toHaveBeenCalledWith('anime');
    expect(manager.unloadModel).toHaveBeenCalledWith('anime');
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      'The Anime model was deleted.',
    );
    expect(row(section, 'anime').dataset.modelStatus).toBe('not-downloaded');
    // Focus moves to the row's remaining button (Download)
    expect(document.activeElement?.getAttribute('data-model-download')).toBe('anime');
  });

  it('refuses to delete a model a running analysis uses, and updates when it ends', async () => {
    const remove = vi.fn(async () => true);
    const { section, manager } = mount({ remove });
    manager.busy.add('anime');
    await settle();
    expect(btn(section, 'delete', 'anime')?.disabled).toBe(true);
    expect(row(section, 'anime').textContent).toContain('In use by a running analysis');
    const button = /** @type {HTMLButtonElement} */ (btn(section, 'delete', 'anime'));
    button.disabled = false;
    button.click();
    await flush();
    expect(remove).not.toHaveBeenCalled();
    manager.setBusy('anime', false);
    expect(btn(section, 'delete', 'anime')?.disabled).toBe(false);
  });

  it('offers Update for a model cached under an older pin, and Delete removes it', async () => {
    const { section } = mount({ list: async () => models({ anime: false, animeStale: true }) });
    await settle();
    expect(row(section, 'anime').dataset.modelStatus).toBe('update-available');
    expect(btn(section, 'download', 'anime')?.textContent).toBe('Update');
    expect(btn(section, 'delete', 'anime')).not.toBeNull();
  });

  it('lists old files, deletes one on its own, and reports failures', async () => {
    let oldFiles = [{ url: FP32_URL, fileName: 'isnetis.onnx', bytes: 176_069_933 }];
    const removeFile = vi.fn(async () => {
      oldFiles = [];
      return true;
    });
    const { section } = mount({ list: async () => models({ oldFiles }), removeFile });
    await settle();
    const oldRow = /** @type {HTMLElement} */ (section.querySelector('[data-old-file]'));
    expect(oldRow.querySelector('h3')?.textContent).toBe('Old model file');
    expect(oldRow.textContent).toContain('isnetis.onnx · 176 MB');
    /** @type {HTMLButtonElement} */ (oldRow.querySelector('button')).click();
    await settle();
    expect(removeFile).toHaveBeenCalledWith(FP32_URL);
    expect(section.querySelectorAll('[data-old-file]')).toHaveLength(0);

    document.body.innerHTML = '';
    const broken = mount({
      list: async () => {
        throw new Error('no caches');
      },
    });
    await settle();
    expect(broken.section.querySelector('[role="status"]')?.textContent).toBe(
      'The AI models could not be listed.',
    );
  });

  it('toggles "Prepare downloaded models when the editor opens"', async () => {
    let on = true;
    const set = vi.fn((/** @type {boolean} */ value) => {
      on = value;
    });
    const { section } = mount({ preloadSetting: { get: () => on, set } });
    const toggle = /** @type {HTMLButtonElement} */ (
      section.querySelector('#settings-models-preload')
    );
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(set).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toBe('Off');
  });

  it('writes nothing after its cleanup ran', async () => {
    /** @type {(value: any) => void} */
    let resolveList = () => {};
    const { section, manager } = mount({
      list: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    expect(manager.listenerCount).toBe(0);
    resolveList(models());
    await settle();
    expect(section.querySelectorAll('li')).toHaveLength(0);
  });
});

describe('deriveModelStatus', () => {
  const base = { cached: false, updateAvailable: false };
  it('derives each state, most specific first', () => {
    expect(deriveModelStatus(base).kind).toBe('not-downloaded');
    expect(deriveModelStatus({ ...base, cached: true })).toEqual({
      kind: 'downloaded',
      text: 'Downloaded',
    });
    expect(deriveModelStatus({ ...base, cached: null }).kind).toBe('unknown');
    expect(deriveModelStatus({ cached: false, updateAvailable: true }).kind).toBe(
      'update-available',
    );
    expect(deriveModelStatus({ ...base, cached: true }, { loaded: true }).kind).toBe('loaded');
    expect(
      deriveModelStatus(
        { ...base, cached: true },
        { loaded: true, download: { phase: 'downloading', loadedBytes: 88, totalBytes: 100 } },
      ),
    ).toEqual({ kind: 'downloading', text: 'Downloading 88%' });
    expect(
      deriveModelStatus(base, {
        download: { phase: 'verifying', loadedBytes: 100, totalBytes: 100 },
      }).text,
    ).toBe('Checking the download…');
    expect(deriveModelStatus({ ...base, cached: true }, { busy: true }).text).toContain('In use');
  });
});

describe('describeStorage / describeDownloadResult', () => {
  it('says whether storage is persistent, falling back to the model sizes', () => {
    expect(describeStorage({ persistent: true, usage: 5_000_000, fallbackBytes: 1 })).toBe(
      'Storage used: 5 MB · Stored persistently',
    );
    expect(describeStorage({ persistent: false, usage: null, fallbackBytes: 90_000_000 })).toBe(
      'Storage used: 90 MB · Browser may clear these when space is low',
    );
    expect(describeStorage({ persistent: null, usage: null, fallbackBytes: 0 })).toBe(
      'Storage used: 0 MB',
    );
  });

  it('describes each download outcome', () => {
    expect(describeDownloadResult('Anime', { outcome: 'done', cached: false })).toContain(
      'could not keep it',
    );
    expect(
      describeDownloadResult('Anime', {
        outcome: 'failed',
        error: { code: SegmentationErrorCode.HASH_MISMATCH },
      }),
    ).toContain('damaged');
    expect(describeDownloadResult('Anime', { outcome: 'failed', error: new Error('x') })).toContain(
      'Check your connection',
    );
  });
});
