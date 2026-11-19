/**
 * Click-to-select tracking through a clip
 * @module features/ai-cutout/click-tracker
 *
 * Turns the clicks (the edits' picks: keep / remove points on frames) into
 * a mask on every frame of the selection with a promptable segmenter
 * (MobileSAM):
 *
 * 1. Anchors: every frame with clicks is decoded with its own points, the
 *    frame on screen first (its mask shows within a fraction of a second).
 *    SAM's four answers are narrowed to the whole or a part (the edits'
 *    `clickScope`, see chooseCandidate). Remove points alone say what to
 *    drop, not what to keep: a frame with only those is prompted with the
 *    box and an inside point of the mask it has now (the one the user
 *    corrected), or, without one, of the previous frame's mask once a pass
 *    reaches it (see refinePrompt).
 * 2. Tracking: from each anchor, forward to the next anchor (or the end of
 *    the selection), then backward to the previous one (or the start):
 *    each frame is prompted with the previous frame's mask box, a point
 *    deep inside it, points deep in the background it left out, and its
 *    low-res logits as `mask_input` (which holds the answer to the object's
 *    shape), and keeps the answer that overlaps the previous mask most. A backward pass stops at frames an earlier pass already did, so
 *    a frame between two anchors is done once, by whichever pass reaches it
 *    first — after a click that re-anchors a lost object, tracking fills
 *    the gap from both sides.
 * 3. Lost: a frame whose mask area jumps by more than half (or is empty)
 *    gets no mask, and the pass tries the next frames from the last frame
 *    it kept (the object may come back: it left the frame, or was hidden)
 *    until one is found again; only the first frame of each run of lost
 *    frames is reported (where a click would re-anchor it).
 * 4. Seeds (`seedOf`, see object-seeds.js): an anchor frame that has an
 *    answer from earlier prompts which these prompts extend (one more click
 *    or box, the same scope) is prompted with that answer: its grown box
 *    (stretched over the new keep points and boxes), its inside and
 *    background points except those right at a new point, the frame's own
 *    points, and its low-res logits as `mask_input`; the best-scoring
 *    answer is kept (refineAnchorPrompt). A box the earlier prompts did not
 *    have is also prompted on its own (with the keep points inside it and
 *    the frame's remove points) and joined to that answer, as boxes are
 *    without a seed: inside the answer's box it would change nothing there. A correction then refines what
 *    the frame showed instead of starting over from its own points (which
 *    answers a click beside a region with that piece alone, or the whole
 *    frame). A frame with only remove points starts from its seed's mask
 *    (not its logits) when it has no mask of these prompts. The seed only
 *    shapes the prompt: the answer is this run's, stored like any other.
 *
 * Masks of a click model depend on the clicks, not only on the frame, so a
 * run first drops the selection's masks it is about to redo (all but the
 * anchors and the frame on screen, which are redone first and would only
 * flash) and at the end drops the ones no pass reached. A run that stops
 * early (cancel, failure) drops those it had not redone yet too, unless
 * another run follows at once (`superseded`), which redoes them first.
 *
 * Frames that share pixels (imported holds, same `keyOf`) share one mask.
 * No ORT, no DOM: `prompt` does the model work, so this is unit-tested.
 */

import {
  chooseCandidate,
  interiorPoint,
  isTrackingLost,
  maskStats,
  planAnchors,
  splitAnchorPrompts,
  trackingPrompt,
} from './sam-prompts.js';

/** @typedef {import('./sam-prompts.js').SamCandidate} SamCandidate */
/** @typedef {import('./sam-prompts.js').SamPoint} SamPoint */
/** @typedef {import('./sam-prompts.js').SamBox} SamBox */

/**
 * @typedef {Object} ClickMask
 * @property {Uint8Array} data - 0..255 probability
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} TrackProgress
 * @property {number} done - Frames with a mask from this run
 * @property {number} total - Frames in the selection
 * @property {number} frame - The frame that just finished
 */

/**
 * @typedef {Object} TrackResult
 * @property {number} tracked - Frames that got a mask
 * @property {number[]} lost - Frames where tracking lost the object (sorted), each
 *   the first frame of a pass that got no mask
 * @property {number} anchors - Frames with clicks inside the selection
 */

/**
 * @typedef {Object} TrackOptions
 * @property {{ start: number, end: number }} range - Selection, inclusive
 * @property {number} currentFrame - Frame on screen (worked on first)
 * @property {{ frame: number, x: number, y: number, mode: 'keep' | 'remove' }[]} picks
 * @property {{ frame: number, x0: number, y0: number, x1: number, y1: number }[]} [boxes] - A
 *   box prompt per frame (with that frame's points); a frame with a box is
 *   an anchor like one with a keep point
 * @property {'whole' | 'part'} [scope]
 * @property {number | null} [candidate] - The user's pick among the clicked
 *   frames' answers, ordered small to large (see chooseCandidate's rank);
 *   it replaces `scope` there, and applies to boxes too
 * @property {(frame: number, candidates: SamCandidate[]) => void} [onAnswers] -
 *   The answers to the first prompt on the frame on screen (when it is an
 *   anchor decoded from its own points): what the user picks among
 * @property {number} [wholeMinScoreRatio] - Whole on a clicked frame: see
 *   chooseCandidate (default WHOLE_MIN_SCORE_RATIO)
 * @property {number} [minScoreRatio] - A tracked frame whose chosen mask scores
 *   below this fraction of the best score so far on its pass is lost too (0:
 *   off, area changes only). Catches an object that left the frame while the
 *   box prompt keeps "finding" it in the same place, which the area misses;
 *   against the best rather than the previous frame, since the score sinks
 *   over a few frames as the old mask_input fades.
 * @property {(frameIndex: number, prompt: { points: SamPoint[], box: SamBox | null, maskInput?: Float32Array | null }) => Promise<SamCandidate[]>} prompt
 * @property {(frameIndex: number) => string} keyOf - Pixel identity of a frame
 * @property {(frameIndex: number, mask: ClickMask, lowRes: Float32Array | null) => void} store -
 *   lowRes: the answer's low-res logits (for a seed of a later run), null when none
 * @property {(frameIndex: number) => void} clear - Drop a frame's mask (no-op when none)
 * @property {(frameIndex: number) => ClickMask | null} [peek] - The mask a frame has
 *   before this run, to refine a frame that has only remove points
 * @property {(frameIndex: number) => { mask: ClickMask, lowRes: Float32Array | null, boxes?: SamBox[] } | null} [seedOf] -
 *   An answer on the frame from earlier prompts that these extend (see
 *   object-seeds.js): prompts the frame when it is an anchor, never stored.
 *   boxes: the frame's boxes the earlier prompts did not have
 * @property {'off' | 'score'} [seedGuard] - 'score': an anchor prompted from
 *   its seed is also decoded without it, and the seeded answer is kept only
 *   when its predicted IoU is not lower
 * @property {() => boolean} [superseded] - On an early stop: whether another
 *   run with new clicks starts right away (the masks this run had not redone
 *   stay until that run redoes them, instead of flashing off)
 * @property {(progress: TrackProgress) => void} [onProgress]
 * @property {'resume' | 'stop'} [afterLost] - At a lost frame: try the next
 *   frames from the last frame kept ('resume', default) or end the pass
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} DoneMask
 * @property {ClickMask} mask
 * @property {number} area
 * @property {Float32Array | null} lowRes
 * @property {number | null} peak - Best predicted IoU of the pass up to this frame
 */

/**
 * Whether a tracked frame's score fell too far below the best of its pass
 * @param {number | null} peak
 * @param {number} score
 * @param {number} minRatio - 0: never
 * @returns {boolean}
 */
export function isScoreDrop(peak, score, minRatio) {
  if (!(minRatio > 0) || peak === null || !(peak > 0)) return false;
  return score < peak * minRatio;
}

/** Closest a mask's inside point may be to a remove point (frame fraction) */
const REFINE_POINT_CLEARANCE = 0.05;

/** A seeded anchor's box reaches this far past a keep point outside it (frame fraction) */
const KEEP_POINT_MARGIN = 0.02;

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Tracking cancelled', 'AbortError');
}

/**
 * Whether an anchor says where the object is (a keep point or a box), not
 * only where it is not
 * @param {{ points: SamPoint[], boxes: unknown[] }} anchor
 * @returns {boolean}
 */
function isPositive(anchor) {
  return anchor.boxes.length > 0 || anchor.points.some((p) => p.mode === 'keep');
}

/**
 * One region from the answers chosen for an anchor's prompts: the union of
 * their masks, the maximum of their low-res logits (the union, for the
 * next frame's mask_input; none unless every answer has them) and the
 * lowest score (a later frame's score drop is judged against the weakest
 * part)
 * @param {SamCandidate[]} chosen - At least one, all the same size
 * @returns {SamCandidate}
 */
export function joinCandidates(chosen) {
  if (chosen.length === 1) return chosen[0];
  const [first] = chosen;
  const data = new Uint8Array(first.data.length);
  for (const c of chosen) {
    for (let i = 0; i < data.length; i++) if (c.data[i] > data[i]) data[i] = c.data[i];
  }
  /** @type {Float32Array | null} */
  let lowRes = null;
  if (chosen.every((c) => c.lowRes && c.lowRes.length === first.lowRes?.length)) {
    lowRes = Float32Array.from(/** @type {Float32Array} */ (first.lowRes));
    for (const c of chosen) {
      const l = /** @type {Float32Array} */ (c.lowRes);
      for (let i = 0; i < lowRes.length; i++) if (l[i] > lowRes[i]) lowRes[i] = l[i];
    }
  }
  return {
    ...first,
    data,
    lowRes,
    score: Math.min(...chosen.map((c) => c.score)),
  };
}

/**
 * The prompt that refines a mask with remove points: the tracking prompt of
 * the mask (its grown box, a keep point deep inside it unless a remove point
 * is right there, background points) and the remove points
 * @param {ClickMask} base
 * @param {SamPoint[]} removes
 * @returns {{ points: SamPoint[], box: SamBox } | null} null when `base` is empty
 */
export function refinePrompt(base, removes) {
  const tracked = trackingPrompt(base.data, base.width, base.height);
  if (!tracked) return null;
  const inside = interiorPoint(base.data, base.width, base.height);
  const clear =
    inside !== null &&
    removes.every((r) => Math.hypot(r.x - inside.x, r.y - inside.y) > REFINE_POINT_CLEARANCE);
  return {
    points: [...tracked.points.filter((p) => clear || p.mode !== 'keep'), ...removes],
    box: tracked.box,
  };
}

/**
 * The prompt of an anchor frame that has a seed (an answer of earlier
 * prompts): the seed's grown box stretched over the frame's boxes and keep
 * points, its inside / background points (trackingPrompt) except those
 * within REFINE_POINT_CLEARANCE of one of the frame's points, then the
 * frame's points
 * @param {ClickMask} seed
 * @param {{ points: SamPoint[], boxes: SamBox[] }} anchor
 * @returns {{ points: SamPoint[], box: SamBox } | null} null when the seed is empty
 */
export function refineAnchorPrompt(seed, anchor) {
  const tracked = trackingPrompt(seed.data, seed.width, seed.height);
  if (!tracked) return null;
  const far = (/** @type {SamPoint} */ q) =>
    anchor.points.every((r) => Math.hypot(r.x - q.x, r.y - q.y) > REFINE_POINT_CLEARANCE);
  let [x0, y0, x1, y1] = tracked.box;
  for (const b of anchor.boxes) {
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  for (const k of anchor.points) {
    if (k.mode !== 'keep') continue;
    x0 = Math.min(x0, k.x - KEEP_POINT_MARGIN);
    y0 = Math.min(y0, k.y - KEEP_POINT_MARGIN);
    x1 = Math.max(x1, k.x + KEEP_POINT_MARGIN);
    y1 = Math.max(y1, k.y + KEEP_POINT_MARGIN);
  }
  const clamp = (/** @type {number} */ v) => Math.max(0, Math.min(1, v));
  return {
    points: [...tracked.points.filter(far), ...anchor.points],
    box: [clamp(x0), clamp(y0), clamp(x1), clamp(y1)],
  };
}

/**
 * The decoder's most confident non-empty answer (a box with points leaves
 * little ambiguity, and the answer overlapping the old mask most would be
 * the one that ignores the remove points)
 * @param {SamCandidate[]} candidates
 * @returns {SamCandidate}
 */
function bestScoring(candidates) {
  if (candidates.length === 0) throw new RangeError('No candidate masks');
  const nonEmpty = candidates.filter((c) => maskStats(c.data, c.width, c.height).area > 0);
  const pool = nonEmpty.length > 0 ? nonEmpty : candidates;
  return pool.reduce((a, b) => (b.score > a.score ? b : a));
}

/**
 * Track the clicked object through the selection.
 * @param {TrackOptions} options
 * @returns {Promise<TrackResult>}
 * @throws {DOMException} AbortError when `signal` aborts (masks stored so far
 *   stay; those from earlier clicks this run had not redone go, unless
 *   `superseded`)
 */
export async function trackClicks({
  range,
  currentFrame,
  picks,
  boxes = [],
  scope = 'whole',
  candidate = null,
  onAnswers,
  minScoreRatio = 0,
  wholeMinScoreRatio,
  prompt,
  keyOf,
  store,
  clear,
  peek,
  seedOf,
  seedGuard = 'off',
  superseded,
  onProgress,
  afterLost = 'resume',
  signal,
}) {
  throwIfAborted(signal);
  const total = range.end - range.start + 1;
  const anchors = planAnchors(picks, range, currentFrame, boxes);
  if (anchors.length === 0) return { tracked: 0, lost: [], anchors: 0 };
  const anchorFrames = new Set(anchors.map((a) => a.frame));

  // A frame with only remove points starts from the mask it has now (or,
  // without one, its seed); a frame with a keep point or a box from its
  // seed: read them all before this run stores anything
  /** @type {Map<number, { mask: ClickMask, lowRes: Float32Array | null }>} */
  const seeds = new Map();
  for (const anchor of anchors) {
    const seed = seedOf?.(anchor.frame) ?? null;
    if (isPositive(anchor)) {
      if (seed) seeds.set(anchor.frame, seed);
      continue;
    }
    const mask = peek?.(anchor.frame);
    if (mask) seeds.set(anchor.frame, { mask, lowRes: null });
    else if (seed) seeds.set(anchor.frame, seed);
  }

  // Redone below: drop now what would otherwise stay from the old clicks
  for (let f = range.start; f <= range.end; f++) {
    if (!anchorFrames.has(f) && f !== currentFrame) clear(f);
  }

  /**
   * Masks of this run, with the decoder's low-res logits of each (the next
   * frame's mask_input)
   * and the best predicted IoU of the pass up to it
   * @type {Map<number, DoneMask>}
   */
  const done = new Map();
  /** Frame key → the frame of this run holding its mask @type {Map<string, number>} */
  const doneKeys = new Map();
  /** Keys of more than one frame in the range (holds): their logits stay for the run */
  const sharedKeys = new Set();
  {
    const seen = new Set();
    for (let f = range.start; f <= range.end; f++) {
      const key = keyOf(f);
      if (seen.has(key)) sharedKeys.add(key);
      seen.add(key);
    }
  }
  /** @type {Set<number>} */
  const lost = new Set();
  /**
   * Frames with only remove points and no mask to start from: refined from
   * the previous frame when a pass reaches them
   * @type {Map<number, SamPoint[]>}
   */
  const refineOnPass = new Map();

  /**
   * @param {number} frame
   * @param {ClickMask} mask
   * @param {number} area
   * @param {Float32Array | null} [lowRes]
   * @param {number | null} [peak]
   */
  const record = (frame, mask, area, lowRes = null, peak = null) => {
    done.set(frame, { mask, area, lowRes, peak });
    doneKeys.set(keyOf(frame), frame);
    store(frame, mask, lowRes);
    onProgress?.({ done: done.size, total, frame });
  };

  /**
   * @param {SamCandidate} candidate
   * @returns {ClickMask}
   */
  const toMask = (candidate) => ({
    data: candidate.data,
    width: candidate.width,
    height: candidate.height,
  });

  /**
   * Refine a frame's mask with its remove points
   * @param {number} frame
   * @param {ClickMask} base - The mask to start from
   * @param {SamPoint[]} removes
   * @param {Float32Array | null} [maskInput] - Low-res logits of `base` (a
   *   mask of this run; none for a mask stored before it)
   * @returns {Promise<boolean>} false when `base` or the answer is empty
   */
  const refine = async (frame, base, removes, maskInput = null) => {
    const next = refinePrompt(base, removes);
    if (!next) return false;
    const candidates = await prompt(frame, { ...next, maskInput });
    throwIfAborted(signal);
    const chosen = bestScoring(candidates);
    const { area } = maskStats(chosen.data, chosen.width, chosen.height);
    if (area <= 0) return false;
    record(frame, toMask(chosen), area, chosen.lowRes ?? null, chosen.score);
    return true;
  };

  /**
   * Track one frame from its done neighbour; false when the object is lost
   * @param {number} frame
   * @param {number} from - The neighbour with a mask of this run
   * @returns {Promise<boolean>}
   */
  const step = async (frame, from) => {
    const previous = /** @type {DoneMask} */ (done.get(from));
    const removes = refineOnPass.get(frame);
    if (removes) return refine(frame, previous.mask, removes, previous.lowRes);
    const same = doneKeys.get(keyOf(frame));
    if (same !== undefined) {
      const shared = /** @type {DoneMask} */ (done.get(same));
      record(frame, shared.mask, shared.area, shared.lowRes, shared.peak);
      return true;
    }
    const { data, width, height } = previous.mask;
    const next = trackingPrompt(data, width, height);
    if (!next) return false;
    const candidates = await prompt(frame, { ...next, maskInput: previous.lowRes });
    throwIfAborted(signal);
    const chosen = chooseCandidate(candidates, { previous: data });
    const { area } = maskStats(chosen.data, chosen.width, chosen.height);
    if (isTrackingLost(previous.area, area)) return false;
    if (isScoreDrop(previous.peak, chosen.score, minScoreRatio)) return false;
    const peak = Math.max(previous.peak ?? chosen.score, chosen.score);
    record(frame, toMask(chosen), area, chosen.lowRes ?? null, peak);
    return true;
  };

  /**
   * Walk from an anchor while frames are free (a frame with only remove
   * points that had no mask to start from is refined on the way)
   * @param {number} anchor
   * @param {1 | -1} direction
   */
  const pass = async (anchor, direction) => {
    const stop = direction > 0 ? range.end : range.start;
    let from = anchor;
    let losing = false;
    for (let f = anchor + direction; direction > 0 ? f <= stop : f >= stop; f += direction) {
      if (done.has(f) || (anchorFrames.has(f) && !refineOnPass.has(f))) return;
      throwIfAborted(signal);
      if (!(await step(f, from))) {
        // Lost here: try the next frames from the last frame kept (or, with
        // the switch on Stop there, end the pass)
        if (!losing) lost.add(f);
        if (afterLost === 'stop') return;
        losing = true;
        continue;
      }
      losing = false;
      // The step read the previous frame's logits (a lost run keeps `from`
      // and retries from it, so they go only after a frame is kept); nothing reads them again
      // unless that frame starts another pass (an anchor) or shares its
      // pixels with other frames (a hold: a later step may copy its entry,
      // in either pass). Audit B7: every frame's logits stayed for the
      // whole run, 75 MiB per 300 frames
      if (!anchorFrames.has(from) && !sharedKeys.has(keyOf(from))) {
        const previous = done.get(from);
        if (previous) previous.lowRes = null;
      }
      from = f;
    }
  };

  const run = async () => {
    for (const anchor of anchors) {
      throwIfAborted(signal);
      const seed = seeds.get(anchor.frame);
      if (!isPositive(anchor)) {
        // Without the seed's logits, like a mask the frame has now: they hold
        // the old answer and pull against the new remove points
        if (!seed || !(await refine(anchor.frame, seed.mask, anchor.points))) {
          refineOnPass.set(anchor.frame, anchor.points);
        }
        continue;
      }
      /** @type {SamCandidate | null} */
      let seeded = null;
      const next = seed ? refineAnchorPrompt(seed.mask, anchor) : null;
      if (seed && next) {
        const candidates = await prompt(anchor.frame, { ...next, maskInput: seed.lowRes });
        throwIfAborted(signal);
        const best = bestScoring(candidates);
        if (maskStats(best.data, best.width, best.height).area > 0) seeded = best;
        // A new box on its own, joined: inside the seed's box it would not
        // change the prompt above, so it could not pick a part it missed
        if (seeded && seed.boxes?.length) {
          const fresh = splitAnchorPrompts({ points: anchor.points, boxes: seed.boxes }).filter(
            (p) => p.box,
          );
          const boxed = [];
          for (const p of fresh) {
            const answers = await prompt(anchor.frame, p);
            throwIfAborted(signal);
            boxed.push(chooseCandidate(answers, { scope: 'whole', wholeMinScoreRatio }));
          }
          seeded = joinCandidates([seeded, ...boxed]);
        }
        if (seeded && seedGuard !== 'score') {
          const { area } = maskStats(seeded.data, seeded.width, seeded.height);
          record(anchor.frame, toMask(seeded), area, seeded.lowRes ?? null, seeded.score);
          continue;
        }
      }
      // One prompt per box and per lone keep point, joined into one region.
      // A box marks the extent: its answer is the whole of what it holds
      // (Part would pick a piece inside it).
      /** @type {SamCandidate[]} */
      const parts = [];
      let first = true;
      for (const p of splitAnchorPrompts(anchor)) {
        const candidates = await prompt(anchor.frame, p);
        throwIfAborted(signal);
        if (first && anchor.frame === currentFrame) onAnswers?.(anchor.frame, candidates);
        first = false;
        parts.push(
          chooseCandidate(candidates, {
            scope: p.box ? 'whole' : scope,
            wholeMinScoreRatio,
            rank: candidate,
          }),
        );
      }
      const joined = joinCandidates(parts);
      // seedGuard 'score': the seeded answer only when it scores at least as well
      const chosen = seeded && seeded.score >= joined.score ? seeded : joined;
      const { area } = maskStats(chosen.data, chosen.width, chosen.height);
      record(anchor.frame, toMask(chosen), area, chosen.lowRes ?? null, chosen.score);
    }
    for (const anchor of anchors) {
      if (!done.has(anchor.frame)) continue;
      await pass(anchor.frame, 1);
      await pass(anchor.frame, -1);
    }
  };

  try {
    await run();
  } catch (error) {
    // The anchors and the frame on screen still hold masks from the old
    // clicks where this run did not get to them
    if (!superseded?.()) {
      for (const f of [...anchorFrames, currentFrame]) {
        if (f >= range.start && f <= range.end && !done.has(f)) clear(f);
      }
    }
    throw error;
  }

  for (let f = range.start; f <= range.end; f++) {
    if (!done.has(f)) clear(f);
  }
  return {
    tracked: done.size,
    lost: [...lost].filter((f) => !done.has(f)).sort((a, b) => a - b),
    anchors: anchors.length,
  };
}
