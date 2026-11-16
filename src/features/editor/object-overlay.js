/**
 * Show mask: each tracked fix-up's region drawn over the frame in its own
 * colour with an outline (solid for a removed region, dashed for a kept
 * one), the hovered chip's region emphasized
 * @module features/editor/object-overlay
 */

import { OBJECT_MASK_THRESHOLD, upsampleThreshold } from '../../shared/masks/object-masks.js';

/** The overlay is painted at most this large (long side), then scaled */
export const OVERLAY_MAX_SIDE = 960;

/**
 * @typedef {Object} OverlayRegion
 * @property {'remove' | 'add'} mode
 * @property {string} color - '#rrggbb'
 * @property {{ data: Uint8Array, width: number, height: number }} mask - 0..255 probability
 */

/**
 * @param {string} hex - '#rrggbb'
 * @returns {[number, number, number]}
 */
function parseHex(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Paint regions into RGBA pixels (straight alpha, transparent elsewhere; a
 * later region paints over an earlier one)
 * @param {Uint8ClampedArray} out - width * height * 4, cleared by the caller
 * @param {number} width
 * @param {number} height
 * @param {OverlayRegion[]} regions
 * @param {{ highlight?: number, line?: number }} [options] - highlight: the
 *   index of the region to emphasize (the others fade); line: outline width
 *   in pixels
 */
export function paintRegions(out, width, height, regions, options = {}) {
  const { highlight = -1, line = 2 } = options;
  const inside = new Uint8Array(width * height);
  const dash = Math.max(4, line * 3);
  regions.forEach((region, index) => {
    upsampleThreshold(
      region.mask.data,
      region.mask.width,
      region.mask.height,
      width,
      height,
      inside,
      OBJECT_MASK_THRESHOLD,
    );
    const [r, g, b] = parseHex(region.color);
    const emphasized = index === highlight;
    const faded = highlight >= 0 && !emphasized;
    const fill = emphasized ? 140 : faded ? 40 : 90;
    const width2 = emphasized ? line * 2 : line;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!inside[i]) continue;
        let edge = false;
        for (let d = 1; d <= width2 && !edge; d++) {
          edge =
            x < d ||
            y < d ||
            x + d >= width ||
            y + d >= height ||
            !inside[i - d] ||
            !inside[i + d] ||
            !inside[i - d * width] ||
            !inside[i + d * width];
        }
        // A kept region's outline is dashed
        const drawn = edge && (region.mode === 'remove' || Math.floor((x + y) / dash) % 2 === 0);
        const o = i * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = drawn ? (faded ? 120 : 255) : fill;
      }
    }
  });
}

/**
 * Draw the regions over the frame on a canvas the frame's size
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {OverlayRegion[]} regions
 * @param {number} [highlight] - Index of the region to emphasize, -1 for none
 */
export function drawRegions(ctx, frameWidth, frameHeight, regions, highlight = -1) {
  if (regions.length === 0 || frameWidth <= 0 || frameHeight <= 0) return;
  const scale = Math.min(1, OVERLAY_MAX_SIDE / Math.max(frameWidth, frameHeight));
  const w = Math.max(1, Math.round(frameWidth * scale));
  const h = Math.max(1, Math.round(frameHeight * scale));
  const image = new ImageData(w, h);
  paintRegions(image.data, w, h, regions, {
    highlight,
    line: Math.max(1, Math.round(Math.max(w, h) / 320)),
  });
  const layer = document.createElement('canvas');
  layer.width = w;
  layer.height = h;
  layer.getContext('2d')?.putImageData(image, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer, 0, 0, frameWidth, frameHeight);
  ctx.restore();
}
