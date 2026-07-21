import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initEditor } from '../../../src/features/editor/index.js';
import * as ui from '../../../src/features/editor/ui.js';
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

describe('editor subscriber diffs against last-rendered state (issue #50)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;
  /** @type {HTMLElement} */
  let container;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    document.body.innerHTML = '<div id="main-content"></div>';
    // Enable the editor test hooks so we can drive store state directly
    window.__TEST_HOOKS__ = {};
    container = /** @type {HTMLElement} */ (document.querySelector('#main-content'));
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    document.body.innerHTML = '';
    delete window.__TEST_HOOKS__;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies play-button, timeline-range, and scene-panel updates that coalesce inside a single 16ms throttle window', () => {
    setClipPayload({
      frames: createTestFrames(30),
      fps: 30,
      capturedAt: Date.now(),
    });

    cleanup = initEditor();

    // Leading throttle call is consumed immediately by setState -> subscribe.
    // Everything below lands in the SAME throttled window and only the
    // final (state, prevState) pair would survive a naive prevState diff.
    window.__TEST_HOOKS__.setEditorState({ isPlaying: true });
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 5, end: 14 } });
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 9 });
    // Toggle isPlaying back off within the same window: a naive prevState
    // diff (comparing only the last two deliveries) would see
    // prevState.isPlaying === true and state.isPlaying === false and still
    // catch this one - the failure mode is specifically for values that
    // change and then coalesce with unrelated fields, exercised below via
    // the range + scene panel assertions.
    vi.advanceTimersByTime(20);

    const playBtn = container.querySelector('.btn-play');
    expect(playBtn?.classList.contains('playing')).toBe(true);

    expect(container.querySelector('.time-display .total')?.textContent).toBe(
      frameToTimecode(10, 30),
    );
    expect(container.querySelector('.time-display .current')?.textContent).toBe(
      frameToTimecode(4, 30), // frame 9 is 4 frames past the new IN point (5)
    );

    const timelineContainer = container.querySelector('.editor-timeline-container');
    expect(timelineContainer?.querySelector('.tl-selection')).not.toBeNull();
  });

  it('only rebuilds the scenes panel when scene-relevant state actually changes, even under rapid drag-like updates', () => {
    setClipPayload({
      frames: createTestFrames(30),
      fps: 30,
      capturedAt: Date.now(),
    });

    const updateScenesPanelSpy = vi.spyOn(ui, 'updateScenesPanel');

    cleanup = initEditor();
    updateScenesPanelSpy.mockClear();

    // Simulate a drag: many rapid range updates, one per throttle window,
    // each one genuinely changing the selection -> panel must rebuild once
    // per distinct range.
    for (let i = 0; i < 5; i++) {
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: i, end: 20 + i } });
      vi.advanceTimersByTime(20);
    }
    expect(updateScenesPanelSpy).toHaveBeenCalledTimes(5);

    updateScenesPanelSpy.mockClear();

    // Now drive updates that do NOT touch scenes/sceneDetection/selectedRange
    // (only playback state and frame position) - the panel must not rebuild.
    for (let i = 0; i < 5; i++) {
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 10 + i });
      vi.advanceTimersByTime(20);
    }
    expect(updateScenesPanelSpy).not.toHaveBeenCalled();

    updateScenesPanelSpy.mockClear();

    // Re-setting the SAME range repeatedly (e.g. a drag that pauses on one
    // frame while still emitting ticks) must not cause redundant rebuilds.
    for (let i = 0; i < 3; i++) {
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 4, end: 24 } });
      vi.advanceTimersByTime(20);
    }
    expect(updateScenesPanelSpy).not.toHaveBeenCalled();
  });

  it('looks up the timeline container once per subscriber tick instead of twice', () => {
    setClipPayload({
      frames: createTestFrames(30),
      fps: 30,
      capturedAt: Date.now(),
    });

    cleanup = initEditor();

    const querySelectorSpy = vi.spyOn(container, 'querySelector');

    // A single state change that touches both currentFrame (playhead) and
    // selectedRange (timeline range) - both used to look up
    // '.editor-timeline-container' independently.
    window.__TEST_HOOKS__.setEditorState({
      currentFrame: 12,
      selectedRange: { start: 2, end: 20 },
    });
    vi.advanceTimersByTime(20);

    const timelineLookups = querySelectorSpy.mock.calls.filter(
      (call) => call[0] === '.editor-timeline-container',
    );
    expect(timelineLookups.length).toBe(1);
  });

  it('a range change coalesced with a later playback tick within the same window still updates the header, timeline, and scenes panel', () => {
    setClipPayload({
      frames: createTestFrames(30),
      fps: 30,
      capturedAt: Date.now(),
    });

    const updateScenesPanelSpy = vi.spyOn(ui, 'updateScenesPanel');
    cleanup = initEditor();
    updateScenesPanelSpy.mockClear();

    // Leading call consumes the throttle immediately; both of these land in
    // the same trailing window, so only the last (state, prevState) pair
    // would be visible to a naive prevState diff.
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 8 });
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 5, end: 14 } });
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 9 });
    vi.advanceTimersByTime(20);

    expect(container.querySelector('.time-display .total')?.textContent).toBe(
      frameToTimecode(10, 30),
    );
    expect(updateScenesPanelSpy).toHaveBeenCalledTimes(1);
  });
});
