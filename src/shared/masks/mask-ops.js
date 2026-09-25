/**
 * Mask Operations - Pure Functions
 *
 * Everything the AI cutout does to a segmentation mask between the model's
 * probability output and the pixels it clears: thresholding (optionally
 * averaged with the neighbouring frames), connected components, following
 * clicked characters ("picks") through the clip, growing/shrinking the
 * result, bit-packing it for storage, and clearing an output region with it.
 *
 * Mask conventions:
 * - probability masks are Uint8Array, 0..255, row-major, width * height
 * - binary masks are Uint8Array of 0/1, row-major, width * height
 * - packed masks store one bit per pixel over the flat row-major index,
 *   most significant bit first (pixel i is bit 7 - (i & 7) of byte i >> 3)
 *
 * No DOM access: tested without a browser.
 *
 * @module shared/masks/mask-ops
 */

/**
 * Join rule, IoU part: a component of the neighbouring frame joins a pick's
 * selection when its intersection-over-union with the selection is at least
 * this.
 */
export const TRACK_JOIN_IOU = 0.3;

/**
 * A click that misses the foreground snaps to the nearest foreground pixel
 * within this fraction of the mask diagonal (~2%).
 */
export const PICK_SNAP_RADIUS_FRACTION = 0.02;

/**
 * @typedef {Object} PackedMask
 * @property {Uint8Array} bits - ceil(width * height / 8) bytes, MSB first
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} Components
 * @property {Int32Array} labels - per pixel: 0 = background, else 1..count
 * @property {number} count      - number of components
 * @property {Int32Array} areas  - pixel count per label (index 0 unused)
 * @property {Int32Array} bboxes - per label: minX, minY, maxX, maxY
 *   (inclusive) at [4 * label .. 4 * label + 3]
 * @property {Float64Array} sumX - sum of member x coordinates per label
 * @property {Float64Array} sumY - sum of member y coordinates per label
 */

/**
 * @typedef {Object} Pick
 * @property {number} frame  - absolute clip frame index
 * @property {number} x      - fraction of the frame width, 0..1
 * @property {number} y      - fraction of the frame height, 0..1
 * @property {'keep'|'remove'} mode
 */

/**
 * Byte value a probability must reach to count as foreground
 * @param {number} threshold - 0..1
 * @returns {number} 1..255 (a probability of 0 is never foreground)
 */
export function thresholdCutoff(threshold) {
  const t = Number.isFinite(threshold) ? threshold : 0.5;
  return Math.min(255, Math.max(1, Math.round(t * 255)));
}

/**
 * Binary mask of the pixels whose probability is at least `threshold`
 * @param {Uint8Array | Uint8ClampedArray} prob - 0..255
 * @param {number} threshold - 0..1
 * @param {Uint8Array} [out] - Reused output (at least prob.length)
 * @returns {Uint8Array} 0/1 per pixel
 */
export function thresholdMask(prob, threshold, out = new Uint8Array(prob.length)) {
  const cutoff = thresholdCutoff(threshold);
  for (let i = 0; i < prob.length; i++) {
    out[i] = prob[i] >= cutoff ? 1 : 0;
  }
  return out;
}

/**
 * Average a frame's probability with the neighbouring frames that exist
 * (null neighbours, or ones of another size, are skipped), rounded to the
 * nearest byte. With no neighbours the result equals `cur`.
 * @param {Uint8Array | null | undefined} prev
 * @param {Uint8Array} cur
 * @param {Uint8Array | null | undefined} next
 * @param {Uint8Array} [out] - Reused output (at least cur.length)
 * @returns {Uint8Array}
 */
export function smoothTemporal(prev, cur, next, out = new Uint8Array(cur.length)) {
  const n = cur.length;
  const a = prev && prev.length === n ? prev : null;
  const b = next && next.length === n ? next : null;
  const count = 1 + (a ? 1 : 0) + (b ? 1 : 0);
  const half = count >> 1;
  for (let i = 0; i < n; i++) {
    const sum = cur[i] + (a ? a[i] : 0) + (b ? b[i] : 0);
    out[i] = ((sum + half) / count) | 0;
  }
  return out;
}

/**
 * Nearest-neighbour resample of a mask (probability or binary)
 * @param {Uint8Array} src
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function resampleNearest(src, srcW, srcH, dstW, dstH, out = new Uint8Array(dstW * dstH)) {
  const cols = new Int32Array(dstW);
  for (let x = 0; x < dstW; x++) {
    cols[x] = Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / dstW));
  }
  for (let y = 0; y < dstH; y++) {
    const srcRow = Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / dstH)) * srcW;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      out[dstRow + x] = src[srcRow + cols[x]];
    }
  }
  return out;
}

/**
 * Union-find parents for labelComponents, reused across calls and grown
 * only when a larger mask arrives (labeling runs on every frame of a clip).
 */
let scratchParents = new Int32Array(0);

/**
 * Root of a provisional label, with path halving
 * @param {Int32Array} parent
 * @param {number} label
 * @returns {number}
 */
function findRoot(parent, label) {
  let x = label;
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

/**
 * Merge two provisional labels' sets; the smaller root wins, so a set's
 * root is its first label in scan order
 * @param {Int32Array} parent
 * @param {number} a
 * @param {number} b
 * @returns {number} The surviving root
 */
function unionRoots(parent, a, b) {
  const ra = findRoot(parent, a);
  const rb = findRoot(parent, b);
  if (ra === rb) return ra;
  if (ra < rb) {
    parent[rb] = ra;
    return ra;
  }
  parent[ra] = rb;
  return rb;
}

/**
 * Label the 8-connected foreground components of a binary mask.
 *
 * Two-pass union-find (iterative, no recursion): labels are numbered 1..count
 * in order of each component's first pixel in row-major scan order, so the
 * same mask always gets the same labels.
 *
 * @param {Uint8Array} binary - 0/1 per pixel
 * @param {number} width
 * @param {number} height
 * @param {Int32Array} [labelsOut] - Reused label buffer (at least width * height)
 * @returns {Components}
 */
export function labelComponents(binary, width, height, labelsOut) {
  const size = width * height;
  const labels = labelsOut && labelsOut.length >= size ? labelsOut : new Int32Array(size);
  // A new provisional label needs its W/NW/N/NE neighbours empty, which
  // bounds the count by half the pixels (plus label 0)
  const maxProvisional = (size >> 1) + 2;
  if (scratchParents.length < maxProvisional) {
    scratchParents = new Int32Array(maxProvisional);
  }
  const parent = scratchParents;
  let next = 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!binary[i]) {
        labels[i] = 0;
        continue;
      }
      let label = 0;
      // Already-labeled neighbours: W, NW, N, NE
      if (x > 0 && labels[i - 1]) label = labels[i - 1];
      if (y > 0) {
        const up = i - width;
        if (x > 0 && labels[up - 1]) {
          label = label ? unionRoots(parent, label, labels[up - 1]) : labels[up - 1];
        }
        if (labels[up]) {
          label = label ? unionRoots(parent, label, labels[up]) : labels[up];
        }
        if (x < width - 1 && labels[up + 1]) {
          label = label ? unionRoots(parent, label, labels[up + 1]) : labels[up + 1];
        }
      }
      if (!label) {
        label = next++;
        parent[label] = label;
      }
      labels[i] = label;
    }
  }

  // Provisional roots -> consecutive final labels, in scan order
  const remap = new Int32Array(next);
  let count = 0;
  for (let l = 1; l < next; l++) {
    if (findRoot(parent, l) === l) remap[l] = ++count;
  }
  for (let l = 1; l < next; l++) {
    remap[l] = remap[findRoot(parent, l)];
  }

  const areas = new Int32Array(count + 1);
  const bboxes = new Int32Array(4 * (count + 1));
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  for (let l = 1; l <= count; l++) {
    bboxes[4 * l] = width;
    bboxes[4 * l + 1] = height;
    bboxes[4 * l + 2] = -1;
    bboxes[4 * l + 3] = -1;
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!labels[i]) continue;
      const l = remap[labels[i]];
      labels[i] = l;
      areas[l]++;
      sumX[l] += x;
      sumY[l] += y;
      const b = 4 * l;
      if (x < bboxes[b]) bboxes[b] = x;
      if (y < bboxes[b + 1]) bboxes[b + 1] = y;
      if (x > bboxes[b + 2]) bboxes[b + 2] = x;
      if (y > bboxes[b + 3]) bboxes[b + 3] = y;
    }
  }

  return { labels, count, areas, bboxes, sumX, sumY };
}

/**
 * The last non-empty selection of one pick, stored inside its bounding box
 * @typedef {Object} TrackRef
 * @property {Uint8Array | null} mask - bbox-local 0/1, null before the first selection
 * @property {number} minX
 * @property {number} minY
 * @property {number} boxW
 * @property {number} boxH
 * @property {number} area
 * @property {number} cx - centroid x (pixels)
 * @property {number} cy - centroid y (pixels)
 */

/** @returns {TrackRef} */
function createTrackRef() {
  return { mask: null, minX: 0, minY: 0, boxW: 0, boxH: 0, area: 0, cx: 0, cy: 0 };
}

/**
 * Component under a pick, or the one owning the nearest foreground pixel
 * within PICK_SNAP_RADIUS_FRACTION of the diagonal
 * @param {Components} comps
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} pick - Fractions of the frame
 * @returns {number} Label, or 0 when nothing is close enough
 */
export function findPickedComponent(comps, width, height, pick) {
  if (comps.count === 0 || width <= 0 || height <= 0) return 0;
  const px = Math.min(width - 1, Math.max(0, Math.floor(pick.x * width)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(pick.y * height)));
  const { labels } = comps;
  if (labels[py * width + px]) return labels[py * width + px];

  const radius = Math.max(1, Math.round(PICK_SNAP_RADIUS_FRACTION * Math.hypot(width, height)));
  let best = 0;
  let bestDistSq = radius * radius + 1;
  for (let y = Math.max(0, py - radius); y <= Math.min(height - 1, py + radius); y++) {
    const dy = y - py;
    for (let x = Math.max(0, px - radius); x <= Math.min(width - 1, px + radius); x++) {
      const label = labels[y * width + x];
      if (!label) continue;
      const dx = x - px;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = label;
      }
    }
  }
  return best;
}

/**
 * Components of a frame that join a pick's selection (the default join
 * rule): IoU with the reference selection >= TRACK_JOIN_IOU, or containing
 * the reference selection's centroid.
 * @param {Components} comps
 * @param {number} width
 * @param {number} height
 * @param {TrackRef} ref
 * @returns {number[]} Labels, ascending
 */
function followSelection(comps, width, height, ref) {
  if (!ref.mask || comps.count === 0) return [];
  const { labels, areas, count } = comps;
  const overlap = new Int32Array(count + 1);
  for (let yy = 0; yy < ref.boxH; yy++) {
    const src = yy * ref.boxW;
    const dst = (ref.minY + yy) * width + ref.minX;
    for (let xx = 0; xx < ref.boxW; xx++) {
      if (!ref.mask[src + xx]) continue;
      const label = labels[dst + xx];
      if (label) overlap[label]++;
    }
  }
  const cx = Math.min(width - 1, Math.max(0, Math.round(ref.cx)));
  const cy = Math.min(height - 1, Math.max(0, Math.round(ref.cy)));
  const centroidLabel = labels[cy * width + cx];

  /** @type {number[]} */
  const joined = [];
  for (let l = 1; l <= count; l++) {
    const inter = overlap[l];
    const iou = inter / (areas[l] + ref.area - inter);
    if (iou >= TRACK_JOIN_IOU || l === centroidLabel) joined.push(l);
  }
  return joined;
}

/**
 * Make a non-empty selection the pick's new reference; an empty one keeps
 * the previous reference (a hidden character is looked for where it was
 * last seen)
 * @param {TrackRef} ref
 * @param {Components} comps
 * @param {number} width
 * @param {number[]} selected - Labels
 */
function rememberSelection(ref, comps, width, selected) {
  if (selected.length === 0) return;
  const { labels, areas, bboxes, sumX, sumY } = comps;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  let sx = 0;
  let sy = 0;
  const member = new Uint8Array(comps.count + 1);
  for (const l of selected) {
    member[l] = 1;
    minX = Math.min(minX, bboxes[4 * l]);
    minY = Math.min(minY, bboxes[4 * l + 1]);
    maxX = Math.max(maxX, bboxes[4 * l + 2]);
    maxY = Math.max(maxY, bboxes[4 * l + 3]);
    area += areas[l];
    sx += sumX[l];
    sy += sumY[l];
  }
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const mask = new Uint8Array(boxW * boxH);
  for (let yy = 0; yy < boxH; yy++) {
    const src = (minY + yy) * width + minX;
    for (let xx = 0; xx < boxW; xx++) {
      if (member[labels[src + xx]]) mask[yy * boxW + xx] = 1;
    }
  }
  Object.assign(ref, { mask, minX, minY, boxW, boxH, area, cx: sx / area, cy: sy / area });
}

/**
 * Follows picks through a clip in two passes (the incremental core of
 * trackPicks, driven frame by frame so a caller can yield between frames):
 *
 * 1. backward: trackBackward(f, comps) for f from `backwardStart` down to 0
 * 2. forward: selectForward(f, comps) for f from 0 up to the last frame,
 *    which returns the frame's final selection
 *
 * Each pick is seeded on its own frame (the component under it) and
 * followed away from it in both directions with the default join rule.
 * A pick that finds no component on its own frame (nothing under it or
 * within the snap radius, no mask there, or a frame past the clip) is
 * ignored: a keep pick that missed must not empty every frame. The backward
 * pass visits every pick's frame before the forward pass selects anything.
 * Only the chosen labels per frame are kept between the passes (labels are
 * deterministic, so the forward pass relabels the same components), plus
 * one bounding-box-sized reference mask per pick.
 *
 * Result per frame = union of the 'keep' selections (all foreground when no
 * 'keep' pick found its character) minus the 'remove' selections.
 *
 * @param {{ picks: readonly Pick[], width: number, height: number }} params
 */
export function createPickTracker({ picks, width, height }) {
  const backwardStart = picks.reduce((max, p) => Math.max(max, p.frame), -1);
  /** @type {Map<number, { keep: number[], remove: number[] }>} */
  const backward = new Map();
  let refs = picks.map(() => createTrackRef());
  let forwardStarted = false;
  /** Picks that found their component on their own frame (the others are ignored) */
  const seeded = picks.map(() => false);
  const keepsSome = () => picks.some((p, k) => p.mode === 'keep' && seeded[k]);

  /**
   * Selections of the picks active in one direction on one frame
   * @param {number} frame
   * @param {Components | null} comps
   * @param {(pick: Pick) => boolean} active
   */
  function step(frame, comps, active) {
    /** @type {{ keep: number[], remove: number[] }} */
    const chosen = { keep: [], remove: [] };
    picks.forEach((pick, k) => {
      if (!active(pick) || !comps) return;
      let selected;
      if (pick.frame === frame) {
        const label = findPickedComponent(comps, width, height, pick);
        if (label) seeded[k] = true;
        selected = label ? [label] : [];
      } else {
        selected = followSelection(comps, width, height, refs[k]);
      }
      rememberSelection(refs[k], comps, width, selected);
      chosen[pick.mode === 'remove' ? 'remove' : 'keep'].push(...selected);
    });
    return chosen;
  }

  /** Switch to the forward pass (fresh references: it tracks from the picks again) */
  function startForward() {
    if (forwardStarted) return;
    forwardStarted = true;
    refs = picks.map(() => createTrackRef());
  }

  return {
    /** Highest frame the backward pass starts at (-1: no picks, skip it) */
    backwardStart,

    /**
     * Whether a keep pick found its character (otherwise every foreground
     * pixel is kept). Final once the backward pass has visited every pick's
     * frame.
     * @returns {boolean}
     */
    get hasKeep() {
      return keepsSome();
    },

    /**
     * Backward pass step for one frame
     * @param {number} frame
     * @param {Components | null} comps - null for a frame without a mask
     */
    trackBackward(frame, comps) {
      if (forwardStarted) throw new Error('trackBackward after the forward pass started');
      backward.set(
        frame,
        step(frame, comps, (pick) => pick.frame >= frame),
      );
    },

    /**
     * Forward pass step: the frame's final selection
     * @param {number} frame
     * @param {Components} comps
     * @param {Uint8Array} [out] - Reused output (at least width * height)
     * @returns {Uint8Array} 0/1 per pixel
     */
    selectForward(frame, comps, out = new Uint8Array(width * height)) {
      startForward();
      const forward = step(frame, comps, (pick) => pick.frame <= frame);
      const before = backward.get(frame);
      backward.delete(frame);
      // 1 = kept, 2 = removed, per label
      const flags = new Uint8Array(comps.count + 1);
      for (const l of forward.keep) flags[l] |= 1;
      for (const l of forward.remove) flags[l] |= 2;
      for (const l of before?.keep ?? []) flags[l] |= 1;
      for (const l of before?.remove ?? []) flags[l] |= 2;
      const need = keepsSome() ? 1 : 0;
      const { labels } = comps;
      const size = width * height;
      for (let i = 0; i < size; i++) {
        const label = labels[i];
        const f = label ? flags[label] : 0;
        out[i] = label && (f & 1) >= need && !(f & 2) ? 1 : 0;
      }
      return out;
    },

    /**
     * Forward pass step for a frame without a mask: nothing is selected and
     * every pick keeps following its last selection
     * @param {number} frame
     */
    skipForward(frame) {
      startForward();
      backward.delete(frame);
    },
  };
}

/**
 * Per-frame selection of a clip's picks (synchronous; see createPickTracker
 * for the rule). Without picks every frame's selection is its foreground.
 *
 * @param {Object} params
 * @param {number} params.frameCount
 * @param {(frame: number) => Uint8Array | null} params.getBinary - 0/1 mask
 *   of a frame (width * height), or null when the frame has none. It is
 *   consumed before the next call, so it may return a reused buffer.
 * @param {readonly Pick[]} params.picks
 * @param {number} params.width
 * @param {number} params.height
 * @returns {(Uint8Array | null)[]} Selection per frame (null: no mask)
 */
export function trackPicks({ frameCount, getBinary, picks, width, height }) {
  const tracker = createPickTracker({ picks, width, height });
  const labels = new Int32Array(width * height);
  /** @param {number} frame */
  const components = (frame) => {
    const binary = getBinary(frame);
    return binary ? labelComponents(binary, width, height, labels) : null;
  };

  for (let f = Math.min(tracker.backwardStart, frameCount - 1); f >= 0; f--) {
    tracker.trackBackward(f, components(f));
  }

  /** @type {(Uint8Array | null)[]} */
  const result = [];
  for (let f = 0; f < frameCount; f++) {
    if (picks.length === 0) {
      const binary = getBinary(f);
      result.push(binary ? Uint8Array.from(binary) : null);
      continue;
    }
    const comps = components(f);
    if (!comps) {
      tracker.skipForward(f);
      result.push(null);
      continue;
    }
    result.push(tracker.selectForward(f, comps));
  }
  return result;
}

/**
 * For each pixel, whether the window [i - r, i + r] along one axis
 * (clipped to the mask) contains `target`
 * @param {Uint8Array} src
 * @param {Uint8Array} dst
 * @param {number} length - pixels along the axis
 * @param {number} lines - number of lines
 * @param {number} step - index distance between neighbours along the axis
 * @param {number} lineStep - index distance between lines
 * @param {number} radius
 * @param {number} target - 0 or 1
 */
function windowContains(src, dst, length, lines, step, lineStep, radius, target) {
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    let count = 0;
    for (let k = 0; k <= Math.min(radius, length - 1); k++) {
      if (src[base + k * step] === target) count++;
    }
    for (let k = 0; k < length; k++) {
      dst[base + k * step] = count > 0 ? 1 : 0;
      const add = k + radius + 1;
      if (add < length && src[base + add * step] === target) count++;
      const drop = k - radius;
      if (drop >= 0 && src[base + drop * step] === target) count--;
    }
  }
}

/**
 * Grow (radius > 0) or shrink (radius < 0) a binary mask by |radius| pixels
 * with a square window, in O(pixels) whatever the radius (separable
 * running max/min).
 *
 * Windows are clipped to the mask: pixels beyond the border count as
 * neither foreground nor background, so shrinking never eats into a
 * character where it is cut off by the frame edge. |radius| is capped at
 * the larger mask dimension; radius 0 returns a copy.
 *
 * @param {Uint8Array} binary - 0/1 per pixel
 * @param {number} width
 * @param {number} height
 * @param {number} radius - Integer pixels (rounded)
 * @param {Uint8Array} [out] - Reused output (at least width * height; must not be `binary`)
 * @returns {Uint8Array}
 */
export function morphMask(binary, width, height, radius, out = new Uint8Array(width * height)) {
  const size = width * height;
  const r = Math.min(Math.max(width, height), Math.abs(Math.round(radius) || 0));
  if (r === 0 || size === 0) {
    out.set(binary.subarray(0, size));
    return out;
  }
  const grow = radius > 0;
  // Dilate: any foreground in the window. Erode: no background in it.
  const target = grow ? 1 : 0;
  const rows = new Uint8Array(size);
  windowContains(binary, rows, width, height, 1, width, r, target);
  windowContains(rows, out, height, width, width, 1, r, 1);
  if (!grow) {
    for (let i = 0; i < size; i++) out[i] ^= 1;
  }
  return out;
}

/**
 * Bytes a packed mask of this size takes
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function packedMaskBytes(width, height) {
  return Math.ceil((width * height) / 8);
}

/**
 * Pack a binary mask to one bit per pixel
 * @param {Uint8Array} binary - 0/1 per pixel
 * @param {number} width
 * @param {number} height
 * @returns {PackedMask}
 */
export function packMask(binary, width, height) {
  const size = width * height;
  const bits = new Uint8Array(packedMaskBytes(width, height));
  // Whole bytes at once (this runs on every frame of a clip), then the tail
  const whole = size & ~7;
  let i = 0;
  for (; i < whole; i += 8) {
    bits[i >> 3] =
      (binary[i] << 7) |
      (binary[i + 1] << 6) |
      (binary[i + 2] << 5) |
      (binary[i + 3] << 4) |
      (binary[i + 4] << 3) |
      (binary[i + 5] << 2) |
      (binary[i + 6] << 1) |
      binary[i + 7];
  }
  for (; i < size; i++) {
    if (binary[i]) bits[i >> 3] |= 0x80 >> (i & 7);
  }
  return { bits, width, height };
}

/**
 * Unpack a packed mask to 0/1 per pixel
 * @param {PackedMask} packed
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function unpackMask(packed, out = new Uint8Array(packed.width * packed.height)) {
  const size = packed.width * packed.height;
  const { bits } = packed;
  for (let i = 0; i < size; i++) {
    out[i] = (bits[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return out;
}

/**
 * One pixel of a packed mask (0 outside it)
 * @param {PackedMask} packed
 * @param {number} x
 * @param {number} y
 * @returns {0 | 1}
 */
export function maskBit(packed, x, y) {
  if (x < 0 || y < 0 || x >= packed.width || y >= packed.height) return 0;
  const i = y * packed.width + x;
  return /** @type {0 | 1} */ ((packed.bits[i >> 3] >> (7 - (i & 7))) & 1);
}

/**
 * Clear the pixels of an output region that a final mask excludes: RGBA
 * becomes 0,0,0,0 (like the color key) where the mask is 0.
 *
 * The region is a rectangle of the SOURCE frame (the crop, or the whole
 * frame) whose pixels are `rgba`; the mask covers the whole source frame at
 * its own resolution. Each region pixel samples the mask pixel under its
 * center (nearest neighbour).
 *
 * @param {Uint8Array | Uint8ClampedArray} rgba - regionW * regionH * 4 bytes
 * @param {number} regionW - Pixel columns of `rgba`
 * @param {number} regionH - Pixel rows of `rgba`
 * @param {Uint8Array} finalMask - Packed bits (see PackedMask)
 * @param {number} maskW
 * @param {number} maskH
 * @param {{ x: number, y: number, width: number, height: number }} regionInSourcePx
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {number} Pixels cleared
 */
export function applyMaskToRegion(
  rgba,
  regionW,
  regionH,
  finalMask,
  maskW,
  maskH,
  regionInSourcePx,
  sourceW,
  sourceH,
) {
  if (regionW <= 0 || regionH <= 0 || maskW <= 0 || maskH <= 0 || sourceW <= 0 || sourceH <= 0) {
    return 0;
  }
  const region = regionInSourcePx;
  const scaleX = (region.width || regionW) / regionW;
  const scaleY = (region.height || regionH) / regionH;
  const cols = new Int32Array(regionW);
  for (let x = 0; x < regionW; x++) {
    const sx = region.x + (x + 0.5) * scaleX;
    cols[x] = Math.min(maskW - 1, Math.max(0, Math.floor((sx * maskW) / sourceW)));
  }

  let cleared = 0;
  for (let y = 0; y < regionH; y++) {
    const sy = region.y + (y + 0.5) * scaleY;
    const maskRow = Math.min(maskH - 1, Math.max(0, Math.floor((sy * maskH) / sourceH))) * maskW;
    let p = y * regionW * 4;
    for (let x = 0; x < regionW; x++, p += 4) {
      const i = maskRow + cols[x];
      if ((finalMask[i >> 3] >> (7 - (i & 7))) & 1) continue;
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
      rgba[p + 3] = 0;
      cleared++;
    }
  }
  return cleared;
}
