import { describe, it, expect } from 'vitest';
import {
  setCropArea,
  constrainAspectRatio,
  clampCropArea,
  calculateCropFromDrag,
} from '../../../src/features/editor/core.js';

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
 * @param {number} width
 * @param {number} height
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(width = 1920, height = 1080) {
  return {
    id: 'test-frame',
    data: /** @type {ImageData} */ (createMockImageData(width, height)),
    timestamp: 0,
    width,
    height,
  };
}

describe('setCropArea', () => {
  it('creates new crop area', () => {
    const frame = createMockFrame();
    const rect = { x: 100, y: 100, width: 500, height: 300 };

    const crop = setCropArea(null, rect, frame);

    expect(crop.x).toBe(100);
    expect(crop.y).toBe(100);
    expect(crop.width).toBe(500);
    expect(crop.height).toBe(300);
    expect(crop.aspectRatio).toBe('free');
  });

  it('updates existing crop area', () => {
    const frame = createMockFrame();
    const existing = { x: 0, y: 0, width: 100, height: 100, aspectRatio: '1:1' };
    const rect = { x: 200, y: 200, width: 600, height: 400 };

    const crop = setCropArea(existing, rect, frame);

    expect(crop.x).toBe(200);
    expect(crop.y).toBe(200);
    expect(crop.width).toBe(600);
    expect(crop.height).toBe(400);
    // Should preserve aspect ratio from existing
    expect(crop.aspectRatio).toBe('1:1');
  });

  it('clamps crop to frame bounds', () => {
    const frame = createMockFrame(800, 600);
    const rect = { x: 700, y: 500, width: 200, height: 200 };

    const crop = setCropArea(null, rect, frame);

    // Should be clamped to fit within 800x600 frame
    expect(crop.x + crop.width).toBeLessThanOrEqual(800);
    expect(crop.y + crop.height).toBeLessThanOrEqual(600);
  });
});

describe('constrainAspectRatio', () => {
  it('maintains free aspect ratio', () => {
    const crop = { x: 100, y: 100, width: 500, height: 300, aspectRatio: 'free' };

    const result = constrainAspectRatio(crop, 'free');

    expect(result.width).toBe(500);
    expect(result.height).toBe(300);
    expect(result.aspectRatio).toBe('free');
  });

  it('constrains to 1:1 ratio', () => {
    const crop = { x: 100, y: 100, width: 500, height: 300, aspectRatio: 'free' };

    const result = constrainAspectRatio(crop, '1:1');

    expect(result.width).toBe(result.height);
    expect(result.aspectRatio).toBe('1:1');
  });

  it('constrains to 16:9 ratio', () => {
    const crop = { x: 0, y: 0, width: 1600, height: 1000, aspectRatio: 'free' };

    const result = constrainAspectRatio(crop, '16:9');

    const actualRatio = result.width / result.height;
    const expectedRatio = 16 / 9;

    expect(actualRatio).toBeCloseTo(expectedRatio, 2);
    expect(result.aspectRatio).toBe('16:9');
  });

  it('constrains to 4:3 ratio', () => {
    const crop = { x: 0, y: 0, width: 800, height: 800, aspectRatio: 'free' };

    const result = constrainAspectRatio(crop, '4:3');

    const actualRatio = result.width / result.height;
    const expectedRatio = 4 / 3;

    expect(actualRatio).toBeCloseTo(expectedRatio, 2);
    expect(result.aspectRatio).toBe('4:3');
  });

  it('constrains to 9:16 ratio (vertical)', () => {
    const crop = { x: 0, y: 0, width: 800, height: 800, aspectRatio: 'free' };

    const result = constrainAspectRatio(crop, '9:16');

    const actualRatio = result.width / result.height;
    const expectedRatio = 9 / 16;

    expect(actualRatio).toBeCloseTo(expectedRatio, 2);
    expect(result.aspectRatio).toBe('9:16');
  });
});

describe('clampCropArea', () => {
  it('keeps valid crop unchanged', () => {
    const crop = { x: 100, y: 100, width: 500, height: 300, aspectRatio: 'free' };

    const result = clampCropArea(crop, 1920, 1080);

    expect(result).toEqual(crop);
  });

  it('clamps negative x', () => {
    const crop = { x: -50, y: 100, width: 500, height: 300, aspectRatio: 'free' };

    const result = clampCropArea(crop, 1920, 1080);

    expect(result.x).toBe(0);
  });

  it('clamps negative y', () => {
    const crop = { x: 100, y: -50, width: 500, height: 300, aspectRatio: 'free' };

    const result = clampCropArea(crop, 1920, 1080);

    expect(result.y).toBe(0);
  });

  it('clamps width when exceeds frame', () => {
    const crop = { x: 1500, y: 0, width: 600, height: 300, aspectRatio: 'free' };

    const result = clampCropArea(crop, 1920, 1080);

    expect(result.x + result.width).toBeLessThanOrEqual(1920);
  });

  it('clamps height when exceeds frame', () => {
    const crop = { x: 0, y: 900, width: 500, height: 300, aspectRatio: 'free' };

    const result = clampCropArea(crop, 1920, 1080);

    expect(result.y + result.height).toBeLessThanOrEqual(1080);
  });

  it('handles crop larger than frame', () => {
    const crop = { x: 0, y: 0, width: 3000, height: 2000, aspectRatio: 'free' };

    const result = clampCropArea(crop, 800, 600);

    expect(result.width).toBeLessThanOrEqual(800);
    expect(result.height).toBeLessThanOrEqual(600);
  });

  it('ensures minimum dimensions', () => {
    const crop = { x: 0, y: 0, width: 5, height: 5, aspectRatio: 'free' };

    const result = clampCropArea(crop, 1920, 1080);

    // Minimum should be at least 10x10
    expect(result.width).toBeGreaterThanOrEqual(10);
    expect(result.height).toBeGreaterThanOrEqual(10);
  });
});

describe('calculateCropFromDrag', () => {
  const frame = createMockFrame(800, 600);

  it('creates crop from top-left to bottom-right drag', () => {
    const start = { x: 100, y: 100 };
    const end = { x: 300, y: 250 };

    const crop = calculateCropFromDrag(start, end, frame);

    expect(crop.x).toBe(100);
    expect(crop.y).toBe(100);
    expect(crop.width).toBe(200);
    expect(crop.height).toBe(150);
  });

  it('creates crop from bottom-right to top-left drag', () => {
    const start = { x: 300, y: 250 };
    const end = { x: 100, y: 100 };

    const crop = calculateCropFromDrag(start, end, frame);

    expect(crop.x).toBe(100);
    expect(crop.y).toBe(100);
    expect(crop.width).toBe(200);
    expect(crop.height).toBe(150);
  });

  it('creates crop from top-right to bottom-left drag', () => {
    const start = { x: 300, y: 100 };
    const end = { x: 100, y: 250 };

    const crop = calculateCropFromDrag(start, end, frame);

    expect(crop.x).toBe(100);
    expect(crop.y).toBe(100);
    expect(crop.width).toBe(200);
    expect(crop.height).toBe(150);
  });

  it('enforces minimum size', () => {
    const start = { x: 100, y: 100 };
    const end = { x: 102, y: 102 };

    const crop = calculateCropFromDrag(start, end, frame);

    expect(crop.width).toBeGreaterThanOrEqual(10);
    expect(crop.height).toBeGreaterThanOrEqual(10);
  });

  it('clamps to frame bounds', () => {
    const start = { x: 700, y: 500 };
    const end = { x: 900, y: 700 };

    const crop = calculateCropFromDrag(start, end, frame);

    expect(crop.x + crop.width).toBeLessThanOrEqual(800);
    expect(crop.y + crop.height).toBeLessThanOrEqual(600);
  });

  it('applies aspect ratio constraint when specified', () => {
    const start = { x: 100, y: 100 };
    const end = { x: 300, y: 300 };

    const crop = calculateCropFromDrag(start, end, frame, '16:9');

    // constrainAspectRatio is called which sets the aspectRatio field
    const ratio = crop.width / crop.height;
    expect(ratio).toBeCloseTo(16 / 9, 1);
  });

  it('defaults to free aspect ratio', () => {
    const start = { x: 100, y: 100 };
    const end = { x: 300, y: 250 };

    const crop = calculateCropFromDrag(start, end, frame);

    expect(crop.aspectRatio).toBe('free');
  });
});
