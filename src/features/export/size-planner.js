/**
 * Target file size: the quality ladder and the planner that walks it.
 *
 * A target size trades quality for bytes in a fixed order of preference:
 * first fewer colors (256 → 128 → 64 → 32), then fewer frames (frame skip
 * 1 → 2 → 3), then a smaller output (scale 100 → 75 → 50 → 33 %). Each rung
 * of the ladder is capped by what the user already chose, so a target never
 * exports more colors, more frames or a larger GIF than the settings say.
 *
 * The planner is pure: the estimator (encode a small sample, extrapolate)
 * and the encoder are injected, so the walk is unit-tested with fakes and
 * the dialog supplies the real ones.
 *
 * @module features/export/size-planner
 */

/** Bytes per MB as the dialog shows sizes (formatBytes uses 1024) */
export const BYTES_PER_MB = 1024 * 1024;

/** A rung fits when its estimate is at most this share of the target */
export const SAFETY_MARGIN = 0.9;

/** Re-encodes one rung further down when a real GIF is still too big */
export const MAX_RETRIES = 2;

/**
 * The ladder before capping, in order of preference
 * @type {ReadonlyArray<SizeRung>}
 */
export const SIZE_LADDER = Object.freeze([
  { maxColors: 256, frameSkip: 1, scale: 1 },
  { maxColors: 128, frameSkip: 1, scale: 1 },
  { maxColors: 64, frameSkip: 1, scale: 1 },
  { maxColors: 32, frameSkip: 1, scale: 1 },
  { maxColors: 32, frameSkip: 2, scale: 1 },
  { maxColors: 32, frameSkip: 3, scale: 1 },
  { maxColors: 32, frameSkip: 3, scale: 0.75 },
  { maxColors: 32, frameSkip: 3, scale: 0.5 },
  { maxColors: 32, frameSkip: 3, scale: 1 / 3 },
]);

/**
 * @typedef {Object} SizeRung
 * @property {number} maxColors - Palette size cap
 * @property {number} frameSkip - Keep every Nth frame
 * @property {number} scale - Output scale
 */

/**
 * The ladder for one export: every rung capped by the user's own settings
 * (colors never above theirs, frame skip never below theirs, scale never
 * above theirs), with rungs that end up identical removed.
 * @param {SizeRung} base - The user's settings as a rung
 * @param {ReadonlyArray<SizeRung>} [ladder=SIZE_LADDER]
 * @returns {SizeRung[]} At least one rung; the first is the user's settings
 *   capped by the ladder's first rung
 */
export function buildSizeLadder(base, ladder = SIZE_LADDER) {
  /** @type {SizeRung[]} */
  const rungs = [];
  for (const rung of ladder) {
    const capped = {
      maxColors: Math.min(base.maxColors, rung.maxColors),
      frameSkip: Math.max(base.frameSkip, rung.frameSkip),
      scale: Math.min(base.scale, rung.scale),
    };
    const last = rungs.at(-1);
    if (
      last &&
      last.maxColors === capped.maxColors &&
      last.frameSkip === capped.frameSkip &&
      last.scale === capped.scale
    ) {
      continue;
    }
    rungs.push(capped);
  }
  return rungs;
}

/**
 * Every frame skip the ladder can use (for preparing AI masks up front:
 * skip 3 exports frames that skip 2 never touches)
 * @param {SizeRung[]} rungs
 * @returns {number[]} Distinct, ascending
 */
export function getLadderFrameSkips(rungs) {
  return [...new Set(rungs.map((rung) => rung.frameSkip))].sort((a, b) => a - b);
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Encoding cancelled', 'AbortError');
  }
}

/**
 * @typedef {Object} PlanStep
 * @property {'estimate'} phase
 * @property {number} index - Rung being estimated
 * @property {number} total - Rungs in the ladder
 */

/**
 * Find the first rung whose estimated size fits the target with the safety
 * margin. Walks from the top and stops at the first fit.
 * @param {Object} options
 * @param {SizeRung[]} options.rungs
 * @param {number} options.targetBytes
 * @param {(rung: SizeRung) => Promise<number>} options.estimate - Estimated bytes
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.margin=SAFETY_MARGIN]
 * @param {(step: PlanStep) => void} [options.onStep]
 * @returns {Promise<{ index: number, fits: boolean, estimates: number[] }>}
 *   index: the first fitting rung, or the last rung when none fits
 */
export async function planTargetSize({
  rungs,
  targetBytes,
  estimate,
  signal,
  margin = SAFETY_MARGIN,
  onStep,
}) {
  if (rungs.length === 0) throw new Error('The size ladder is empty');
  /** @type {number[]} */
  const estimates = [];
  for (let index = 0; index < rungs.length; index++) {
    throwIfAborted(signal);
    onStep?.({ phase: 'estimate', index, total: rungs.length });
    const bytes = await estimate(rungs[index]);
    throwIfAborted(signal);
    estimates.push(bytes);
    if (bytes <= targetBytes * margin) {
      return { index, fits: true, estimates };
    }
  }
  return { index: rungs.length - 1, fits: false, estimates };
}

/**
 * @typedef {Object} TargetSizeStep
 * @property {'estimate' | 'encode'} phase
 * @property {number} index - Rung being estimated or encoded
 * @property {number} total - Rungs in the ladder
 * @property {number} [attempt] - Encode attempt (1-based; encode only)
 * @property {number} [previousBytes] - Size of the attempt that was too big
 */

/**
 * @typedef {Object} TargetSizeResult
 * @property {Blob} blob - The GIF that was kept (the last one encoded)
 * @property {SizeRung} rung - Settings it was encoded with
 * @property {number} index - Its rung in the ladder
 * @property {boolean} fits - blob.size <= targetBytes
 * @property {number} attempts - Encodes run (1 + retries)
 */

/**
 * Export aiming at a target size: plan the rung, encode it, and when the
 * real GIF is still too big step down one rung and encode again (at most
 * `maxRetries` times, and never past the last rung). Returns the last GIF
 * encoded even when it does not fit — the caller says so.
 * @param {Object} options
 * @param {SizeRung[]} options.rungs
 * @param {number} options.targetBytes
 * @param {(rung: SizeRung) => Promise<number>} options.estimate
 * @param {(rung: SizeRung, attempt: number) => Promise<Blob>} options.encode
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.margin=SAFETY_MARGIN]
 * @param {number} [options.maxRetries=MAX_RETRIES]
 * @param {(step: TargetSizeStep) => void} [options.onStep]
 * @returns {Promise<TargetSizeResult>}
 */
export async function exportToTargetSize({
  rungs,
  targetBytes,
  estimate,
  encode,
  signal,
  margin = SAFETY_MARGIN,
  maxRetries = MAX_RETRIES,
  onStep,
}) {
  const plan = await planTargetSize({ rungs, targetBytes, estimate, signal, margin, onStep });
  let index = plan.index;
  let attempt = 1;
  /** @type {number | undefined} */
  let previousBytes;
  for (;;) {
    throwIfAborted(signal);
    onStep?.({ phase: 'encode', index, total: rungs.length, attempt, previousBytes });
    const blob = await encode(rungs[index], attempt);
    throwIfAborted(signal);
    const fits = blob.size <= targetBytes;
    if (fits || attempt > maxRetries || index >= rungs.length - 1) {
      return { blob, rung: rungs[index], index, fits, attempts: attempt };
    }
    previousBytes = blob.size;
    index++;
    attempt++;
  }
}

/**
 * Header (6) + logical screen descriptor (7) + NETSCAPE loop extension (19)
 * + trailer (1). The global color table belongs to the first frame.
 */
export const GIF_FILE_OVERHEAD = 33;

/**
 * Extrapolate a GIF's size from a sample encode. GIF frames are encoded
 * independently here (each with its own image data and, except the first,
 * its own color table), so the sample's bytes per frame carry over; only
 * the fixed file overhead (header, logical screen descriptor, loop
 * extension, trailer) is paid once.
 * @param {number} sampleBytes - Size of the sample GIF
 * @param {number} sampleFrames - Frames in the sample
 * @param {number} gifFrames - Frames the real GIF will have (after merging)
 * @returns {number}
 */
export function extrapolateGifSize(sampleBytes, sampleFrames, gifFrames) {
  if (sampleFrames <= 0) return sampleBytes;
  const perFrame = Math.max(0, sampleBytes - GIF_FILE_OVERHEAD) / sampleFrames;
  return Math.round(GIF_FILE_OVERHEAD + perFrame * gifFrames);
}

/**
 * Human-readable summary of the settings a target size used, e.g.
 * "64 colors · every 2nd frame · 75 %"
 * @param {SizeRung} rung
 * @returns {string}
 */
export function describeRung(rung) {
  const parts = [`${rung.maxColors} colors`];
  parts.push(
    rung.frameSkip <= 1
      ? 'every frame'
      : `every ${rung.frameSkip === 2 ? '2nd' : rung.frameSkip === 3 ? '3rd' : `${rung.frameSkip}th`} frame`,
  );
  parts.push(`${Math.round(rung.scale * 100)} %`);
  return parts.join(' · ');
}
