/**
 * Click-to-select (Segment Anything) prompts and masks — pure helpers
 * @module features/ai-cutout/sam-prompts
 *
 * Everything between a click on the preview and a stored mask that needs
 * no ONNX Runtime and no DOM, so it is unit-tested:
 *
 * - Geometry: the encoder sees the frame resized so its long side is 1024
 *   (getEncoderSize, like SAM's ResizeLongestSide); a click stored as
 *   fractions of the source frame becomes a point in those pixels
 *   (toEncoderPoint), and a box becomes SAM's two corner points (labels 2
 *   and 3). The decoder is asked for its masks at the mask resolution
 *   directly (`orig_im_size`), so a mask pixel maps back to the frame by
 *   plain scaling, like every other model's mask.
 * - Masks: logits become the 0..255 probabilities the mask store holds
 *   (a sigmoid: SAM's "inside" threshold 0 is probability 0.5, the Fit
 *   slider's default); maskStats gives a mask's area and bounding box,
 *   interiorPoint the pixel deepest inside it.
 * - Choice: SAM returns four masks per prompt (0: its single-mask answer,
 *   1–3: a part, a bigger part, the whole). chooseCandidate picks the whole
 *   (the largest confident mask) or a part (the best-scoring smaller one) on
 *   a clicked frame, and on a tracked frame the one that overlaps the
 *   previous frame's mask most (steadier than the best score).
 * - Tracking: each next frame is prompted with the previous mask's box
 *   (grown a little) and a point deep inside it (trackingPrompt); a frame
 *   whose mask area jumps (isTrackingLost) is where the object was lost.
 */

/** Long side of the encoder input (MobileSAM, like every SAM) */
export const SAM_INPUT_SIZE = 1024;

/** Side of the decoder's low-resolution mask input/output */
export const SAM_LOW_RES_SIZE = 256;

/** Point labels of the SAM prompt encoder */
export const SAM_LABEL = Object.freeze({
  PAD: -1,
  REMOVE: 0,
  KEEP: 1,
  BOX_TOP_LEFT: 2,
  BOX_BOTTOM_RIGHT: 3,
});

/** Tracked frames: the previous mask's box grows by this fraction of its size per side */
export const TRACK_BOX_MARGIN = 0.1;

/** Tracked frames: an area change above this fraction of the previous area means lost */
export const TRACK_MAX_AREA_CHANGE = 0.5;

/** Whole: masks scoring below this fraction of the best score are not "the whole" */
export const WHOLE_MIN_SCORE_RATIO = 0.8;

/**
 * A prompt point: fractions of the source frame (0..1) and whether it marks
 * something to keep or to remove.
 * @typedef {Object} SamPoint
 * @property {number} x
 * @property {number} y
 * @property {'keep' | 'remove'} mode
 */

/**
 * A box: fractions of the source frame, [left, top, right, bottom].
 * @typedef {[number, number, number, number]} SamBox
 */

/**
 * One of the decoder's masks at the mask resolution.
 * @typedef {Object} SamCandidate
 * @property {Uint8Array} data - 0..255 probability, width * height
 * @property {number} width
 * @property {number} height
 * @property {number} score - The decoder's predicted IoU
 * @property {number} index - 0 (single-mask answer) .. 3
 */

/**
 * Size of the encoder input for a frame: the long side becomes `longSide`,
 * the other keeps the aspect ratio (rounded like SAM's
 * ResizeLongestSide.get_preprocess_shape: `int(x * scale + 0.5)`).
 * @param {number} width
 * @param {number} height
 * @param {number} [longSide]
 * @returns {{ width: number, height: number }}
 */
export function getEncoderSize(width, height, longSide = SAM_INPUT_SIZE) {
  const scale = longSide / Math.max(width, height);
  return {
    width: Math.max(1, Math.floor(width * scale + 0.5)),
    height: Math.max(1, Math.floor(height * scale + 0.5)),
  };
}

/**
 * A point in fractions of the source frame as encoder-input pixels
 * @param {{ x: number, y: number }} point
 * @param {{ width: number, height: number }} encoderSize
 * @returns {[number, number]}
 */
export function toEncoderPoint(point, encoderSize) {
  return [point.x * encoderSize.width, point.y * encoderSize.height];
}

/**
 * The decoder's `point_coords` / `point_labels`: the points (keep 1,
 * remove 0), then the box as its two corners (labels 2 and 3), or without a
 * box the padding point SAM's ONNX export expects (0, 0, label -1).
 * @param {{ points: SamPoint[], box?: SamBox | null, encoderSize: { width: number, height: number }, maxPoints?: number }} prompt
 * @returns {{ coords: Float32Array, labels: Float32Array, count: number }}
 * @throws {RangeError} without any point or box, or with more than maxPoints points
 */
export function buildPromptInputs({ points, box = null, encoderSize, maxPoints = 32 }) {
  if (points.length === 0 && !box) throw new RangeError('A prompt needs a point or a box');
  if (points.length > maxPoints) {
    throw new RangeError(`A prompt takes at most ${maxPoints} points, got ${points.length}`);
  }
  const count = points.length + (box ? 2 : 1);
  const coords = new Float32Array(count * 2);
  const labels = new Float32Array(count);
  points.forEach((point, i) => {
    const [x, y] = toEncoderPoint(point, encoderSize);
    coords[i * 2] = x;
    coords[i * 2 + 1] = y;
    labels[i] = point.mode === 'remove' ? SAM_LABEL.REMOVE : SAM_LABEL.KEEP;
  });
  const n = points.length;
  if (box) {
    const [x0, y0] = toEncoderPoint({ x: box[0], y: box[1] }, encoderSize);
    const [x1, y1] = toEncoderPoint({ x: box[2], y: box[3] }, encoderSize);
    coords.set([x0, y0, x1, y1], n * 2);
    labels[n] = SAM_LABEL.BOX_TOP_LEFT;
    labels[n + 1] = SAM_LABEL.BOX_BOTTOM_RIGHT;
  } else {
    labels[n] = SAM_LABEL.PAD;
  }
  return { coords, labels, count };
}

/**
 * Mask logits (> 0 is inside) as 0..255 probabilities (sigmoid)
 * @param {ArrayLike<number>} logits
 * @param {number} offset - First value to convert
 * @param {number} length
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function logitsToProbability(logits, offset, length, out = new Uint8Array(length)) {
  for (let i = 0; i < length; i++) {
    const v = logits[offset + i];
    // Clamped so exp() never overflows; |v| > 12 is 0 or 255 anyway
    const p = 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, v))));
    out[i] = Math.round(p * 255);
  }
  return out;
}

/**
 * Area and bounding box of a probability mask (pixels at or above the threshold)
 * @param {Uint8Array} data - 0..255, width * height
 * @param {number} width
 * @param {number} height
 * @param {number} [threshold] - 0..255 (128: SAM's own cut)
 * @returns {{ area: number, box: SamBox | null }} area: fraction of the frame;
 *   box: fractions, right/bottom exclusive; null for an empty mask
 */
export function maskStats(data, width, height, threshold = 128) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] < threshold) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const area = width * height > 0 ? count / (width * height) : 0;
  if (count === 0) return { area: 0, box: null };
  return { area, box: [x0 / width, y0 / height, (x1 + 1) / width, (y1 + 1) / height] };
}

/**
 * A box grown by `margin` of its size on every side, clamped to the frame
 * @param {SamBox} box
 * @param {number} [margin]
 * @returns {SamBox}
 */
export function expandBox(box, margin = TRACK_BOX_MARGIN) {
  const dx = (box[2] - box[0]) * margin;
  const dy = (box[3] - box[1]) * margin;
  const clamp = (/** @type {number} */ v) => Math.max(0, Math.min(1, v));
  return [clamp(box[0] - dx), clamp(box[1] - dy), clamp(box[2] + dx), clamp(box[3] + dy)];
}

/**
 * The mask pixel deepest inside the mask (largest distance to the nearest
 * outside pixel, 3-4 chamfer distance, two passes), as fractions of the
 * frame at the pixel's centre. A point there stays on the object when it
 * moves a little, unlike the centroid of a ring or a crescent.
 * @param {Uint8Array} data - 0..255, width * height
 * @param {number} width
 * @param {number} height
 * @param {number} [threshold]
 * @returns {{ x: number, y: number } | null} null for an empty mask
 */
export function interiorPoint(data, width, height, threshold = 128) {
  const size = width * height;
  if (size === 0) return null;
  const big = 1 << 30;
  const dist = new Int32Array(size);
  for (let i = 0; i < size; i++) dist[i] = data[i] >= threshold ? big : 0;
  // Outside the frame counts as outside the mask
  const at = (/** @type {number} */ x, /** @type {number} */ y) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : dist[y * width + x];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      dist[i] = Math.min(
        dist[i],
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  }
  let best = -1;
  let bestValue = 0;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      dist[i] = Math.min(
        dist[i],
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
      if (dist[i] >= bestValue) {
        bestValue = dist[i];
        best = i;
      }
    }
  }
  if (best < 0) return null;
  return { x: ((best % width) + 0.5) / width, y: (Math.floor(best / width) + 0.5) / height };
}

/**
 * Intersection over union of two masks of the same size (at the threshold)
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} [threshold]
 * @returns {number} 0..1 (1 for two empty masks)
 */
export function maskIoU(a, b, threshold = 128) {
  if (a.length !== b.length) throw new RangeError('Masks of different sizes');
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const ia = a[i] >= threshold;
    const ib = b[i] >= threshold;
    if (ia && ib) inter++;
    if (ia || ib) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * Count of mask pixels at or above the threshold
 * @param {Uint8Array} data
 * @param {number} [threshold]
 * @returns {number}
 */
function countInside(data, threshold = 128) {
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= threshold) n++;
  return n;
}

/**
 * Pick one of the decoder's masks.
 * - 'whole' (clicked frame): the largest of the masks that score at least
 *   WHOLE_MIN_SCORE_RATIO of the best (a click on a face gives the person);
 * - 'part' (clicked frame): the best-scoring mask that is smaller than the
 *   whole (the face), or the whole when nothing smaller is non-empty;
 * - with `previous` (tracked frame): the mask overlapping it most.
 * Empty masks are never chosen while a non-empty one exists.
 * @param {SamCandidate[]} candidates
 * @param {{ scope?: 'whole' | 'part', previous?: Uint8Array | null }} [options]
 * @returns {SamCandidate}
 */
export function chooseCandidate(candidates, { scope = 'whole', previous = null } = {}) {
  if (candidates.length === 0) throw new RangeError('No candidate masks');
  const sized = candidates.map((c) => ({ c, area: countInside(c.data) }));
  const nonEmpty = sized.filter((s) => s.area > 0);
  const pool = nonEmpty.length > 0 ? nonEmpty : sized;
  if (previous) {
    let best = pool[0];
    let bestIoU = -1;
    for (const s of pool) {
      const iou = maskIoU(s.c.data, previous);
      if (iou > bestIoU) {
        bestIoU = iou;
        best = s;
      }
    }
    return best.c;
  }
  const topScore = Math.max(...pool.map((s) => s.c.score));
  const confident = pool.filter((s) => s.c.score >= topScore * WHOLE_MIN_SCORE_RATIO);
  const whole = confident.reduce((a, b) => (b.area > a.area ? b : a));
  if (scope === 'whole') return whole.c;
  const smaller = pool.filter((s) => s.area < whole.area);
  if (smaller.length === 0) return whole.c;
  return smaller.reduce((a, b) => (b.c.score > a.c.score ? b : a)).c;
}

/**
 * The prompt of a tracked frame: the previous frame's mask box grown by
 * TRACK_BOX_MARGIN, plus a keep point deep inside that mask.
 * @param {Uint8Array} previous - 0..255
 * @param {number} width
 * @param {number} height
 * @returns {{ points: SamPoint[], box: SamBox } | null} null when the previous mask is empty
 */
export function trackingPrompt(previous, width, height) {
  const { box } = maskStats(previous, width, height);
  if (!box) return null;
  const inside = interiorPoint(previous, width, height);
  return {
    points: inside ? [{ x: inside.x, y: inside.y, mode: 'keep' }] : [],
    box: expandBox(box),
  };
}

/**
 * Whether a tracked frame lost the object: its mask is empty, or its area
 * changed by more than `maxChange` of the previous frame's area.
 * @param {number} previousArea - Fraction of the frame
 * @param {number} area - Fraction of the frame
 * @param {number} [maxChange]
 * @returns {boolean}
 */
export function isTrackingLost(previousArea, area, maxChange = TRACK_MAX_AREA_CHANGE) {
  if (area <= 0) return true;
  if (previousArea <= 0) return false;
  return Math.abs(area - previousArea) / previousArea > maxChange;
}

/**
 * The frames that hold prompts, with their points: one anchor per frame,
 * in the order they are worked on (the frame on screen first, then the
 * nearest), only frames inside the range.
 * @param {{ frame: number, x: number, y: number, mode: 'keep' | 'remove' }[]} picks
 * @param {{ start: number, end: number }} range - Inclusive
 * @param {number} currentFrame
 * @returns {{ frame: number, points: SamPoint[] }[]}
 */
export function planAnchors(picks, range, currentFrame) {
  /** @type {Map<number, SamPoint[]>} */
  const byFrame = new Map();
  for (const pick of picks) {
    if (pick.frame < range.start || pick.frame > range.end) continue;
    const points = byFrame.get(pick.frame) ?? [];
    points.push({ x: pick.x, y: pick.y, mode: pick.mode });
    byFrame.set(pick.frame, points);
  }
  return [...byFrame]
    .map(([frame, points]) => ({ frame, points }))
    .sort(
      (a, b) =>
        Math.abs(a.frame - currentFrame) - Math.abs(b.frame - currentFrame) || a.frame - b.frame,
    );
}
