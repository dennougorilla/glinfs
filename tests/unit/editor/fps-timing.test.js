import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClip,
  getClipFps,
  getPlaybackIntervalMs,
} from '../../../src/features/editor/core.js';
import { initEditor } from '../../../src/features/editor/index.js';
import { renderTimeline } from '../../../src/features/editor/timeline.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

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
    frames.push(createMockFrame(String(i), i * 16.67));
  }
  return frames;
}

describe('FPS-aware playback timing (issue #41)', () => {
  describe('getClipFps', () => {
    it('returns the clip fps when set', () => {
      const clip = createClip(createTestFrames(10), 60);
      expect(getClipFps(clip)).toBe(60);
    });

    it('falls back to 30 for null clip', () => {
      expect(getClipFps(null)).toBe(30);
    });

    it('falls back to 30 for invalid fps values', () => {
      const clip = createClip(createTestFrames(10), 60);
      expect(getClipFps({ ...clip, fps: 0 })).toBe(30);
      expect(getClipFps({ ...clip, fps: undefined })).toBe(30);
    });
  });

  describe('getPlaybackIntervalMs', () => {
    it('returns ~16.7ms for a 60fps clip at 1x speed', () => {
      expect(getPlaybackIntervalMs(60, 1)).toBeCloseTo(16.67, 1);
    });

    it('returns ~66.7ms for a 15fps clip at 1x speed', () => {
      expect(getPlaybackIntervalMs(15, 1)).toBeCloseTo(66.67, 1);
    });

    it('scales with playback speed', () => {
      expect(getPlaybackIntervalMs(30, 2)).toBeCloseTo(16.67, 1);
      expect(getPlaybackIntervalMs(30, 0.5)).toBeCloseTo(66.67, 1);
    });

    it('defaults playback speed to 1', () => {
      expect(getPlaybackIntervalMs(30)).toBeCloseTo(33.33, 1);
    });
  });

  describe('playback loop uses clip fps', () => {
    /** @type {(() => void) | null} */
    let cleanup = null;
    /** @type {FrameRequestCallback[]} */
    let pendingFrames = [];

    /**
     * Run the queued animation frame callbacks at a given timestamp
     * @param {number} timestamp
     */
    function flushFrame(timestamp) {
      const callbacks = pendingFrames;
      pendingFrames = [];
      for (const callback of callbacks) callback(timestamp);
    }

    /**
     * Start the editor with a clip; it auto-plays on init
     * @param {number} frameCount
     * @param {number} fps
     * @returns {number} performance.now() at the time playback started
     */
    function startEditor(frameCount, fps) {
      setClipPayload({ frames: createTestFrames(frameCount), fps, capturedAt: Date.now() });
      const startedAt = 1000;
      vi.spyOn(performance, 'now').mockReturnValue(startedAt);
      cleanup = initEditor();
      return startedAt;
    }

    beforeEach(() => {
      resetAppStore();
      pendingFrames = [];
      document.body.innerHTML = '<div id="main-content"></div>';
      window.__TEST_HOOKS__ = {};
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
        pendingFrames = [];
      });
    });

    afterEach(() => {
      cleanup?.();
      cleanup = null;
      delete window.__TEST_HOOKS__;
      resetAppStore();
      document.body.innerHTML = '';
      vi.restoreAllMocks();
    });

    const currentFrame = () => window.__TEST_HOOKS__.getEditorState().currentFrame;

    it('advances ~60 frames per second of wall-clock time for a 60fps clip', () => {
      const t0 = startEditor(200, 60);
      expect(window.requestAnimationFrame).toHaveBeenCalled();

      flushFrame(t0 + 1000 / 60 + 1);
      expect(currentFrame()).toBe(1);
      flushFrame(t0 + 1000);
      expect(currentFrame()).toBe(60);
    });

    it('advances ~15 frames per second of wall-clock time for a 15fps clip', () => {
      const t0 = startEditor(200, 15);

      flushFrame(t0 + 50);
      expect(currentFrame()).toBe(0);
      flushFrame(t0 + 1000);
      expect(currentFrame()).toBe(15);
    });

    it('catches up on a late tick and wraps within the selected range', () => {
      const t0 = startEditor(10, 30);

      // One tick 1s late: 30 frames elapsed in a 10-frame loop
      flushFrame(t0 + 1000);
      expect(currentFrame()).toBe(0);
      flushFrame(t0 + 1100);
      expect(currentFrame()).toBe(3);
    });

    it('re-anchors on an external seek instead of jumping back to the clock', () => {
      const t0 = startEditor(100, 30);

      flushFrame(t0 + 1000);
      expect(currentFrame()).toBe(30);
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 80 });
      flushFrame(t0 + 1010);
      expect(currentFrame()).toBe(80);
      flushFrame(t0 + 1010 + 100);
      expect(currentFrame()).toBe(83);
    });

    it('stops scheduling frames after cleanup', () => {
      startEditor(10, 30);
      expect(pendingFrames.length).toBe(1);

      cleanup?.();
      cleanup = null;
      expect(window.cancelAnimationFrame).toHaveBeenCalled();
      expect(pendingFrames.length).toBe(0);
    });
  });

  describe('timeline hover timecode uses clip fps', () => {
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

    /**
     * Render the timeline and prepare the track for hover interaction
     * @param {import('../../../src/features/editor/types.js').Clip} clip
     * @returns {HTMLElement} The timeline track element
     */
    function renderAndGetTrack(clip) {
      cleanup = renderTimeline(container, clip, 0, clip.selectedRange, {
        onRangeChange: vi.fn(),
      });

      const track = /** @type {HTMLElement} */ (container.querySelector('.tl-track'));
      // JSDOM has no layout, so mock the track geometry (120px wide)
      track.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 120,
        bottom: 40,
        width: 120,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      return track;
    }

    it('shows frame 60 of a 60fps clip as 1 second ("01:00")', () => {
      // 121 frames at 60fps: hovering at 50% = frame 60 = exactly 1.0s
      const clip = createClip(createTestFrames(121), 60);
      const track = renderAndGetTrack(clip);

      track.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, bubbles: true }));

      const hoverTime = container.querySelector('.tl-hover-time');
      expect(hoverTime?.textContent).toBe('01:00');
    });

    it('shows frame 15 of a 15fps clip as 1 second ("01:00")', () => {
      // 31 frames at 15fps: hovering at 50% = frame 15 = exactly 1.0s
      const clip = createClip(createTestFrames(31), 15);
      const track = renderAndGetTrack(clip);

      track.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, bubbles: true }));

      const hoverTime = container.querySelector('.tl-hover-time');
      expect(hoverTime?.textContent).toBe('01:00');
    });
  });
});
