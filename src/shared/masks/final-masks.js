/**
 * Final Masks
 *
 * Turns a clip's probability masks (one per analyzed frame, from the
 * segmentation model) and the AI cutout parameters into the final 1-bit
 * mask of every frame: threshold (optionally averaged with the neighbouring
 * frames), follow the picks, grow/shrink by the edge, bit-pack.
 *
 * Building runs on the main thread in slices: it yields to the event loop
 * between frames whenever a slice has run for BUILD_SLICE_MS, reports
 * progress and stops at an AbortSignal. Only a few frames' unpacked
 * buffers exist at a time; the result holds one bit per pixel (a 300-frame
 * clip at 1024x576 is ~22 MB).
 *
 * The result is exposed as a MaskSource, the object compose/export take:
 * `getFinalMask(frameIndex)` plus a `version` that differs between any two
 * builds, so renderer caches keyed on it never mix results.
 *
 * @module shared/masks/final-masks
 */

import {
  createPickTracker,
  labelComponents,
  morphMask,
  packMask,
  resampleNearest,
  smoothTemporal,
  thresholdMask,
} from './mask-ops.js';

/** @typedef {import('./mask-ops.js').PackedMask} PackedMask */
/** @typedef {import('../edits/model.js').AiCutout} AiCutout */

/**
 * @typedef {Object} ProbMask
 * @property {Uint8Array} data - 0..255 foreground probability, width * height
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} MaskSource
 * @property {(frameIndex: number) => PackedMask | null} getFinalMask - Final
 *   mask of an absolute clip frame (covering the whole source frame), or
 *   null when that frame has no analysis yet
 * @property {number} version - Unique per build; equal versions mean equal masks
 */

/**
 * @typedef {Object} BuildProgress
 * @property {number} done  - frame steps finished
 * @property {number} total - frame steps in the build (frames, plus the
 *   frames the pick tracking walks backward)
 */

/**
 * @typedef {Object} BuildOptions
 * @property {number} frameCount - Clip frame count; masks cover 0..frameCount-1
 * @property {(frameIndex: number) => ProbMask | null} getProb - Probability
 *   mask of a frame, or null when it was not analyzed
 * @property {AiCutout} ai - Normalized AI cutout parameters
 * @property {number} [sourceWidth] - Source frame width in pixels (edge is
 *   in source pixels); defaults to the mask width
 * @property {AbortSignal} [signal]
 * @property {(progress: BuildProgress) => void} [onProgress]
 * @property {number} [sliceMs] - Longest run between yields (BUILD_SLICE_MS)
 * @property {() => number} [now] - Clock (performance.now)
 * @property {() => Promise<void>} [yieldToMain] - How to give the event loop a turn
 */

/** Longest stretch of work (ms) before the builder yields to the event loop */
export const BUILD_SLICE_MS = 30;

/** Build counter behind MaskSource.version */
let buildCounter = 0;

/**
 * Yield to the event loop: scheduler.yield() where available (keeps the
 * task's priority), else a macrotask
 * @returns {Promise<void>}
 */
function defaultYieldToMain() {
  const scheduler = /** @type {any} */ (globalThis).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** @returns {number} */
function defaultNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Edge (source pixels) as a mask-pixel radius. A non-zero edge is never
 * rounded away: it moves the cutout by at least one mask pixel.
 * @param {number} edge - Integer source pixels, negative shrinks
 * @param {number} maskWidth
 * @param {number} sourceWidth
 * @returns {number}
 */
export function edgeRadiusInMaskPixels(edge, maskWidth, sourceWidth) {
  if (!Number.isFinite(edge) || edge === 0) return 0;
  const scale = sourceWidth > 0 ? maskWidth / sourceWidth : 1;
  return Math.sign(edge) * Math.max(1, Math.round(Math.abs(edge) * scale));
}

/**
 * Cache key of the parameters a build depends on (besides the masks)
 * @param {AiCutout} ai
 * @returns {string}
 */
export function getAiParamsKey(ai) {
  const picks = (ai.picks ?? []).map((p) => `${p.frame}:${p.x}:${p.y}:${p.mode}`).join(',');
  return `${ai.threshold}|${ai.smoothing ? 1 : 0}|${ai.edge}|${picks}`;
}

/**
 * Throw AbortError when cancelled
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Final mask build cancelled', 'AbortError');
  }
}

/**
 * Build the final masks of a clip.
 *
 * Without picks every frame is independent (one pass). With picks, the
 * tracking walks backward from the last pick frame first, then forward over
 * the whole clip, where each frame's final mask is produced.
 *
 * Frames whose probability mask has another size than the clip's first
 * analyzed frame are resampled to it (nearest neighbour), so tracking
 * compares like with like.
 *
 * @param {BuildOptions} options
 * @returns {Promise<{ masks: (PackedMask | null)[], width: number, height: number, bytes: number }>}
 * @throws {DOMException} AbortError when cancelled
 */
export async function buildFinalMasks(options) {
  const {
    frameCount,
    getProb,
    ai,
    signal,
    onProgress,
    sliceMs = BUILD_SLICE_MS,
    now = defaultNow,
    yieldToMain = defaultYieldToMain,
  } = options;
  throwIfAborted(signal);

  /** @type {(PackedMask | null)[]} */
  const masks = new Array(Math.max(0, frameCount)).fill(null);

  // Reference size: the first analyzed frame
  let width = 0;
  let height = 0;
  for (let f = 0; f < frameCount && width === 0; f++) {
    const prob = getProb(f);
    if (prob && prob.width > 0 && prob.height > 0) {
      width = prob.width;
      height = prob.height;
    }
  }
  if (width === 0) {
    return { masks, width: 0, height: 0, bytes: 0 };
  }

  const size = width * height;
  const radius = edgeRadiusInMaskPixels(ai.edge, width, options.sourceWidth ?? width);
  const picks = ai.picks ?? [];
  const tracker = picks.length > 0 ? createPickTracker({ picks, width, height }) : null;
  const backwardStart = tracker ? Math.min(tracker.backwardStart, frameCount - 1) : -1;
  const total = frameCount + (backwardStart + 1);

  // Scratch, reused for every frame
  const smoothed = new Uint8Array(size);
  const binary = new Uint8Array(size);
  const labels = new Int32Array(size);
  const selected = new Uint8Array(size);
  const morphed = new Uint8Array(size);
  /** @type {Map<number, Uint8Array | null>} */
  const resampled = new Map();

  /**
   * A frame's probability at the reference size (null: not analyzed).
   * Keeps the last few resampled frames: smoothing reads each one three times.
   * @param {number} f
   * @returns {Uint8Array | null}
   */
  const probAt = (f) => {
    if (f < 0 || f >= frameCount) return null;
    const prob = getProb(f);
    if (!prob) return null;
    if (prob.width === width && prob.height === height) return prob.data;
    if (!resampled.has(f)) {
      if (resampled.size >= 3) resampled.delete(resampled.keys().next().value);
      resampled.set(f, resampleNearest(prob.data, prob.width, prob.height, width, height));
    }
    return /** @type {Uint8Array} */ (resampled.get(f));
  };

  /**
   * Thresholded (and smoothed) mask of a frame, in the shared scratch
   * @param {number} f
   * @returns {Uint8Array | null}
   */
  const binaryAt = (f) => {
    const cur = probAt(f);
    if (!cur) return null;
    const source = ai.smoothing ? smoothTemporal(probAt(f - 1), cur, probAt(f + 1), smoothed) : cur;
    return thresholdMask(source, ai.threshold, binary);
  };

  let done = 0;
  let sliceStart = now();
  /** Count a finished frame step; yield when the slice is used up */
  const stepDone = async () => {
    done++;
    onProgress?.({ done, total });
    if (now() - sliceStart >= sliceMs) {
      await yieldToMain();
      sliceStart = now();
    }
    throwIfAborted(signal);
  };

  if (tracker) {
    for (let f = backwardStart; f >= 0; f--) {
      const bin = binaryAt(f);
      tracker.trackBackward(f, bin ? labelComponents(bin, width, height, labels) : null);
      await stepDone();
    }
  }

  let bytes = 0;
  for (let f = 0; f < frameCount; f++) {
    const bin = binaryAt(f);
    if (!bin) {
      tracker?.skipForward(f);
    } else {
      let mask = bin;
      if (tracker) {
        mask = tracker.selectForward(f, labelComponents(bin, width, height, labels), selected);
      }
      if (radius !== 0) {
        mask = morphMask(mask, width, height, radius, morphed);
      }
      const packed = packMask(mask, width, height);
      masks[f] = packed;
      bytes += packed.bits.byteLength;
    }
    await stepDone();
  }

  return { masks, width, height, bytes };
}

/**
 * Wrap built masks as a MaskSource with a fresh version
 * @param {(PackedMask | null)[]} masks
 * @returns {MaskSource}
 */
function createMaskSource(masks) {
  buildCounter += 1;
  return {
    version: buildCounter,
    getFinalMask: (frameIndex) => masks[frameIndex] ?? null,
  };
}

/**
 * Memoized final masks for one clip at a time: a build with the same
 * inputs (mask-store version, frame count, source width, AI params) as the
 * last completed one returns its MaskSource without work; a different one
 * replaces it once it completes (the old masks are released). A build that
 * was superseded by a newer call, or cancelled, never replaces the memo.
 */
export function createFinalMaskCache() {
  /** @type {{ key: string, source: MaskSource, bytes: number } | null} */
  let current = null;
  let latestRequest = 0;

  /**
   * @param {number} storeVersion
   * @param {number} frameCount
   * @param {number | undefined} sourceWidth
   * @param {AiCutout} ai
   */
  const keyOf = (storeVersion, frameCount, sourceWidth, ai) =>
    `${storeVersion}|${frameCount}|${sourceWidth ?? ''}|${getAiParamsKey(ai)}`;

  return {
    /**
     * Final masks for these inputs, building them when not memoized
     * @param {BuildOptions & { storeVersion: number }} options - storeVersion:
     *   the mask store's version (bumps whenever a probability mask changes)
     * @returns {Promise<MaskSource>}
     */
    async build(options) {
      const key = keyOf(options.storeVersion, options.frameCount, options.sourceWidth, options.ai);
      if (current && current.key === key) return current.source;
      latestRequest += 1;
      const request = latestRequest;
      const result = await buildFinalMasks(options);
      const source = createMaskSource(result.masks);
      if (request === latestRequest) {
        current = { key, source, bytes: result.bytes };
      }
      return source;
    },

    /**
     * The memoized MaskSource for these inputs, or null (never builds)
     * @param {{ storeVersion: number, frameCount: number, sourceWidth?: number, ai: AiCutout }} inputs
     * @returns {MaskSource | null}
     */
    peek(inputs) {
      const key = keyOf(inputs.storeVersion, inputs.frameCount, inputs.sourceWidth, inputs.ai);
      return current && current.key === key ? current.source : null;
    },

    /** Drop the memoized masks */
    clear() {
      current = null;
      latestRequest += 1;
    },

    /** @returns {number} Bytes held by the memoized masks */
    bytes() {
      return current?.bytes ?? 0;
    },
  };
}
