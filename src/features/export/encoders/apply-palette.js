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
 * With `stable`, the index depends on the pixel's color alone: the first
 * pixel of a key changes from frame to frame, so a still pixel could change
 * index (and shown color) between frames. The encoder uses it; the default
 * stays gifenc's.
 * - A key whose color range holds palette colors maps each pixel to the
 *   nearest of those, from the pixel's own color: a pixel of a palette color
 *   always gets that color (#226 review: searched from the centre, black lost
 *   to (18,12,10) at rgb444).
 * - Any other key is searched once, from the centre of its range.
 *
 * @module features/export/encoders/apply-palette
 */

/** @type {Int16Array | null} Reused cache (65536 keys, -1 = not looked up) */
let cache = null;

/**
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @param {number[][]} palette - At most 256 colors
 * @param {'rgb565' | 'rgb444'} [format='rgb565']
 * @param {{ stable?: boolean }} [options] - stable: the index depends on the
 *   color alone, so a color maps to the same index wherever and whenever it
 *   appears, and a palette color to itself
 * @returns {Uint8Array} Palette index per pixel
 */
export function applyPaletteFast(rgba, palette, format = 'rgb565', { stable = false } = {}) {
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

  // stable: the palette colors inside each key's range, as a chain from
  // cellFirst[key] through cellNext (highest index first, so an exact tie
  // goes to the last equal color, as in gifenc's search). A key with one
  // such color is answered up front through the cache; a key with several
  // is marked -2 and searched per color
  const cellFirst = stable ? new Int16Array(bins).fill(-1) : null;
  const cellNext = stable ? new Int16Array(n) : null;
  if (cellFirst && cellNext) {
    for (let j = 0; j < n; j++) {
      const key = rgb444
        ? ((pr[j] >> 4) << 8) | (pg[j] & 0xf0) | (pb[j] >> 4)
        : ((pr[j] << 8) & 0xf800) | ((pg[j] << 2) & 0x03e0) | (pb[j] >> 3);
      cellNext[j] = cellFirst[key];
      cellFirst[key] = j;
      c[key] = cellNext[j] < 0 ? j : -2;
    }
  }
  // The last color searched in a key marked -2 (runs of one color are common)
  let lastWord = -1;
  let lastK = 0;

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
    if (k === -2 && cellFirst && cellNext) {
      // Nearest of the key's own palette colors, from the pixel's color
      const rgb = r | (g << 8) | (b << 16);
      if (rgb !== lastWord) {
        let min = Number.POSITIVE_INFINITY;
        for (let j = cellFirst[key]; j >= 0; j = cellNext[j]) {
          const dr = pr[j] - r;
          const dg = pg[j] - g;
          const db = pb[j] - b;
          const d = dr * dr + dg * dg + db * db;
          if (d < min) {
            min = d;
            lastK = j;
          }
        }
        lastWord = rgb;
      }
      index[i] = lastK;
      continue;
    }
    if (k < 0) {
      // The color searched for: the pixel's, or (stable, a key without
      // palette colors) its key's range centre
      const sr = stable ? (rgb444 ? (r & 0xf0) | 8 : (r & 0xf8) | 4) : r;
      const sg = stable ? (rgb444 ? (g & 0xf0) | 8 : (g & 0xf8) | 4) : g;
      const sb = stable ? (rgb444 ? (b & 0xf0) | 8 : (b & 0xf8) | 4) : b;
      // gifenc's nearestColorIndexRGB: squared distance, channel by channel
      // with early exits; a later color at an equal distance wins
      k = 0;
      let min = Number.POSITIVE_INFINITY;
      for (let j = 0; j < n; j++) {
        const dr = pr[j] - sr;
        let d = dr * dr;
        if (d > min) continue;
        const dg = pg[j] - sg;
        d += dg * dg;
        if (d > min) continue;
        const db = pb[j] - sb;
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
