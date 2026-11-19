import { describe, expect, it } from 'vitest';
import { I420_COLOR_SPACE, i420Layout, rgbaToI420 } from '../../../src/shared/i420.js';

/**
 * RGBA -> I420 reference (D3's cheap half): the converter worker's WebGL
 * pass must give these exact bytes, and it is the fallback without WebGL2.
 * BT.709 full range; chroma is the mean of each 2x2 block.
 */

/**
 * @param {number} w
 * @param {number} h
 * @param {(x: number, y: number) => [number, number, number]} color
 */
function rgba(w, h, color) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return data;
}

describe('i420Layout', () => {
  it('has a full-size Y plane and half-size U and V planes', () => {
    expect(i420Layout(1920, 1080)).toEqual({
      chromaWidth: 960,
      chromaHeight: 540,
      size: 1920 * 1080 * 1.5,
    });
  });

  it('rounds the chroma planes up for odd sizes', () => {
    expect(i420Layout(5, 3)).toEqual({ chromaWidth: 3, chromaHeight: 2, size: 15 + 2 * 6 });
  });
});

describe('rgbaToI420', () => {
  it('maps white, black and pure red with BT.709 full range', () => {
    const [w, h] = [2, 2];
    expect([
      ...rgbaToI420(
        rgba(w, h, () => [255, 255, 255]),
        w,
        h,
      ),
    ]).toEqual([255, 255, 255, 255, 128, 128]);
    expect([
      ...rgbaToI420(
        rgba(w, h, () => [0, 0, 0]),
        w,
        h,
      ),
    ]).toEqual([0, 0, 0, 0, 128, 128]);
    // Y = 0.2126 * 255; U = (0 - Y) / 1.8556 + 128; V = (255 - Y) / 1.5748 + 128, clamped
    expect([
      ...rgbaToI420(
        rgba(w, h, () => [255, 0, 0]),
        w,
        h,
      ),
    ]).toEqual([54, 54, 54, 54, 99, 255]);
  });

  it('takes chroma from the mean of each 2x2 block', () => {
    // Left column red, right column blue: one chroma sample of their mean
    const data = rgba(2, 2, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 255]));
    const out = rgbaToI420(data, 2, 2);
    expect([...out.subarray(0, 4)]).toEqual([54, 18, 54, 18]);
    const mean = { r: 127.5, g: 0, b: 127.5 };
    const y = 0.2126 * mean.r + 0.0722 * mean.b;
    expect(out[4]).toBe(Math.round((mean.b - y) / 1.8556 + 128));
    expect(out[5]).toBe(Math.round((mean.r - y) / 1.5748 + 128));
  });

  it('repeats the last row and column at odd edges', () => {
    const data = rgba(3, 1, (x) => (x < 2 ? [0, 0, 0] : [255, 0, 0]));
    const out = rgbaToI420(data, 3, 1);
    expect(out).toHaveLength(i420Layout(3, 1).size);
    // U plane, then V plane: the second chroma sample sees only the red column
    expect([...out.subarray(3)]).toEqual([128, 99, 128, 255]);
  });

  it('describes the colour space the bytes are in', () => {
    expect(I420_COLOR_SPACE).toEqual({
      matrix: 'bt709',
      primaries: 'bt709',
      transfer: 'iec61966-2-1',
      fullRange: true,
    });
  });
});
