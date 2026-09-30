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

    // Anything: a running analysis with it, then Person mid-run
    const held = holdNextAnalysis();
    await chooseAi('general');
    expect(getEditorState()?.edits.background.ai).toMatchObject({
      model: 'general',
      threshold: 0.3,
    });
    expect(fake.analyzeFrames.mock.calls.at(-1)[1]).toMatchObject({ modelId: 'general' });
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
    expect(text).toContain('The General model could not run on WebGPU in this browser');
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
    // The active tool is obvious: button, cursor (data-tool) and a hint on the preview
    expect($('label[for="ai-pick-keep"]').classList.contains('is-active')).toBe(true);
    expect($('.editor-canvas-container').dataset.tool).toBe('keep');
    expect($('#preview-tool-hint').hidden).toBe(false);
    expect($('#preview-tool-hint').textContent).toContain('click a character');
    expect($('.editor-canvas-container').classList.contains('editor-ai-picking')).toBe(true);

    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 30, clientY: 70, bubbles: true }));
    await settle();
    let state = getEditorState();
    expect(state?.edits.background.ai.picks).toEqual([{ frame: 2, x: 0.3, y: 0.7, mode: 'keep' }]);
    expect(state?.aiPickTool).toBeNull();
    expect($('#preview-tool-hint').hidden).toBe(true);
    expect($('.editor-canvas-container').dataset.tool).toBe('');
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
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
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

  it('refuses a pick on the background with a notice and keeps the tool on', async () => {
    mount(3);
    fake.analyzeFrames.mockResolvedValueOnce({ analyzed: 0, skipped: 0, backend: 'wasm' });
    await chooseAi();
    // Frame 1 analyzed: a character on the left half, background on the right
    const data = new Uint8Array(100);
    for (let y = 0; y < 10; y++) data.fill(255, y * 10, y * 10 + 5);
    getSharedMaskStore().set('anime:a1', { data, width: 10, height: 10 }, 'clip-a');
    await settle();

    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    check('ai-pick-keep');
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 90, clientY: 50, bubbles: true }));
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toEqual([]);
    expect(getEditorState()?.aiPickTool).toBe('keep');
    expect($('#ai-notice').textContent).toBe('No character here. Click on a character.');

    // On the character: added, and the notice goes
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 20, clientY: 50, bubbles: true }));
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toHaveLength(1);
    expect(getEditorState()?.aiPickTool).toBeNull();
    expect($('#ai-notice').textContent).toBe('');
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
    // The tool ends: focus goes back to its toggle, the preview leaves the tab order
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
