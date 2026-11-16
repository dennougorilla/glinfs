/**
 * Tracked objects on top of the base model's mask - Pure Functions
 *
 * A tracked object (the edits' `AiCutout.objects`) is a thing the user
 * clicked once, followed through the selection by the click-to-select
 * model (MobileSAM). Its per-frame mask is subtracted from ('remove') or
 * added to ('add') the base model's final mask, so the base model keeps its
 * own edges everywhere else.
 *
 * Storage size: MobileSAM computes every mask from its 256 × 256 low-res
 * logits over the frame padded to a square (the full-size mask is that
 * grid upsampled), so a mask whose long side is OBJECT_MASK_LONG_SIDE
 * holds everything the model knows. A 300-frame selection at 16:9 is
 * 256 × 144 bytes × 300 ≈ 11 MB per object, 44 MB for the four an AiCutout
 * may have; at the base masks' 1024 they would be 177 MB each and push the
 * base masks out of the mask store.
 *
 * No DOM access: tested without a browser.
 *
 * @module shared/masks/object-masks
 */

import { morphMask } from './mask-ops.js';

/** Long side of a stored object mask (MobileSAM's low-res grid) */
export const OBJECT_MASK_LONG_SIDE = 256;

/**
 * An object mask counts where its probability is at least this (0..255).
 * Above SAM's own 128 cut: MobileSAM's "whole" answer can hold a neighbour
 * at just over 0.5 (the character beside a clicked shelf scored 146 in a
 * live run), and subtracting that would take a bite out of the character.
 */
export const OBJECT_MASK_THRESHOLD = 192;

/**
 * Object tracking: a frame whose mask scores below this fraction of the best
 * score so far on its pass is where the object was lost. Measured live
 * (MobileSAM, WebGPU, a shelf that leaves the frame for three frames): 0.955
 * to 1.008 while it is there, 0.907 and 0.878 on the second and third frame
 * it is gone (the first still scores 0.985 from the previous frame's
 * mask_input), while the box prompt kept the mask's area the same.
 */
export const OBJECT_TRACK_MIN_SCORE_RATIO = 0.93;

/**
 * Object clicks: "whole" is the largest decoder answer scoring at least this
 * fraction of the best (the click-to-select model uses 0.8). Measured live:
 * a click on a shelf beside a character answered the shelf alone at 0.914
 * and shelf + half the character at 0.847 (best 0.970); 0.8 took the
 * second, which removed the character's head on the next frames too.
 */
export const OBJECT_WHOLE_MIN_SCORE_RATIO = 0.9;

/**
 * A correction's anchor frame prompted from its seed (its earlier answer,
 * see object-seeds.js): 'score' also decodes it without the seed and keeps
 * the seeded answer only when it scores at least as well; 'off' always
 * keeps the seeded answer. Measured on 7 targets of the owner's anime clips
 * (a scripted user, up to 8 corrections; see the PR that added seeds): 'score'
 * made a few fewer frames worse (25 vs 26 from a click, 18 vs 22 from a box)
 * but solved one target less from a Whole click and lowered the box start's
 * worst-frame score (mean 0.49 vs 0.60), so 'off'.
 * @type {'off' | 'score'}
 */
export const OBJECT_SEED_GUARD = 'off';

/**
 * A removed object grows by this many pixels of a 1024-wide mask before it
 * is subtracted, so no fringe of it stays around its edge
 */
export const OBJECT_REMOVE_GROW_PX = 2;

/**
 * @typedef {Object} ObjectMaskLayer
 * @property {'remove' | 'add'} mode
 * @property {{ data: Uint8Array, width: number, height: number } | null} mask - The
 *   object's 0..255 probability on this frame, any size (null: not tracked
 *   here, the frame keeps the base mask)
 */

/**
 * Size an object mask is stored at for a frame: the frame's aspect, long
 * side OBJECT_MASK_LONG_SIDE (never larger than the frame)
 * @param {number} width - Frame width in pixels
 * @param {number} height
 * @returns {{ width: number, height: number }}
 */
export function getObjectMaskSize(width, height) {
  const long = Math.max(width, height);
  if (!(long > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, OBJECT_MASK_LONG_SIDE / long);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Grow radius of a removed object in pixels of a mask this wide
 * @param {number} maskWidth
 * @returns {number}
 */
export function getRemoveGrowRadius(maskWidth) {
  return Math.max(1, Math.round((OBJECT_REMOVE_GROW_PX * maskWidth) / 1024));
}

/**
 * Upsample (or resample) a probability mask with bilinear filtering and
 * threshold it: the object's 0/1 mask at the base mask's size. Pixel
 * centres are aligned (like align_corners = false), so a mask of the same
 * size comes back thresholded as is.
 * @param {Uint8Array} prob - 0..255, srcW * srcH
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {Uint8Array} [out]
 * @param {number} [threshold] - 0..255; inside where the value is at least this
 * @returns {Uint8Array} 0/1, dstW * dstH
 */
export function upsampleThreshold(
  prob,
  srcW,
  srcH,
  dstW,
  dstH,
  out = new Uint8Array(dstW * dstH),
  threshold = 128,
) {
  if (srcW === dstW && srcH === dstH) {
    for (let i = 0; i < dstW * dstH; i++) out[i] = prob[i] >= threshold ? 1 : 0;
    return out;
  }
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  // Horizontal taps per destination column, computed once
  const x0s = new Int32Array(dstW);
  const x1s = new Int32Array(dstW);
  const fxs = new Float32Array(dstW);
  for (let x = 0; x < dstW; x++) {
    const fx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * sx - 0.5));
    const x0 = Math.floor(fx);
    x0s[x] = x0;
    x1s[x] = Math.min(srcW - 1, x0 + 1);
    fxs[x] = fx - x0;
  }
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = fy - y0;
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;
    const o = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const x0 = x0s[x];
      const x1 = x1s[x];
      const wx = fxs[x];
      const top = prob[row0 + x0] + (prob[row0 + x1] - prob[row0 + x0]) * wx;
      const bottom = prob[row1 + x0] + (prob[row1 + x1] - prob[row1 + x0]) * wx;
      out[o + x] = top + (bottom - top) * wy >= threshold - 0.5 ? 1 : 0;
    }
  }
  return out;
}

/**
 * @typedef {Object} ObjectScratch
 * @property {Uint8Array} object - The object's 0/1 mask at the base size
 * @property {Uint8Array} grown - The removed object after growing
 * @property {Uint8Array} result
 */

/**
 * Scratch buffers for applyObjectMasks at one mask size
 * @param {number} size - width * height
 * @returns {ObjectScratch}
 */
export function createObjectScratch(size) {
  return {
    object: new Uint8Array(size),
    grown: new Uint8Array(size),
    result: new Uint8Array(size),
  };
}

/**
 * Apply tracked objects to a frame's final mask, in order (a later object
 * wins where two overlap), each inside where it reaches
 * OBJECT_MASK_THRESHOLD: a 'remove' object, grown by
 * getRemoveGrowRadius, is cleared from the mask; an 'add' object is added
 * to it. Layers without a mask on this frame change nothing.
 * @param {Uint8Array} mask - 0/1, width * height (not modified)
 * @param {number} width
 * @param {number} height
 * @param {ObjectMaskLayer[]} layers
 * @param {ObjectScratch} scratch - From createObjectScratch(width * height)
 * @returns {Uint8Array} `mask` itself when no layer applies, else scratch.result
 */
export function applyObjectMasks(mask, width, height, layers, scratch) {
  const size = width * height;
  let out = mask;
  for (const layer of layers) {
    const object = layer.mask;
    if (!object || object.width <= 0 || object.height <= 0) continue;
    if (out === mask) {
      scratch.result.set(mask.subarray(0, size));
      out = scratch.result;
    }
    let bin = upsampleThreshold(
      object.data,
      object.width,
      object.height,
      width,
      height,
      scratch.object,
      OBJECT_MASK_THRESHOLD,
    );
    if (layer.mode === 'remove') {
      bin = morphMask(bin, width, height, getRemoveGrowRadius(width), scratch.grown);
      for (let i = 0; i < size; i++) if (bin[i]) out[i] = 0;
    } else {
      for (let i = 0; i < size; i++) if (bin[i]) out[i] = 1;
    }
  }
  return out;
}
