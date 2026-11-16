/**
 * Final Masks
 *
 * Turns a clip's probability masks (one per analyzed frame, from the
 * segmentation model) and the AI cutout parameters into the final 1-bit
 * mask of every frame: threshold (optionally averaged with the neighbouring
 * frames), follow the picks, clean up (small pieces, small holes),
 * grow/shrink by the edge, subtract / add the
 * tracked objects (see object-masks.js), bit-pack.
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

import { getAiModel, getRegionPicks, isClickModel } from '../edits/model.js';
import {
  createPickTracker,
  fillSmallHoles,
  findPickedComponent,
  labelComponents,
  morphMask,
  packMask,
  removeSmallComponents,
  resampleNearest,
  smoothTemporal,
  thresholdMask,
} from './mask-ops.js';
import { applyObjectMasks, createObjectScratch } from './object-masks.js';

/** @typedef {import('./mask-ops.js').PackedMask} PackedMask */
/** @typedef {import('../edits/model.js').AiCutout} AiCutout */

/**
 * @typedef {Object} ProbMask
 * @property {Uint8Array} data - 0..255 foreground probability, width * height
 * @property {number} width
 * @property {number} height
 */

/**
 * A tracked object's masks, as a build reads them
 * @typedef {Object} ObjectMaskInput
 * @property {'remove' | 'add'} mode
 * @property {(frameIndex: number) => ProbMask | null} getMask - The object's
 *   probability mask on a frame (any size), or null where it was not
 *   tracked (that frame keeps the base mask). Read once per frame when a
 *   build starts, like getProb.
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
 * @property {ObjectMaskInput[]} [objects] - The tracked objects of `ai.objects`,
 *   in the same order (applied after the edge, a later one wins)
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
export function defaultYieldToMain() {
  const scheduler = /** @type {any} */ (globalThis).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** @returns {number} */
export function defaultNow() {
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
  const picks = getRegionPicks(ai)
    .map((p) => `${p.frame}:${p.x}:${p.y}:${p.mode}`)
    .join(',');
  // The model is part of the key: the shared cache must never hand one
  // model's cutout to the other (the same model the masks are read with).
  // The click model's picks and scope change its probability masks (the
  // store version), not the build.
  const click = isClickModel(ai) ? '|click' : '';
  // Like the click model's picks, an object's clicks change its masks (the
  // store version), not the build: only which objects apply, and how
  const objects = (ai.objects ?? []).map((o) => `${o.id}:${o.mode}`).join(',');
  const cleanup = `${ai.cleanup?.minIslandArea ?? 0}:${ai.cleanup?.maxHoleArea ?? 0}`;
  return `${getAiModel(ai)}|${ai.threshold}|${ai.smoothing ? 1 : 0}|${ai.edge}|${picks}${click}|${objects}|${cleanup}`;
}

/**
 * @typedef {Object} CleanupScratch
 * @property {Int32Array} labels
 * @property {Uint8Array} islands
 * @property {Uint8Array} holes
 */

/**
 * Scratch buffers for applyCleanup, or null when the clean-up is off
 * @param {AiCutout} ai
 * @param {number} size - width * height
 * @returns {CleanupScratch | null}
 */
function createCleanupScratch(ai, size) {
  if (!(ai.cleanup?.minIslandArea > 0) && !(ai.cleanup?.maxHoleArea > 0)) return null;
  return {
    labels: new Int32Array(size),
    islands: new Uint8Array(size),
    holes: new Uint8Array(size),
  };
}

/**
 * The whole-clip clean-up of one frame's selection: small separate pieces
 * go, small holes are filled (areas are fractions of the frame)
 * @param {Uint8Array} mask - 0/1, width * height (not modified)
 * @param {number} width
 * @param {number} height
 * @param {import('../edits/model.js').CutoutCleanup} cleanup
 * @param {CleanupScratch} scratch
 * @returns {Uint8Array}
 */
export function applyCleanup(mask, width, height, cleanup, scratch) {
  const size = width * height;
  let out = mask;
  const minIsland = cleanup.minIslandArea * size;
  if (minIsland > 0) {
    const comps = labelComponents(out, width, height, scratch.labels);
    out = removeSmallComponents(out, comps, minIsland, scratch.islands);
  }
  const maxHole = cleanup.maxHoleArea * size;
  if (maxHole > 0) out = fillSmallHoles(out, width, height, maxHole, scratch.labels, scratch.holes);
  return out;
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
    objects = [],
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
  // Snapshot, like the probability masks: the store may change while the
  // build yields
  const objectMasks = objects.map((object) => {
    /** @type {(ProbMask | null)[]} */
    const masks = [];
    for (let f = 0; f < frameCount; f++) masks.push(object.getMask(f) ?? null);
    return { mode: object.mode, masks };
  });

  const size = width * height;
  const radius = edgeRadiusInMaskPixels(ai.edge, width, options.sourceWidth ?? width);
  const picks = getRegionPicks(ai);
  const tracker = picks.length > 0 ? createPickTracker({ picks, width, height }) : null;
  const backwardStart = tracker ? Math.min(tracker.backwardStart, frameCount - 1) : -1;
  const total = frameCount + (backwardStart + 1);

  // Scratch, reused for every frame
  const labels = new Int32Array(size);
  const selected = new Uint8Array(size);
  const morphed = new Uint8Array(size);
  const objectScratch = objectMasks.length > 0 ? createObjectScratch(size) : null;
  const cleanupScratch = createCleanupScratch(ai, size);

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
      if (cleanupScratch) {
        mask = applyCleanup(mask, width, height, ai.cleanup, cleanupScratch);
      }
      if (radius !== 0) {
        mask = morphMask(mask, width, height, radius, morphed);
      }
      if (objectScratch) {
        const layers = objectMasks.map((o) => ({ mode: o.mode, mask: o.masks[f] }));
        mask = applyObjectMasks(mask, width, height, layers, objectScratch);
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
 * A fresh MaskSource version (shared by builds and drafts, so a renderer
 * cache keyed on it never mixes the two)
 * @returns {number}
 */
export function nextMaskVersion() {
  buildCounter += 1;
  return buildCounter;
}

/**
 * Wrap built masks as a MaskSource with a fresh version
 * @param {(PackedMask | null)[]} masks
 * @returns {MaskSource}
 */
function createMaskSource(masks) {
  return {
    version: nextMaskVersion(),
    getFinalMask: (frameIndex) => masks[frameIndex] ?? null,
  };
}

/** Frames a draft keeps computed (the current one, plus a few while playing) */
export const DRAFT_CACHE_FRAMES = 8;

/**
 * Keep only the components of `binary` that overlap `previous` (the last
 * full build's final mask of the same frame, which already follows the
 * picks)
 * @param {Uint8Array} binary - 0/1, width * height
 * @param {number} width
 * @param {number} height
 * @param {PackedMask} previous - Same size as the binary mask
 * @param {Int32Array} labels - Scratch
 * @param {Uint8Array} out
 * @returns {Uint8Array}
 */
function keepOverlappingComponents(binary, width, height, previous, labels, out) {
  const comps = labelComponents(binary, width, height, labels);
  const size = width * height;
  const keep = new Uint8Array(comps.count + 1);
  const { bits } = previous;
  for (let i = 0; i < size; i++) {
    const label = comps.labels[i];
    if (label && (bits[i >> 3] >> (7 - (i & 7))) & 1) keep[label] = 1;
  }
  for (let i = 0; i < size; i++) out[i] = keep[comps.labels[i]];
  return out;
}

/**
 * A MaskSource that computes each frame's final mask on demand, for the
 * preview while an AI slider is being dragged: a full build walks the whole
 * clip (and restarts on every change), so the preview would stay frozen on
 * the old masks until the drag ends. A draft computes only the frames that
 * are drawn, synchronously and in a few milliseconds each.
 *
 * Without picks the result is exact: each frame of a build only depends on
 * its own (and, with smoothing, its neighbours') probability masks. Pick
 * tracking needs the whole clip, so with picks a draft approximates it by
 * keeping the components that overlap `base`'s mask of the frame (the last
 * full build, which followed the picks); frames `base` has no mask for keep
 * every component. The full build replaces the draft once the drag ends.
 *
 * Tracked objects apply exactly as in a build (they are per frame).
 *
 * @param {{ frameCount: number, getProb: (frameIndex: number) => ProbMask | null, ai: AiCutout, objects?: ObjectMaskInput[], sourceWidth?: number, base?: MaskSource | null, cacheFrames?: number }} options
 * @returns {MaskSource & { draft: true }}
 */
export function createDraftMaskSource({
  frameCount,
  getProb,
  ai,
  objects = [],
  sourceWidth,
  base = null,
  cacheFrames = DRAFT_CACHE_FRAMES,
}) {
  const frameBinary = createFrameBinarySource({ frameCount, getProb, ai });
  const picks = getRegionPicks(ai);
  /** @type {Map<number, PackedMask | null>} */
  const computed = new Map();
  /** @type {{ labels: Int32Array, selected: Uint8Array, morphed: Uint8Array, objects: import('./object-masks.js').ObjectScratch | null, cleanup: CleanupScratch | null } | null} */
  let scratch = null;

  /**
   * @param {number} frameIndex
   * @returns {PackedMask | null}
   */
  const compute = (frameIndex) => {
    if (!frameBinary || frameIndex < 0 || frameIndex >= frameCount) return null;
    const { width, height } = frameBinary;
    const bin = frameBinary.binaryAt(frameIndex);
    if (!bin) return null;
    const size = width * height;
    scratch ??= {
      labels: new Int32Array(size),
      selected: new Uint8Array(size),
      morphed: new Uint8Array(size),
      objects: objects.length > 0 ? createObjectScratch(size) : null,
      cleanup: createCleanupScratch(ai, size),
    };
    let mask = bin;
    const previous = picks.length > 0 ? (base?.getFinalMask(frameIndex) ?? null) : null;
    if (previous && previous.width === width && previous.height === height) {
      mask = keepOverlappingComponents(
        bin,
        width,
        height,
        previous,
        scratch.labels,
        scratch.selected,
      );
    }
    if (scratch.cleanup) mask = applyCleanup(mask, width, height, ai.cleanup, scratch.cleanup);
    const radius = edgeRadiusInMaskPixels(ai.edge, width, sourceWidth ?? width);
    if (radius !== 0) mask = morphMask(mask, width, height, radius, scratch.morphed);
    if (scratch.objects) {
      const layers = objects.map((o) => ({ mode: o.mode, mask: o.getMask(frameIndex) ?? null }));
      mask = applyObjectMasks(mask, width, height, layers, scratch.objects);
    }
    return packMask(mask, width, height);
  };

  return {
    draft: true,
    version: nextMaskVersion(),
    getFinalMask(frameIndex) {
      if (computed.has(frameIndex)) return computed.get(frameIndex) ?? null;
      const mask = compute(frameIndex);
      if (computed.size >= cacheFrames) {
        computed.delete(/** @type {number} */ (computed.keys().next().value));
      }
      computed.set(frameIndex, mask);
      return mask;
    },
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
  /** @type {{ key: string, clipId: string | undefined, source: MaskSource, bytes: number } | null} */
  let current = null;
  /**
   * @typedef {Object} InflightBuild
   * @property {string} key
   * @property {string | undefined} clipId
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
      current = { key: entry.key, clipId: entry.clipId, source, bytes: result.bytes };
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
          clipId: options.clipId,
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

    /**
     * A clip is gone for good: drop its memoized masks and stop a build in
     * flight for it (masks and builds of other clips stay)
     * @param {string} clipId
     */
    forgetClip(clipId) {
      if (current?.clipId === clipId) current = null;
      if (inflight?.clipId === clipId) {
        inflight.controller.abort();
        inflight = null;
      }
    },

    /** @returns {number} Bytes held by the memoized masks */
    bytes() {
      return current?.bytes ?? 0;
    },
  };
}
