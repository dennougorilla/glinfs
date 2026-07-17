import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClip, getPositionInSelection } from '../../../src/features/editor/core.js';
import { initEditor } from '../../../src/features/editor/index.js';
import { initEditorState } from '../../../src/features/editor/state.js';
import { renderEditorScreen, updateTimelineHeader } from '../../../src/features/editor/ui.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';
import { frameToTimecode } from '../../../src/shared/utils/format.js';

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
    data: /** @type {ImageData} */ (createMockImageData(100, 100)),
    timestamp,
    width: 100,
    height: 100,
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

/**
 * Create no-op UI handlers for renderEditorScreen
 * @returns {import('../../../src/features/editor/ui.js').EditorUIHandlers}
 */
function createHandlers() {
  return {
    onTogglePlay: vi.fn(),
    onFrameChange: vi.fn(),
    onRangeChange: vi.fn(),
    onCropChange: vi.fn(),
    onToggleGrid: vi.fn(),
    onAspectRatioChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onExport: vi.fn(),
  };
}

describe('Toolbar time display updates (issue #44)', () => {
  describe('getPositionInSelection', () => {
    it('returns offset from selection start', () => {
      expect(getPositionInSelection(7, { start: 5, end: 14 })).toBe(2);
    });

    it('clamps to 0 when current frame is before the selection', () => {
      expect(getPositionInSelection(2, { start: 5, end: 14 })).toBe(0);
    });

    it('clamps to the last position when current frame is after the selection', () => {
      expect(getPositionInSelection(20, { start: 5, end: 14 })).toBe(9);
    });
  });

  describe('renderEditorScreen time display', () => {
    /** @type {(() => void) | null} */
    let cleanup = null;
    /** @type {HTMLElement} */
    let container;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      cleanup?.();
      cleanup = null;
      document.body.innerHTML = '';
    });

    it('renders the total span with a "total" class so it can be updated later', () => {
      const state = initEditorState(createClip(createTestFrames(30), 30));
      const result = renderEditorScreen(container, state, createHandlers(), 30);
      cleanup = result.cleanup;

      const totalEl = container.querySelector('.time-display .total');
      expect(totalEl).not.toBeNull();
      expect(totalEl?.textContent).toBe(frameToTimecode(30, 30)); // "01:00"
    });

    it('updateTimelineHeader recomputes current and total time from its arguments', () => {
      const state = initEditorState(createClip(createTestFrames(30), 30));
      const result = renderEditorScreen(container, state, createHandlers(), 30);
      cleanup = result.cleanup;

      // Selection shrinks to 10 frames; playhead (frame 8) stays inside the range
      updateTimelineHeader(container, { start: 5, end: 14 }, 8, 30);

      const currentEl = container.querySelector('.time-display .current');
      const totalEl = container.querySelector('.time-display .total');
      expect(currentEl?.textContent).toBe(frameToTimecode(3, 30)); // "00:03"
      expect(totalEl?.textContent).toBe(frameToTimecode(10, 30)); // "00:10"

      // Existing timeline header fields keep working
      expect(container.querySelector('.timeline-in-value')?.textContent).toBe(
        frameToTimecode(5, 30),
      );
      expect(container.querySelector('.timeline-out-value')?.textContent).toBe(
        frameToTimecode(14, 30),
      );
    });

    it('updateTimelineHeader clamps the current time to the selection bounds', () => {
      const state = initEditorState(createClip(createTestFrames(30), 30));
      const result = renderEditorScreen(container, state, createHandlers(), 30);
      cleanup = result.cleanup;

      // Playhead (frame 20) is outside the new selection
      updateTimelineHeader(container, { start: 0, end: 9 }, 20, 30);

      const currentEl = container.querySelector('.time-display .current');
      expect(currentEl?.textContent).toBe(frameToTimecode(9, 30)); // clamped to last position
    });
  });

  describe('selection change refreshes the time display (via editor store)', () => {
    /** @type {(() => void) | null} */
    let cleanup = null;

    beforeEach(() => {
      vi.useFakeTimers();
      resetAppStore();
      document.body.innerHTML = '<div id="main-content"></div>';
      // Enable the editor test hooks so we can drive store state directly
      window.__TEST_HOOKS__ = {};
    });

    afterEach(() => {
      cleanup?.();
      cleanup = null;
      resetAppStore();
      document.body.innerHTML = '';
      delete window.__TEST_HOOKS__;
      vi.useRealTimers();
    });

    it('updates current and total when only the selection changes', () => {
      setClipPayload({
        frames: createTestFrames(30),
        fps: 30,
        capturedAt: Date.now(),
      });

      cleanup = initEditor();
      const container = /** @type {HTMLElement} */ (document.querySelector('#main-content'));

      expect(container.querySelector('.time-display .total')?.textContent).toBe(
        frameToTimecode(30, 30),
      );

      // Move the playhead inside the future selection (leading throttle call)
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 8 });
      // Change only the selection; playhead stays at frame 8 (inside new range)
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 5, end: 14 } });
      // Flush the trailing throttled subscriber call
      vi.advanceTimersByTime(20);

      expect(container.querySelector('.time-display .current')?.textContent).toBe(
        frameToTimecode(3, 30), // frame 8 is 3 frames past the IN point
      );
      expect(container.querySelector('.time-display .total')?.textContent).toBe(
        frameToTimecode(10, 30), // 10 selected frames
      );
    });

    it('survives a range change coalesced with a playback tick in the same throttle window', () => {
      setClipPayload({
        frames: createTestFrames(30),
        fps: 30,
        capturedAt: Date.now(),
      });

      cleanup = initEditor();
      const container = /** @type {HTMLElement} */ (document.querySelector('#main-content'));

      // First update consumes the leading throttle call and heats the window
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 8 });
      // Range change immediately followed by a playback tick within 16ms:
      // the throttle delivers only the LAST (state, prevState) pair, whose
      // prevState already contains the new range — a prevState diff misses
      // it (Codex review on #60).
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 5, end: 14 } });
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 9 });
      vi.advanceTimersByTime(20);

      expect(container.querySelector('.time-display .total')?.textContent).toBe(
        frameToTimecode(10, 30),
      );
      expect(container.querySelector('.time-display .current')?.textContent).toBe(
        frameToTimecode(4, 30), // frame 9 is 4 frames past the IN point
      );
    });
  });
});
