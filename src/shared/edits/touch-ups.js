/**
 * Touch-ups (mask brush) - Pure Functions
 *
 * Brush strokes refine a background removal: 'erase' removes the pixels
 * under the stroke, 'restore' keeps them (the original pixels come back).
 * They change the removal's keep/remove DECISION before any pixel is
 * cleared (see getRemovalStep in ./compose.js), which is what lets a
 * restore bring back pixels the color key or the AI mask would remove.
 *
 * Strokes live in SOURCE frame coordinates (fractions of the frame, radius
 * a fraction of its shorter side), so they stay where they were painted
 * whatever the crop or the output scale; each output pixel tests its center
 * mapped back to the source, the same mapping the AI mask uses.
 *
 * No DOM access.
 *
 * @module shared/edits/touch-ups
 */

import { createLayerId, EDIT_LIMITS, limitStrokePoints } from './model.js';

/** @typedef {import('./model.js').TouchUp} TouchUp */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * Brush radius in source pixels
 * @param {number} radius - Fraction of the source frame's shorter side
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {number}
 */
export function touchUpRadiusPx(radius, sourceW, sourceH) {
  return radius * Math.min(sourceW, sourceH);
}

/**
 * Source x interval, relative to `ax`, where the horizontal line at vertical
 * offset `v` (from `ay`) meets the capsule of radius r around the segment
 * a→a+(dx, dy): the union of the discs around both ends and the band along
 * the segment. The capsule is convex, so that union is a single interval.
 * Writes it to `out` ([lo, hi]); returns false when the line misses it.
 * @param {number} v - Row center y minus ay
 * @param {number} dx
 * @param {number} dy
 * @param {number} lenSq - dx² + dy²
 * @param {number} r
 * @param {number} rSq
 * @param {number[]} out
 * @returns {boolean}
 */
function capsuleRowSpan(v, dx, dy, lenSq, r, rSq, out) {
  let lo = Infinity;
  let hi = -Infinity;
  // Disc around a
  if (v >= -r && v <= r) {
    const h = Math.sqrt(rSq - v * v);
    lo = -h;
    hi = h;
  }
  if (lenSq > 0) {
    // Disc around b
    const w = v - dy;
    if (w >= -r && w <= r) {
      const h = Math.sqrt(rSq - w * w);
      if (dx - h < lo) lo = dx - h;
      if (dx + h > hi) hi = dx + h;
    }
    // Band: the projection t = (dx*u + dy*v) / lenSq in 0..1, and the
    // distance |dx*v - dy*u| / len at most r (u = x - ax)
    const rLen = r * Math.sqrt(lenSq);
    let bandLo = -Infinity;
    let bandHi = Infinity;
    if (dx !== 0) {
      const t0 = (-dy * v) / dx;
      const t1 = (lenSq - dy * v) / dx;
      bandLo = Math.min(t0, t1);
      bandHi = Math.max(t0, t1);
    } else if (dy * v < 0 || dy * v > lenSq) {
      bandHi = -Infinity;
    }
    if (dy !== 0) {
      const c0 = (dx * v - rLen) / dy;
      const c1 = (dx * v + rLen) / dy;
      bandLo = Math.max(bandLo, Math.min(c0, c1));
      bandHi = Math.min(bandHi, Math.max(c0, c1));
    } else if (Math.abs(dx * v) > rLen) {
      bandHi = -Infinity;
    }
    if (bandLo <= bandHi) {
      if (bandLo < lo) lo = bandLo;
      if (bandHi > hi) hi = bandHi;
    }
  }
  if (lo > hi) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

/**
 * Paint one stroke onto a decision buffer: every region pixel whose center
 * lies within the brush radius of the stroke's path gets `value`.
 *
 * Rasterized by row spans: for each segment and each region row it
 * crosses, the pixels whose centers fall inside the segment's capsule form
 * one run, found analytically and filled at once, so no pixel is
 * distance-tested (overlapping segments only rewrite runs).
 * @param {Uint8Array} decision
 * @param {number} regionW
 * @param {number} regionH
 * @param {TouchUp} stroke
 * @param {Rect} region - Region in source pixels
 * @param {number} scaleX - Source pixels per region pixel, horizontally
 * @param {number} scaleY - Source pixels per region pixel, vertically
 * @param {number} sourceW
 * @param {number} sourceH
 * @param {0 | 1} value
 */
function paintStroke(
  decision,
  regionW,
  regionH,
  stroke,
  region,
  scaleX,
  scaleY,
  sourceW,
  sourceH,
  value,
) {
  // Never thinner than one output pixel: a small brush on a scaled-down
  // output still covers the pixel it was painted on
  const r = Math.max(
    touchUpRadiusPx(stroke.radius, sourceW, sourceH),
    0.5 * Math.max(scaleX, scaleY),
  );
  const rSq = r * r;
  const pts = stroke.points;
  const segments = Math.max(1, pts.length - 1);
  const span = [0, 0];
  for (let s = 0; s < segments; s++) {
    const a = pts[s];
    const b = pts[Math.min(s + 1, pts.length - 1)];
    const ax = a.x * sourceW;
    const ay = a.y * sourceH;
    const dx = b.x * sourceW - ax;
    const dy = b.y * sourceH - ay;
    const lenSq = dx * dx + dy * dy;

    // Region rows whose centers can be within r of the segment
    const y0 = Math.max(0, Math.ceil((Math.min(ay, ay + dy) - r - region.y) / scaleY - 0.5));
    const y1 = Math.min(
      regionH - 1,
      Math.floor((Math.max(ay, ay + dy) + r - region.y) / scaleY - 0.5),
    );
    for (let y = y0; y <= y1; y++) {
      const v = region.y + (y + 0.5) * scaleY - ay;
      if (!capsuleRowSpan(v, dx, dy, lenSq, r, rSq, span)) continue;
      // Region pixels whose centers lie in ax + [lo, hi]
      const x0 = Math.max(0, Math.ceil((ax + span[0] - region.x) / scaleX - 0.5));
      const x1 = Math.min(regionW - 1, Math.floor((ax + span[1] - region.x) / scaleX - 0.5));
      if (x0 <= x1) decision.fill(value, y * regionW + x0, y * regionW + x1 + 1);
    }
  }
}

/**
 * Apply touch-up strokes to a removal decision in place, in array order
 * (a later stroke wins where strokes overlap): erase sets 1 (remove),
 * restore sets 0 (keep).
 *
 * The decision covers an output region of regionW x regionH pixels that
 * shows `regionInSourcePx` of the source frame (the crop, or the whole
 * frame; smaller than the rectangle when the output is scaled down).
 *
 * @param {Uint8Array} decision - 1 = remove, per region pixel
 * @param {number} regionW
 * @param {number} regionH
 * @param {readonly TouchUp[]} strokes - Already filtered to the frame
 * @param {Rect} regionInSourcePx
 * @param {number} sourceW
 * @param {number} sourceH
 */
export function applyTouchUpsToDecision(
  decision,
  regionW,
  regionH,
  strokes,
  regionInSourcePx,
  sourceW,
  sourceH,
) {
  if (regionW <= 0 || regionH <= 0 || sourceW <= 0 || sourceH <= 0) return;
  const region = regionInSourcePx;
  const scaleX = (region.width || regionW) / regionW;
  const scaleY = (region.height || regionH) / regionH;
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    paintStroke(
      decision,
      regionW,
      regionH,
      stroke,
      region,
      scaleX,
      scaleY,
      sourceW,
      sourceH,
      stroke.mode === 'restore' ? 0 : 1,
    );
  }
}

/**
 * A stroke path being painted (see startStrokePath)
 * @typedef {Object} StrokePath
 * @property {{ x: number, y: number }[]} points - Kept points, fractions of
 *   the source frame; never more than EDIT_LIMITS.touchUpPoints.max - 1,
 *   so the tail always fits
 * @property {{ x: number, y: number } | null} tail - The latest position
 *   when it was too close to the last kept point to be kept (null: it was
 *   kept); part of the stroke, previewed and saved
 * @property {number} minDistancePx - Spacing of kept points, source pixels
 * @property {number} sourceW
 * @property {number} sourceH
 */

/**
 * Start a stroke path at its first point. Points closer than a quarter of
 * the brush radius to the last kept point add nothing a round brush does
 * not already cover, so they are thinned out as they arrive.
 * @param {{ x: number, y: number }} point - Fractions of the source frame
 * @param {number} radius - Fraction of the source frame's shorter side
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {StrokePath}
 */
export function startStrokePath(point, radius, sourceW, sourceH) {
  return {
    points: [point],
    tail: null,
    minDistancePx: Math.max(1, touchUpRadiusPx(radius, sourceW, sourceH) / 4),
    sourceW,
    sourceH,
  };
}

/**
 * Add the next pointer position to a stroke path (in place). When the kept
 * points would pass the point limit they go through limitStrokePoints, the
 * rule normalizeEdits applies on save, and the spacing doubles so the path
 * keeps its new density; the live preview shows exactly that path, so what
 * is saved is what was painted.
 * @param {StrokePath} path
 * @param {{ x: number, y: number }} point - Fractions of the source frame
 * @returns {boolean} Whether the stroke changed (a new point, or a new tail)
 */
export function extendStrokePath(path, point) {
  const last = path.points[path.points.length - 1];
  const dx = (point.x - last.x) * path.sourceW;
  const dy = (point.y - last.y) * path.sourceH;
  if (dx * dx + dy * dy < path.minDistancePx * path.minDistancePx) {
    const changed =
      path.tail === null
        ? point.x !== last.x || point.y !== last.y
        : point.x !== path.tail.x || point.y !== path.tail.y;
    path.tail = point;
    return changed;
  }
  path.points.push(point);
  path.tail = null;
  const max = EDIT_LIMITS.touchUpPoints.max - 1;
  if (path.points.length > max) {
    path.points = limitStrokePoints(path.points, max);
    path.minDistancePx *= 2;
  }
  return true;
}

/**
 * The points of a stroke path as a stroke stores them: the kept points and
 * the tail, within EDIT_LIMITS.touchUpPoints.max (so normalizeEdits keeps
 * them as they are)
 * @param {StrokePath} path
 * @returns {{ x: number, y: number }[]} A new array
 */
export function getStrokePathPoints(path) {
  const last = path.points[path.points.length - 1];
  const { tail } = path;
  return tail && (tail.x !== last.x || tail.y !== last.y)
    ? [...path.points, tail]
    : [...path.points];
}

/**
 * Whether a point (fractions of the source frame) lies on the frame
 * @param {{ x: number, y: number }} p
 * @returns {boolean}
 */
export function isPointInFrame(p) {
  return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}

/**
 * The stroke points for a pointer move from `from` to `to` (fractions of the
 * source frame, either may lie outside it): only the part of the move over
 * the frame paints. Where the move enters the frame its entry point starts
 * a new stroke; where it leaves, its exit point ends the stroke and a null
 * marks the break. Positions outside the frame are never clamped onto its
 * edge (that would paint a band along the edge).
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @returns {({ x: number, y: number } | null)[]} Empty when the move misses the frame
 */
export function clipStrokeMove(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Liang-Barsky: the part t0..t1 of the move inside 0..1 x 0..1
  let t0 = 0;
  let t1 = 1;
  const edges = [
    [-dx, from.x],
    [dx, 1 - from.x],
    [-dy, from.y],
    [dy, 1 - from.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return [];
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return [];
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return [];
      if (r < t1) t1 = r;
    }
  }
  /** @type {({ x: number, y: number } | null)[]} */
  const out = [];
  if (t0 > 0) out.push({ x: from.x + t0 * dx, y: from.y + t0 * dy });
  if (t1 < 1) {
    out.push({ x: from.x + t1 * dx, y: from.y + t1 * dy }, null);
  } else {
    out.push(to);
  }
  return out;
}

/** Signatures per strokes array (arrays are replaced, never mutated) */
const signatures = new WeakMap();

/**
 * Cache identity of a set of strokes: equal signatures mean equal strokes.
 * Strokes are immutable once added (a new stroke gets a new id), so ids,
 * point counts and ranges identify them; memoized per array.
 * @param {readonly TouchUp[] | null | undefined} strokes
 * @returns {string}
 */
export function getTouchUpsSignature(strokes) {
  if (!strokes || strokes.length === 0) return '';
  const cached = signatures.get(strokes);
  if (cached !== undefined) return cached;
  const signature = strokes
    .map((s) => `${s.id}:${s.mode}:${s.radius}:${s.points.length}:${s.start}-${s.end}`)
    .join(',');
  signatures.set(strokes, signature);
  return signature;
}

/**
 * The strokes with one frame taken out of their ranges ("Clear on this
 * frame"): a stroke only on that frame goes, one starting or ending there
 * shrinks, and one spanning it is split in two around it (the second part
 * gets a new id and stays right after the first, so the paint order is
 * kept). Strokes not covering the frame are untouched.
 * @param {readonly TouchUp[]} strokes
 * @param {number} frameIndex - Absolute clip frame index
 * @param {() => string} [newId]
 * @returns {TouchUp[]} A new array (may be longer than the input)
 */
export function removeTouchUpsFromFrame(strokes, frameIndex, newId = createLayerId) {
  /** @type {TouchUp[]} */
  const out = [];
  for (const stroke of strokes) {
    if (stroke.start > frameIndex || stroke.end < frameIndex) {
      out.push(stroke);
    } else if (stroke.start === frameIndex && stroke.end === frameIndex) {
      // Only on this frame: gone
    } else if (stroke.start === frameIndex) {
      out.push({ ...stroke, start: frameIndex + 1 });
    } else if (stroke.end === frameIndex) {
      out.push({ ...stroke, end: frameIndex - 1 });
    } else {
      out.push({ ...stroke, end: frameIndex - 1 });
      out.push({ ...stroke, id: newId(), start: frameIndex + 1 });
    }
  }
  return out;
}
