import { describe, it, expect, vi } from 'vitest';
import {
  safeClose,
  safeCloseFrame,
  closeAllFrames,
} from '../../../src/shared/utils/videoframe.js';

// Helper to create mock VideoFrame
function createMockVideoFrame(shouldThrow = false) {
  return {
    close: shouldThrow
      ? vi.fn().mockImplementation(() => {
          throw new Error('Frame already closed');
        })
      : vi.fn(),
  };
}

// Helper to create mock Frame object
function createMockFrame(id, shouldThrow = false) {
  return {
    id,
    frame: createMockVideoFrame(shouldThrow),
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

describe('safeClose', () => {
  it('should close valid VideoFrame', () => {
    // Arrange
    const videoFrame = createMockVideoFrame();

    // Act
    const result = safeClose(videoFrame);

    // Assert
    expect(result).toBe(true);
    expect(videoFrame.close).toHaveBeenCalledOnce();
  });

  it('should return false for null VideoFrame', () => {
    // Act
    const result = safeClose(null);

    // Assert
    expect(result).toBe(false);
  });

  it('should return false for undefined VideoFrame', () => {
    // Act
    const result = safeClose(undefined);

    // Assert
    expect(result).toBe(false);
  });

  it('should handle already-closed VideoFrame gracefully', () => {
    // Arrange
    const videoFrame = createMockVideoFrame(true);

    // Act
    const result = safeClose(videoFrame);

    // Assert
    expect(result).toBe(false);
    expect(videoFrame.close).toHaveBeenCalled();
  });

  it('should not throw when close() throws', () => {
    // Arrange
    const videoFrame = createMockVideoFrame(true);

    // Act & Assert
    expect(() => safeClose(videoFrame)).not.toThrow();
  });
});

describe('safeCloseFrame', () => {
  it('should close VideoFrame inside Frame object', () => {
    // Arrange
    const frame = createMockFrame('test-1');

    // Act
    const result = safeCloseFrame(frame);

    // Assert
    expect(result).toBe(true);
    expect(frame.frame.close).toHaveBeenCalledOnce();
  });

  it('should return false for null Frame', () => {
    // Act
    const result = safeCloseFrame(null);

    // Assert
    expect(result).toBe(false);
  });

  it('should return false for undefined Frame', () => {
    // Act
    const result = safeCloseFrame(undefined);

    // Assert
    expect(result).toBe(false);
  });

  it('should return false for Frame with null frame property', () => {
    // Arrange
    const frame = { id: 'test', frame: null };

    // Act
    const result = safeCloseFrame(frame);

    // Assert
    expect(result).toBe(false);
  });

  it('should return false for Frame with undefined frame property', () => {
    // Arrange
    const frame = { id: 'test' };

    // Act
    const result = safeCloseFrame(frame);

    // Assert
    expect(result).toBe(false);
  });

  it('should handle already-closed Frame gracefully', () => {
    // Arrange
    const frame = createMockFrame('test-2', true);

    // Act
    const result = safeCloseFrame(frame);

    // Assert
    expect(result).toBe(false);
  });
});

describe('closeAllFrames', () => {
  it('should close all frames and return count', () => {
    // Arrange
    const frames = [
      createMockFrame('1'),
      createMockFrame('2'),
      createMockFrame('3'),
    ];

    // Act
    const closedCount = closeAllFrames(frames);

    // Assert
    expect(closedCount).toBe(3);
    frames.forEach((f) => {
      expect(f.frame.close).toHaveBeenCalledOnce();
    });
  });

  it('should return 0 for empty array', () => {
    // Act
    const closedCount = closeAllFrames([]);

    // Assert
    expect(closedCount).toBe(0);
  });

  it('should handle mixed valid and invalid frames', () => {
    // Arrange
    const frames = [
      createMockFrame('1'),
      null,
      createMockFrame('2'),
      { id: '3', frame: null },
      createMockFrame('3'),
    ];

    // Act
    const closedCount = closeAllFrames(frames);

    // Assert
    expect(closedCount).toBe(3);
  });

  it('should continue closing even when some frames throw', () => {
    // Arrange
    const frames = [
      createMockFrame('1'),
      createMockFrame('2', true), // throws
      createMockFrame('3'),
    ];

    // Act
    const closedCount = closeAllFrames(frames);

    // Assert - 1 and 3 succeeded, 2 failed
    expect(closedCount).toBe(2);
    expect(frames[0].frame.close).toHaveBeenCalled();
    expect(frames[1].frame.close).toHaveBeenCalled();
    expect(frames[2].frame.close).toHaveBeenCalled();
  });

  it('should not throw even when all frames throw', () => {
    // Arrange
    const frames = [
      createMockFrame('1', true),
      createMockFrame('2', true),
    ];

    // Act & Assert
    expect(() => closeAllFrames(frames)).not.toThrow();
    expect(closeAllFrames(frames)).toBe(0);
  });
});
