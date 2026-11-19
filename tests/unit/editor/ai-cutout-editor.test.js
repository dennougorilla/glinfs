/**
 * The AI cutout wired into a mounted editor (segmentation manager faked):
 * subject cards with the download question, the instant analysis (frame on
 * screen first), the status slot, pick tools on the preview, Escape order,
 * Fit / Reset, Hold to compare / Show mask, and mask cleanup when clips are
 * released.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/ai-cutout/segmentation-manager.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  const fake = {
    getCapabilities: vi.fn(async () => ({ webgpu: false })),
    getReadyInfo: vi.fn(() => null),
    analyzeFrames: vi.fn(),
    analyzeObject: vi.fn(async () => ({ tracked: 0, lost: [], anchors: 0, backend: 'wasm' })),
    dispose: vi.fn(),
    forgetClip: vi.fn(),
  };
  return { ...actual, getSegmentationManager: () => fake, __fake: fake };
});

import { getSharedMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import * as segmentation from '../../../src/features/ai-cutout/segmentation-manager.js';
import {
  buildClipMaskSource,
  getSharedFinalMaskCache,
  setWasmAllowed,
} from '../../../src/features/editor/ai-cutout.js';
import {
  deleteActiveClipFromAnywhere,
  getEditorState,
  initEditor,
} from '../../../src/features/editor/index.js';
import {
  deleteQueuedClip,
  enqueueClip,
  getClipQueue,
  registerClipCodec,
  releaseAllFramesAndReset,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { normalizeEdits } from '../../../src/shared/edits/model.js';
import { loadSettings, rememberAiCutoutModel } from '../../../src/shared/user-settings.js';

const fake = /** @type {any} */ (segmentation).__fake;

/**
 * @param {number} count
 * @param {string} prefix
 */
function createTestFrames(count, prefix = '') {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    data: { data: new Uint8ClampedArray(10 * 10 * 4), width: 10, height: 10 },
    timestamp: i * 33,
    width: 10,
    height: 10,
  }));
}

/** @param {string} key */
function press(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** Let the throttled store subscription render */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(20);
  await Promise.resolve();
}

/** @param {string} selector */
function $(selector) {
  return /** @type {HTMLElement} */ (document.querySelector(selector));
}

/**
 * @param {string} id
 * @param {boolean} [checked]
 */
function check(id, checked = true) {
  const input = /** @type {HTMLInputElement} */ ($(`#${id}`));
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * A Keep / Remove click on the preview: press on the overlay, release
 * (picks are decided on release: a click or a dragged box)
 * @param {Element} overlay
 * @param {number} x
 * @param {number} y
 * @param {{ toX?: number, toY?: number, altKey?: boolean }} [options] - toX/toY: drag there first
 */
function clickPreview(overlay, x, y, options = {}) {
  const { toX = x, toY = y, altKey = false } = options;
  overlay.dispatchEvent(
    new MouseEvent('mousedown', { clientX: x, clientY: y, altKey, bubbles: true }),
  );
  if (toX !== x || toY !== y) {
    overlay.dispatchEvent(
      new MouseEvent('mousemove', { clientX: toX, clientY: toY, altKey, bubbles: true }),
    );
  }
  window.dispatchEvent(
    new MouseEvent('mouseup', { clientX: toX, clientY: toY, altKey, bubbles: true }),
  );
}

describe('AI cutout in the mounted editor', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    getSharedMaskStore().clear();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
    fake.getCapabilities.mockClear();
    fake.dispose.mockClear();
    fake.forgetClip.mockClear();
    fake.analyzeFrames.mockReset();
    fake.getReadyInfo.mockReset();
    fake.getReadyInfo.mockReturnValue(null);
    fake.analyzeFrames.mockImplementation(async (frames, options) => {
      const store = getSharedMaskStore();
      const pending = segmentation.collectPendingFrames(frames, store, options.modelId);
      let done = 0;
      for (const { key } of pending) {
        store.set(
          key,
          { data: new Uint8Array(100).fill(255), width: 10, height: 10 },
          options.clipId,
        );
        done++;
        options.onProgress?.({
          phase: 'analyzing',
          loadedBytes: 1,
          totalBytes: 1,
          fromCache: true,
          framesDone: done,
          framesTotal: pending.length,
          backend: 'wasm',
          frameMs: 1,
        });
      }
      return { analyzed: pending.length, skipped: frames.length - pending.length, backend: 'wasm' };
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    getSharedMaskStore().clear();
    setWasmAllowed(false);
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** @param {number} [count] */
  function mount(count = 6) {
    setClipPayload({
      frames: createTestFrames(count, 'a'),
      fps: 10,
      capturedAt: Date.now(),
      id: 'clip-a',
    });
    cleanup = /** @type {() => void} */ (initEditor());
    // Keep the playhead still (the toggle also stops the playback loop)
    if (getEditorState()?.isPlaying) $('.btn-play').click();
  }

  /**
   * Choose an AI subject card; a model that still has to download is
   * confirmed in the inline question
   * @param {'anime' | 'portrait' | 'general'} [subject]
   */
  async function chooseAi(subject = 'anime') {
    check(`subject-${subject}`);
    await settle();
    await settle();
    if (!$('#background-download').hidden) {
      $('#background-download-confirm').click();
      await settle();
    }
    await settle();
  }

  /** A pending analysis that ends only when aborted; returns its signal holder */
  function holdNextAnalysis() {
    /** @type {{ signal: AbortSignal | null }} */
    const held = { signal: null };
    fake.analyzeFrames.mockImplementationOnce(
      (/** @type {any} */ _frames, /** @type {any} */ options) =>
        new Promise((_resolve, reject) => {
          held.signal = options.signal;
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    return held;
  }

  it('asks before downloading a model, then starts with the frame on screen', async () => {
    mount();
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 3, selectedRange: { start: 1, end: 4 } });
    await settle();
    expect(/** @type {HTMLInputElement} */ ($('#subject-none')).checked).toBe(true);
    expect($('#background-settings').hidden).toBe(true);
    // Not downloaded: the card says what it downloads
    await settle();
    expect($('#subject-status-anime').textContent).toContain('88 MB');

    check('subject-anime');
    await settle();
    await settle();
    // Asked inline; nothing changed, nothing downloaded
    expect($('#background-download').hidden).toBe(false);
    expect($('#background-download-title').textContent).toBe('Download 88 MB?');
    expect(/** @type {HTMLInputElement} */ ($('#subject-anime')).checked).toBe(true);
    expect(getEditorState()?.edits.background.enabled).toBe(false);
    expect(fake.analyzeFrames).not.toHaveBeenCalled();

    // Cancel: back to Off
    $('#background-download-cancel').click();
    await settle();
    expect($('#background-download').hidden).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('#subject-none')).checked).toBe(true);
    expect(fake.analyzeFrames).not.toHaveBeenCalled();

    // Download: AI on with that model, the current frame first, then the selection
    check('subject-anime');
    await settle();
    await settle();
    $('#background-download-confirm').click();
    await settle();
    await settle();
    expect(getEditorState()?.edits.background).toMatchObject({
      enabled: true,
      method: 'ai',
      colorChosen: false,
      ai: { model: 'anime' },
    });
    expect(fake.analyzeFrames).toHaveBeenCalledTimes(1);
    const [frames, options] = fake.analyzeFrames.mock.calls[0];
    expect(frames.map((/** @type {any} */ f) => f.id)).toEqual(['a3', 'a1', 'a2', 'a4']);
    expect(options).toMatchObject({ clipId: 'clip-a', modelId: 'anime', allowWasm: false });
    expect($('#ai-section').hidden).toBe(false);
    expect($('#color-section').hidden).toBe(true);
    expect($('#ai-status').dataset.kind).toBe('done');
    expect($('#ai-status-text').textContent).toBe('4 of 6 frames analyzed');

    // Final masks built: the analyzed frame has no note
    await vi.waitFor(async () => {
      await settle();
      expect(getEditorState()?.aiCutout.maskVersion).toBeGreaterThan(0);
    });
    await settle();
    expect($('#ai-preview-note').hidden).toBe(true);
  });

  it('a ready model starts at once, without asking', async () => {
    fake.getReadyInfo.mockImplementation((/** @type {string} */ id) =>
      id === 'portrait' ? { backend: 'webgpu' } : null,
    );
    mount(3);
    await settle();
    await settle();
    expect($('#subject-status-portrait').textContent).toContain('Ready');
    check('subject-portrait');
    await settle();
    await settle();
    expect($('#background-download').hidden).toBe(true);
    expect(fake.analyzeFrames).toHaveBeenCalledTimes(1);
    expect(fake.analyzeFrames.mock.calls[0][1]).toMatchObject({ modelId: 'portrait' });
    expect(getEditorState()?.edits.background.ai.model).toBe('portrait');
  });

  it('a model on two cards (BiRefNet: Anime and Anything) stays on the card it was chosen with', async () => {
    mount(2);
    await chooseAi('general');
    const select = /** @type {HTMLSelectElement} */ ($('#ai-model'));
    select.value = 'birefnet-general';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await settle();
    // Not downloaded: asked on the Anything card, then used there
    expect($('#background-download').hidden).toBe(false);
    expect(/** @type {HTMLInputElement} */ ($('#subject-general')).checked).toBe(true);
    $('#background-download-confirm').click();
    await settle();
    await settle();
    expect(getEditorState()?.edits.background.ai).toMatchObject({
      model: 'birefnet-general',
      subject: 'general',
    });
    expect(/** @type {HTMLInputElement} */ ($('#subject-general')).checked).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('#subject-anime')).checked).toBe(false);
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({ modelId: 'birefnet-general' });

    // The Anime card can use the same model: the clip keeps it, on Anime now
    await chooseAi('anime');
    expect(getEditorState()?.edits.background.ai).toMatchObject({
      model: 'birefnet-general',
      subject: 'anime',
    });
    expect(/** @type {HTMLInputElement} */ ($('#subject-anime')).checked).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('#subject-general')).checked).toBe(false);
  });

  it('switching subjects restarts the analysis with the new model; each model keeps its masks', async () => {
    mount(4);
    await chooseAi('anime');
    expect($('#ai-status-text').textContent).toBe('4 of 4 frames analyzed');
    window.__TEST_HOOKS__.setEditorState({
      edits: {
        ...getEditorState()?.edits,
        background: {
          ...getEditorState()?.edits.background,
          ai: { ...getEditorState()?.edits.background.ai, threshold: 0.3 },
        },
      },
    });
    await settle();

    // Anything (nothing downloaded or remembered: the first-run BEN2): a
    // running analysis with it, then Person mid-run
    const held = holdNextAnalysis();
    await chooseAi('general');
    expect(getEditorState()?.edits.background.ai).toMatchObject({
      model: 'ben2',
      threshold: 0.3,
    });
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({ modelId: 'ben2' });
    expect($('#ai-status').dataset.kind).toBe('running');
    expect($('#ai-cancel').hidden).toBe(false);

    await chooseAi('portrait');
    expect(held.signal?.aborted).toBe(true);
    await settle();
    await settle();
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({ modelId: 'portrait' });
    expect(getEditorState()?.edits.background.ai.model).toBe('portrait');
    expect($('#ai-status-text').textContent).toBe('4 of 4 frames analyzed');

    // Back to anime: its masks are reused, nothing new to analyze
    const calls = fake.analyzeFrames.mock.calls.length;
    await chooseAi('anime');
    expect($('#ai-status').dataset.kind).toBe('done');
    expect(
      getSharedMaskStore()
        .keysForClip('clip-a')
        .filter((k) => k.startsWith('anime:')),
    ).toHaveLength(4);
    // A call may happen, but it analyzes nothing
    for (const call of fake.analyzeFrames.mock.calls.slice(calls)) {
      expect(call[1].modelId).toBe('anime');
    }
  });

  it('Solid color detects the key color; Off stops a running analysis', async () => {
    mount(2);
    const held = holdNextAnalysis();
    await chooseAi('anime');
    expect(held.signal).not.toBeNull();
    expect($('#ai-status').dataset.kind).toBe('running');

    check('subject-color');
    await settle();
    expect(held.signal?.aborted).toBe(true);
    expect(getEditorState()?.edits.background.method).toBe('color');
    expect($('#ai-section').hidden).toBe(true);
    expect($('#color-section').hidden).toBe(false);
    expect(getEditorState()?.aiCutout.phase).toBe('idle');

    check('subject-none');
    await settle();
    expect(getEditorState()?.edits.background.enabled).toBe(false);
    expect($('#background-settings').hidden).toBe(true);
    // AI again never picks a key color for the AI
    await chooseAi('anime');
    expect(getEditorState()?.edits.background).toMatchObject({
      enabled: true,
      method: 'ai',
    });
  });

  it('without WebGPU: the explicit CPU choice runs the analysis with WASM allowed', async () => {
    mount(2);
    fake.analyzeFrames.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'webgpu-unavailable' }),
    );
    await chooseAi();
    expect(fake.getCapabilities).toHaveBeenCalled();
    expect($('#ai-webgpu-warning').hidden).toBe(false);
    expect($('#ai-run-wasm').textContent).toBe('Run on the CPU (very slow)');
    $('#ai-run-wasm').click();
    await settle();
    await settle();
    expect(fake.analyzeFrames.mock.calls.at(-1)[1].allowWasm).toBe(true);
    expect($('#ai-webgpu-warning').hidden).toBe(true);
    expect($('#ai-wasm-note').hidden).toBe(false);
  });

  it('starts a subject with the model chosen last and remembers a new choice (#187)', async () => {
    rememberAiCutoutModel('general', 'general');
    mount(2);
    await chooseAi('general');
    expect(getEditorState()?.edits.background.ai.model).toBe('general');
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({ modelId: 'general' });
    await chooseAi('portrait');
    expect(loadSettings().aiCutout).toMatchObject({
      lastModel: 'portrait',
      lastModelBySubject: { general: 'general', portrait: 'portrait' },
    });
  });

  it('Anime on a fresh clip starts with the model chosen last for it, not the untouched default (release review 0.17.0)', async () => {
    rememberAiCutoutModel('birefnet-lite', 'anime');
    mount(2);
    await chooseAi('anime');
    expect(getEditorState()?.edits.background.ai.model).toBe('birefnet-lite');
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({ modelId: 'birefnet-lite' });
    // A clip that has made its choice keeps it: Off, then Anime again
    check('subject-none');
    await settle();
    rememberAiCutoutModel('birefnet-toonout', 'anime');
    await chooseAi('anime');
    expect(getEditorState()?.edits.background.ai.model).toBe('birefnet-lite');
  });

  it('a model that fails on WebGPU asks for the slow choice for that model only', async () => {
    fake.getCapabilities.mockResolvedValue({ webgpu: true });
    mount(2);
    fake.analyzeFrames.mockRejectedValueOnce(
      Object.assign(new Error('The model could not run on WebGPU: shader limits'), {
        code: 'webgpu-model-failed',
      }),
    );
    await chooseAi('general');
    // The browser has WebGPU: the copy names the model, not a missing WebGPU
    expect(getEditorState()?.aiCutout).toMatchObject({
      webgpu: true,
      needsWasmChoice: true,
      webgpuModelFailed: true,
    });
    expect($('#ai-error').hidden).toBe(true);
    expect($('#ai-webgpu-warning').hidden).toBe(false);
    const text = $('#ai-webgpu-warning-text').textContent ?? '';
    expect(text).toContain('The Hair & detail model could not run on WebGPU in this browser');
    expect(text).not.toContain('does not provide');

    // The anime model is not affected: switching clears the choice and runs it
    await chooseAi('anime');
    expect(getEditorState()?.aiCutout).toMatchObject({
      needsWasmChoice: false,
      webgpuModelFailed: false,
    });
    expect($('#ai-webgpu-warning').hidden).toBe(true);
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({
      modelId: 'anime',
      allowWasm: false,
    });
    expect($('#ai-status-text').textContent).toBe('2 of 2 frames analyzed');
    fake.getCapabilities.mockResolvedValue({ webgpu: false });
  });

  it('shows errors with Try again; Analyze picks up frames added to the selection', async () => {
    mount(4);
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 1 } });
    await settle();
    fake.analyzeFrames.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'download-failed' }),
    );
    await chooseAi();
    expect($('#ai-error').hidden).toBe(false);
    expect($('#ai-error-text').textContent).toContain('could not be downloaded');
    $('#ai-retry').click();
    await settle();
    await settle();
    expect($('#ai-error').hidden).toBe(true);
    expect($('#ai-status-text').textContent).toBe('2 of 4 frames analyzed');

    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 3 } });
    await settle();
    expect($('#ai-status').dataset.kind).toBe('pending');
    expect($('#ai-status-text').textContent).toBe('2 frames not analyzed');
    expect($('#ai-analyze').hidden).toBe(false);
    $('#ai-analyze').click();
    await settle();
    await settle();
    expect($('#ai-status-text').textContent).toBe('4 of 4 frames analyzed');
  });

  it('pick tools: a preview click adds a pick on the current frame; Escape leaves the tool first', async () => {
    mount();
    await chooseAi();

    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');

    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    check('ai-pick-keep');
    await settle();
    expect(getEditorState()?.aiPickTool).toBe('keep');
    // The active tool is obvious from the button and the cursor (data-tool);
    // nothing covers the preview: its hint is for screen readers only, and
    // the keys are in the tool's tooltip (cutout-ux 7)
    expect($('label[for="ai-pick-keep"]').classList.contains('is-active')).toBe(true);
    expect($('.editor-canvas-container').dataset.tool).toBe('keep');
    expect($('#preview-tool-hint').hidden).toBe(false);
    expect($('#preview-tool-hint').classList.contains('sr-only')).toBe(true);
    expect($('#preview-tool-hint').textContent).toContain(
      'Anything not attached to it disappears on every frame',
    );
    expect($('#ai-preview-note').classList.contains('sr-only')).toBe(true);
    for (const tool of ['keep', 'remove', 'colour']) {
      expect($(`label[for="ai-pick-${tool}"]`).title).toMatch(/Alt-click .*· Esc to finish$/);
    }
    expect($('.editor-canvas-container').classList.contains('editor-ai-picking')).toBe(true);

    clickPreview(overlay, 30, 70);
    await settle();
    let state = getEditorState();
    expect(state?.edits.background.ai.picks).toEqual([{ frame: 2, x: 0.3, y: 0.7, mode: 'keep' }]);
    // The tool stays on for the next piece (cutout-ux 4: 16 actions for 8 flames before)
    expect(state?.aiPickTool).toBe('keep');
    expect($('.editor-canvas-container').dataset.tool).toBe('keep');
    // The crop was not touched by the pick
    expect(state?.cropArea).toBeNull();
    expect($('#ai-pick-list').children).toHaveLength(1);
    expect($('#ai-pick-list').textContent).toContain('Keep at');

    // Escape: pick tool first
    check('ai-pick-remove');
    await settle();
    expect(getEditorState()?.aiPickTool).toBe('remove');
    press('Escape');
    expect(getEditorState()?.aiPickTool).toBeNull();

    // A pick on a frame without analysis is refused with a note
    getSharedMaskStore().delete('anime:a4');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 4 });
    check('ai-pick-remove');
    clickPreview(overlay, 50, 50);
    await settle();
    state = getEditorState();
    expect(state?.edits.background.ai.picks).toHaveLength(1);
    expect(state?.aiCutout.notice).toContain('not analyzed yet');
    expect($('#ai-notice').textContent).toContain('not analyzed yet');
    press('Escape');
    await settle();
    expect($('#ai-notice').textContent).toBe('');

    // List: go to the pick's frame, remove it
    /** @type {HTMLElement} */ ($('.editor-cutout-pick-go')).click();
    expect(getEditorState()?.currentFrame).toBe(2);
    /** @type {HTMLElement} */ ($('.editor-cutout-pick-delete')).click();
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toEqual([]);
    expect($('#ai-pick-list').hidden).toBe(true);
  });

  it('Keep / Remove choose the mechanism from what the click lands on', async () => {
    mount(3);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    // Frame 1 analyzed: a character on the left half, a separate blob top
    // right, background elsewhere
    const data = new Uint8Array(100);
    for (let y = 0; y < 10; y++) data.fill(255, y * 10, y * 10 + 5);
    data.fill(255, 8, 10);
    data.fill(255, 18, 20);
    getSharedMaskStore().set('anime:a1', { data, width: 10, height: 10 }, 'clip-a');
    await settle();

    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    const ai = () => getEditorState()?.edits.background.ai;

    // Remove on nothing: refused, the tool stays on
    check('ai-pick-remove');
    clickPreview(overlay, 70, 70);
    await settle();
    expect(ai()?.picks).toEqual([]);
    expect(ai()?.objects).toEqual([]);
    expect(getEditorState()?.aiPickTool).toBe('remove');
    expect($('#ai-notice').textContent).toBe('No character here. Click on a character.');

    // Remove on the separate blob: a remove pick
    clickPreview(overlay, 90, 10);
    await settle();
    expect(ai()?.picks).toEqual([{ frame: 1, x: 0.9, y: 0.1, mode: 'remove' }]);
    expect(getEditorState()?.aiPickTool).toBe('remove');
    expect($('#ai-notice').textContent).toBe('');

    // Remove on the subject: a tracked fix-up, not selected
    check('ai-pick-remove');
    clickPreview(overlay, 20, 50);
    await settle();
    // With a pick, the subject is judged after the picks (asynchronously)
    await settle();
    expect(ai()?.objects).toMatchObject([
      { mode: 'remove', clicks: [{ frame: 1, x: 0.2, y: 0.5, mode: 'keep' }] },
    ]);
    expect(getEditorState()?.aiActiveObjectId).toBeNull();

    // Keep on the subject: a keep pick; Keep on nothing: a tracked fix-up
    check('ai-pick-keep');
    clickPreview(overlay, 30, 50);
    await settle();
    expect(ai()?.picks).toHaveLength(2);
    check('ai-pick-keep');
    clickPreview(overlay, 70, 70);
    await settle();
    expect(ai()?.objects?.map((o) => o.mode)).toEqual(['remove', 'add']);

    // A drag always makes a tracked fix-up around the box
    check('ai-pick-remove');
    clickPreview(overlay, 60, 40, { toX: 90, toY: 90 });
    await settle();
    expect(ai()?.objects?.[2]).toMatchObject({
      mode: 'remove',
      clicks: [],
      boxes: [{ frame: 1, x0: 0.6, y0: 0.4, x1: 0.9, y1: 0.9 }],
    });
    // One list: two picks, three tracked fix-ups with swatches
    expect($('#ai-pick-list').children).toHaveLength(5);
    expect($('#ai-pick-list').querySelectorAll('.editor-cutout-pick-swatch')).toHaveLength(3);
  });

  it('Remove on a Keep-picked character smaller than what the pick dropped is tracked, not a pick (review #195)', async () => {
    mount(3);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    // Frame 1: a big shelf on the left (columns 0-5), a small character on the right (8-9)
    const data = new Uint8Array(100);
    for (let y = 0; y < 10; y++) data.fill(255, y * 10, y * 10 + 6);
    for (let y = 2; y < 8; y++) data.fill(255, y * 10 + 8, y * 10 + 10);
    getSharedMaskStore().set('anime:a1', { data, width: 10, height: 10 }, 'clip-a');
    await settle();
    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    const ai = () => getEditorState()?.edits.background.ai;

    check('ai-pick-keep');
    clickPreview(overlay, 90, 50);
    await settle();
    expect(ai()?.picks).toEqual([{ frame: 1, x: 0.9, y: 0.5, mode: 'keep' }]);
    check('ai-pick-remove');
    clickPreview(overlay, 90, 50);
    await settle();
    await settle();
    // The kept character is the subject: a tracked fix-up, the pick list unchanged
    expect(ai()?.picks).toHaveLength(1);
    expect(ai()?.objects).toMatchObject([{ mode: 'remove' }]);
  });

  /**
   * Frame 1 of 3: a big shelf (columns 0-5) and a small character (8-9),
   * the character Keep-picked; the Remove tool on
   */
  async function keptCharacterOnFrame1() {
    mount(3);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    const data = new Uint8Array(100);
    for (let y = 0; y < 10; y++) data.fill(255, y * 10, y * 10 + 6);
    for (let y = 2; y < 8; y++) data.fill(255, y * 10 + 8, y * 10 + 10);
    getSharedMaskStore().set('anime:a1', { data, width: 10, height: 10 }, 'clip-a');
    await settle();
    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    check('ai-pick-keep');
    clickPreview(overlay, 90, 50);
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toHaveLength(1);
    check('ai-pick-remove');
    return overlay;
  }

  it('a Keep / Remove click stops playback, so the frame it is judged on stays (review #195 r2)', async () => {
    const overlay = await keptCharacterOnFrame1();
    window.__TEST_HOOKS__.setEditorState({ isPlaying: true, currentFrame: 1 });
    clickPreview(overlay, 90, 50);
    expect(getEditorState()?.isPlaying).toBe(false);
    await settle();
    await settle();
    expect(getEditorState()?.edits.background.ai.objects).toHaveLength(1);
  });

  it('a Keep / Remove box stops playback when the drag starts and goes on that frame (release review 0.17.0)', async () => {
    mount(4);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    check('ai-pick-remove');
    await settle();
    window.__TEST_HOOKS__.setEditorState({ isPlaying: true, currentFrame: 1 });
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 20, clientY: 20, bubbles: true }));
    expect(getEditorState()?.isPlaying).toBe(false);
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 70, bubbles: true }));
    // A frame step that was already on its way lands mid-drag
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 3 });
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 70, bubbles: true }));
    await settle();
    const [object] = getEditorState()?.edits.background.ai.objects ?? [];
    expect(object.boxes).toEqual([{ frame: 1, x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.7 }]);
  });

  it('a click dropped because the frame changed while it was judged says so (review #195 r2)', async () => {
    const overlay = await keptCharacterOnFrame1();
    clickPreview(overlay, 90, 50);
    // The judgement (picks tracked up to the frame) is still running
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    await settle();
    await settle();
    const ai = getEditorState()?.edits.background.ai;
    expect(ai?.objects).toEqual([]);
    expect(ai?.picks).toHaveLength(1);
    expect(getEditorState()?.aiCutout.notice).toBe(
      'The frame or the cutout changed before that click was added. Click again.',
    );
  });

  it('closing the editor while a click is judged does not throw (review #195 r2)', async () => {
    const overlay = await keptCharacterOnFrame1();
    clickPreview(overlay, 90, 50);
    cleanup?.();
    cleanup = null;
    // Before the fix the click went on and read the closed editor's store:
    // vitest reports that as an unhandled rejection and the run fails
    for (let i = 0; i < 5; i++) await settle();
    expect(getEditorState()).toBeFalsy();
  });

  it('a selected fix-up takes corrections: its tool adds, Alt or the other tool takes away, a drag adds a box', async () => {
    mount(3);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    window.__TEST_HOOKS__.setEditorState({
      currentFrame: 0,
      edits: normalizeEdits(
        {
          ...getEditorState()?.edits,
          background: {
            ...getEditorState()?.edits.background,
            ai: {
              ...getEditorState()?.edits.background.ai,
              objects: [
                {
                  id: 'o1',
                  mode: 'remove',
                  scope: 'whole',
                  clicks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
                },
              ],
            },
          },
        },
        3,
      ),
    });
    await settle();
    // Its chip selects it, on its own tool (Remove for a removed region)
    /** @type {HTMLElement} */ ($('[data-object-id="o1"] .editor-cutout-pick-go')).click();
    await settle();
    expect(getEditorState()?.aiActiveObjectId).toBe('o1');
    expect(getEditorState()?.aiPickTool).toBe('remove');
    expect($('[data-object-id="o1"]').classList.contains('is-active')).toBe(true);

    // Frame 2 has the fix-up's mask (taking away there is a point)
    getSharedMaskStore().set(
      'object:o1:a2',
      { data: new Uint8Array(100).fill(255), width: 10, height: 10 },
      'clip',
      'object:o1',
    );
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    clickPreview(overlay, 10, 10);
    clickPreview(overlay, 20, 20, { altKey: true });
    await settle();
    check('ai-pick-keep');
    clickPreview(overlay, 30, 30);
    clickPreview(overlay, 50, 50, { toX: 80, toY: 70 });
    await settle();
    const [object] = getEditorState()?.edits.background.ai.objects ?? [];
    expect(object.clicks.map((c) => [c.frame, c.mode])).toEqual([
      [0, 'keep'],
      [2, 'keep'],
      [2, 'remove'],
      [2, 'remove'],
    ]);
    expect(object.boxes).toEqual([{ frame: 2, x0: 0.5, y0: 0.5, x1: 0.8, y1: 0.7 }]);
    // Taking away on a frame without its mask: "not here" (cutout-ux 5), no point
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    // (the Keep tool is on: on a Remove fix-up it takes away)
    clickPreview(overlay, 20, 20);
    await settle();
    const [gone] = getEditorState()?.edits.background.ai.objects ?? [];
    expect(gone.gone).toEqual([1]);
    expect(gone.clicks).toHaveLength(4);
    // Still selected; Escape finishes
    expect(getEditorState()?.aiActiveObjectId).toBe('o1');
    press('Escape');
    expect(getEditorState()?.aiActiveObjectId).toBeNull();
    expect(getEditorState()?.aiPickTool).toBeNull();
  });

  it('steps through the answers of the selected fix-up with 1-4, stored after a short pause (cutout-ux 2)', async () => {
    mount(3);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    window.__TEST_HOOKS__.setEditorState({
      currentFrame: 0,
      edits: normalizeEdits(
        {
          ...getEditorState()?.edits,
          background: {
            ...getEditorState()?.edits.background,
            ai: {
              ...getEditorState()?.edits.background.ai,
              objects: [
                {
                  id: 'o1',
                  mode: 'remove',
                  scope: 'part',
                  clicks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
                },
              ],
            },
          },
        },
        3,
      ),
    });
    await settle();
    /** @type {HTMLElement} */ ($('[data-object-id="o1"] .editor-cutout-pick-go')).click();
    await settle();
    expect(getEditorState()?.aiPickerId).toBe('o1');
    /** @param {string} code */
    const digit = (code) => {
      const e = new KeyboardEvent('keydown', {
        key: code.slice(-1),
        code,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Shown at once, stored (and tracked again) after a pause
    expect(digit('Digit2')).toBe(true);
    expect(getEditorState()?.aiPickerRank).toBe(1);
    expect(getEditorState()?.edits.background.ai.objects[0].candidate).toBeUndefined();
    expect(digit('Digit1')).toBe(true);
    vi.advanceTimersByTime(500);
    await settle();
    const [object] = getEditorState()?.edits.background.ai.objects ?? [];
    expect(object.candidate).toBe(0);
    // The pick replaces Part
    expect(object.scope).toBe('whole');
    expect(getEditorState()?.aiPickerRank).toBeNull();
    // On another frame the digits are the clip shortcuts again
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    await settle();
    expect(digit('Digit3')).toBe(false);
    // Escape ends the tool, then the picker
    press('Escape');
    press('Escape');
    expect(getEditorState()?.aiPickerId).toBeNull();
  });

  it('the Colour tool makes a Colour fix-up at the click, never tracked; more clicks add colours (cutout-ux 4)', async () => {
    mount(3);
    await chooseAi();
    await vi.waitFor(async () => {
      await settle();
      expect(getEditorState()?.aiCutout.maskVersion).toBeGreaterThan(0);
    });
    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    fake.analyzeObject.mockClear();
    check('ai-pick-colour');
    await settle();
    expect(getEditorState()?.aiPickTool).toBe('colour');
    clickPreview(overlay, 40, 40);
    await settle();
    const [object] = getEditorState()?.edits.background.ai.objects ?? [];
    expect(object).toMatchObject({ mode: 'remove', scope: 'colour' });
    // Selected with the tool on: the next clicks add a colour, Alt one to keep
    expect(getEditorState()?.aiActiveObjectId).toBe(object.id);
    expect(getEditorState()?.aiPickTool).toBe('colour');
    clickPreview(overlay, 60, 40);
    clickPreview(overlay, 70, 40, { altKey: true });
    await settle();
    const [after] = getEditorState()?.edits.background.ai.objects ?? [];
    expect(after.clicks.map((c) => c.mode)).toEqual(['keep', 'keep', 'remove']);
    expect(getEditorState()?.edits.background.ai.objects).toHaveLength(1);
    // Never tracked
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.analyzeObject).not.toHaveBeenCalled();
    // Its reach: Everywhere, from the panel
    check('ai-object-reach-everywhere');
    await settle();
    expect(getEditorState()?.edits.background.ai.objects[0].everywhere).toBe(true);
  });

  it('keeps keyboard focus in the panel when the focused control hides itself', async () => {
    mount(2);
    const held = holdNextAnalysis();
    await chooseAi();
    expect(held.signal).not.toBeNull();
    $('#ai-cancel').focus();
    $('#ai-cancel').click();
    await settle();
    await settle();
    expect($('#ai-cancel').hidden).toBe(true);
    expect(document.activeElement?.id).toBe('ai-fit');

    // A pick's × removes it: focus stays in the panel
    window.__TEST_HOOKS__.setEditorState({
      edits: {
        ...getEditorState()?.edits,
        background: {
          ...getEditorState()?.edits.background,
          ai: { ...getEditorState()?.edits.background.ai, picks: [{ frame: 0, x: 0.1, y: 0.1 }] },
        },
      },
    });
    await settle();
    /** @type {HTMLElement} */ ($('.editor-cutout-pick-delete')).focus();
    /** @type {HTMLElement} */ ($('.editor-cutout-pick-delete')).click();
    await settle();
    expect(document.activeElement?.id).toBe('ai-pick-keep');
  });

  it('keyboard picks: the focused preview moves a marker with the arrows and picks on Enter', async () => {
    mount();
    await chooseAi();
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    await settle();

    const overlay = /** @type {HTMLCanvasElement} */ ($('.editor-canvas-overlay'));
    expect(overlay.hasAttribute('tabindex')).toBe(false);

    // Switching the toggle from the keyboard sends focus to the preview
    const keep = /** @type {HTMLInputElement} */ ($('#ai-pick-keep'));
    keep.focus();
    keep.matches = (/** @type {string} */ selector) => selector === ':focus-visible';
    check('ai-pick-keep');
    await settle();
    expect(getEditorState()?.aiPickTool).toBe('keep');
    expect(overlay.tabIndex).toBe(0);
    expect(overlay.getAttribute('aria-label')).toContain('Arrow keys move the marker');
    expect(document.activeElement).toBe(overlay);

    /** @param {string} key @param {boolean} [shiftKey] */
    const key = (key, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      overlay.dispatchEvent(event);
      return event;
    };
    // The arrows move the marker, not the playhead
    expect(key('ArrowRight', true).defaultPrevented).toBe(true);
    key('ArrowDown');
    key('ArrowDown');
    expect(getEditorState()?.currentFrame).toBe(2);
    key('Enter');
    await settle();
    const [pick] = getEditorState()?.edits.background.ai.picks ?? [];
    expect(pick).toMatchObject({ frame: 2, mode: 'keep' });
    expect(pick.x).toBeCloseTo(0.6, 5);
    expect(pick.y).toBeCloseTo(0.54, 5);
    // The tool stays on for the next pick (cutout-ux 4); Escape ends it below
    expect(getEditorState()?.aiPickTool).toBe('keep');
    press('Escape');
    await settle();
    expect(getEditorState()?.aiPickTool).toBeNull();
    expect(document.activeElement).toBe(keep);
    expect(overlay.hasAttribute('tabindex')).toBe(false);

    // Escape on the focused preview leaves the tool the same way
    check('ai-pick-remove');
    await settle();
    overlay.focus();
    press('Escape');
    await settle();
    expect(getEditorState()?.aiPickTool).toBeNull();
    expect(document.activeElement?.id).toBe('ai-pick-remove');
  });

  it('Fit and Reduce flicker patch the AI edits; dragging previews drafts, release builds', async () => {
    mount(2);
    await chooseAi();
    await vi.waitFor(async () => {
      await settle();
      expect(getEditorState()?.aiCutout.maskVersion).toBeGreaterThan(0);
    });

    const fit = /** @type {HTMLInputElement} */ ($('#ai-fit'));
    fit.value = '-4';
    fit.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(getEditorState()?.edits.background.ai).toMatchObject({ threshold: 0.66, edge: -2 });
    // Live: no "building" flashed while dragging
    expect(getEditorState()?.aiCutout.building).toBe(false);
    fit.dispatchEvent(new Event('change', { bubbles: true }));
    check('ai-smoothing', false);
    await settle();
    expect(getEditorState()?.edits.background.ai).toMatchObject({
      threshold: 0.66,
      edge: -2,
      smoothing: false,
    });
    expect(fit.getAttribute('aria-valuetext')).toContain('Tighter 4');

    // Reset: defaults back, picks and strokes gone
    window.__TEST_HOOKS__.setEditorState({
      edits: {
        ...getEditorState()?.edits,
        background: {
          ...getEditorState()?.edits.background,
          ai: { ...getEditorState()?.edits.background.ai, picks: [{ frame: 0, x: 0.1, y: 0.1 }] },
        },
      },
    });
    await settle();
    expect(/** @type {HTMLButtonElement} */ ($('#background-reset')).disabled).toBe(false);
    $('#background-reset').click();
    await settle();
    expect(getEditorState()?.edits.background.ai).toMatchObject({
      model: 'anime',
      threshold: 0.5,
      edge: 0,
      smoothing: true,
      picks: [],
    });
    expect(/** @type {HTMLButtonElement} */ ($('#background-reset')).disabled).toBe(true);
  });

  it('Clean up chips: specks and holes toggle the whole-clip clean-up, a blob becomes a remove pick', async () => {
    mount(6);
    await chooseAi();
    await vi.waitFor(async () => {
      await settle();
      expect(getEditorState()?.aiCutout.maskVersion).toBeGreaterThan(0);
    });
    // Let the suggestion pass of that build finish (a clean mask: none)
    await vi.advanceTimersByTimeAsync(2000);
    const suggestions = [
      { kind: 'specks', count: 2, minIslandArea: 0.001 },
      { kind: 'blob', frames: 2, where: 'left', pick: { frame: 4, x: 0.1, y: 0.5 } },
    ];
    window.__TEST_HOOKS__.setEditorState({
      aiCutout: { ...getEditorState()?.aiCutout, cleanupSuggestions: suggestions },
    });
    await settle();
    const chip = (/** @type {string} */ kind) =>
      /** @type {HTMLElement} */ ($(`#ai-cleanup-list [data-cleanup="${kind}"] button`));
    expect($('#ai-cleanup').hidden).toBe(false);

    chip('specks').click();
    await settle();
    expect(getEditorState()?.edits.background.ai.cleanup).toEqual({
      minIslandArea: 0.001,
      maxHoleArea: 0,
    });
    expect(chip('specks').getAttribute('aria-pressed')).toBe('true');

    chip('blob').click();
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toEqual([
      { frame: 4, x: 0.1, y: 0.5, mode: 'remove' },
    ]);
    expect(getEditorState()?.currentFrame).toBe(4);

    // Tapping the checked chip turns the clean-up off
    chip('specks').click();
    await settle();
    expect(getEditorState()?.edits.background.ai.cleanup.minIslandArea).toBe(0);
  });

  it('Hold to compare shows the original while held; Show mask tints what is removed', async () => {
    mount(2);
    expect($('#preview-compare-controls').hidden).toBe(true);
    check('subject-color');
    await settle();
    expect($('#preview-compare-controls').hidden).toBe(false);

    const hold = $('#preview-compare');
    hold.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    await settle();
    expect(getEditorState()?.comparing).toBe(true);
    expect($('.editor-canvas-container').dataset.previewView).toBe('original');
    hold.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await settle();
    expect(getEditorState()?.comparing).toBe(false);
    expect($('.editor-canvas-container').dataset.previewView).toBe('result');

    // Hold backslash
    press('\\');
    await settle();
    expect(getEditorState()?.comparing).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: '\\' }));
    await settle();
    expect(getEditorState()?.comparing).toBe(false);

    // Space/Enter on the focused button hold too, without toggling playback
    hold.focus();
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    hold.dispatchEvent(space);
    await settle();
    expect(getEditorState()?.comparing).toBe(true);
    expect(getEditorState()?.isPlaying).toBe(false);
    hold.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    await settle();
    expect(getEditorState()?.comparing).toBe(false);

    check('preview-show-mask');
    await settle();
    expect(getEditorState()?.previewView).toBe('mask');
    expect($('.editor-canvas-container').dataset.previewView).toBe('mask');
    check('preview-show-mask', false);
    await settle();
    expect(getEditorState()?.previewView).toBe('result');

    // Removal off: nothing to compare, the backslash does nothing
    check('subject-none');
    await settle();
    expect($('#preview-compare-controls').hidden).toBe(true);
    press('\\');
    await settle();
    expect(getEditorState()?.comparing).toBe(false);
  });

  it('keeps analyzing the deleted clip on screen under its own id while the successor decodes', async () => {
    // A compressed successor: deleting the active clip keeps it on screen
    registerClipCodec({
      isCompressionAvailable: () => true,
      encode: async () => ({
        ok: true,
        chunks: [{ type: 'key', timestamp: 0, duration: null, data: new ArrayBuffer(16) }],
        config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 },
        byteLength: 16,
      }),
      decode: () => new Promise(() => {}),
    });
    try {
      enqueueClip({ frames: createTestFrames(2, 'q'), fps: 10, capturedAt: 0, id: 'clip-q' });
      await settle();
      expect(getClipQueue()[0]?.status).toBe('compressed');
      mount();
      await chooseAi();

      expect(deleteActiveClipFromAnywhere()).toBe(true);
      await settle();
      expect($('#ai-analyze')).not.toBeNull();
      getSharedMaskStore().clear();
      await settle();
      $('#ai-analyze').click();
      await settle();
      expect(fake.analyzeFrames.mock.calls.at(-1)[1].clipId).toBe('clip-a');
      expect(getSharedMaskStore().keysForClip('clip-a').length).toBeGreaterThan(0);

      // Once the deletion is final, those masks go with the clip
      vi.advanceTimersByTime(5000);
      expect(getSharedMaskStore().keysForClip('clip-a')).toEqual([]);
      expect(getSharedMaskStore().size).toBe(0);
    } finally {
      registerClipCodec(null);
    }
  });

  it('drops a clip’s masks once its deletion is final, and everything on reset', async () => {
    const store = getSharedMaskStore();
    store.set('anime:q0', { data: new Uint8Array(4), width: 2, height: 2 }, 'clip-q');
    store.set('anime:a0', { data: new Uint8Array(4), width: 2, height: 2 }, 'clip-a');
    setClipPayload({ frames: createTestFrames(2, 'a'), fps: 10, capturedAt: 0, id: 'clip-a' });
    enqueueClip({ frames: createTestFrames(2, 'q'), fps: 10, capturedAt: 0, id: 'clip-q' });
    // The queued clip's final masks are memoized in the shared cache
    const cache = getSharedFinalMaskCache();
    const ai = normalizeEdits({}, 2).background.ai;
    await buildClipMaskSource({
      frames: /** @type {any} */ (createTestFrames(2, 'q')),
      ai,
      clipId: 'clip-q',
    });
    expect(cache.bytes()).toBeGreaterThan(0);

    expect(deleteQueuedClip('clip-q')).toBe(true);
    // Undo window: masks stay
    expect(store.has('anime:q0')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(store.has('anime:q0')).toBe(false);
    expect(store.has('anime:a0')).toBe(true);
    // Masks of its frames still in the worker are dropped when they arrive
    expect(fake.forgetClip).toHaveBeenCalledWith('clip-q');
    expect(fake.forgetClip).not.toHaveBeenCalledWith('clip-a');
    // Its memoized final masks go too
    expect(cache.bytes()).toBe(0);

    releaseAllFramesAndReset();
    expect(store.size).toBe(0);
    expect(fake.dispose).toHaveBeenCalled();
  });
});
