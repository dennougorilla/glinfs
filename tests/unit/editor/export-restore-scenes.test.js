import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClip } from '../../../src/features/editor/core.js';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { resetAppStore, setClipPayload, setEditorPayload } from '../../../src/shared/app-store.js';

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
 * Create mock detected scenes
 * @returns {import('../../../src/features/scene-detection/types.js').Scene[]}
 */
function createMockScenes() {
  return [
    { id: 'scene-1', startFrame: 0, endFrame: 4, confidence: 0.9 },
    { id: 'scene-2', startFrame: 5, endFrame: 9, confidence: 0.8 },
  ];
}

describe('Scene restoration when returning from Export (issue #43)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    resetAppStore();
    document.body.innerHTML = '<div id="main-content"></div>';
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    document.body.innerHTML = '';
  });

  it('re-applies pre-computed scenes when restoring editor state from EditorPayload', () => {
    const frames = createTestFrames(10);
    const scenes = createMockScenes();

    // Capture produced a clip with scene detection enabled and pre-computed scenes
    setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      sceneDetectionEnabled: true,
      scenes,
    });

    // Simulate handleExport(): editor state saved before navigating to Export
    const clip = { ...createClip(frames, 30), selectedRange: { start: 2, end: 8 } };
    setEditorPayload({
      selectedRange: clip.selectedRange,
      cropArea: null,
      clip,
      fps: 30,
    });

    // Returning from Export: initEditor restores from EditorPayload
    cleanup = initEditor();

    const state = getEditorState();
    expect(state).not.toBeNull();
    // Restore path was taken (selection preserved)
    expect(state?.selectedRange).toEqual({ start: 2, end: 8 });
    // Scenes must be re-applied from the ClipPayload (regression: previously [])
    expect(state?.scenes).toEqual(scenes);
    expect(state?.sceneDetectionStatus).toBe('completed');
  });

  it('renders the scenes sidebar with the restored scenes instead of the empty state', () => {
    const frames = createTestFrames(10);
    const scenes = createMockScenes();

    setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      sceneDetectionEnabled: true,
      scenes,
    });
    setEditorPayload({
      selectedRange: { start: 0, end: 9 },
      cropArea: null,
      clip: createClip(frames, 30),
      fps: 30,
    });

    cleanup = initEditor();

    const sidebar = document.querySelector('[data-scenes-container]');
    expect(sidebar).not.toBeNull();
    // Must not show the "No scenes to show" empty state after a round-trip
    expect(sidebar?.textContent).not.toContain('No scenes to show');
    const sceneCards = sidebar?.querySelectorAll('.scene-thumbnail-card');
    expect(sceneCards?.length).toBe(scenes.length);
  });

  it('keeps scenes empty in the restore path when scene detection was disabled', () => {
    const frames = createTestFrames(10);

    setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      sceneDetectionEnabled: false,
    });
    setEditorPayload({
      selectedRange: { start: 0, end: 9 },
      cropArea: null,
      clip: createClip(frames, 30),
      fps: 30,
    });

    cleanup = initEditor();

    const state = getEditorState();
    expect(state?.scenes).toEqual([]);
    expect(state?.sceneDetectionStatus).toBe('idle');
  });

  it('still applies pre-computed scenes on the fresh path from Capture', () => {
    const frames = createTestFrames(10);
    const scenes = createMockScenes();

    // No EditorPayload: fresh navigation from Capture
    setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      sceneDetectionEnabled: true,
      scenes,
    });

    cleanup = initEditor();

    const state = getEditorState();
    expect(state?.scenes).toEqual(scenes);
    expect(state?.sceneDetectionStatus).toBe('completed');
  });

  it('treats a cached empty scene list as completed instead of re-detecting', () => {
    const frames = createTestFrames(10);

    // Detection legitimately found no transitions: loading stored []
    setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      sceneDetectionEnabled: true,
      scenes: [],
    });

    cleanup = initEditor();

    const state = getEditorState();
    // Regression (Codex review on #59): [] was treated as "missing" and the
    // full async detection restarted on every visit, flashing a detecting
    // state over the correct completed result.
    expect(state?.sceneDetectionStatus).toBe('completed');
    expect(state?.scenes).toEqual([]);
  });
});
