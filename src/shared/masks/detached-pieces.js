/**
 * Colour reach = Detached pieces (Methods; task 7 item 3, "pieces-palette"):
 * a Colour fix-up removes the small detached pieces of the cutout whose
 * pixels are mostly in the clicked piece's palette. Measured on the owner's
 * clips: all of job 3's flames (9-18 small pieces per frame whose colours
 * are close to the wall's) went with nothing of the character eaten, where
 * Touching and Everywhere removed 1-2 %; it does nothing for leftovers
 * attached to the character (Touching / Everywhere stay the tools there).
 * @module shared/masks/detached-pieces
 */

import { labelComponents } from './mask-ops.js';

/** A piece this share of the frame or larger is never removed */
export const PIECE_MAX_SHARE = 0.02;

/** A piece goes when at least this share of its pixels is in the palette */
export const PALETTE_MATCH_SHARE = 0.5;

/** Index of a colour in the 16 x 16 x 16 palette grid (4 bits per channel) */
const cell = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) =>
  ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

/**
 * The palette of the piece under a click: the 4-bit colours of its pixels,
 * each grown by one step on every channel (1 = in the palette)
 * @param {Uint8ClampedArray | Uint8Array} rgba - The frame, width * height * 4
 * @param {Uint8Array} mask - The cutout on that frame (nonzero = kept)
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} point - The click, 0..1
 * @returns {Uint8Array | null} 4096 cells, or null when the click is on no piece
 */
export function createPiecePalette(rgba, mask, width, height, point) {
  const px = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)));
  if (!mask[py * width + px]) return null;
  const { labels } = labelComponents(mask, width, height);
  const label = labels[py * width + px];
  const seen = new Uint8Array(4096);
  for (let i = 0; i < width * height; i++) {
    if (labels[i] !== label) continue;
    seen[cell(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])] = 1;
  }
  const palette = new Uint8Array(4096);
  for (let c = 0; c < 4096; c++) {
    if (!seen[c]) continue;
    const r = c >> 8;
    const g = (c >> 4) & 15;
    const b = c & 15;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          const rr = r + dr;
          const gg = g + dg;
          const bb = b + db;
          if (rr < 0 || gg < 0 || bb < 0 || rr > 15 || gg > 15 || bb > 15) continue;
          palette[(rr << 8) | (gg << 4) | bb] = 1;
        }
      }
    }
  }
  return palette;
}

/**
 * Remove (set to 0) every detached piece of `out` that is not the largest,
 * is under PIECE_MAX_SHARE of the frame and has at least PALETTE_MATCH_SHARE
 * of its pixels in the palette
 * @param {Uint8Array} out - The cutout (nonzero = kept), changed in place
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray | Uint8Array} rgba - The frame, width * height * 4
 * @param {Uint8Array} palette - From createPiecePalette
 * @param {Int32Array} [labelsOut] - Reused label buffer
 * @returns {number} Pixels removed
 */
export function removeDetachedPieces(out, width, height, rgba, palette, labelsOut) {
  const size = width * height;
  const { labels, count, areas } = labelComponents(out, width, height, labelsOut);
  if (count < 2) return 0;
  let largest = 1;
  for (let k = 2; k <= count; k++) if (areas[k] > areas[largest]) largest = k;
  const limit = PIECE_MAX_SHARE * size;
  const matches = new Int32Array(count + 1);
  for (let i = 0; i < size; i++) {
    const k = labels[i];
    if (k === 0 || k === largest || areas[k] > limit) continue;
    if (palette[cell(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])]) matches[k]++;
  }
  let removed = 0;
  for (let i = 0; i < size; i++) {
    const k = labels[i];
    if (k === 0 || k === largest || areas[k] > limit) continue;
    if (matches[k] >= PALETTE_MATCH_SHARE * areas[k]) {
      out[i] = 0;
      removed++;
    }
  }
  return removed;
}
