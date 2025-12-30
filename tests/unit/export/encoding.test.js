import { describe, it, expect, vi } from 'vitest';
import {
  applyFrameSkip,
  calculateFrameDelay,
  calculateProgress,
  getCroppedDimensions,
  generateFilename,
} from '../../../src/features/export/core.js';

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
 * @param {number} width
 * @param {number} height
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id, width = 640, height = 480) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(width, height)),
    timestamp: 0,
    width,
    height,
  };
}

describe('GIF Encoding Functions (US3)', () => {
  describe('applyFrameSkip', () => {
    it('returns all frames with skip=1', () => {
      const frames = [createMockFrame('1'), createMockFrame('2'), createMockFrame('3')];

      const result = applyFrameSkip(frames, 1);

      expect(result).toHaveLength(3);
    });

    it('returns every 2nd frame with skip=2', () => {
      const frames = [
        createMockFrame('1'),
        createMockFrame('2'),
        createMockFrame('3'),
        createMockFrame('4'),
      ];

      const result = applyFrameSkip(frames, 2);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('3');
    });

    it('handles empty frames array', () => {
      const result = applyFrameSkip([], 2);

      expect(result).toHaveLength(0);
    });
  });

  describe('calculateFrameDelay', () => {
    it('calculates correct delay for 30fps at normal speed', () => {
      const delay = calculateFrameDelay(30, 1, 1);

      // 1000ms / 30fps = 33.33ms = 3.33 centiseconds
      expect(delay).toBeGreaterThanOrEqual(3);
      expect(delay).toBeLessThanOrEqual(4);
    });

    it('halves delay when speed is doubled', () => {
      const normalDelay = calculateFrameDelay(30, 1, 1);
      const fastDelay = calculateFrameDelay(30, 2, 1);

      expect(fastDelay).toBeLessThan(normalDelay);
    });

    it('enforces minimum delay', () => {
      // Very high speed should still have minimum delay
      const delay = calculateFrameDelay(60, 4, 1);

      expect(delay).toBeGreaterThanOrEqual(2); // MIN_DELAY_CS
    });

    it('accounts for frame skip in delay', () => {
      const noSkipDelay = calculateFrameDelay(30, 1, 1);
      const withSkipDelay = calculateFrameDelay(30, 1, 2);

      // Skip 2 should roughly double the delay to maintain duration
      // (accounting for rounding and minimum delay constraints)
      expect(withSkipDelay).toBeGreaterThan(noSkipDelay);
      expect(withSkipDelay).toBeLessThanOrEqual(noSkipDelay * 2 + 1);
    });
  });

  describe('calculateProgress', () => {
    it('returns 0% at start', () => {
      const progress = calculateProgress(0, 100, Date.now());

      expect(progress.percent).toBe(0);
    });

    it('returns 50% at halfway', () => {
      const progress = calculateProgress(50, 100, Date.now());

      expect(progress.percent).toBe(50);
    });

    it('returns 100% when complete', () => {
      const progress = calculateProgress(100, 100, Date.now());

      expect(progress.percent).toBe(100);
    });

    it('estimates remaining time', () => {
      const startTime = Date.now() - 1000; // Started 1 second ago
      const progress = calculateProgress(50, 100, startTime);

      // 50% done in 1000ms, should estimate ~1000ms remaining
      expect(progress.estimatedRemaining).toBeGreaterThan(500);
      expect(progress.estimatedRemaining).toBeLessThan(1500);
    });
  });

  describe('getCroppedDimensions', () => {
    it('returns frame dimensions when no crop', () => {
      const frame = createMockFrame('1', 800, 600);

      const dims = getCroppedDimensions(frame, null);

      expect(dims.width).toBe(800);
      expect(dims.height).toBe(600);
    });

    it('returns crop dimensions when crop is set', () => {
      const frame = createMockFrame('1', 800, 600);
      const crop = { x: 100, y: 100, width: 400, height: 300, aspectRatio: 'free' };

      const dims = getCroppedDimensions(frame, crop);

      expect(dims.width).toBe(400);
      expect(dims.height).toBe(300);
    });
  });

  describe('generateFilename', () => {
    it('uses glinfs prefix by default', () => {
      const filename = generateFilename();

      expect(filename.startsWith('glinfs-')).toBe(true);
      expect(filename.endsWith('.gif')).toBe(true);
    });

    it('accepts custom prefix', () => {
      const filename = generateFilename('myapp');

      expect(filename.startsWith('myapp-')).toBe(true);
    });

    it('includes timestamp in filename', () => {
      const filename = generateFilename();

      // Should match pattern: glinfs-YYYY-MM-DDTHH-MM-SS.gif
      expect(filename).toMatch(/^glinfs-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.gif$/);
    });
  });
});
