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
 *    `clickScope`, see chooseCandidate).
 * 2. Tracking: from each anchor, forward to the next anchor (or the end of
 *    the selection), then backward to the previous one (or the start):
 *    each frame is prompted with the previous frame's mask box and a point
 *    deep inside it, and keeps the answer that overlaps the previous mask
 *    most. A backward pass stops at frames an earlier pass already did, so
 *    a frame between two anchors is done once, by whichever pass reaches it
 *    first — after a click that re-anchors a lost object, tracking fills
 *    the gap from both sides.
 * 3. Lost: a frame whose mask area jumps by more than half (or is empty)
 *    stops that pass; the frame is reported as needing a click and gets no
 *    mask.
 *
 * Masks of a click model depend on the clicks, not only on the frame, so a
 * run first drops the selection's masks it is about to redo (all but the
 * anchors and the frame on screen, which are redone first and would only
 * flash) and at the end drops the ones no pass reached.
 *
 * Frames that share pixels (imported holds, same `keyOf`) share one mask.
 * No ORT, no DOM: `prompt` does the model work, so this is unit-tested.
 */

import {
  chooseCandidate,
  isTrackingLost,
  maskStats,
  planAnchors,
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
 * @property {'whole' | 'part'} [scope]
 * @property {(frameIndex: number, prompt: { points: SamPoint[], box: SamBox | null }) => Promise<SamCandidate[]>} prompt
 * @property {(frameIndex: number) => string} keyOf - Pixel identity of a frame
 * @property {(frameIndex: number, mask: ClickMask) => void} store
 * @property {(frameIndex: number) => void} clear - Drop a frame's mask (no-op when none)
 * @property {(progress: TrackProgress) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Tracking cancelled', 'AbortError');
}

/**
 * Track the clicked object through the selection.
 * @param {TrackOptions} options
 * @returns {Promise<TrackResult>}
 * @throws {DOMException} AbortError when `signal` aborts (masks stored so far stay)
 */
export async function trackClicks({
  range,
  currentFrame,
  picks,
  scope = 'whole',
  prompt,
  keyOf,
  store,
  clear,
  onProgress,
  signal,
}) {
  throwIfAborted(signal);
  const total = range.end - range.start + 1;
  const anchors = planAnchors(picks, range, currentFrame);
  if (anchors.length === 0) return { tracked: 0, lost: [], anchors: 0 };
  const anchorFrames = new Set(anchors.map((a) => a.frame));

  // Redone below: drop now what would otherwise stay from the old clicks
  for (let f = range.start; f <= range.end; f++) {
    if (!anchorFrames.has(f) && f !== currentFrame) clear(f);
  }

  /** Masks of this run @type {Map<number, { mask: ClickMask, area: number }>} */
  const done = new Map();
  /** Frame key → the frame of this run holding its mask @type {Map<string, number>} */
  const doneKeys = new Map();
  /** @type {Set<number>} */
  const lost = new Set();

  /**
   * @param {number} frame
   * @param {ClickMask} mask
   * @param {number} area
   */
  const record = (frame, mask, area) => {
    done.set(frame, { mask, area });
    doneKeys.set(keyOf(frame), frame);
    store(frame, mask);
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

  for (const anchor of anchors) {
    throwIfAborted(signal);
    const candidates = await prompt(anchor.frame, { points: anchor.points, box: null });
    throwIfAborted(signal);
    const chosen = chooseCandidate(candidates, { scope });
    record(anchor.frame, toMask(chosen), maskStats(chosen.data, chosen.width, chosen.height).area);
  }

  /**
   * Track one frame from its done neighbour; false when the object is lost
   * @param {number} frame
   * @param {number} from - The neighbour with a mask of this run
   * @returns {Promise<boolean>}
   */
  const step = async (frame, from) => {
    const previous = /** @type {{ mask: ClickMask, area: number }} */ (done.get(from));
    const same = doneKeys.get(keyOf(frame));
    if (same !== undefined) {
      const shared = /** @type {{ mask: ClickMask, area: number }} */ (done.get(same));
      record(frame, shared.mask, shared.area);
      return true;
    }
    const { data, width, height } = previous.mask;
    const next = trackingPrompt(data, width, height);
    if (!next) return false;
    const candidates = await prompt(frame, next);
    throwIfAborted(signal);
    const chosen = chooseCandidate(candidates, { previous: data });
    const { area } = maskStats(chosen.data, chosen.width, chosen.height);
    if (isTrackingLost(previous.area, area)) return false;
    record(frame, toMask(chosen), area);
    return true;
  };

  /**
   * Walk from an anchor while frames are free
   * @param {number} anchor
   * @param {1 | -1} direction
   */
  const pass = async (anchor, direction) => {
    const stop = direction > 0 ? range.end : range.start;
    let from = anchor;
    for (let f = anchor + direction; direction > 0 ? f <= stop : f >= stop; f += direction) {
      if (anchorFrames.has(f) || done.has(f)) return;
      throwIfAborted(signal);
      if (!(await step(f, from))) {
        lost.add(f);
        return;
      }
      from = f;
    }
  };

  for (const anchor of anchors) {
    await pass(anchor.frame, 1);
    await pass(anchor.frame, -1);
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
