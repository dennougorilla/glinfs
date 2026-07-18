import { describe, expect, it } from 'vitest';
import { createCaptureStore, updateSettings } from '../../../src/features/capture/state.js';

describe('updateSettings', () => {
  it('updates worker configuration without mutating the previous state', () => {
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });
    const previous = store.getState();

    store.setState((state) => updateSettings(state, { fps: 15, bufferDuration: 20 }));

    expect(previous.settings).toEqual(expect.objectContaining({ fps: 30, bufferDuration: 10 }));
    expect(store.getState().settings).toEqual(
      expect.objectContaining({ fps: 15, bufferDuration: 20 }),
    );
  });

  it('preserves worker stats for unrelated settings', () => {
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });
    store.setState((state) => ({
      ...state,
      stats: { frameCount: 10, duration: 1 / 3, memoryMB: 0, fps: 30 },
    }));

    store.setState((state) => updateSettings(state, { sceneDetection: false }));

    expect(store.getState().stats.frameCount).toBe(10);
    expect(store.getState().settings.sceneDetection).toBe(false);
  });
});
