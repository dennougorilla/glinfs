import { describe, expect, it } from 'vitest';
import {
  areFramesIdentical,
  calculateFrameDelay,
  sampleFramePixels,
} from '../../../src/features/export/core.js';

/**
 * @param {number[]} bytes
 * @param {number} [width]
 * @param {number} [height]
 */
const frame = (bytes, width = bytes.length / 4, height = 1) => ({
  data: new Uint8ClampedArray(bytes),
  width,
  height,
});

describe('areFramesIdentical', () => {
  it('is true for byte-identical frames of the same size', () => {
    expect(
      areFramesIdentical(frame([1, 2, 3, 4, 5, 6, 7, 8]), frame([1, 2, 3, 4, 5, 6, 7, 8])),
    ).toBe(true);
  });

  it('is false when any byte differs, including alpha', () => {
    expect(areFramesIdentical(frame([1, 2, 3, 4]), frame([1, 2, 3, 5]))).toBe(false);
    expect(
      areFramesIdentical(frame([0, 0, 0, 0, 9, 0, 0, 0]), frame([0, 0, 0, 0, 8, 0, 0, 0])),
    ).toBe(false);
  });

  it('is false for different sizes, even with equal bytes', () => {
    const bytes = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(areFramesIdentical(frame(bytes, 2, 1), frame(bytes, 1, 2))).toBe(false);
    expect(areFramesIdentical(frame([1, 2, 3, 4], 1, 1), frame(bytes, 1, 1))).toBe(false);
  });

  it('compares unaligned views byte by byte', () => {
    const buffer = new ArrayBuffer(12);
    const a = new Uint8ClampedArray(buffer, 1, 8);
    a.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      areFramesIdentical({ data: a, width: 2, height: 1 }, { data: b, width: 2, height: 1 }),
    ).toBe(true);
    b[7] = 0;
    expect(
      areFramesIdentical({ data: a, width: 2, height: 1 }, { data: b, width: 2, height: 1 }),
    ).toBe(false);
  });
});

describe('calculateFrameDelay runLength', () => {
  it('matches the pre-merging formula exactly for runLength 1', () => {
    // The formula calculateFrameDelay used before runLength existed
    const legacy = (
      /** @type {number} */ fps,
      /** @type {number} */ speed,
      /** @type {number} */ skip,
    ) => Math.max(2, Math.round(((1000 / fps / speed) * skip) / 10));
    for (const fps of [1, 7, 10, 12, 15, 24, 25, 30, 48, 50, 60]) {
      for (const speed of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) {
        for (const skip of [1, 2, 3, 4, 5]) {
          expect(calculateFrameDelay(fps, speed, skip)).toBe(legacy(fps, speed, skip));
          expect(calculateFrameDelay(fps, speed, skip, 1)).toBe(legacy(fps, speed, skip));
        }
      }
    }
  });

  it('rounds a run as a whole', () => {
    // 3 frames at 30fps = 100ms (per-frame rounding: 3 x 3cs = 9cs)
    expect(calculateFrameDelay(30, 1, 1, 3)).toBe(10);
    expect(calculateFrameDelay(10, 1, 1, 5)).toBe(50);
    expect(calculateFrameDelay(10, 2, 2, 4)).toBe(40);
  });

  it('keeps the 2cs minimum', () => {
    expect(calculateFrameDelay(60, 4, 1, 1)).toBe(2);
  });
});

describe('sampleFramePixels opaqueOnly', () => {
  it('skips pixels with alpha < 128 and returns the shorter offset', () => {
    const rgba = new Uint8ClampedArray([10, 0, 0, 255, 20, 0, 0, 127, 30, 0, 0, 128, 40, 0, 0, 0]);
    const out = new Uint8ClampedArray(16);

    const end = sampleFramePixels(rgba, 4, 1, 1, out, 0, 0, true);

    expect(end).toBe(8);
    expect(Array.from(out.subarray(0, end))).toEqual([10, 0, 0, 255, 30, 0, 0, 128]);
    expect(sampleFramePixels(rgba, 4, 1, 1, new Uint8ClampedArray(16), 0, 0)).toBe(16);
  });
});
