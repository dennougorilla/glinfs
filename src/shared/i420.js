/**
 * RGBA -> I420 (D3's cheap half): the layout, the colour space and the CPU
 * reference conversion of a capture frame held as CPU YUV.
 *
 * A clip from the capture buffer used to stay as RGBA VideoFrames on the
 * GPU (4 B/px). As I420 it takes 1.5 B/px of CPU memory, like a clip that
 * was opened from the queue. The converter worker does the conversion with
 * WebGL2 and must give exactly these bytes; this function is its fallback
 * where WebGL2 is not available.
 *
 * BT.709 full range: the matrix and range that lose the least on 8 bits.
 * Chroma is the mean of each 2x2 block (4:2:0), with the last row and
 * column repeated at odd edges.
 *
 * @module shared/i420
 */

/** Colour space of the bytes rgbaToI420 makes (a VideoFrameInit colorSpace) */
export const I420_COLOR_SPACE = Object.freeze({
  matrix: 'bt709',
  primaries: 'bt709',
  transfer: 'iec61966-2-1',
  fullRange: true,
});

/** Bytes per pixel of an I420 frame (one luma byte, half a byte of chroma) */
export const I420_BYTES_PER_PIXEL = 1.5;

/** BT.709 luma weights */
const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;
/** 2 * (1 - KB) and 2 * (1 - KR): the Cb and Cr scales */
const CB_SCALE = 1.8556;
const CR_SCALE = 1.5748;

/**
 * Plane sizes of a w x h I420 frame: Y is w x h, U and V are each
 * ceil(w/2) x ceil(h/2), stored one after the other
 * @param {number} width
 * @param {number} height
 * @returns {{ chromaWidth: number, chromaHeight: number, size: number }}
 */
export function i420Layout(width, height) {
  const chromaWidth = (width + 1) >> 1;
  const chromaHeight = (height + 1) >> 1;
  return { chromaWidth, chromaHeight, size: width * height + 2 * chromaWidth * chromaHeight };
}

/**
 * @param {number} value
 * @returns {number}
 */
function toByte(value) {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/**
 * Convert opaque RGBA pixels to I420 bytes (alpha is ignored)
 * @param {Uint8ClampedArray | Uint8Array} rgba - width * height * 4 bytes
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} [out] - At least i420Layout(width, height).size bytes
 * @returns {Uint8Array}
 */
export function rgbaToI420(rgba, width, height, out) {
  const { chromaWidth, chromaHeight, size } = i420Layout(width, height);
  const bytes = out ?? new Uint8Array(size);
  const uOffset = width * height;
  const vOffset = uOffset + chromaWidth * chromaHeight;

  for (let p = 0, k = 0; k < width * height; k++, p += 4) {
    bytes[k] = toByte(KR * rgba[p] + KG * rgba[p + 1] + KB * rgba[p + 2]);
  }

  for (let cy = 0; cy < chromaHeight; cy++) {
    const y0 = cy * 2;
    const y1 = Math.min(y0 + 1, height - 1);
    for (let cx = 0; cx < chromaWidth; cx++) {
      const x0 = cx * 2;
      const x1 = Math.min(x0 + 1, width - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      for (const p of [
        (y0 * width + x0) * 4,
        (y0 * width + x1) * 4,
        (y1 * width + x0) * 4,
        (y1 * width + x1) * 4,
      ]) {
        r += rgba[p];
        g += rgba[p + 1];
        b += rgba[p + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const luma = KR * r + KG * g + KB * b;
      const c = cy * chromaWidth + cx;
      bytes[uOffset + c] = toByte((b - luma) / CB_SCALE + 128);
      bytes[vOffset + c] = toByte((r - luma) / CR_SCALE + 128);
    }
  }
  return bytes;
}
