import { describe, it, expect } from 'vitest';
import {
  createBuffer,
  addFrame,
  getFrames,
} from '../../../src/features/capture/core.js';
import {
  initCaptureState,
  updateSettings,
  addFrameToState,
} from '../../../src/features/capture/state.js';

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

describe('Buffer Resize During Active Recording (US1 Edge Case)', () => {
  describe('increasing buffer size during recording', () => {
    it('creates new larger buffer when duration increases', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 5 });

      // Add some frames to simulate active recording
      for (let i = 0; i < 50; i++) {
        state = addFrameToState(state, createMockFrame(String(i)));
      }
      expect(state.buffer.size).toBe(50);
      expect(state.buffer.maxFrames).toBe(150); // 5s * 30fps

      // Increase buffer duration (simulates settings change during recording)
      state = updateSettings(state, { bufferDuration: 10 });

      // Buffer should be recreated with new capacity
      expect(state.buffer.maxFrames).toBe(300); // 10s * 30fps
      // Note: Current implementation clears buffer on settings change
      expect(state.buffer.size).toBe(0);
    });
  });

  describe('decreasing buffer size during recording', () => {
    it('creates new smaller buffer when duration decreases', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      // Add frames
      for (let i = 0; i < 100; i++) {
        state = addFrameToState(state, createMockFrame(String(i)));
      }
      expect(state.buffer.maxFrames).toBe(300); // 10s * 30fps

      // Decrease buffer duration
      state = updateSettings(state, { bufferDuration: 5 });

      expect(state.buffer.maxFrames).toBe(150); // 5s * 30fps
    });
  });

  describe('fps change during recording', () => {
    it('recalculates buffer capacity when fps changes', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });
      expect(state.buffer.maxFrames).toBe(300);

      state = updateSettings(state, { fps: 60 });

      expect(state.buffer.maxFrames).toBe(600); // 10s * 60fps
      expect(state.settings.fps).toBe(60);
    });

    it('handles downgrade from 60fps to 15fps', () => {
      let state = initCaptureState({ fps: 60, bufferDuration: 10 });
      expect(state.buffer.maxFrames).toBe(600);

      state = updateSettings(state, { fps: 15 });

      expect(state.buffer.maxFrames).toBe(150); // 10s * 15fps
      expect(state.settings.fps).toBe(15);
    });
  });

  describe('buffer continuity after resize', () => {
    it('can continue adding frames after buffer resize', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 5 });

      // Add some initial frames
      for (let i = 0; i < 20; i++) {
        state = addFrameToState(state, createMockFrame(String(i)));
      }

      // Change settings
      state = updateSettings(state, { bufferDuration: 10 });

      // Continue adding frames after resize
      for (let i = 20; i < 50; i++) {
        state = addFrameToState(state, createMockFrame(String(i)));
      }

      expect(state.buffer.size).toBe(30);
      expect(state.stats.frameCount).toBe(30);
    });

    it('maintains correct stats after resize', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 5 });

      state = updateSettings(state, { bufferDuration: 10 });

      // Add frames
      for (let i = 0; i < 60; i++) {
        state = addFrameToState(state, createMockFrame(String(i)));
      }

      expect(state.stats.frameCount).toBe(60);
      expect(state.stats.duration).toBeCloseTo(2, 1); // 60 frames / 30fps = 2 seconds
    });
  });
});
