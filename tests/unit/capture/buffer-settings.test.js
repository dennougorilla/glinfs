import { describe, expect, it } from 'vitest';
import { calculateMaxFrames } from '../../../src/features/capture/core.js';
import { initCaptureState, updateSettings } from '../../../src/features/capture/state.js';

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
    it('resets stats when buffer duration changes', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { bufferDuration: 20 });

      expect(state.stats.frameCount).toBe(0);
      expect(state.stats.duration).toBe(0);
      expect(state.settings.bufferDuration).toBe(20);
    });

    it('resets stats when fps changes', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { fps: 60 });

      expect(state.stats.frameCount).toBe(0);
      expect(state.stats.fps).toBe(60);
      expect(state.settings.fps).toBe(60);
    });

    it('resets stats when both fps and duration change', () => {
      let state = initCaptureState({ fps: 30, bufferDuration: 10 });

      state = updateSettings(state, { fps: 15, bufferDuration: 30 });

      expect(state.stats.frameCount).toBe(0);
      expect(state.settings.fps).toBe(15);
      expect(state.settings.bufferDuration).toBe(30);
    });
  });
});
