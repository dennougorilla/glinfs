/**
 * Regression tests for issue #37 (stale-state handlers from the #30 refactor)
 *
 * render() runs only once, so frame navigation buttons, keyboard shortcuts,
 * and the Clear Crop button must read the CURRENT state via handlers.getState()
 * instead of closing over the initial state snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { releaseAllFramesAndReset, setClipPayload } from '../../../src/shared/app-store.js';

/**
 * Create mock ImageData for testing
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function createMockImageData(width, height) {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

/**
 * Create a mock frame for testing
 * @param {string} id
 * @param {number} timestamp
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id, timestamp = 0) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(10, 10)),
    timestamp,
    width: 10,
    height: 10,
  };
}

/**
 * Create test frames
 * @param {number} count
 * @returns {import('../../../src/features/capture/types.js').Frame[]}
 */
function createTestFrames(count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(createMockFrame(String(i), i * 33.33));
  }
  return frames;
}

/** @type {(() => void) | null} */
let editorCleanup = null;

/**
 * Initialize the editor with a fresh 10-frame clip and test hooks enabled
 * @param {number} frameCount
 */
function initEditorWithClip(frameCount = 10) {
  window.__TEST_HOOKS__ = {};
  setClipPayload({
    frames: createTestFrames(frameCount),
    fps: 30,
    capturedAt: Date.now(),
  });
  editorCleanup = /** @type {() => void} */ (initEditor());
}

describe('Editor UI handlers use current state (issue #37)', () => {
  beforeEach(() => {
    // Fake timers keep the auto-playback interval and throttled
    // subscription updates fully deterministic.
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="main-content"></div>';
  });

  afterEach(() => {
    if (editorCleanup) {
      editorCleanup();
      editorCleanup = null;
    }
    releaseAllFramesAndReset();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('editor mount lifecycle', () => {
    it('routes an empty clip through validation without mounting the editor UI', () => {
      initEditorWithClip(0);

      expect(document.querySelector('#main-content')?.textContent).toContain('Invalid Clip Data');
      expect(document.querySelector('#main-content')?.textContent).toContain(
        'ClipPayload.frames cannot be empty',
      );
      expect(document.querySelector('.editor-toolbar')).toBeNull();
      expect(getEditorState()).toBeNull();
    });

    it('cancels a pending throttled render when the editor unmounts', () => {
      initEditorWithClip(10);
      const pauseBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('[aria-label="Pause"]')
      );
      pauseBtn.click();
      vi.advanceTimersByTime(20);

      const setEditorState = window.__TEST_HOOKS__.setEditorState;
      setEditorState({ currentFrame: 1 });
      setEditorState({ currentFrame: 2 });
      expect(vi.getTimerCount()).toBe(1);

      editorCleanup?.();
      editorCleanup = null;
      document.querySelector('#main-content').innerHTML = '<p data-after-cleanup>Unmounted</p>';

      expect(getEditorState()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(20);
      expect(document.querySelector('[data-after-cleanup]')?.textContent).toBe('Unmounted');
    });
  });

  describe('frame navigation buttons', () => {
    it('pressing Next twice advances currentFrame by 2', () => {
      initEditorWithClip(10);
      const nextBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('[aria-label="Next frame"]')
      );
      expect(nextBtn).toBeTruthy();
      expect(getEditorState()?.currentFrame).toBe(0);

      nextBtn.click();
      expect(getEditorState()?.currentFrame).toBe(1);

      nextBtn.click();
      expect(getEditorState()?.currentFrame).toBe(2);
    });

    it('pressing Previous twice goes back 2 frames from the current position', () => {
      initEditorWithClip(10);
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 5 });

      const prevBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('[aria-label="Previous frame"]')
      );
      prevBtn.click();
      prevBtn.click();
      expect(getEditorState()?.currentFrame).toBe(3);
    });

    it('First/Last frame buttons use the current selection range', () => {
      initEditorWithClip(10);
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 2, end: 7 } });

      const lastBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('[aria-label="Go to last frame"]')
      );
      lastBtn.click();
      expect(getEditorState()?.currentFrame).toBe(7);

      const firstBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('[aria-label="Go to first frame"]')
      );
      firstBtn.click();
      expect(getEditorState()?.currentFrame).toBe(2);
    });
  });

  describe('keyboard shortcuts', () => {
    it('pressing ArrowRight twice advances currentFrame by 2', () => {
      initEditorWithClip(10);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(getEditorState()?.currentFrame).toBe(2);
    });

    it('pressing ArrowLeft twice goes back 2 frames from the current position', () => {
      initEditorWithClip(10);
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 5 });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      expect(getEditorState()?.currentFrame).toBe(3);
    });

    it('Home/End use the current selection range', () => {
      initEditorWithClip(10);
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 2, end: 7 } });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
      expect(getEditorState()?.currentFrame).toBe(7);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
      expect(getEditorState()?.currentFrame).toBe(2);
    });

    it('suppresses editor shortcuts while the Frame Grid modal is open', () => {
      initEditorWithClip(10);
      const cropArea = { x: 1, y: 1, width: 8, height: 8, aspectRatio: 'free' };

      const pauseBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('[aria-label="Pause"]')
      );
      pauseBtn.click();
      expect(getEditorState()?.isPlaying).toBe(false);

      window.__TEST_HOOKS__.setEditorState({
        currentFrame: 0,
        cropArea,
        showGrid: false,
      });

      const frameGridBtn = /** @type {HTMLButtonElement} */ (
        document.querySelector('.btn-frame-grid-compact')
      );
      frameGridBtn.focus();
      frameGridBtn.click();
      expect(document.querySelector('.frame-grid-modal')).toBeTruthy();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));

      expect(getEditorState()?.currentFrame).toBe(0);
      expect(getEditorState()?.showGrid).toBe(false);
      expect(getEditorState()?.isPlaying).toBe(false);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(document.querySelector('.frame-grid-modal')).toBeNull();
      expect(getEditorState()?.cropArea).toEqual(cropArea);
    });
  });

  describe('Clear Crop button', () => {
    it('renders a crop change coalesced with a later frame update', () => {
      initEditorWithClip(10);
      const setEditorState = window.__TEST_HOOKS__.setEditorState;
      const cropArea = { x: 1, y: 1, width: 8, height: 8, aspectRatio: 'free' };

      // Heat the leading edge, then make a crop transition that is followed
      // by another update inside the throttle window. The trailing store
      // prevState already contains the crop, although the UI has not seen it.
      setEditorState({ currentFrame: 1 });
      setEditorState({ cropArea });
      setEditorState({ currentFrame: 2 });
      vi.advanceTimersByTime(20);

      expect(document.querySelector('.btn-clear-crop')).toBeTruthy();
      expect(getEditorState()?.cropArea).toEqual(cropArea);
    });

    it('still clears the crop after multiple crop updates', () => {
      initEditorWithClip(10);
      const setEditorState = window.__TEST_HOOKS__.setEditorState;

      // Simulate a crop drag: multiple state updates, each processed by the
      // throttled subscription (advance past the 16ms throttle window).
      setEditorState({ cropArea: { x: 0, y: 0, width: 8, height: 8, aspectRatio: 'free' } });
      vi.advanceTimersByTime(20);
      setEditorState({ cropArea: { x: 1, y: 1, width: 7, height: 7, aspectRatio: 'free' } });
      vi.advanceTimersByTime(20);
      setEditorState({ cropArea: { x: 2, y: 2, width: 6, height: 6, aspectRatio: 'free' } });
      vi.advanceTimersByTime(20);

      const clearBtn = /** @type {HTMLButtonElement} */ (document.querySelector('.btn-clear-crop'));
      expect(clearBtn).toBeTruthy();

      clearBtn.click();
      expect(getEditorState()?.cropArea).toBeNull();
    });

    it('removes the Clear Crop button after clearing', () => {
      initEditorWithClip(10);
      const setEditorState = window.__TEST_HOOKS__.setEditorState;

      setEditorState({ cropArea: { x: 0, y: 0, width: 8, height: 8, aspectRatio: 'free' } });
      vi.advanceTimersByTime(20);

      const clearBtn = /** @type {HTMLButtonElement} */ (document.querySelector('.btn-clear-crop'));
      clearBtn.click();
      vi.advanceTimersByTime(20);

      expect(document.querySelector('.btn-clear-crop')).toBeNull();
    });
  });
});
