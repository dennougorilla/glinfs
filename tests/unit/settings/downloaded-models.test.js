import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeModelStatus,
  renderDownloadedModelsSection,
} from '../../../src/features/settings/downloaded-models.js';

/** @returns {import('../../../src/features/ai-cutout/model-cache.js').DownloadedModelInfo[]} */
function models({ anime = true, general = false } = {}) {
  return [
    {
      id: 'anime',
      label: 'Anime',
      description: 'Anime and illustrated characters',
      bytes: 176_069_933,
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
      upstream: 'https://github.com/SkyTNT/anime-segmentation',
      cached: anime,
    },
    {
      id: 'general',
      label: 'General',
      description: 'People, pets and objects in live-action video',
      bytes: 178_648_008,
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
      upstream: 'https://github.com/xuebinqin/DIS',
      cached: general,
    },
  ];
}

function fakeManager() {
  /** @type {Set<string>} */
  const busy = new Set();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    busy,
    isModelBusy: (/** @type {string} */ id) => busy.has(id),
    onBusyChange: (/** @type {() => void} */ listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {HTMLElement} section @param {string} id */
const row = (section, id) =>
  /** @type {HTMLElement} */ (section.querySelector(`[data-model-id="${id}"]`));
/** @param {HTMLElement} section @param {string} id */
const deleteButton = (section, id) =>
  /** @type {HTMLButtonElement} */ (section.querySelector(`[data-model-delete="${id}"]`));

describe('Settings → Downloaded models', () => {
  /** @type {Array<() => void>} */
  let cleanups;

  beforeEach(() => {
    cleanups = [];
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('lists each model with its size, license and cache state', async () => {
    const manager = fakeManager();
    const section = renderDownloadedModelsSection(cleanups, {
      list: async () => models(),
      remove: vi.fn(),
      manager,
    });
    document.body.append(section);
    expect(section.getAttribute('aria-labelledby')).toBe('settings-models-title');
    expect(section.querySelector('h2')?.textContent).toBe('Downloaded models');
    await flush();

    const anime = row(section, 'anime');
    expect(anime.querySelector('h3')?.textContent).toBe('Anime');
    expect(anime.textContent).toContain('176 MB');
    expect(anime.querySelector('a')?.textContent).toBe('Apache-2.0');
    expect(anime.textContent).toContain('Downloaded, kept in this browser’s cache');
    expect(deleteButton(section, 'anime').disabled).toBe(false);
    expect(deleteButton(section, 'anime').getAttribute('aria-label')).toBe(
      'Delete the Anime model',
    );

    expect(row(section, 'general').textContent).toContain('Not downloaded');
    expect(row(section, 'general').textContent).toContain('179 MB');
    expect(deleteButton(section, 'general').disabled).toBe(true);
    expect(section.querySelector('ul')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('deletes a model, unloads it, says so and refreshes the list', async () => {
    const manager = fakeManager();
    let cached = true;
    const remove = vi.fn(async () => {
      cached = false;
      return true;
    });
    const section = renderDownloadedModelsSection(cleanups, {
      list: async () => models({ anime: cached }),
      remove,
      manager,
    });
    document.body.append(section);
    await flush();

    deleteButton(section, 'anime').focus();
    deleteButton(section, 'anime').click();
    expect(deleteButton(section, 'anime').textContent).toBe('Deleting…');
    expect(deleteButton(section, 'anime').disabled).toBe(true);
    await flush();
    await flush();
    expect(remove).toHaveBeenCalledWith('anime');
    expect(manager.unloadModel).toHaveBeenCalledWith('anime');
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      'The Anime model was deleted.',
    );
    expect(row(section, 'anime').textContent).toContain('Not downloaded');
    // Focus stays on the row (its button is disabled now)
    expect(document.activeElement?.id).toBe('settings-model-anime-name');
  });

  it('refuses to delete a model a running analysis uses, and updates when it ends', async () => {
    const manager = fakeManager();
    manager.busy.add('anime');
    const remove = vi.fn(async () => true);
    const section = renderDownloadedModelsSection(cleanups, {
      list: async () => models(),
      remove,
      manager,
    });
    document.body.append(section);
    await flush();
    expect(deleteButton(section, 'anime').disabled).toBe(true);
    expect(row(section, 'anime').textContent).toContain('In use by a running analysis');

    // A click that slips through (the analysis started after the render)
    deleteButton(section, 'anime').disabled = false;
    deleteButton(section, 'anime').click();
    await flush();
    expect(remove).not.toHaveBeenCalled();

    manager.setBusy('anime', false);
    expect(deleteButton(section, 'anime').disabled).toBe(false);
    expect(row(section, 'anime').textContent).toContain('Downloaded');
  });

  it('reports a failed delete and a failed listing', async () => {
    const manager = fakeManager();
    const section = renderDownloadedModelsSection(cleanups, {
      list: async () => models(),
      remove: async () => {
        throw new Error('nope');
      },
      manager,
    });
    await flush();
    deleteButton(section, 'anime').click();
    await flush();
    await flush();
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      'The Anime model could not be deleted.',
    );

    const broken = renderDownloadedModelsSection(cleanups, {
      list: async () => {
        throw new Error('no caches');
      },
      manager,
    });
    await flush();
    expect(broken.querySelector('[role="status"]')?.textContent).toBe(
      'The downloaded models could not be listed.',
    );
  });

  it('writes nothing after its cleanup ran', async () => {
    const manager = fakeManager();
    /** @type {(value: any) => void} */
    let resolveList = () => {};
    const section = renderDownloadedModelsSection(cleanups, {
      list: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
      manager,
    });
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    expect(manager.listenerCount).toBe(0);
    resolveList(models());
    await flush();
    expect(section.querySelectorAll('li')).toHaveLength(0);
  });

  it('describes each state', () => {
    const [anime] = models();
    expect(describeModelStatus(anime, true)).toContain('In use');
    expect(describeModelStatus({ ...anime, cached: null }, false)).toContain('does not allow');
    expect(describeModelStatus({ ...anime, cached: false }, false)).toBe('Not downloaded');
  });
});
