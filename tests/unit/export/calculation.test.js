import { describe, it, expect } from 'vitest';
import {
  calculateFrameDelay,
  applyFrameSkip,
  calculateProgress,
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
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(100, 100)),
    timestamp: Date.now(),
    width: 100,
    height: 100,
  };
}

describe('calculateFrameDelay', () => {
  it('calculates delay for 30fps at normal speed', () => {
    const delay = calculateFrameDelay(30, 1, 1);

    // 30fps = 33.3ms per frame = 3.33 centiseconds (GIF format)
    // GIF rounds to nearest integer centisecond
    expect(delay).toBeCloseTo(3, 0);
  });

  it('calculates delay for 60fps at normal speed', () => {
    const delay = calculateFrameDelay(60, 1, 1);

    // 60fps = 16.67ms per frame = 1.67 centiseconds
    // GIF minimum is usually 2cs (20ms)
    expect(delay).toBeGreaterThanOrEqual(2);
  });

  it('faster playback reduces delay', () => {
    const normalDelay = calculateFrameDelay(30, 1, 1);
    const fastDelay = calculateFrameDelay(30, 2, 1);

    expect(fastDelay).toBeLessThan(normalDelay);
  });

  it('slower playback increases delay', () => {
    const normalDelay = calculateFrameDelay(30, 1, 1);
    const slowDelay = calculateFrameDelay(30, 0.5, 1);

    expect(slowDelay).toBeGreaterThan(normalDelay);
  });

  it('frame skip affects delay', () => {
    const noSkip = calculateFrameDelay(30, 1, 1);
    const withSkip = calculateFrameDelay(30, 1, 2);

    // With skip of 2, delay should be roughly doubled to maintain perceived speed
    // Allow for rounding differences
    expect(withSkip).toBeGreaterThan(noSkip);
    expect(withSkip).toBeLessThanOrEqual(noSkip * 2 + 1);
  });

  it('returns minimum delay for very high fps', () => {
    const delay = calculateFrameDelay(120, 1, 1);

    // GIF minimum delay is typically 2 centiseconds (20ms)
    expect(delay).toBeGreaterThanOrEqual(2);
  });
});

describe('applyFrameSkip', () => {
  it('returns all frames with skip of 1', () => {
    const frames = [
      createMockFrame('1'),
      createMockFrame('2'),
      createMockFrame('3'),
      createMockFrame('4'),
      createMockFrame('5'),
    ];

    const result = applyFrameSkip(frames, 1);

    expect(result).toHaveLength(5);
    expect(result.map((f) => f.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('returns every other frame with skip of 2', () => {
    const frames = [
      createMockFrame('1'),
      createMockFrame('2'),
      createMockFrame('3'),
      createMockFrame('4'),
      createMockFrame('5'),
    ];

    const result = applyFrameSkip(frames, 2);

    expect(result).toHaveLength(3);
    expect(result.map((f) => f.id)).toEqual(['1', '3', '5']);
  });

  it('returns every third frame with skip of 3', () => {
    const frames = [
      createMockFrame('1'),
      createMockFrame('2'),
      createMockFrame('3'),
      createMockFrame('4'),
      createMockFrame('5'),
      createMockFrame('6'),
      createMockFrame('7'),
      createMockFrame('8'),
      createMockFrame('9'),
    ];

    const result = applyFrameSkip(frames, 3);

    expect(result).toHaveLength(3);
    expect(result.map((f) => f.id)).toEqual(['1', '4', '7']);
  });

  it('handles empty array', () => {
    const result = applyFrameSkip([], 2);

    expect(result).toHaveLength(0);
  });

  it('handles single frame', () => {
    const frames = [createMockFrame('1')];
    const result = applyFrameSkip(frames, 3);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });
});

describe('calculateProgress', () => {
  it('returns 0 percent at start', () => {
    const result = calculateProgress(0, 100, Date.now());

    expect(result.percent).toBe(0);
  });

  it('returns 50 percent at halfway', () => {
    const result = calculateProgress(50, 100, Date.now() - 1000);

    expect(result.percent).toBe(50);
  });

  it('returns 100 percent at end', () => {
    const result = calculateProgress(100, 100, Date.now() - 1000);

    expect(result.percent).toBe(100);
  });

  it('estimates remaining time', () => {
    // Started 1 second ago, 50% complete
    const startTime = Date.now() - 1000;
    const result = calculateProgress(50, 100, startTime);

    // Should estimate about 1 second remaining
    expect(result.estimatedRemaining).toBeGreaterThan(500);
    expect(result.estimatedRemaining).toBeLessThan(2000);
  });

  it('handles edge case of zero current', () => {
    const result = calculateProgress(0, 100, Date.now());

    // No estimate possible at start
    expect(result.estimatedRemaining).toBe(0);
  });

  it('handles single frame total', () => {
    const result = calculateProgress(1, 1, Date.now() - 100);

    expect(result.percent).toBe(100);
    expect(result.estimatedRemaining).toBe(0);
  });
});
