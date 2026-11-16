/**
 * Clean-up suggestions - Pure Functions
 *
 * One pass over a build's final masks finds the usual mistakes of an AI
 * cutout and words them as one-tap fixes (the Background panel's chips):
 *
 * - specks: small separate pieces (every one smaller than
 *   SPECK_MAX_FRAME_FRACTION of the frame and SPECK_MAX_MAIN_FRACTION of the
 *   character) → set `cleanup.minIslandArea` just above the largest
 * - holes: background enclosed by the cutout (not touching the border),
 *   smaller than HOLE_MAX_FRAME_FRACTION, inside the character's box →
 *   set `cleanup.maxHoleArea` to the largest
 * - blobs: a piece that flickers (on fewer than FLICKER_MAX_PRESENCE of the
 *   frames of its span with at least FLICKER_MIN_TOGGLES on/off changes,
 *   or there for at most FLICKER_MAX_FRAMES frames) → a remove pick on it
 * - shrink: the character's area dips below SHRINK_RATIO of its median for
 *   at most SHRINK_MAX_FRAMES frames → go there (nothing to apply)
 *
 * Pieces are followed from frame to frame with the pick tracking's join
 * rule (IoU >= TRACK_JOIN_IOU or containing the last centroid). Frames are
 * counted once per run of identical frames (holds of limited animation
 * share a key), so a held frame never reads as flicker.
 *
 * No DOM access: tested without a browser. Sliced and abortable like a
 * final-mask build.
 *
 * @module shared/masks/cleanup-suggestions
 */

import {
  createFrameBinarySource,
  createPreEdgeMaskSource,
  defaultNow,
  defaultYieldToMain,
} from './final-masks.js';
import { findPickedComponent, labelComponents, TRACK_JOIN_IOU } from './mask-ops.js';

/** Specks: at most this fraction of the frame */
export const SPECK_MAX_FRAME_FRACTION = 0.002;
/** Specks: at most this fraction of the character (the largest piece) */
export const SPECK_MAX_MAIN_FRACTION = 0.05;
/** Holes: at most this fraction of the frame */
export const HOLE_MAX_FRAME_FRACTION = 0.005;
/** Flicker: present on fewer than this fraction of the frames of its span */
export const FLICKER_MAX_PRESENCE = 0.6;
/** Flicker: with at least this many on/off changes */
export const FLICKER_MIN_TOGGLES = 3;
/** Flicker: or there for at most this many frames (of a longer clip) */
export const FLICKER_MAX_FRAMES = 3;
/** Shrink: the character's area below this fraction of its median */
export const SHRINK_RATIO = 0.5;
/** Shrink: for at most this many frames */
export const SHRINK_MAX_FRAMES = 5;
/** Chips shown at most */
export const MAX_SUGGESTIONS = 4;
/** Flicker chips at most */
const MAX_BLOB_SUGGESTIONS = 2;
/** Frames a piece may be missing and still be the same piece */
const TRACK_MAX_GAP = 5;

/**
 * @typedef {{ kind: 'specks', count: number, minIslandArea: number }
 *   | { kind: 'holes', count: number, maxHoleArea: number }
 *   | { kind: 'blob', frames: number, where: string, pick: { frame: number, x: number, y: number } }
 *   | { kind: 'shrink', frames: number, frame: number }} CleanupSuggestion
 *   Areas are fractions of the frame; specks' and holes' count is the most
 *   on one frame (what a viewer sees); a blob's pick is a remove pick
 *   (x, y fractions of the frame); shrink's frame is the first one
 */

/**
 * @typedef {Object} SuggestOptions
 * @property {number} frameCount
 * @property {(frameIndex: number) => { data: Uint8Array, width: number, height: number } | null} getBinary
 *   0/1 final mask of a frame (null: none); consumed before the next call
 * @property {(frameIndex: number) => string} [keyOf] - Pixel identity of a
 *   frame (consecutive frames with one key count once)
 * @property {(frameIndex: number) => void} [visit] - Called for every frame
 *   in order, held ones included, inside the time slices, before getBinary
 *   (a source that must see each frame advances here)
 * @property {AbortSignal} [signal]
 * @property {number} [sliceMs]
 * @property {() => number} [now]
 * @property {() => Promise<void>} [yieldToMain]
 */

/**
 * A piece followed through the clip
 * @typedef {Object} Track
 * @property {number} firstStep - Unique-frame step of its first appearance
 * @property {number} lastStep
 * @property {number} steps - Unique frames it is on
 * @property {number} frames - Clip frames it is on (holds counted)
 * @property {number} gaps - Times it went missing and came back
 * @property {number} maxArea - Pixels
 * @property {number} maxFrame - Clip frame of maxArea
 * @property {number} pickX - A pixel of the piece near its centroid on maxFrame
 * @property {number} pickY
 * @property {boolean} main - It was the largest piece of some frame
 * @property {Uint8Array} mask - Last shape, bbox-local
 * @property {number} minX
 * @property {number} minY
 * @property {number} boxW
 * @property {number} boxH
 * @property {number} area - Last area
 * @property {number} cx - Last centroid
 * @property {number} cy
 */

/**
 * Follows the pieces of a sequence of labelled frames
 */
class Tracker {
  /** @param {number} width */
  constructor(width) {
    this.width = width;
    /** @type {Track[]} */
    this.tracks = [];
  }

  /**
   * Link one frame's pieces to the tracks
   * @param {number} step - Unique-frame index
   * @param {number} frame - Clip frame
   * @param {number} weight - Clip frames this unique frame stands for
   * @param {import('./mask-ops.js').Components} comps
   * @param {(label: number) => boolean} wanted - Pieces to follow
   * @param {number} mainLabel - The largest piece (0: none)
   */
  add(step, frame, weight, comps, wanted, mainLabel) {
    const { width } = this;
    const { labels, areas, count } = comps;
    /** @type {{ track: Track, label: number, score: number }[]} */
    const pairs = [];
    for (const track of this.tracks) {
      if (step - track.lastStep > TRACK_MAX_GAP) continue;
      /** @type {Map<number, number>} */
      const overlap = new Map();
      for (let yy = 0; yy < track.boxH; yy++) {
        const src = yy * track.boxW;
        const dst = (track.minY + yy) * width + track.minX;
        for (let xx = 0; xx < track.boxW; xx++) {
          if (!track.mask[src + xx]) continue;
          const label = labels[dst + xx];
          if (label && wanted(label)) overlap.set(label, (overlap.get(label) ?? 0) + 1);
        }
      }
      const centroid = labels[Math.round(track.cy) * width + Math.round(track.cx)];
      if (centroid && wanted(centroid) && !overlap.has(centroid)) overlap.set(centroid, 0);
      for (const [label, inter] of overlap) {
        const iou = inter / (areas[label] + track.area - inter);
        if (iou >= TRACK_JOIN_IOU || label === centroid) {
          pairs.push({ track, label, score: iou });
        }
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    /** @type {Map<number, Track>} */
    const linked = new Map();
    const taken = new Set();
    for (const { track, label } of pairs) {
      if (linked.has(label) || taken.has(track)) continue;
      linked.set(label, track);
      taken.add(track);
    }
    for (let l = 1; l <= count; l++) {
      if (!wanted(l)) continue;
      let track = linked.get(l);
      if (!track) {
        track = /** @type {Track} */ ({
          firstStep: step,
          lastStep: step,
          steps: 0,
          frames: 0,
          gaps: 0,
          maxArea: 0,
          main: false,
        });
        this.tracks.push(track);
      } else if (step - track.lastStep > 1) {
        track.gaps++;
      }
      track.lastStep = step;
      track.steps++;
      track.frames += weight;
      if (l === mainLabel) track.main = true;
      remember(track, comps, l, width);
      if (areas[l] > track.maxArea) {
        track.maxArea = areas[l];
        track.maxFrame = frame;
        const [px, py] = nearestPixel(comps, l, width, track.cx, track.cy);
        track.pickX = px;
        track.pickY = py;
      }
    }
  }
}

/**
 * Store a piece as a track's last shape
 * @param {Track} track
 * @param {import('./mask-ops.js').Components} comps
 * @param {number} label
 * @param {number} width
 */
function remember(track, comps, label, width) {
  const { labels, areas, bboxes, sumX, sumY } = comps;
  const b = 4 * label;
  const minX = bboxes[b];
  const minY = bboxes[b + 1];
  const boxW = bboxes[b + 2] - minX + 1;
  const boxH = bboxes[b + 3] - minY + 1;
  const mask = new Uint8Array(boxW * boxH);
  for (let yy = 0; yy < boxH; yy++) {
    const src = (minY + yy) * width + minX;
    for (let xx = 0; xx < boxW; xx++) if (labels[src + xx] === label) mask[yy * boxW + xx] = 1;
  }
  Object.assign(track, {
    mask,
    minX,
    minY,
    boxW,
    boxH,
    area: areas[label],
    cx: sumX[label] / areas[label],
    cy: sumY[label] / areas[label],
  });
}

/**
 * The pixel of a piece closest to a point (a pick there selects the piece
 * even when its centroid falls outside it)
 * @param {import('./mask-ops.js').Components} comps
 * @param {number} label
 * @param {number} width
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]}
 */
function nearestPixel(comps, label, width, x, y) {
  const b = 4 * label;
  let best = [comps.bboxes[b], comps.bboxes[b + 1]];
  let bestD = Number.POSITIVE_INFINITY;
  for (let yy = comps.bboxes[b + 1]; yy <= comps.bboxes[b + 3]; yy++) {
    for (let xx = comps.bboxes[b]; xx <= comps.bboxes[b + 2]; xx++) {
      if (comps.labels[yy * width + xx] !== label) continue;
      const d = (xx - x) ** 2 + (yy - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [xx, yy];
      }
    }
  }
  return /** @type {[number, number]} */ (best);
}

/**
 * Where a point is, in words ("top-left", "center", …)
 * @param {number} x - Fraction of the frame
 * @param {number} y
 * @returns {string}
 */
export function describePlace(x, y) {
  const col = x < 1 / 3 ? 'left' : x < 2 / 3 ? '' : 'right';
  const row = y < 1 / 3 ? 'top' : y < 2 / 3 ? '' : 'bottom';
  if (!row && !col) return 'center';
  return row && col ? `${row}-${col}` : row || col;
}

/**
 * Round a fraction up (so a threshold set from it still covers the value)
 * @param {number} value
 * @returns {number}
 */
function ceilFraction(value) {
  return Math.ceil(value * 1e6) / 1e6;
}

/**
 * The median of numbers (0 for none)
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Find the clean-up suggestions of a clip's final masks
 * @param {SuggestOptions} options
 * @returns {Promise<CleanupSuggestion[]>} At most MAX_SUGGESTIONS, in the
 *   order specks, holes, blobs (largest first), shrink
 * @throws {DOMException} AbortError when cancelled
 */
export async function findCleanupSuggestions(options) {
  const {
    frameCount,
    getBinary,
    visit,
    keyOf = (f) => String(f),
    signal,
    sliceMs = 30,
    now = defaultNow,
    yieldToMain = defaultYieldToMain,
  } = options;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Suggestions cancelled', 'AbortError');
  };
  throwIfAborted();

  /** @type {Tracker | null} */
  let pieces = null;
  /** @type {Tracker | null} */
  let holes = null;
  /** @type {Int32Array | null} */
  let labels = null;
  /** @type {Int32Array | null} */
  let holeLabels = null;
  /** @type {Uint8Array | null} */
  let inverse = null;
  let width = 0;
  let height = 0;
  let maxHole = 0;
  /** Per frame: the areas of its pieces besides the character (specks counted at the end) */
  /** @type {number[][]} */
  const sidePieces = [];
  /** The most holes on one frame */
  let holesPerFrame = 0;
  /** Largest piece per unique frame @type {{ step: number, frame: number, weight: number, area: number }[]} */
  const mains = [];
  let step = -1;
  let lastKey = /** @type {string | null} */ (null);
  let sliceStart = now();

  for (let f = 0; f < frameCount; f++) {
    // Every frame, held and missing ones too, counts against the slice
    if (now() - sliceStart >= sliceMs) {
      await yieldToMain();
      sliceStart = now();
    }
    throwIfAborted();
    visit?.(f);
    const key = keyOf(f);
    if (key === lastKey) {
      // A hold: the same pixels as the frame before
      mains[mains.length - 1].weight++;
      for (const track of [...(pieces?.tracks ?? []), ...(holes?.tracks ?? [])]) {
        if (track.lastStep === step) track.frames++;
      }
      continue;
    }
    lastKey = null;
    const bin = getBinary(f);
    if (!bin) continue;
    if (!labels) {
      ({ width, height } = bin);
      labels = new Int32Array(width * height);
      holeLabels = new Int32Array(width * height);
      inverse = new Uint8Array(width * height);
      pieces = new Tracker(width);
      holes = new Tracker(width);
    }
    if (bin.width !== width || bin.height !== height) continue;
    lastKey = key;
    step++;
    const comps = labelComponents(bin.data, width, height, labels);
    let main = 0;
    for (let l = 1; l <= comps.count; l++)
      if (!main || comps.areas[l] > comps.areas[main]) main = l;
    mains.push({ step, frame: f, weight: 1, area: main ? comps.areas[main] : 0 });
    /** @type {Tracker} */ (pieces).add(step, f, 1, comps, () => true, main);
    const side = [];
    for (let l = 1; l <= comps.count; l++) if (l !== main) side.push(comps.areas[l]);
    sidePieces.push(side);

    // Holes: background pieces off the border, small, inside the character's box
    const inv = /** @type {Uint8Array} */ (inverse);
    for (let i = 0; i < inv.length; i++) inv[i] = bin.data[i] ? 0 : 1;
    const back = labelComponents(inv, width, height, /** @type {Int32Array} */ (holeLabels));
    const mb = 4 * main;
    const holeLimit = HOLE_MAX_FRAME_FRACTION * width * height;
    /** @param {number} l */
    const isHole = (l) => {
      const b = 4 * l;
      const [x0, y0, x1, y1] = [
        back.bboxes[b],
        back.bboxes[b + 1],
        back.bboxes[b + 2],
        back.bboxes[b + 3],
      ];
      if (x0 === 0 || y0 === 0 || x1 === width - 1 || y1 === height - 1) return false;
      if (back.areas[l] > holeLimit || !main) return false;
      return (
        x0 >= comps.bboxes[mb] &&
        y0 >= comps.bboxes[mb + 1] &&
        x1 <= comps.bboxes[mb + 2] &&
        y1 <= comps.bboxes[mb + 3]
      );
    };
    let frameHoles = 0;
    for (let l = 1; l <= back.count; l++) {
      if (!isHole(l)) continue;
      frameHoles++;
      maxHole = Math.max(maxHole, back.areas[l]);
    }
    holesPerFrame = Math.max(holesPerFrame, frameHoles);
    /** @type {Tracker} */ (holes).add(step, f, 1, back, isHole, 0);
  }
  throwIfAborted();
  if (!pieces || !holes) return [];

  const size = width * height;
  const mainMedian = median(mains.map((m) => m.area));
  const steps = step + 1;

  /** @type {CleanupSuggestion[]} */
  const out = [];

  // Specks
  const speckLimit = Math.min(
    SPECK_MAX_FRAME_FRACTION * size,
    SPECK_MAX_MAIN_FRACTION * mainMedian,
  );
  const specks = pieces.tracks.filter((t) => !t.main && t.maxArea < speckLimit);
  if (specks.length > 0) {
    const largest = Math.max(...specks.map((t) => t.maxArea));
    // The count a viewer sees: the most on one frame (a speck that moves
    // or flickers is not linked frame to frame, so tracks overcount)
    const perFrame = Math.max(
      1,
      ...sidePieces.map((areas) => areas.filter((a) => a <= largest).length),
    );
    out.push({
      kind: 'specks',
      count: perFrame,
      minIslandArea: ceilFraction((largest + 1) / size),
    });
  }

  // Holes
  if (holes.tracks.length > 0) {
    out.push({
      kind: 'holes',
      count: Math.max(1, holesPerFrame),
      maxHoleArea: ceilFraction(maxHole / size),
    });
  }

  // Flickering blobs (not the character, not specks), largest first
  if (steps > FLICKER_MAX_FRAMES) {
    const blobs = pieces.tracks
      .filter((t) => !t.main && t.maxArea >= speckLimit)
      .filter((t) => {
        const span = t.lastStep - t.firstStep + 1;
        const flickers = t.steps / span < FLICKER_MAX_PRESENCE && 2 * t.gaps >= FLICKER_MIN_TOGGLES;
        return flickers || t.steps <= FLICKER_MAX_FRAMES;
      })
      .sort((a, b) => b.maxArea - a.maxArea)
      .slice(0, MAX_BLOB_SUGGESTIONS);
    for (const t of blobs) {
      const x = (t.pickX + 0.5) / width;
      const y = (t.pickY + 0.5) / height;
      out.push({
        kind: 'blob',
        frames: t.frames,
        where: describePlace(x, y),
        pick: { frame: t.maxFrame, x, y },
      });
    }
  }

  // The character shrinks for a few frames (between frames where it does not)
  if (mainMedian > 0) {
    const low = mains.map((m) => m.area < SHRINK_RATIO * mainMedian);
    let frames = 0;
    let first = -1;
    for (let i = 0; i < mains.length; ) {
      if (!low[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < mains.length && low[j]) j++;
      if (i > 0 && j < mains.length && j - i <= SHRINK_MAX_FRAMES) {
        if (first < 0) first = mains[i].frame;
        for (let k = i; k < j; k++) frames += mains[k].weight;
      }
      i = j;
    }
    if (frames > 0) out.push({ kind: 'shrink', frames, frame: first });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

/**
 * The clean-up suggestions of a clip, measured where they act: on each
 * frame's mask after the picks and the clean-up already applied, before
 * Fit's edge and the tracked objects (createPreEdgeMaskSource). A
 * threshold measured there does on the build what the chip says, and a
 * blob found there is a piece the pick tracking can select alone. A blob
 * whose pick would select the frame's largest piece on the mask the picks
 * read is dropped all the same.
 * @param {{ frameCount: number, getProb: (frameIndex: number) => import('./final-masks.js').ProbMask | null, ai: import('../edits/model.js').AiCutout, keyOf?: (frameIndex: number) => string, signal?: AbortSignal, sliceMs?: number, now?: () => number, yieldToMain?: () => Promise<void> }} options
 * @returns {Promise<CleanupSuggestion[]>}
 * @throws {DOMException} AbortError when cancelled
 */
export async function suggestCleanups(options) {
  const { frameCount, getProb, ai, keyOf, signal, sliceMs, now, yieldToMain } = options;
  const source = await createPreEdgeMaskSource({
    frameCount,
    getProb,
    ai,
    signal,
    sliceMs,
    now,
    yieldToMain,
  });
  if (!source) return [];
  const { width, height } = source;
  // The pick tracking must see every frame in order, held ones too: one
  // frame per visit, inside the pass's time slices
  /** @type {Uint8Array | null} */
  let mask = null;
  const suggestions = await findCleanupSuggestions({
    frameCount,
    visit: (f) => {
      mask = source.maskAt(f);
    },
    getBinary: () => (mask ? { data: mask, width, height } : null),
    keyOf,
    signal,
    sliceMs,
    now,
    yieldToMain,
  });
  const picksRead = createFrameBinarySource({ frameCount, getProb, ai });
  return suggestions.filter((s) => {
    if (s.kind !== 'blob' || !picksRead) return true;
    const bin = picksRead.binaryAt(s.pick.frame);
    if (!bin) return false;
    const comps = labelComponents(bin, width, height);
    const picked = findPickedComponent(comps, width, height, s.pick);
    let largest = 0;
    for (let l = 1; l <= comps.count; l++) {
      if (!largest || comps.areas[l] > comps.areas[largest]) largest = l;
    }
    return picked !== 0 && picked !== largest;
  });
}
