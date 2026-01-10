import { describe, it, expect, vi } from 'vitest';
import { createCaptureStore, updateSettings } from '../../../src/features/capture/state.js';

/**
 * Create a mock VideoFrame for testing
 */
function createMockFrame(id) {
  const videoFrame = { close: vi.fn(), clone: vi.fn() };
  return {
    id,
    frame: videoFrame,
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

describe('updateSettings - VideoFrame cleanup', () => {
  it('does NOT close VideoFrames (pure function)', () => {
    // updateSettings is a pure function - it does NOT close frames
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });
    const frame1 = createMockFrame('1');
    const frame2 = createMockFrame('2');

    // Manually add frames to buffer (simulating captured frames)
    store.setState((s) => ({
      ...s,
      buffer: {
        ...s.buffer,
        frames: [frame1, frame2, ...new Array(s.buffer.maxFrames - 2).fill(null)],
        size: 2,
        head: 0,
      },
    }));

    // Act - change fps setting
    store.setState((s) => updateSettings(s, { fps: 15 }));

    // Assert - frames should NOT be closed (updateSettings is pure)
    expect(frame1.frame.close).not.toHaveBeenCalled();
    expect(frame2.frame.close).not.toHaveBeenCalled();
  });

  it('does NOT close VideoFrames when bufferDuration changes', () => {
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });
    const frame = createMockFrame('1');

    store.setState((s) => ({
      ...s,
      buffer: {
        ...s.buffer,
        frames: [frame, ...new Array(s.buffer.maxFrames - 1).fill(null)],
        size: 1,
        head: 0,
      },
    }));

    // Act - change bufferDuration
    store.setState((s) => updateSettings(s, { bufferDuration: 5 }));

    // Assert - frame should NOT be closed
    expect(frame.frame.close).not.toHaveBeenCalled();
  });

  it('should NOT close frames when unrelated settings change', () => {
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });
    const frame = createMockFrame('1');

    store.setState((s) => ({
      ...s,
      buffer: {
        ...s.buffer,
        frames: [frame, ...new Array(s.buffer.maxFrames - 1).fill(null)],
        size: 1,
        head: 0,
      },
    }));

    // Act - change unrelated setting (empty object = no fps/bufferDuration change)
    store.setState((s) => updateSettings(s, {}));

    // Assert - frames should NOT be closed
    expect(frame.frame.close).not.toHaveBeenCalled();
  });

  it('should handle buffer with no frames gracefully', () => {
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });

    // Act & Assert - should not throw
    expect(() => {
      store.setState((s) => updateSettings(s, { fps: 15 }));
    }).not.toThrow();
  });

  it('should handle frames without close method gracefully', () => {
    const store = createCaptureStore({ fps: 30, bufferDuration: 10 });
    const frameWithoutClose = { id: '1', frame: {}, timestamp: 0, width: 100, height: 100 };

    store.setState((s) => ({
      ...s,
      buffer: {
        ...s.buffer,
        frames: [frameWithoutClose, ...new Array(s.buffer.maxFrames - 1).fill(null)],
        size: 1,
        head: 0,
      },
    }));

    // Act & Assert - should not throw
    expect(() => {
      store.setState((s) => updateSettings(s, { fps: 15 }));
    }).not.toThrow();
  });
});
