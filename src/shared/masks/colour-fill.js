/**
 * Colour fix-ups ("this is background" by colour) - Pure Functions
 *
 * A Remove fix-up in Colour scope is not tracked by a model. On every frame
 * it clears the pixels of the current mask that are 4-connected (through
 * the mask) to its points and whose colour is within the tolerance of a
 * colour sampled under those points. Each point samples a small disc on
 * the frame it was placed on; every point seeds every frame at its
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
 * The guard: a frame where the fix-up removes more than this share of what
 * it leaves standing on its reference frame (see getColourGuardShares) is
 * shown to the user. Between the prototype's successes (at most 1.4 % of
 * the character eaten at d = 32, 3.9 % at d = 16) and its failures (19.6 %
 * to 94 %), with room for a character that moves a few pixels.
 */
export const COLOUR_GUARD_SHARE = 0.1;

/**
 * The guard's reference: the fill at this share of the tolerance (at least
 * COLOUR_TOLERANCE.min). A flat leftover is taken whole well inside the
 * tolerance (GIF noise is a few RGB steps), so what only the full
 * tolerance reaches is a colour the points did not sample.
 */
export const COLOUR_GUARD_CORE = 0.5;

/**
 * Tolerance of the guard's reference fill
 * @param {number} tolerance
 * @returns {number}
 */
export function getCoreTolerance(tolerance) {
  return Math.max(COLOUR_TOLERANCE.min, tolerance * COLOUR_GUARD_CORE);
}

/** Cell size (mask pixels) of the guard's coarse grids */
export const COLOUR_GUARD_CELL = 4;

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
 * Pixel indices of the disc around a point (clipped to the frame)
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} point - fractions 0..1 of the frame
 * @param {number} radius - mask pixels
 * @returns {number[]}
 */
export function getDiscPixels(width, height, point, radius) {
  const cx = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)));
  const cy = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)));
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
 * The colours under a disc: its distinct colours, most frequent first, at
 * most COLOUR_SAMPLES_PER_POINT
 * @param {Uint8ClampedArray | Uint8Array} rgba - width * height * 4
 * @param {number[]} disc - pixel indices (getDiscPixels)
 * @returns {number[]} packed RGB
 */
export function sampleColours(rgba, disc) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const i of disc) {
    const c = packRgb(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COLOUR_SAMPLES_PER_POINT)
    .map(([c]) => c);
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
/** A colour the fill removes */
export const COLOUR_REMOVE = 1;
/**
 * A colour within the tolerance of a sampled colour but protected: the
 * fill passes through it without removing it. A GIF palette often maps a
 * few pixels of the leftover onto a protected colour (one shared palette
 * entry on every frame of the generated pillar clip); stopping there left
 * whole frames of the pillar.
 */
export const COLOUR_PASS = 2;

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
 * @returns {(c: number) => number} COLOUR_STOP | COLOUR_REMOVE | COLOUR_PASS, memoized per colour
 */
export function createColourMatcher(samples, protects, tolerance) {
  const t2 = tolerance * tolerance;
  /** @type {Map<number, number>} */
  const memo = new Map();
  return (c) => {
    let hit = memo.get(c);
    if (hit === undefined) {
      const ds = nearestSq(c, samples);
      const dp = nearestSq(c, protects);
      if (ds > t2) hit = COLOUR_STOP;
      else hit = dp <= t2 && dp <= ds ? COLOUR_PASS : COLOUR_REMOVE;
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
 * @returns {{ region: Uint8Array, count: number }}
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
  const test = (/** @type {number} */ i) => {
    if (out[i] || !mask[i]) return;
    const c = packRgb(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    const hit = matches(c);
    if (hit === COLOUR_STOP) {
      out[i] = 2;
      return;
    }
    out[i] = hit === COLOUR_REMOVE ? 1 : 3;
    if (hit === COLOUR_REMOVE) count++;
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
  return { region: out, count };
}

/** Set bits per byte value */
const POPCOUNT = new Uint8Array(256).map((_, v) => {
  let n = 0;
  for (let b = v; b; b >>= 1) n += b & 1;
  return n;
});

/**
 * Coarse grid of a 0/1 mask, packed 8 cells per byte: a cell is set when at
 * least half of its pixels are
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} [cell]
 * @returns {Uint8Array} ceil(cells / 8) bytes, cells = ceil(width / cell) * ceil(height / cell)
 */
export function coarseGrid(mask, width, height, cell = COLOUR_GUARD_CELL) {
  const cw = Math.ceil(width / cell);
  const ch = Math.ceil(height / cell);
  const counts = new Uint16Array(cw * ch);
  for (let y = 0; y < height; y++) {
    const row = ((y / cell) | 0) * cw;
    const o = y * width;
    for (let x = 0; x < width; x++) if (mask[o + x]) counts[row + ((x / cell) | 0)]++;
  }
  const out = new Uint8Array(Math.ceil((cw * ch) / 8));
  for (let cy = 0; cy < ch; cy++) {
    const h = Math.min(cell, height - cy * cell);
    for (let cx = 0; cx < cw; cx++) {
      const w = Math.min(cell, width - cx * cell);
      const i = cy * cw + cx;
      if (counts[i] * 2 >= w * h) out[i >> 3] |= 1 << (i & 7);
    }
  }
  return out;
}

/**
 * The guard's share per frame: how much of what the fix-up leaves standing
 * on its reference frame (the frame of the nearest of its points, which
 * the user looked at when placing it) it removes on this frame. The
 * background of a shot hardly moves (87-100 % of the background within
 * 8/255 of the median in the bake-off clips) and neither do the
 * characters, so what a fill takes there beyond its own frame is the
 * character; a leftover that is bigger on some frame does not count.
 * @param {Map<number, Uint8Array>} removed - frame -> coarseGrid of the removed region
 * @param {Map<number, Uint8Array>} kept - point frame -> coarseGrid of the mask left after the fix-up
 * @param {number[]} pointFrames - frames of the fix-up's points
 * @returns {Map<number, number>} frame -> share 0..1
 */
export function getColourGuardShares(removed, kept, pointFrames) {
  /** @type {Map<number, number>} */
  const shares = new Map();
  const refs = [...new Set(pointFrames)].filter((f) => kept.has(f)).sort((a, b) => a - b);
  if (refs.length === 0) return shares;
  for (const [frame, grid] of removed) {
    let ref = refs[0];
    for (const r of refs) if (Math.abs(r - frame) < Math.abs(ref - frame)) ref = r;
    const base = /** @type {Uint8Array} */ (kept.get(ref));
    let total = 0;
    let hit = 0;
    for (let i = 0; i < base.length; i++) {
      total += POPCOUNT[base[i]];
      hit += POPCOUNT[base[i] & grid[i]];
    }
    shares.set(frame, total > 0 ? hit / total : 0);
  }
  return shares;
}
