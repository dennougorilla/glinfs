/**
 * The AI cutout wired into a mounted editor (segmentation manager faked):
 * method switch, analysis UI, pick tools on the preview, Escape order,
 * parameter controls, and mask cleanup when clips are released.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/ai-cutout/segmentation-manager.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  const fake = {
    getCapabilities: vi.fn(async () => ({ webgpu: false })),
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
    fake.analyzeFrames.mockImplementation(async (frames, options) => {
      const store = getSharedMaskStore();
      const pending = segmentation.collectPendingFrames(frames, store);
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
    // Keep the playhead still
    window.__TEST_HOOKS__.setEditorState({ isPlaying: false });
  }

  async function chooseAi() {
    check('ai-method-ai');
    await settle();
  }

  it('switches the method: AI section instead of the color key, removal on, no key color', async () => {
    mount();
    expect(/** @type {HTMLInputElement} */ ($('#ai-method-color')).checked).toBe(true);
    expect($('#ai-section').hidden).toBe(true);
    expect($('#ai-color-fields').hidden).toBe(false);

    await chooseAi();
    const bg = getEditorState()?.edits.background;
    expect(bg).toMatchObject({ method: 'ai', enabled: true, colorChosen: false });
    expect($('#ai-section').hidden).toBe(false);
    expect($('#ai-color-fields').hidden).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('#background-enabled')).checked).toBe(true);
    expect($('#ai-intro').textContent).toContain('about 200 MB');

    // No adapter: the warning with the explicit slow option
    expect(fake.getCapabilities).toHaveBeenCalled();
    expect($('#ai-webgpu-warning').hidden).toBe(false);
    expect($('#ai-run-wasm').textContent).toBe('Run without WebGPU (very slow)');

    // Turning removal off and on again never picks a key color for the AI
    check('background-enabled', false);
    check('background-enabled', true);
    await settle();
    expect(getEditorState()?.edits.background).toMatchObject({
      enabled: true,
      color: '#00ff00',
      colorChosen: false,
    });

    check('ai-method-color');
    await settle();
    expect(getEditorState()?.edits.background.method).toBe('color');
    expect($('#ai-section').hidden).toBe(true);
  });

  it('analyzes the selection and shows the controls; the preview note follows', async () => {
    mount();
    await chooseAi();
    expect($('#ai-preview-note').hidden).toBe(false);
    expect($('#ai-preview-note').textContent).toBe('Not analyzed yet');
    expect($('#ai-controls').hidden).toBe(true);

    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 3 } });
    await settle();
    expect($('#ai-analyze').textContent).toBe('Analyze selection (4 frames)');

    $('#ai-analyze').click();
    await settle();
    await settle();
    expect(fake.analyzeFrames).toHaveBeenCalledTimes(1);
    expect(fake.analyzeFrames.mock.calls[0][0]).toHaveLength(4);
    expect(fake.analyzeFrames.mock.calls[0][1]).toMatchObject({
      clipId: 'clip-a',
      allowWasm: false,
    });
    expect($('#ai-coverage').textContent).toBe('4 of 6 frames analyzed');
    expect($('#ai-analyze').textContent).toBe('Selection analyzed');
    expect(/** @type {HTMLButtonElement} */ ($('#ai-analyze')).disabled).toBe(true);
    expect($('#ai-notice').textContent).toBe('Analyzed 4 frames.');
    expect($('#ai-controls').hidden).toBe(false);
    expect(getSharedMaskStore().keysForClip('clip-a')).toHaveLength(4);

    // Final masks built: the analyzed frame has no note
    await vi.waitFor(async () => {
      await settle();
      expect(getEditorState()?.aiCutout.maskVersion).toBeGreaterThan(0);
    });
    await settle();
    expect($('#ai-preview-note').hidden).toBe(true);
  });

  it('the explicit WASM choice runs the analysis with WASM allowed', async () => {
    mount(2);
    await chooseAi();
    $('#ai-run-wasm').click();
    await settle();
    await settle();
    expect(fake.analyzeFrames.mock.calls[0][1].allowWasm).toBe(true);
    expect($('#ai-webgpu-warning').hidden).toBe(true);
    expect($('#ai-wasm-note').hidden).toBe(false);
  });

  it('shows errors with Retry', async () => {
    mount(2);
    await chooseAi();
    fake.analyzeFrames.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'download-failed' }),
    );
    $('#ai-analyze').click();
    await settle();
    await settle();
    expect($('#ai-error').hidden).toBe(false);
    expect($('#ai-error-text').textContent).toContain('could not be downloaded');
    $('#ai-retry').click();
    await settle();
    await settle();
    expect($('#ai-error').hidden).toBe(true);
    expect($('#ai-coverage').textContent).toBe('2 of 2 frames analyzed');
  });

  it('pick tools: a preview click adds a pick on the current frame; Escape leaves the tool first', async () => {
    mount();
    await chooseAi();
    $('#ai-analyze').click();
    await settle();
    await settle();

    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');

    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    check('ai-pick-keep');
    await settle();
    expect(getEditorState()?.aiPickTool).toBe('keep');
    expect($('#ai-pick-status').textContent).toContain('Click a character');
    expect($('.editor-canvas-container').classList.contains('editor-ai-picking')).toBe(true);

    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 30, clientY: 70, bubbles: true }));
    await settle();
    let state = getEditorState();
    expect(state?.edits.background.ai.picks).toEqual([{ frame: 2, x: 0.3, y: 0.7, mode: 'keep' }]);
    expect(state?.aiPickTool).toBeNull();
    // The crop was not touched by the pick
    expect(state?.cropArea).toBeNull();
    expect($('#ai-pick-list').children).toHaveLength(1);
    expect($('#ai-pick-list').textContent).toContain('Keep at');

    // Escape: pick tool first, then (next press) the rest of the chain
    check('ai-pick-remove');
    await settle();
    expect(getEditorState()?.aiPickTool).toBe('remove');
    press('Escape');
    expect(getEditorState()?.aiPickTool).toBeNull();

    // A pick on a frame without analysis is refused with a note
    getSharedMaskStore().delete('a4');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 4 });
    check('ai-pick-remove');
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
    await settle();
    state = getEditorState();
    expect(state?.edits.background.ai.picks).toHaveLength(1);
    expect(state?.aiCutout.notice).toContain('not analyzed yet');

    // The eyedropper and a pick tool exclude each other
    check('background-pick');
    await settle();
    expect(getEditorState()).toMatchObject({ pickingKeyColor: true, aiPickTool: null });
    press('Escape');
    expect(getEditorState()?.pickingKeyColor).toBe(false);

    // List: go to the pick's frame, remove it, clear
    /** @type {HTMLElement} */ ($('.editor-ai-pick-go')).click();
    expect(getEditorState()?.currentFrame).toBe(2);
    /** @type {HTMLElement} */ ($('.editor-ai-pick-delete')).click();
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toEqual([]);
    expect($('#ai-pick-list').hidden).toBe(true);
  });

  it('switching to Color stops a running analysis (its progress and Cancel would be hidden)', async () => {
    mount(2);
    await chooseAi();
    /** @type {AbortSignal | null} */
    let signal = null;
    fake.analyzeFrames.mockImplementationOnce(
      (/** @type {any} */ _frames, /** @type {any} */ options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    $('#ai-analyze').click();
    await settle();
    expect(signal).not.toBeNull();
    expect($('#ai-progress').hidden).toBe(false);

    check('ai-method-color');
    await settle();
    expect(/** @type {AbortSignal} */ (/** @type {unknown} */ (signal)).aborted).toBe(true);
    expect($('#ai-section').hidden).toBe(true);
    expect(getEditorState()?.aiCutout.phase).toBe('idle');
  });

  it('a pick that works clears the earlier "not analyzed yet" pick notice', async () => {
    mount(3);
    await chooseAi();
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 1 } });
    await settle();
    $('#ai-analyze').click();
    await settle();
    await settle();
    expect($('#ai-notice').textContent).toBe('Analyzed 2 frames.');

    const base = /** @type {HTMLCanvasElement} */ ($('.editor-canvas'));
    base.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = $('.editor-canvas-overlay');

    // Frame 2 has no analysis: refused with a notice
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    check('ai-pick-keep');
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
    await settle();
    expect($('#ai-notice').textContent).toContain('not analyzed yet');

    // Frame 1 is analyzed: the pick is added and the notice goes
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toHaveLength(1);
    expect($('#ai-notice').textContent).toBe('');

    // Leaving the tool clears it too, but other notices stay
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    check('ai-pick-remove');
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
    await settle();
    expect($('#ai-notice').textContent).toContain('not analyzed yet');
    press('Escape');
    await settle();
    expect(getEditorState()?.aiPickTool).toBeNull();
    expect($('#ai-notice').textContent).toBe('');
  });

  it('refuses a pick on the background with a notice and keeps the tool on', async () => {
    mount(3);
    await chooseAi();
    // Frame 1 analyzed: a character on the left half, background on the right
    const data = new Uint8Array(100);
    for (let y = 0; y < 10; y++) data.fill(255, y * 10, y * 10 + 5);
    getSharedMaskStore().set('a1', { data, width: 10, height: 10 }, 'clip-a');
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

  it('keeps keyboard focus in the AI section when the focused control hides or disables itself', async () => {
    mount(2);
    await chooseAi();
    $('#ai-analyze').click();
    await settle();
    await settle();

    // Clear picks hides itself: focus moves to the Keep tool
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
    $('#ai-picks-clear').focus();
    $('#ai-picks-clear').click();
    await settle();
    expect($('#ai-picks-clear').hidden).toBe(true);
    expect(document.activeElement?.id).toBe('ai-pick-keep');

    // Analyze disables itself while running: focus moves to Cancel, and back
    // to Analyze when Cancel hides
    fake.analyzeFrames.mockImplementationOnce(
      (/** @type {any} */ _frames, /** @type {any} */ options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 1 } });
    getSharedMaskStore().delete('a1');
    getSharedMaskStore().delete('a0');
    await settle();
    $('#ai-analyze').focus();
    $('#ai-analyze').click();
    await settle();
    expect(/** @type {HTMLButtonElement} */ ($('#ai-analyze')).disabled).toBe(true);
    expect(document.activeElement?.id).toBe('ai-cancel');
    $('#ai-cancel').click();
    await settle();
    await settle();
    expect($('#ai-progress').hidden).toBe(true);
    expect(document.activeElement?.id).toBe('ai-analyze');
  });

  it('keyboard picks: the focused preview moves a marker with the arrows and picks on Enter', async () => {
    mount();
    await chooseAi();
    $('#ai-analyze').click();
    await settle();
    await settle();
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
    expect($('#ai-pick-status').textContent).toContain('arrow keys');

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

  it('parameter controls patch the AI edits', async () => {
    mount(2);
    await chooseAi();
    $('#ai-analyze').click();
    await settle();
    await settle();

    const threshold = /** @type {HTMLInputElement} */ ($('#ai-threshold'));
    threshold.value = '70';
    threshold.dispatchEvent(new Event('input', { bubbles: true }));
    const edge = /** @type {HTMLInputElement} */ ($('#ai-edge'));
    edge.value = '-3';
    edge.dispatchEvent(new Event('input', { bubbles: true }));
    check('ai-smoothing', false);
    await settle();

    expect(getEditorState()?.edits.background.ai).toMatchObject({
      threshold: 0.7,
      edge: -3,
      smoothing: false,
    });
    expect($('#ai-threshold-value').textContent).toBe('70%');
    expect($('#ai-edge-value').textContent).toBe('−3 px');

    // Clear picks
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
    expect($('#ai-picks-clear').hidden).toBe(false);
    $('#ai-picks-clear').click();
    await settle();
    expect(getEditorState()?.edits.background.ai.picks).toEqual([]);
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
      $('#ai-analyze').click();
      await settle();
      expect(fake.analyzeFrames).toHaveBeenCalledTimes(1);
      expect(fake.analyzeFrames.mock.calls[0][1].clipId).toBe('clip-a');
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
    store.set('q0', { data: new Uint8Array(4), width: 2, height: 2 }, 'clip-q');
    store.set('a0', { data: new Uint8Array(4), width: 2, height: 2 }, 'clip-a');
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
    expect(store.has('q0')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(store.has('q0')).toBe(false);
    expect(store.has('a0')).toBe(true);
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
