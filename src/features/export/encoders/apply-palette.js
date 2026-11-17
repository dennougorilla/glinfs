/**
 * Palette mapping for gifenc: the same result as gifenc's applyPalette,
 * faster.
 *
 * gifenc maps each pixel through a cache keyed by its color reduced to 5
 * bits per channel ("rgb565" in gifenc is 5-5-5) or 4 bits (rgb444). The
 * first pixel of a key runs the nearest-color search with its exact color
 * and every later pixel of that key reuses the answer. The cache there is a
 * sparse Array probed with `in`; here it is a typed array, and the palette
 * is read from flat typed arrays. Keys, search order and tie-breaking (the
 * last of equally near colors wins) are gifenc's, so the indices are
 * identical.
 *
 * @module features/export/encoders/apply-palette
 */

/** @type {Int16Array | null} Reused cache (65536 keys, -1 = not looked up) */
let cache = null;

/**
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @param {number[][]} palette - At most 256 colors
 * @param {'rgb565' | 'rgb444'} [format='rgb565']
 * @returns {Uint8Array} Palette index per pixel
 */
export function applyPaletteFast(rgba, palette, format = 'rgb565') {
  const n = palette.length;
  if (n === 0 || n > 256) throw new Error('applyPaletteFast() needs 1-256 colors');
  const pr = new Int32Array(n);
  const pg = new Int32Array(n);
  const pb = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    pr[i] = palette[i][0];
    pg[i] = palette[i][1];
    pb[i] = palette[i][2];
  }
  cache ??= new Int16Array(65536);
  const bins = format === 'rgb444' ? 4096 : 65536;
  cache.fill(-1, 0, bins);
  const c = cache;
  const length = rgba.length >> 2;
  const index = new Uint8Array(length);
  const rgb444 = format === 'rgb444';

  // One 32-bit read per pixel (little-endian: R in the low byte), as gifenc
  // does; a view at an unaligned offset falls back to byte reads
  const words =
    rgba.byteOffset % 4 === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, length) : null;
  for (let i = 0, p = 0; i < length; i++, p += 4) {
    const word = words ? words[i] : 0;
    const r = words ? word & 0xff : rgba[p];
    const g = words ? (word >> 8) & 0xff : rgba[p + 1];
    const b = words ? (word >> 16) & 0xff : rgba[p + 2];
    const key = rgb444
      ? ((r >> 4) << 8) | (g & 0xf0) | (b >> 4)
      : ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
    let k = c[key];
    if (k < 0) {
      // gifenc's nearestColorIndexRGB: squared distance, channel by channel
      // with early exits; a later color at an equal distance wins
      k = 0;
      let min = Number.POSITIVE_INFINITY;
      for (let j = 0; j < n; j++) {
        const dr = pr[j] - r;
        let d = dr * dr;
        if (d > min) continue;
        const dg = pg[j] - g;
        d += dg * dg;
        if (d > min) continue;
        const db = pb[j] - b;
        d += db * db;
        if (d > min) continue;
        min = d;
        k = j;
      }
      c[key] = k;
    }
    index[i] = k;
  }
  return index;
}
