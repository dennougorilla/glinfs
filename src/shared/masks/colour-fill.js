/**
 * Colour fix-ups ("this is background" by colour) - Pure Functions
 *
 * A Remove fix-up in Colour scope is not tracked by a model. On every frame
 * it clears the pixels of the current mask that are 4-connected (through
 * the mask) to its points and whose colour is within the tolerance of a
 * colour sampled under those points. Each point samples a small disc on
 * the frame it was placed on, limited to the region of the colour under
 * its centre (see samplePoint); every point seeds every frame at its
 * position, so a second point placed where a panning patch has moved
 * follows it. Protect points (Alt-click) sample colours that this fix-up
 * never removes.
 *
 * Measured basis: the background-stroke prototype of the 2026-11-16
 * bake-off (RGB distance d on decoded GIF frames, a disc of radius 4 px)
 * fixed flat leftovers in 1-3 strokes with 0-0.4 % of the character eaten,
 * and failed on dithered shelves, a pillar the colour of the hair and a
 * patch that pans. The guard (see getColourGuardShares) is there for those.
 *
 * No DOM access: tested without a browser.
 *
 * @module shared/masks/colour-fill
 */

/**
 * Tolerance of a Colour fix-up: Euclidean RGB distance (0..441). The
 * default is the prototype's d = 32: it fixed every flat leftover (the
 * grass needed 4 strokes at 32 and 1 at 48) while d = 48 ate 94 % of the
 * character on the dithered shelves.
 */
export const COLOUR_TOLERANCE = /** @type {const} */ ({ min: 4, max: 96, step: 4, default: 32 });

/** Radius of the disc a point samples, in SOURCE pixels (the prototype's 4) */
export const COLOUR_SAMPLE_RADIUS_PX = 4;

/**
 * Distinct colours a point keeps (a disc of radius 4 at a 1024 mask holds
 * at most ~200 pixels): the most frequent ones
 */
export const COLOUR_SAMPLES_PER_POINT = 48;

/**
 * The guard: a frame where the fill takes more than this share of the
 * cutout it is applied to beyond what is expected (see
 * getColourGuardShares) is shown to the user. Between the prototype's
 * successes (at most 1.4 % of the character eaten at d = 32, 3.9 % at
 * d = 16) and its failures (19.6 % to 94 %).
 */
export const COLOUR_GUARD_SHARE = 0.1;

/**
 * What a point samples: the colours within this share of the tolerance (at
 * least COLOUR_TOLERANCE.min) of the one under its centre, connected to it
 * (see samplePoint). A flat leftover lies well inside it (GIF noise is a
 * few RGB steps).
 */
export const COLOUR_SAMPLE_CORE = 0.5;

/**
 * The colour distance a point samples within (see COLOUR_SAMPLE_CORE)
 * @param {number} tolerance
 * @returns {number}
 */
export function getCoreTolerance(tolerance) {
  return Math.max(COLOUR_TOLERANCE.min, tolerance * COLOUR_SAMPLE_CORE);
}

/**
 * The guard counts a removed pixel farther than this from every sampled
 * colour as a colour the points did not sample (half the default
 * tolerance: below a tolerance of 16 nothing counts)
 */
export const COLOUR_GUARD_NEAR = 16;

/**
 * Pack an RGB colour into one integer
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
export function packRgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

/**
 * Sample radius in mask pixels for a mask this wide
 * @param {number} maskWidth
 * @param {number} [sourceWidth]
 * @returns {number}
 */
export function getSampleRadius(maskWidth, sourceWidth) {
  const scale = sourceWidth && sourceWidth > 0 ? maskWidth / sourceWidth : 1;
  return Math.max(1, Math.round(COLOUR_SAMPLE_RADIUS_PX * scale));
}

/**
 * The pixel under a point
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} point - fractions 0..1 of the frame
 * @returns {number}
 */
function pointPixel(width, height, point) {
  const cx = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)));
  const cy = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)));
  return cy * width + cx;
}

/**
 * Pixel indices of the disc around a point (clipped to the frame)
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} point - fractions 0..1 of the frame
 * @param {number} radius - mask pixels
 * @returns {number[]}
 */
export function getDiscPixels(width, height, point, radius) {
  const centre = pointPixel(width, height, point);
  const cx = centre % width;
  const cy = (centre - cx) / width;
  /** @type {number[]} */
  const out = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= width || dx * dx + dy * dy > r2) continue;
      out.push(y * width + x);
    }
  }
  return out;
}

/**
 * Squared RGB distance between two pixels of a frame
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} i
 * @param {number} j
 */
function pixelDistSq(rgba, i, j) {
  const dr = rgba[i * 4] - rgba[j * 4];
  const dg = rgba[i * 4 + 1] - rgba[j * 4 + 1];
  const db = rgba[i * 4 + 2] - rgba[j * 4 + 2];
  return dr * dr + dg * dg + db * db;
}

/**
 * What a point samples: the pixels of its disc in the region of the colour
 * under its centre, and their colours (most frequent first, at most
 * COLOUR_SAMPLES_PER_POINT). The region is the disc pixels within `near`
 * of the centre's colour and 8-connected to it, plus disc pixels with at
 * least 3 of their 4 neighbours in it (the other colour of a dither). A
 * point near the subject's edge (or a protect point on a thin strand next
 * to a pillar) so never samples what lies across the edge.
 * @param {Uint8ClampedArray | Uint8Array} rgba - width * height * 4
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} point - fractions 0..1 of the frame
 * @param {number} radius - mask pixels
 * @param {number} near - Euclidean RGB distance
 * @returns {{ colours: number[], pixels: number[] }}
 */
export function samplePoint(rgba, width, height, point, radius, near) {
  const disc = getDiscPixels(width, height, point, radius);
  const centre = pointPixel(width, height, point);
  const inDisc = new Set(disc);
  const near2 = near * near;
  /** @type {Set<number>} */
  const region = new Set([centre]);
  const queue = [centre];
  while (queue.length > 0) {
    const i = /** @type {number} */ (queue.pop());
    const x = i % width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || x + dx < 0 || x + dx >= width) continue;
        const j = i + dy * width + dx;
        if (!inDisc.has(j) || region.has(j) || pixelDistSq(rgba, j, centre) > near2) continue;
        region.add(j);
        queue.push(j);
      }
    }
  }
  /** @type {number[]} */
  const pixels = [...region];
  for (const i of disc) {
    if (region.has(i)) continue;
    const x = i % width;
    let around = 0;
    if (x > 0 && region.has(i - 1)) around++;
    if (x < width - 1 && region.has(i + 1)) around++;
    if (region.has(i - width)) around++;
    if (region.has(i + width)) around++;
    if (around >= 3) pixels.push(i);
  }
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const i of pixels) {
    const c = packRgb(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const colours = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COLOUR_SAMPLES_PER_POINT)
    .map(([c]) => c);
  return { colours, pixels };
}

/**
 * Squared distance from a packed colour to the nearest of `colours`
 * @param {number} c
 * @param {number[]} colours
 * @returns {number} Infinity when there are none
 */
function nearestSq(c, colours) {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  let best = Number.POSITIVE_INFINITY;
  for (const s of colours) {
    const dr = r - ((s >> 16) & 255);
    const dg = g - ((s >> 8) & 255);
    const db = b - (s & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < best) best = d;
  }
  return best;
}

/** A colour the fill stops at */
export const COLOUR_STOP = 0;
/** A colour the fill removes, near a sampled colour (see COLOUR_GUARD_NEAR) */
export const COLOUR_REMOVE = 1;
/**
 * A colour within the tolerance of a sampled colour but protected: the
 * fill passes through it without removing it. A GIF palette often maps a
 * few pixels of the leftover onto a protected colour (one shared palette
 * entry on every frame of the generated pillar clip).
 */
export const COLOUR_PASS = 2;
/** A colour the fill removes that is not near any sampled colour (the guard counts it) */
export const COLOUR_REMOVE_FAR = 3;

/**
 * What the fill does with a colour: remove it when it is within the
 * tolerance of a sampled colour and not protected. A colour is protected
 * when it is within the tolerance of a protect colour and at least as close
 * to it as to every sampled colour, so a pillar a little darker than the
 * hair can still go while the hair stays (a colour within the tolerance of
 * both goes to the nearer one). A protected colour the samples reach is
 * passed through (COLOUR_PASS).
 * @param {number[]} samples - packed RGB
 * @param {number[]} protects - packed RGB
 * @param {number} tolerance - Euclidean RGB distance
 * @returns {(c: number) => number} COLOUR_STOP | COLOUR_REMOVE | COLOUR_REMOVE_FAR | COLOUR_PASS, memoized per colour
 */
export function createColourMatcher(samples, protects, tolerance) {
  const t2 = tolerance * tolerance;
  const near2 = COLOUR_GUARD_NEAR * COLOUR_GUARD_NEAR;
  /** @type {Map<number, number>} */
  const memo = new Map();
  return (c) => {
    let hit = memo.get(c);
    if (hit === undefined) {
      const ds = nearestSq(c, samples);
      const dp = nearestSq(c, protects);
      if (ds > t2) hit = COLOUR_STOP;
      else if (dp <= t2 && dp <= ds) hit = COLOUR_PASS;
      else hit = ds <= near2 ? COLOUR_REMOVE : COLOUR_REMOVE_FAR;
      memo.set(c, hit);
    }
    return hit;
  };
}

/**
 * The region one Colour fix-up removes on a frame: the mask pixels of a
 * removed colour, 4-connected through the mask to a seed by pixels the
 * samples reach (removed or passed)
 * @param {Uint8Array} mask - 0/1, width * height
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray | Uint8Array} rgba - the frame at the mask's size
 * @param {Iterable<number>} seeds - pixel indices
 * @param {(c: number) => number} matches - createColourMatcher
 * @param {Uint8Array} [out] - 0/1 region, cleared here
 * @param {Int32Array} [queue] - scratch, width * height
 * @returns {{ region: Uint8Array, count: number, far: number }} far: removed pixels not near a sampled colour
 */
export function fillColourRegion(
  mask,
  width,
  height,
  rgba,
  seeds,
  matches,
  out = new Uint8Array(width * height),
  queue = new Int32Array(width * height),
) {
  out.fill(0);
  // out: 1 removed, 2 looked at and stopped, 3 passed through
  let head = 0;
  let tail = 0;
  let count = 0;
  let far = 0;
  const test = (/** @type {number} */ i) => {
    if (out[i] || !mask[i]) return;
    const c = packRgb(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    const hit = matches(c);
    if (hit === COLOUR_STOP) {
      out[i] = 2;
      return;
    }
    if (hit === COLOUR_PASS) {
      out[i] = 3;
    } else {
      out[i] = 1;
      count++;
      if (hit === COLOUR_REMOVE_FAR) far++;
    }
    queue[tail++] = i;
  };
  for (const seed of seeds) test(seed);
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) test(i - 1);
    if (x < width - 1) test(i + 1);
    if (i >= width) test(i - width);
    if (i + width < width * height) test(i + width);
  }
  for (let i = 0; i < out.length; i++) if (out[i] !== 1) out[i] = 0;
  return { region: out, count, far };
}

/**
 * What the guard records of one frame: the cutout the fill was applied to
 * (pixels), what it removed, and how much of that was not near a sampled
 * colour
 * @typedef {{ mask: number, removed: number, far: number }} ColourFrameStats
 */

/**
 * The guard's share per frame, of the cutout the fill is applied to there
 * (the subject plus the leftover), the larger of:
 * - what it removes that is not near any sampled colour: a colour the
 *   points did not sample (shelf rows that run into the shirt);
 * - what it removes beyond what it removes on the reference frame (the
 *   nearest point frame with a cutout, else the median frame): the subject
 *   moving onto the leftover, a cut. The background of a shot hardly moves
 *   (87-100 % of it within 8/255 of the median in the bake-off clips), so
 *   the leftover takes about the same share on every frame.
 * Shares, not positions, so a subject that moves is still seen.
 * @param {Map<number, ColourFrameStats>} stats - per frame the fill ran on
 * @param {number[]} pointFrames - frames of the fix-up's points
 * @returns {Map<number, number>} frame -> share 0..1
 */
export function getColourGuardShares(stats, pointFrames) {
  /** @type {Map<number, number>} */
  const shares = new Map();
  /** @type {Map<number, number>} */
  const removedShare = new Map();
  for (const [f, s] of stats) if (s.mask > 0) removedShare.set(f, s.removed / s.mask);
  if (removedShare.size === 0) return shares;
  const refs = [...new Set(pointFrames)].filter((f) => removedShare.has(f));
  const sorted = [...removedShare.values()].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  for (const [f, s] of stats) {
    const share = removedShare.get(f);
    if (share === undefined) continue;
    let reference = median;
    if (refs.length > 0) {
      let ref = refs[0];
      for (const r of refs) if (Math.abs(r - f) < Math.abs(ref - f)) ref = r;
      reference = /** @type {number} */ (removedShare.get(ref));
    }
    shares.set(f, Math.max(s.far / s.mask, share - reference, 0));
  }
  return shares;
}
