import { applyPalette } from 'gifenc';
import { describe, expect, it } from 'vitest';
import { applyPaletteFast } from '../../../src/features/export/encoders/apply-palette.js';

/**
 * applyPaletteFast replaces gifenc's applyPalette in the encoder: it must
 * give the very same indices (same cache keys, search order and ties).
 */

/** @param {number} seed */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** A frame mixing a gradient, flat areas and noise */
function frame(seed, w = 64, h = 48) {
  const r = rng(seed);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const zone = x < w / 3 ? 0 : x < (2 * w) / 3 ? 1 : 2;
      px[i] = zone === 0 ? x * 6 : zone === 1 ? 200 : r() * 255;
      px[i + 1] = zone === 0 ? y * 5 : zone === 1 ? 40 : r() * 255;
      px[i + 2] = zone === 0 ? 128 : zone === 1 ? 90 : r() * 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

describe('applyPaletteFast', () => {
  it.each([
    ['rgb565', 16],
    ['rgb565', 100],
    ['rgb565', 256],
    ['rgb444', 32],
  ])('maps exactly like gifenc (%s, %i colors)', (format, colors) => {
    const r = rng(colors);
    const palette = Array.from({ length: colors }, () =>
      [r() * 255, r() * 255, r() * 255].map(Math.round),
    );
    for (const seed of [1, 2, 3]) {
      const px = frame(seed);
      expect(applyPaletteFast(px, palette, /** @type {any} */ (format))).toEqual(
        applyPalette(px, palette, format),
      );
    }
  });

  it('breaks ties between equally near colors as gifenc does', () => {
    // Duplicate entries and colors at equal distances from gray 100
    const palette = [
      [90, 100, 100],
      [110, 100, 100],
      [110, 100, 100],
      [0, 0, 0],
    ];
    const px = Uint8ClampedArray.from([100, 100, 100, 255, 110, 100, 100, 255, 5, 5, 5, 255]);
    expect(applyPaletteFast(px, palette)).toEqual(applyPalette(px, palette, 'rgb565'));
  });

  it.each(['rgb565', 'rgb444'])(
    'stable (%s): a color maps to the same index whichever pixel of its key comes first',
    (format) => {
      // 96 and 103 share a 5-bit (and a 4-bit) key with 100
      const palette = [
        [96, 96, 96],
        [103, 103, 103],
        [0, 0, 0],
      ];
      const px = (first) => Uint8ClampedArray.from([...first, 255, 100, 100, 100, 255]);
      const opts = { stable: true };
      const a = applyPaletteFast(px([96, 96, 96]), palette, /** @type {any} */ (format), opts);
      const b = applyPaletteFast(px([103, 103, 103]), palette, /** @type {any} */ (format), opts);
      expect(a[1]).toBe(b[1]);
      // Without it, the first pixel decides (gifenc)
      const c = applyPaletteFast(px([96, 96, 96]), palette, /** @type {any} */ (format));
      const d = applyPaletteFast(px([103, 103, 103]), palette, /** @type {any} */ (format));
      expect(c[1]).not.toBe(d[1]);
    },
  );
});
