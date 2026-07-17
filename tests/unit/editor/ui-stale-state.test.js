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
  });

  describe('Clear Crop button', () => {
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
