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

/**
 * Bytes per MB: decimal, as upload limits count ("10 MB" = 10,000,000
 * bytes). The export dialog shows and checks every size in these units
 * (formatFileSize), so a GIF that fits a 10 MB target fits a 10 MB limit.
 */
export const BYTES_PER_MB = 1_000_000;

/**
 * A file size in decimal units (1 KB = 1,000 bytes), e.g. "10.2 MB"
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (i < units.length - 1 && bytes >= 1000 ** (i + 1)) i++;
  const value = bytes / 1000 ** i;
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

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
 * The frames a size estimate encodes: a few short runs of consecutive GIF
 * frames, spread across the clip. Consecutive frames matter because opaque
 * GIFs are frame-differenced: a frame costs what changed since the frame
 * before, which frames picked far apart do not show.
 */
export const ESTIMATE_SAMPLE = /** @type {const} */ ({
  /** Runs, spread evenly from the first frame to the last */
  runs: 4,
  /** Consecutive frames per run; only the last one of each run is measured */
  runLength: 3,
});

/**
 * @typedef {Object} EstimateSample
 * @property {number[]} positions - Positions (0-based, ascending) in the GIF's frame list to encode
 * @property {number[]} schedule - The frame index the encoder sees for each
 *   position (its palette schedule counts these)
 * @property {Array<{ indices: number[], share: number }>} groups - Measured
 *   frames (indices into `positions`) and the share of the GIF's frames each
 *   group stands for. A measured frame is the last of its run, which follows
 *   its own previous frame (the first of a run follows a frame from elsewhere
 *   in the clip, and right after that jump the encoder can still be writing
 *   whole frames). Empty when `positions` is the whole GIF.
 */

/**
 * @param {number} total - GIF frames
 * @param {number} [paletteInterval=0] - The encoder's palette schedule: N > 3
 *   rebuilds the palette every Nth frame, and such a frame changes colors
 *   everywhere, so it costs about a whole frame even where the frames around
 *   it cost little. Then half the runs end on a rebuild and stand for 1 in N
 *   frames, the other half end between rebuilds. 0 (one palette) or 1 (one
 *   per frame) treat every frame alike.
 * @param {{ runs: number, runLength: number }} [sample=ESTIMATE_SAMPLE]
 * @returns {EstimateSample}
 */
export function selectEstimateSample(total, paletteInterval = 0, sample = ESTIMATE_SAMPLE) {
  const { runs, runLength } = sample;
  if (total <= runs * runLength) {
    const positions = Array.from({ length: Math.max(0, total) }, (_, i) => i);
    return { positions, schedule: positions, groups: [] };
  }
  const split = paletteInterval > runLength;
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const schedule = [];
  /** @type {number[]} */
  const steady = [];
  /** @type {number[]} */
  const rebuild = [];
  const lastStart = total - runLength;
  for (let r = 0; r < runs; r++) {
    const start = runs === 1 ? 0 : Math.round((r * lastStart) / (runs - 1));
    const onRebuild = split && r % 2 === 1;
    // Between rebuilds: r*N+1 ... r*N+runLength; ending on one: ... r*N+N
    const first = split
      ? r * paletteInterval + (onRebuild ? paletteInterval - runLength + 1 : 1)
      : start;
    for (let k = 0; k < runLength; k++) {
      positions.push(start + k);
      schedule.push(first + k);
    }
    (onRebuild ? rebuild : steady).push(positions.length - 1);
  }
  const groups = split
    ? [
        { indices: steady, share: 1 - 1 / paletteInterval },
        { indices: rebuild, share: 1 / paletteInterval },
      ]
    : [{ indices: steady, share: 1 }];
  return { positions, schedule, groups };
}

/**
 * Bytes of each image in a GIF, from its Graphic Control Extension (or image
 * descriptor) to the end of its pixel data; the rest of the file is fixed
 * overhead (header, screen descriptor, global color table, loop extension,
 * trailer).
 * @param {Uint8Array} bytes
 * @returns {{ frames: number[], overhead: number }}
 */
export function gifFrameSizes(bytes) {
  const lsd = bytes[10];
  let pos = 13 + (lsd & 0x80 ? 3 * (1 << ((lsd & 7) + 1)) : 0);
  const skipSubBlocks = () => {
    while (pos < bytes.length && bytes[pos] !== 0) pos += bytes[pos] + 1;
    pos++;
  };
  /** @type {number[]} */
  const frames = [];
  let frameStart = -1;
  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (bytes[pos + 1] === 0xf9) frameStart = pos;
      pos += 2;
      skipSubBlocks();
    } else if (block === 0x2c) {
      const start = frameStart >= 0 ? frameStart : pos;
      const fields = bytes[pos + 9];
      pos += 10 + (fields & 0x80 ? 3 * (1 << ((fields & 7) + 1)) : 0);
      pos++; // LZW minimum code size
      skipSubBlocks();
      frames.push(pos - start);
      frameStart = -1;
    } else {
      break;
    }
  }
  const imageBytes = frames.reduce((a, b) => a + b, 0);
  return { frames, overhead: bytes.length - imageBytes };
}

/**
 * Extrapolate a GIF's size from a sample encode (selectEstimateSample): the
 * file overhead and the first frame once, every later frame at the
 * share-weighted mean of the measured groups. A sample of the whole GIF is
 * its size.
 * @param {{ frames: number[], overhead: number }} sizes - gifFrameSizes of the sample GIF
 * @param {EstimateSample['groups']} groups
 * @param {number} gifFrames - Frames the real GIF will have
 * @returns {number}
 */
export function extrapolateFromSample(sizes, groups, gifFrames) {
  const { frames, overhead } = sizes;
  const sum = frames.reduce((a, b) => a + b, 0);
  if (frames.length === 0 || gifFrames <= 0) return overhead;
  if (groups.length === 0) return Math.round(overhead + (sum / frames.length) * gifFrames);
  let typical = 0;
  let shares = 0;
  for (const { indices, share } of groups) {
    const counted = indices.filter((i) => i < frames.length);
    if (counted.length === 0) continue;
    typical += (share * counted.reduce((total, i) => total + frames[i], 0)) / counted.length;
    shares += share;
  }
  if (shares === 0) return Math.round(overhead + (sum / frames.length) * gifFrames);
  return Math.round(overhead + frames[0] + (typical / shares) * (gifFrames - 1));
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
