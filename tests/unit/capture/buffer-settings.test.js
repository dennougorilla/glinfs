import { describe, it, expect } from 'vitest';
import {
  initCaptureState,
  updateSettings,
} from '../../../src/features/capture/state.js';
import { calculateMaxFrames } from '../../../src/features/capture/core.js';

describe('Buffer Duration Settings Sync (US1)', () => {
  describe('buffer duration calculation', () => {
    it('calculates correct maxFrames from settings', () => {
      // 10 seconds at 30fps = 300 frames
      expect(calculateMaxFrames({ fps: 30, bufferDuration: 10, thumbnailQuality: 0.5 })).toBe(300);

      // 5 seconds at 60fps = 300 frames
      expect(calculateMaxFrames({ fps: 60, bufferDuration: 5, thumbnailQuality: 0.5 })).toBe(300);

      // 60 seconds at 15fps = 900 frames
      expect(calculateMaxFrames({ fps: 15, bufferDuration: 60, thumbnailQuality: 0.5 })).toBe(900);
    });
  });

  describe('state sync with settings', () => {
    it('initial state buffer matches settings', () => {
      const state = initCaptureState({ fps: 30, bufferDuration: 10 });

      expect(state.buffer.maxFrames).toBe(300);
      expect(state.settings.bufferDuration).toBe(10);
      expect(state.settings.fps).toBe(30);
    });

    it('updates buffer when duration changes', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { bufferDuration: 20 });

      expect(state.buffer.maxFrames).toBe(600); // 20s * 30fps
      expect(state.settings.bufferDuration).toBe(20);
    });

    it('updates buffer when fps changes', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { fps: 60 });

      expect(state.buffer.maxFrames).toBe(600); // 10s * 60fps
      expect(state.settings.fps).toBe(60);
    });

    it('updates buffer when both fps and duration change', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { fps: 15, bufferDuration: 30 });

      expect(state.buffer.maxFrames).toBe(450); // 30s * 15fps
      expect(state.settings.fps).toBe(15);
      expect(state.settings.bufferDuration).toBe(30);
    });

    it('resets buffer stats when settings change', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { bufferDuration: 20 });

      expect(state.stats.frameCount).toBe(0);
      expect(state.stats.duration).toBe(0);
      expect(state.stats.memoryMB).toBe(0);
      expect(state.buffer.size).toBe(0);
    });
  });

  describe('settings boundary values', () => {
    it('handles minimum buffer duration (5s)', () => {
      const state = initCaptureState({ fps: 30, bufferDuration: 5 });

      expect(state.buffer.maxFrames).toBe(150); // 5s * 30fps
      expect(state.settings.bufferDuration).toBe(5);
    });

    it('handles maximum buffer duration (60s)', () => {
      const state = initCaptureState({ fps: 30, bufferDuration: 60 });

      expect(state.buffer.maxFrames).toBe(1800); // 60s * 30fps
      expect(state.settings.bufferDuration).toBe(60);
    });

    it('handles high fps with long duration', () => {
      const state = initCaptureState({ fps: 60, bufferDuration: 60 });

      expect(state.buffer.maxFrames).toBe(3600); // 60s * 60fps
    });
  });
});
