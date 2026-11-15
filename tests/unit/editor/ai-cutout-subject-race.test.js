/**
 * Choosing subject cards before the model availability is known (#187):
 * the last choice waits for the current availability, an earlier one that
 * it superseded does nothing, and a downloaded model wins over the BEN2
 * first-run default. Cache checks are deferred and answered in request
 * order, like a slow Cache Storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/ai-cutout/segmentation-manager.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  const fake = {
    getCapabilities: vi.fn(async () => ({ webgpu: false })),
    getReadyInfo: vi.fn(() => null),
    analyzeFrames: vi.fn(async (frames) => ({
      analyzed: 0,
      skipped: frames.length,
      backend: 'wasm',
    })),
    dispose: vi.fn(),
    forgetClip: vi.fn(),
  };
  return { ...actual, getSegmentationManager: () => fake, __fake: fake };
});

vi.mock('../../../src/features/ai-cutout/model-cache.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  /** @type {{ id: string, resolve: (cached: boolean) => void }[]} */
  const pending = [];
  /** @type {Record<string, boolean>} */
  const cached = {};
  const isModelCached = vi.fn(
    (/** @type {string} */ id) =>
      new Promise((resolve) => {
        pending.push({ id, resolve });
      }),
  );
  return { ...actual, isModelCached, __cache: { pending, cached } };
});

import { getSharedMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import * as modelCache from '../../../src/features/ai-cutout/model-cache.js';
import * as segmentation from '../../../src/features/ai-cutout/segmentation-manager.js';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

const fake = /** @type {any} */ (segmentation).__fake;
const cache = /** @type {any} */ (modelCache).__cache;

/** Let pending promise callbacks run */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Answer the cache checks in request order until none is left */
async function answerCacheChecks() {
  for (let round = 0; round < 50 && cache.pending.length > 0; round++) {
    const { id, resolve } = cache.pending.shift();
    resolve(Boolean(cache.cached[id]));
    await flush();
  }
  await flush();
}

/** @param {string} id */
function check(id) {
  const input = /** @type {HTMLInputElement} */ (document.querySelector(`#${id}`));
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('subject choice while the model availability is checked (#187)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    resetAppStore();
    getSharedMaskStore().clear();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
    cache.pending.length = 0;
    for (const key of Object.keys(cache.cached)) delete cache.cached[key];
    fake.analyzeFrames.mockClear();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    getSharedMaskStore().clear();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
  });

  it('applies the downloaded model of the last choice, not BEN2 or a superseded one', async () => {
    cache.cached.general = true;
    setClipPayload({
      frames: Array.from({ length: 2 }, (_, i) => ({
        id: `f${i}`,
        data: { data: new Uint8ClampedArray(10 * 10 * 4), width: 10, height: 10 },
        timestamp: i * 33,
        width: 10,
        height: 10,
      })),
      fps: 10,
      capturedAt: Date.now(),
      id: 'clip-race',
    });
    cleanup = /** @type {() => void} */ (initEditor());
    if (getEditorState()?.isPlaying)
      /** @type {HTMLElement} */ (document.querySelector('.btn-play')).click();
    await flush();
    // The mount's cache checks are still pending: Person, then Anything
    expect(cache.pending.length).toBeGreaterThan(0);
    check('subject-portrait');
    await flush();
    check('subject-general');
    await flush();
    await answerCacheChecks();

    const state = getEditorState();
    expect(state?.aiCutout.models?.general).toBe('cached');
    expect(state?.downloadPrompt ?? null).toBeNull();
    expect(state?.edits.background).toMatchObject({ enabled: true, method: 'ai' });
    expect(state?.edits.background.ai.model).toBe('general');
    // Person (superseded) never ran or asked
    const models = fake.analyzeFrames.mock.calls.map((call) => call[1].modelId);
    expect(models).not.toContain('portrait');
    expect(models).toContain('general');
  });
});
