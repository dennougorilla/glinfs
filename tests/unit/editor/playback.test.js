import { describe, it, expect } from 'vitest';
import {
  initEditorState,
  togglePlayback,
  setPlaying,
  setPlaybackSpeed,
  goToFrame,
  nextFrame,
  previousFrame,
} from '../../../src/features/editor/state.js';
import { createClip } from '../../../src/features/editor/core.js';

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

describe('Playback State Toggle (US2)', () => {
  describe('togglePlayback', () => {
    it('toggles from playing to stopped (default is playing)', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);
      expect(state.isPlaying).toBe(true);

      state = togglePlayback(state);
      expect(state.isPlaying).toBe(false);
    });

    it('toggles from playing to stopped', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = setPlaying(state, true);
      expect(state.isPlaying).toBe(true);

      state = togglePlayback(state);
      expect(state.isPlaying).toBe(false);
    });

    it('multiple toggles work correctly', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);
      expect(state.isPlaying).toBe(true); // Initial state is playing

      state = togglePlayback(state);
      expect(state.isPlaying).toBe(false);

      state = togglePlayback(state);
      expect(state.isPlaying).toBe(true);

      state = togglePlayback(state);
      expect(state.isPlaying).toBe(false);
    });
  });

  describe('setPlaying', () => {
    it('sets playing state to true', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = setPlaying(state, true);
      expect(state.isPlaying).toBe(true);
    });

    it('sets playing state to false', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);
      state = setPlaying(state, true);

      state = setPlaying(state, false);
      expect(state.isPlaying).toBe(false);
    });
  });

  describe('setPlaybackSpeed', () => {
    it('sets valid playback speed', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = setPlaybackSpeed(state, 2);
      expect(state.playbackSpeed).toBe(2);
    });

    it('clamps speed to minimum 0.25', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = setPlaybackSpeed(state, 0.1);
      expect(state.playbackSpeed).toBe(0.25);
    });

    it('clamps speed to maximum 4', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = setPlaybackSpeed(state, 10);
      expect(state.playbackSpeed).toBe(4);
    });
  });

  describe('frame navigation', () => {
    it('goToFrame navigates to specific frame', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = goToFrame(state, 5);
      expect(state.currentFrame).toBe(5);
    });

    it('goToFrame clamps to valid range', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);

      state = goToFrame(state, 100);
      expect(state.currentFrame).toBe(9); // max is 9 (0-indexed)

      state = goToFrame(state, -5);
      expect(state.currentFrame).toBe(0);
    });

    it('nextFrame advances by one', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);
      state = goToFrame(state, 3);

      state = nextFrame(state);
      expect(state.currentFrame).toBe(4);
    });

    it('previousFrame goes back by one', () => {
      const clip = createClip(createTestFrames(10));
      let state = initEditorState(clip);
      state = goToFrame(state, 5);

      state = previousFrame(state);
      expect(state.currentFrame).toBe(4);
    });
  });
});
