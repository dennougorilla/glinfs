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
  findPickedComponent,
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
 *   mask of a frame, or null when it was not analyzed. Read once per frame
 *   when the build starts; the returned masks must not be mutated afterwards.
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
 * @typedef {Object} BuildParamsInputs
 * @property {string} [clipId] - The clip the masks belong to
 * @property {number} frameCount
 * @property {number} [sourceWidth]
 * @property {AiCutout} ai
 */

/**
 * Key of what a final-mask build depends on besides the probability masks:
 * the clip, its shape and the AI parameters. The cache memoizes under this
 * key plus the mask store's version; a caller that compares builds with
 * the same key knows they differ only in the masks.
 * @param {BuildParamsInputs} inputs
 * @returns {string}
 */
export function getFinalMaskParamsKey({ clipId, frameCount, sourceWidth, ai }) {
  return `${clipId ?? ''}|${frameCount}|${sourceWidth ?? ''}|${getAiParamsKey(ai)}`;
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
 * @typedef {Object} FrameBinarySource
 * @property {number} width - Reference mask width (the first analyzed frame)
 * @property {number} height
 * @property {(frameIndex: number) => Uint8Array | null} binaryAt - Thresholded
 *   (and, with smoothing, averaged with the neighbouring frames) 0/1 mask of
 *   a frame at the reference size, or null when it was not analyzed. The
 *   result lives in a shared buffer that the next call overwrites.
 */

/**
 * The per-frame binary masks a build tracks and cuts with, read from a
 * snapshot of the probability masks.
 *
 * Every probability mask is read once, up front: `getProb` may be backed by
 * a store that keeps changing (analysis progress) while a build yields, and
 * every pass of one build must see the same masks (the pick tracking keeps
 * component labels from one pass to the next).
 *
 * Frames whose probability mask has another size than the reference (the
 * first analyzed frame) are resampled to it (nearest neighbour), so
 * tracking compares like with like.
 *
 * @param {{ frameCount: number, getProb: (frameIndex: number) => ProbMask | null, ai: AiCutout }} options
 * @returns {FrameBinarySource | null} null when no frame is analyzed
 */
export function createFrameBinarySource({ frameCount, getProb, ai }) {
  /** @type {(ProbMask | null)[]} */
  const probs = [];
  for (let f = 0; f < frameCount; f++) probs.push(getProb(f) ?? null);

  const reference = probs.find((prob) => prob && prob.width > 0 && prob.height > 0);
  if (!reference) return null;
  const { width, height } = reference;
  const size = width * height;

  // Scratch, reused for every frame
  const smoothed = new Uint8Array(size);
  const binary = new Uint8Array(size);
  /** @type {Map<number, Uint8Array>} */
  const resampled = new Map();

  /**
   * A frame's probability at the reference size (null: not analyzed).
   * Keeps the last few resampled frames: smoothing reads each one three times.
   * @param {number} f
   * @returns {Uint8Array | null}
   */
  const probAt = (f) => {
    const prob = f >= 0 && f < frameCount ? probs[f] : null;
    if (!prob) return null;
    if (prob.width === width && prob.height === height) return prob.data;
    let data = resampled.get(f);
    if (!data) {
      if (resampled.size >= 3)
        resampled.delete(/** @type {number} */ (resampled.keys().next().value));
      data = resampleNearest(prob.data, prob.width, prob.height, width, height);
      resampled.set(f, data);
    }
    return data;
  };

  return {
    width,
    height,
    binaryAt(f) {
      const cur = probAt(f);
      if (!cur) return null;
      const source = ai.smoothing
        ? smoothTemporal(probAt(f - 1), cur, probAt(f + 1), smoothed)
        : cur;
      return thresholdMask(source, ai.threshold, binary);
    },
  };
}

/**
 * Whether a pick on a frame lands on (or within the snap radius of) a
 * character, judged on the same binary mask a build tracks the pick on
 * @param {{ frameCount: number, getProb: (frameIndex: number) => ProbMask | null, ai: AiCutout }} options
 * @param {{ frame: number, x: number, y: number }} pick - x/y fractions of the frame
 * @returns {boolean}
 */
export function pickFindsComponent(options, pick) {
  const source = createFrameBinarySource(options);
  const bin = source?.binaryAt(pick.frame);
  if (!source || !bin) return false;
  const comps = labelComponents(bin, source.width, source.height);
  return findPickedComponent(comps, source.width, source.height, pick) !== 0;
}

/**
 * Build the final masks of a clip.
 *
 * Without picks every frame is independent (one pass). With picks, the
 * tracking walks backward from the last pick frame first, then forward over
 * the whole clip, where each frame's final mask is produced. Both passes
 * work on one snapshot of the probability masks (createFrameBinarySource).
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

  const frameBinary = createFrameBinarySource({ frameCount, getProb, ai });
  if (!frameBinary) {
    return { masks, width: 0, height: 0, bytes: 0 };
  }
  const { width, height, binaryAt } = frameBinary;

  const size = width * height;
  const radius = edgeRadiusInMaskPixels(ai.edge, width, options.sourceWidth ?? width);
  const picks = ai.picks ?? [];
  const tracker = picks.length > 0 ? createPickTracker({ picks, width, height }) : null;
  const backwardStart = tracker ? Math.min(tracker.backwardStart, frameCount - 1) : -1;
  const total = frameCount + (backwardStart + 1);

  // Scratch, reused for every frame
  const labels = new Int32Array(size);
  const selected = new Uint8Array(size);
  const morphed = new Uint8Array(size);

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
 * @typedef {Object} CacheKeyInputs
 * @property {string} [clipId] - The clip the masks belong to. Pass it
 *   whenever the cache can serve more than one clip: the other inputs do
 *   not identify a clip, so two clips of the same shape would share a memo.
 * @property {number} storeVersion - The mask store's version (bumps
 *   whenever a probability mask changes)
 * @property {number} frameCount
 * @property {number} [sourceWidth]
 * @property {AiCutout} ai
 */

/**
 * Memoized final masks for one clip at a time: a build with the same
 * inputs (clip, mask-store version, frame count, source width, AI params)
 * as the last completed one returns its MaskSource without work; a
 * different one replaces it once it completes (the old masks are
 * released).
 *
 * Only the newest build runs: a build() with other inputs, or clear(),
 * aborts the one in flight, which then rejects with an AbortError (so a
 * superseded build can never resolve with stale masks). A build() with the
 * same inputs as the one in flight joins it: every joined caller gets the
 * build's progress (the latest step at once, then each new one) and can
 * cancel on its own signal, which rejects that caller's promise right away.
 * The shared build stops only when every joined caller has cancelled (a
 * caller without a signal never cancels).
 */
export function createFinalMaskCache() {
  /** @type {{ key: string, source: MaskSource, bytes: number } | null} */
  let current = null;
  /**
   * @typedef {Object} InflightBuild
   * @property {string} key
   * @property {AbortController} controller
   * @property {Promise<MaskSource>} promise - The shared build (callers get joined promises)
   * @property {Set<(progress: BuildProgress) => void>} listeners - Joined callers' onProgress
   * @property {BuildProgress | null} last - Latest progress, replayed to late joiners
   * @property {number} callers - Joined callers that have not cancelled
   */
  /** @type {InflightBuild | null} */
  let inflight = null;

  /** @param {CacheKeyInputs} inputs */
  const keyOf = (inputs) => `${inputs.storeVersion}|${getFinalMaskParamsKey(inputs)}`;

  /**
   * Run one build under its entry's controller, telling every joined caller
   * about its progress
   * @param {InflightBuild} entry
   * @param {BuildOptions} options
   * @returns {Promise<MaskSource>}
   */
  const run = async (entry, options) => {
    try {
      const result = await buildFinalMasks({
        ...options,
        signal: entry.controller.signal,
        onProgress: (progress) => {
          entry.last = progress;
          for (const listener of entry.listeners) listener(progress);
        },
      });
      throwIfAborted(entry.controller.signal);
      const source = createMaskSource(result.masks);
      current = { key: entry.key, source, bytes: result.bytes };
      return source;
    } finally {
      if (inflight === entry) inflight = null;
    }
  };

  /**
   * One caller's view of a shared build: its own progress and its own
   * cancellation (the build stops once no joined caller is left)
   * @param {InflightBuild} entry
   * @param {{ signal?: AbortSignal, onProgress?: (progress: BuildProgress) => void }} caller
   * @returns {Promise<MaskSource>}
   */
  const join = (entry, { signal, onProgress }) => {
    entry.callers++;
    // A fresh function per caller: two callers may pass the same callback
    const listener = onProgress ? (/** @type {BuildProgress} */ p) => onProgress(p) : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const leave = () => {
        settled = true;
        if (listener) entry.listeners.delete(listener);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        leave();
        entry.callers--;
        if (entry.callers === 0) entry.controller.abort();
        reject(new DOMException('Final mask build cancelled', 'AbortError'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (listener) {
        entry.listeners.add(listener);
        if (entry.last) listener(entry.last);
      }
      entry.promise.then(
        (source) => {
          if (settled) return;
          leave();
          resolve(source);
        },
        (error) => {
          if (settled) return;
          leave();
          reject(error);
        },
      );
    });
  };

  return {
    /**
     * Final masks for these inputs, building them when not memoized
     * @param {BuildOptions & CacheKeyInputs} options
     * @returns {Promise<MaskSource>}
     * @throws {DOMException} AbortError when cancelled or superseded
     */
    build(options) {
      const key = keyOf(options);
      if (current && current.key === key) return Promise.resolve(current.source);
      // Join the build in flight for the same inputs, unless every caller
      // already left it (it is stopping)
      if (!inflight || inflight.key !== key || inflight.controller.signal.aborted) {
        inflight?.controller.abort();
        /** @type {InflightBuild} */
        const entry = {
          key,
          controller: new AbortController(),
          promise: Promise.resolve(/** @type {any} */ (null)),
          listeners: new Set(),
          last: null,
          callers: 0,
        };
        inflight = entry;
        entry.promise = run(entry, options);
        // Callers see the outcome through their joined promises
        entry.promise.catch(() => undefined);
      }
      return join(inflight, options);
    },

    /**
     * The memoized MaskSource for these inputs, or null (never builds)
     * @param {CacheKeyInputs} inputs
     * @returns {MaskSource | null}
     */
    peek(inputs) {
      const key = keyOf(inputs);
      return current && current.key === key ? current.source : null;
    },

    /** Drop the memoized masks and abort the build in flight */
    clear() {
      current = null;
      inflight?.controller.abort();
      inflight = null;
    },

    /** @returns {number} Bytes held by the memoized masks */
    bytes() {
      return current?.bytes ?? 0;
    },
  };
}
