import { describe, it, expect, vi } from 'vitest';
import {
  createBuffer,
  addFrame,
  getFrames,
  calculateStats,
  extractClipFromBuffer,
  clearBuffer,
  safeClose,
} from '../../../src/features/capture/core.js';

/**
 * Create a mock VideoFrame for testing
 * @param {number} width
 * @param {number} height
 * @returns {object} Mock VideoFrame object
 */
function createMockVideoFrame(width = 100, height = 100) {
  const closeFn = vi.fn();
  const cloneFn = vi.fn(() => createMockVideoFrame(width, height));

  return {
    codedWidth: width,
    codedHeight: height,
    timestamp: 0,
    close: closeFn,
    clone: cloneFn,
    copyTo: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock frame for testing with VideoFrame
 * @param {string} id
 * @param {number} timestamp
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id, timestamp = 0) {
  return {
    id,
    frame: /** @type {VideoFrame} */ (createMockVideoFrame(100, 100)),
    timestamp,
    width: 100,
    height: 100,
  };
}

describe('createBuffer', () => {
  it('creates empty buffer with correct capacity', () => {
    const buffer = createBuffer(10);

    expect(buffer.size).toBe(0);
    expect(buffer.maxFrames).toBe(10);
    expect(buffer.head).toBe(0);
    expect(buffer.tail).toBe(0);
  });

  it('initializes frames array with correct length', () => {
    const buffer = createBuffer(5);

    expect(buffer.frames.length).toBe(5);
  });
});

describe('addFrame', () => {
  it('adds frame to empty buffer', () => {
    const buffer = createBuffer(5);
    const frame = createMockFrame('1');

    const newBuffer = addFrame(buffer, frame);

    expect(newBuffer.size).toBe(1);
    expect(getFrames(newBuffer)).toHaveLength(1);
    expect(getFrames(newBuffer)[0].id).toBe('1');
  });

  it('adds multiple frames in order', () => {
    let buffer = createBuffer(5);

    buffer = addFrame(buffer, createMockFrame('1', 100));
    buffer = addFrame(buffer, createMockFrame('2', 200));
    buffer = addFrame(buffer, createMockFrame('3', 300));

    const frames = getFrames(buffer);
    expect(frames).toHaveLength(3);
    expect(frames[0].id).toBe('1');
    expect(frames[1].id).toBe('2');
    expect(frames[2].id).toBe('3');
  });

  it('evicts oldest frame when buffer is full', () => {
    let buffer = createBuffer(3);

    buffer = addFrame(buffer, createMockFrame('1', 100));
    buffer = addFrame(buffer, createMockFrame('2', 200));
    buffer = addFrame(buffer, createMockFrame('3', 300));
    buffer = addFrame(buffer, createMockFrame('4', 400));
    buffer = addFrame(buffer, createMockFrame('5', 500));

    const frames = getFrames(buffer);
    expect(frames).toHaveLength(3);
    expect(frames[0].id).toBe('3'); // Oldest kept
    expect(frames[1].id).toBe('4');
    expect(frames[2].id).toBe('5'); // Newest
  });

  it('returns new buffer object (immutability)', () => {
    const buffer = createBuffer(5);
    const newBuffer = addFrame(buffer, createMockFrame('1'));

    expect(newBuffer).not.toBe(buffer);
    expect(buffer.size).toBe(0);
    expect(newBuffer.size).toBe(1);
  });

  it('calls VideoFrame.close() on evicted frame when buffer is full (T016)', () => {
    let buffer = createBuffer(2);

    // Create frames with trackable close functions
    const frame1 = createMockFrame('1');
    const frame2 = createMockFrame('2');
    const frame3 = createMockFrame('3');

    buffer = addFrame(buffer, frame1);
    buffer = addFrame(buffer, frame2);

    // Frame 1's VideoFrame.close() should not be called yet
    expect(frame1.frame.close).not.toHaveBeenCalled();

    // Adding frame 3 should evict frame 1 and call close()
    buffer = addFrame(buffer, frame3);

    expect(frame1.frame.close).toHaveBeenCalledTimes(1);
    expect(frame2.frame.close).not.toHaveBeenCalled();
    expect(frame3.frame.close).not.toHaveBeenCalled();
  });

  it('does not call close() when buffer is not full', () => {
    let buffer = createBuffer(5);

    const frame1 = createMockFrame('1');
    const frame2 = createMockFrame('2');

    buffer = addFrame(buffer, frame1);
    buffer = addFrame(buffer, frame2);

    expect(frame1.frame.close).not.toHaveBeenCalled();
    expect(frame2.frame.close).not.toHaveBeenCalled();
  });
});

describe('clearBuffer', () => {
  it('releases all VideoFrame resources when clearing buffer (T017)', () => {
    let buffer = createBuffer(5);

    const frame1 = createMockFrame('1');
    const frame2 = createMockFrame('2');
    const frame3 = createMockFrame('3');

    buffer = addFrame(buffer, frame1);
    buffer = addFrame(buffer, frame2);
    buffer = addFrame(buffer, frame3);

    // Clear the buffer - all VideoFrames should be closed
    const clearedBuffer = clearBuffer(buffer);

    expect(frame1.frame.close).toHaveBeenCalledTimes(1);
    expect(frame2.frame.close).toHaveBeenCalledTimes(1);
    expect(frame3.frame.close).toHaveBeenCalledTimes(1);

    // Buffer should be empty
    expect(clearedBuffer.size).toBe(0);
    expect(getFrames(clearedBuffer)).toHaveLength(0);
  });

  it('returns empty buffer with same capacity', () => {
    let buffer = createBuffer(10);
    buffer = addFrame(buffer, createMockFrame('1'));
    buffer = addFrame(buffer, createMockFrame('2'));

    const clearedBuffer = clearBuffer(buffer);

    expect(clearedBuffer.maxFrames).toBe(10);
    expect(clearedBuffer.size).toBe(0);
    expect(clearedBuffer.head).toBe(0);
    expect(clearedBuffer.tail).toBe(0);
  });

  it('handles empty buffer gracefully', () => {
    const buffer = createBuffer(5);
    const clearedBuffer = clearBuffer(buffer);

    expect(clearedBuffer.size).toBe(0);
    expect(clearedBuffer.maxFrames).toBe(5);
  });

  it('handles frames with missing VideoFrame (defensive)', () => {
    let buffer = createBuffer(3);

    // Add a frame with null VideoFrame
    const frameWithNull = {
      id: '1',
      frame: null,
      timestamp: 0,
      width: 100,
      height: 100,
    };

    buffer = addFrame(buffer, /** @type {any} */ (frameWithNull));

    // Should not throw
    expect(() => clearBuffer(buffer)).not.toThrow();
  });
});

describe('safeClose', () => {
  it('closes valid VideoFrame', () => {
    const videoFrame = createMockVideoFrame();

    const result = safeClose(/** @type {any} */ (videoFrame));

    expect(result).toBe(true);
    expect(videoFrame.close).toHaveBeenCalledTimes(1);
  });

  it('returns false for null', () => {
    const result = safeClose(null);
    expect(result).toBe(false);
  });

  it('returns false for undefined', () => {
    const result = safeClose(undefined);
    expect(result).toBe(false);
  });

  it('handles already-closed frame gracefully', () => {
    const videoFrame = {
      close: vi.fn(() => {
        throw new Error('Frame already closed');
      }),
    };

    // Should not throw
    expect(() => safeClose(/** @type {any} */ (videoFrame))).not.toThrow();
    const result = safeClose(/** @type {any} */ (videoFrame));
    expect(result).toBe(false);
  });
});

describe('getFrames', () => {
  it('returns empty array for empty buffer', () => {
    const buffer = createBuffer(5);

    expect(getFrames(buffer)).toEqual([]);
  });

  it('returns frames in chronological order', () => {
    let buffer = createBuffer(5);

    buffer = addFrame(buffer, createMockFrame('1', 100));
    buffer = addFrame(buffer, createMockFrame('2', 200));
    buffer = addFrame(buffer, createMockFrame('3', 300));

    const frames = getFrames(buffer);
    expect(frames[0].timestamp).toBe(100);
    expect(frames[1].timestamp).toBe(200);
    expect(frames[2].timestamp).toBe(300);
  });

  it('maintains order after wrap-around', () => {
    let buffer = createBuffer(3);

    // Fill and overflow
    buffer = addFrame(buffer, createMockFrame('1', 100));
    buffer = addFrame(buffer, createMockFrame('2', 200));
    buffer = addFrame(buffer, createMockFrame('3', 300));
    buffer = addFrame(buffer, createMockFrame('4', 400)); // Evicts 1
    buffer = addFrame(buffer, createMockFrame('5', 500)); // Evicts 2

    const frames = getFrames(buffer);
    expect(frames.map((f) => f.id)).toEqual(['3', '4', '5']);
  });
});

describe('calculateStats', () => {
  it('returns zero stats for empty buffer', () => {
    const buffer = createBuffer(10);
    const stats = calculateStats(buffer, 30);

    expect(stats.frameCount).toBe(0);
    expect(stats.duration).toBe(0);
  });

  it('calculates correct frame count', () => {
    let buffer = createBuffer(10);
    buffer = addFrame(buffer, createMockFrame('1'));
    buffer = addFrame(buffer, createMockFrame('2'));
    buffer = addFrame(buffer, createMockFrame('3'));

    const stats = calculateStats(buffer, 30);
    expect(stats.frameCount).toBe(3);
  });

  it('calculates duration from fps', () => {
    let buffer = createBuffer(10);
    for (let i = 0; i < 5; i++) {
      buffer = addFrame(buffer, createMockFrame(String(i)));
    }

    const stats = calculateStats(buffer, 30);
    // 5 frames at 30fps = 5/30 seconds
    expect(stats.duration).toBeCloseTo(5 / 30, 2);
  });

  it('estimates memory usage for VideoFrame (GPU-resident)', () => {
    let buffer = createBuffer(10);
    // Each 100x100 VideoFrame = 100*100*4 / 10 = 4000 bytes (GPU-resident estimate)
    buffer = addFrame(buffer, createMockFrame('1'));
    buffer = addFrame(buffer, createMockFrame('2'));

    const stats = calculateStats(buffer, 30);
    // 2 frames * 4KB = 8KB = ~0.0076 MB (VideoFrame uses ~1/10th memory due to GPU compression)
    expect(stats.memoryMB).toBeCloseTo(0.0076, 3);
  });
});

describe('extractClipFromBuffer', () => {
  it('extracts all frames from partial buffer', () => {
    let buffer = createBuffer(300);
    // Add 5 frames
    for (let i = 0; i < 5; i++) {
      buffer = addFrame(buffer, createMockFrame(String(i), i * 33));
    }

    const result = extractClipFromBuffer(buffer, 30, 10000);

    expect(result.frameCount).toBe(5);
    expect(result.frames.length).toBe(5);
    expect(result.fps).toBe(30);
  });

  it('extracts most recent 10 seconds when buffer is full', () => {
    let buffer = createBuffer(600); // 20s at 30fps
    // Fill buffer with 600 frames
    for (let i = 0; i < 600; i++) {
      buffer = addFrame(buffer, createMockFrame(String(i), i * 33));
    }

    const result = extractClipFromBuffer(buffer, 30, 10000);

    // At 30fps, 10s = 300 frames
    expect(result.frameCount).toBe(300);
    expect(result.frames.length).toBe(300);
  });

  it('returns empty result for empty buffer', () => {
    const buffer = createBuffer(300);

    const result = extractClipFromBuffer(buffer, 30, 10000);

    expect(result.frameCount).toBe(0);
    expect(result.frames).toEqual([]);
    expect(result.duration).toBe(0);
  });

  it('includes capturedAt timestamp', () => {
    let buffer = createBuffer(300);
    buffer = addFrame(buffer, createMockFrame('1'));

    const before = Date.now();
    const result = extractClipFromBuffer(buffer, 30, 10000);
    const after = Date.now();

    expect(result.capturedAt).toBeGreaterThanOrEqual(before);
    expect(result.capturedAt).toBeLessThanOrEqual(after);
  });

  it('calculates duration correctly', () => {
    let buffer = createBuffer(300);
    // Add 90 frames at 30fps = 3 seconds
    for (let i = 0; i < 90; i++) {
      buffer = addFrame(buffer, createMockFrame(String(i), i * 33));
    }

    const result = extractClipFromBuffer(buffer, 30, 10000);

    expect(result.duration).toBe(3);
  });

  it('returns copies of frame data (not references)', () => {
    let buffer = createBuffer(300);
    buffer = addFrame(buffer, createMockFrame('1'));

    const result = extractClipFromBuffer(buffer, 30, 10000);

    // The frames array should be a copy
    expect(result.frames).not.toBe(getFrames(buffer));
  });
});
