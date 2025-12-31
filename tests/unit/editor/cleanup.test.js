import { describe, it, expect, vi } from 'vitest';

/**
 * Create a mock VideoFrame for testing
 * @returns {object} Mock VideoFrame with close and clone methods
 */
function createMockVideoFrame() {
  return {
    close: vi.fn(),
    clone: vi.fn(),
  };
}

/**
 * Create a mock frame with VideoFrame
 * @param {string} id - Frame identifier
 * @returns {object} Mock frame object
 */
function createMockFrame(id) {
  return {
    id,
    frame: createMockVideoFrame(),
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

/**
 * Close frames utility (extracted from cleanup logic for testability)
 * This mirrors the cleanup logic in src/features/editor/index.js
 * @param {object} state - Editor state
 */
function closeFrames(state) {
  for (const frame of state.clip?.frames ?? []) {
    if (frame?.frame && typeof frame.frame.close === 'function') {
      try {
        frame.frame.close();
      } catch (e) {
        // Ignore errors from already-closed frames
      }
    }
  }
}

describe('Editor cleanup - VideoFrame close', () => {
  it('should close all VideoFrames in state.clip.frames', () => {
    // Arrange
    const frames = [createMockFrame('1'), createMockFrame('2'), createMockFrame('3')];
    const state = {
      clip: { frames, selectedRange: { start: 0, end: 2 }, cropArea: null, fps: 30 },
      currentFrame: 0,
    };

    // Act
    closeFrames(state);

    // Assert
    frames.forEach((f) => {
      expect(f.frame.close).toHaveBeenCalledOnce();
    });
  });

  it('should handle null clip gracefully', () => {
    // Arrange
    const state = { clip: null, currentFrame: 0 };

    // Act & Assert - should not throw
    expect(() => closeFrames(state)).not.toThrow();
  });

  it('should handle undefined clip gracefully', () => {
    // Arrange
    const state = { currentFrame: 0 };

    // Act & Assert
    expect(() => closeFrames(state)).not.toThrow();
  });

  it('should handle empty frames array', () => {
    // Arrange
    const state = {
      clip: { frames: [], selectedRange: { start: 0, end: 0 }, cropArea: null, fps: 30 },
    };

    // Act & Assert
    expect(() => closeFrames(state)).not.toThrow();
  });

  it('should handle already-closed frames (close throws error)', () => {
    // Arrange
    const frame = createMockFrame('1');
    frame.frame.close.mockImplementation(() => {
      throw new Error('Frame already closed');
    });
    const state = {
      clip: { frames: [frame], selectedRange: { start: 0, end: 0 }, cropArea: null, fps: 30 },
    };

    // Act & Assert - should not throw
    expect(() => closeFrames(state)).not.toThrow();
  });

  it('should handle frames without close method', () => {
    // Arrange
    const frameWithoutClose = { id: '1', frame: {}, timestamp: 0, width: 100, height: 100 };
    const state = {
      clip: { frames: [frameWithoutClose], selectedRange: { start: 0, end: 0 }, cropArea: null, fps: 30 },
    };

    // Act & Assert
    expect(() => closeFrames(state)).not.toThrow();
  });
});
