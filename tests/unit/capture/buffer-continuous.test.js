import { describe, it, expect } from 'vitest';
import {
  createBuffer,
  addFrame,
  getFrames,
} from '../../../src/features/capture/core.js';

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

describe('Continuous Buffer Recording (US1)', () => {
  describe('buffer never stops accepting frames', () => {
    it('continues accepting frames after reaching maxFrames', () => {
      let buffer = createBuffer(5);

      // Add 10 frames (2x capacity)
      for (let i = 0; i < 10; i++) {
        buffer = addFrame(buffer, createMockFrame(String(i), i * 100));
      }

      // Buffer should still have 5 frames (most recent)
      expect(buffer.size).toBe(5);
      const frames = getFrames(buffer);
      expect(frames).toHaveLength(5);

      // Should contain the 5 most recent frames (5, 6, 7, 8, 9)
      expect(frames.map((f) => f.id)).toEqual(['5', '6', '7', '8', '9']);
    });

    it('maintains rolling window behavior for extended recording', () => {
      let buffer = createBuffer(30); // 30 frames = 1 second at 30fps

      // Simulate 5 seconds of recording at 30fps (150 frames)
      for (let i = 0; i < 150; i++) {
        buffer = addFrame(buffer, createMockFrame(String(i), i * 33.33));
      }

      // Buffer should contain the last 30 frames
      expect(buffer.size).toBe(30);
      const frames = getFrames(buffer);
      expect(frames[0].id).toBe('120');
      expect(frames[29].id).toBe('149');
    });

    it('correctly overwrites oldest frames in circular order', () => {
      let buffer = createBuffer(3);

      // Add frames 0, 1, 2 (fills buffer)
      buffer = addFrame(buffer, createMockFrame('A'));
      buffer = addFrame(buffer, createMockFrame('B'));
      buffer = addFrame(buffer, createMockFrame('C'));

      // Add frame 3 (should evict A)
      buffer = addFrame(buffer, createMockFrame('D'));
      expect(getFrames(buffer).map((f) => f.id)).toEqual(['B', 'C', 'D']);

      // Add frame 4 (should evict B)
      buffer = addFrame(buffer, createMockFrame('E'));
      expect(getFrames(buffer).map((f) => f.id)).toEqual(['C', 'D', 'E']);

      // Add frame 5 (should evict C)
      buffer = addFrame(buffer, createMockFrame('F'));
      expect(getFrames(buffer).map((f) => f.id)).toEqual(['D', 'E', 'F']);
    });
  });

  describe('buffer size stability', () => {
    it('never exceeds maxFrames', () => {
      let buffer = createBuffer(10);

      // Add 100 frames
      for (let i = 0; i < 100; i++) {
        buffer = addFrame(buffer, createMockFrame(String(i)));
        expect(buffer.size).toBeLessThanOrEqual(10);
      }

      expect(buffer.size).toBe(10);
    });

    it('maintains consistent frame count after reaching capacity', () => {
      let buffer = createBuffer(5);

      // Fill buffer
      for (let i = 0; i < 5; i++) {
        buffer = addFrame(buffer, createMockFrame(String(i)));
      }
      expect(buffer.size).toBe(5);

      // Add 20 more frames, size should stay at 5
      for (let i = 5; i < 25; i++) {
        buffer = addFrame(buffer, createMockFrame(String(i)));
        expect(buffer.size).toBe(5);
      }
    });
  });
});
