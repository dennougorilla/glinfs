/**
 * AI cutout glue shared by the editor and the export screen
 * @module features/editor/ai-cutout
 *
 * Connects the clip's frames to the segmentation manager's probability
 * masks (mask store, keyed by model and `frame.sharedKey ?? frame.id`) and
 * to the final-mask builder. The model is `ai.model` of the clip's edits:
 * every lookup reads that model's masks only. One final-mask cache serves
 * both screens, so the export reuses the masks the editor already built for
 * the same inputs.
 *
 * Also holds the user's "Run without WebGPU" choice for the page session
 * (asked once, valid for the editor and the export).
 */

import { getAiModel } from '../../shared/edits/model.js';
import {
  createDraftMaskSource,
  createFinalMaskCache,
  getColourRegion,
  getFinalMaskParamsKey,
  getPickedPieceRole,
  getSurvivingMask,
  pickFindsComponent,
} from '../../shared/masks/final-masks.js';
import { getSharedMaskStore } from '../ai-cutout/mask-store.js';
import { DEFAULT_MODEL_ID, formatModelSize, getModelEntry } from '../ai-cutout/model-registry.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import {
  collectPendingFrames,
  getStaleObjectFrames,
  maskKey,
  objectMaskKey,
} from '../ai-cutout/segmentation-manager.js';

/** @typedef {import('../capture/types.js').Frame} Frame */
/** @typedef {import('../ai-cutout/mask-store.js').MaskStore} MaskStore */
/** @typedef {import('../../shared/masks/final-masks.js').MaskSource} MaskSource */
/** @typedef {import('../../shared/masks/final-masks.js').BuildProgress} BuildProgress */
/** @typedef {import('../../shared/edits/model.js').AiCutout} AiCutout */
/** @typedef {ReturnType<typeof createFinalMaskCache>} FinalMaskCache */

/** ONNX Runtime's WebAssembly binary, downloaded once for every model (26.8 MB) */
export const RUNTIME_SIZE_LABEL = 'about 27 MB';

/**
 * The model an AiCutout uses (edits from before the general model have none;
 * the registry's ids are the edits' AI_MODELS, a unit test keeps them equal)
 * @param {{ model?: string } | null | undefined} ai
 * @returns {string}
 */
export function getAiModelId(ai) {
  return getAiModel(ai);
}

/**
 * Download size of a model as shown next to its name ("88 MB")
 * @param {string} modelId
 * @returns {string}
 */
export function getModelSizeLabel(modelId) {
  return formatModelSize(getModelEntry(modelId).bytes);
}

/**
 * Typical time per frame, used for the time-left estimate before the first
 * frame of an analysis has finished (measured with the real model)
 */
export const TYPICAL_FRAME_MS = /** @type {const} */ ({ webgpu: 850, wasm: 14_000 });

/** @type {FinalMaskCache | null} */
let sharedCache = null;

/** The user chose to run without WebGPU (page session) */
let wasmAllowed = false;

/**
 * The app-wide final-mask cache (editor preview and export share it)
 * @returns {FinalMaskCache}
 */
export function getSharedFinalMaskCache() {
  sharedCache ??= createFinalMaskCache();
  return sharedCache;
}

/** @returns {boolean} The user chose to run the model without WebGPU */
export function isWasmAllowed() {
  return wasmAllowed;
}

/**
 * Record the explicit "Run without WebGPU (very slow)" choice
 * @param {boolean} [allowed]
 */
export function setWasmAllowed(allowed = true) {
  wasmAllowed = allowed;
}

/**
 * Probability mask lookup by clip frame index, for one model
 * @param {Frame[]} frames - The whole clip
 * @param {MaskStore} maskStore
 * @param {string} [modelId]
 * @returns {(frameIndex: number) => import('../ai-cutout/preprocess.js').ProbabilityMask | null}
 */
export function getClipProbSource(frames, maskStore, modelId = DEFAULT_MODEL_ID) {
  return (frameIndex) => {
    const frame = frames[frameIndex];
    return frame ? maskStore.get(maskKey(frame, modelId)) : null;
  };
}

/**
 * The tracked objects' mask lookups by clip frame index, in `ai.objects`
 * order (what a final-mask build composes on top of the base masks)
 * @param {Frame[]} frames - The whole clip
 * @param {AiCutout} ai
 * @param {MaskStore} maskStore
 * @returns {import('../../shared/masks/final-masks.js').ObjectMaskInput[]}
 */
export function getClipObjectSources(frames, ai, maskStore) {
  return (ai.objects ?? []).map((object) =>
    isColourObject(object)
      ? {
          id: object.id,
          mode: object.mode,
          getMask: () => null,
          colour: { clicks: object.clicks, tolerance: object.tolerance },
        }
      : {
          id: object.id,
          mode: object.mode,
          getMask: (frameIndex) => {
            const frame = frames[frameIndex];
            return frame ? maskStore.get(objectMaskKey(frame, object.id)) : null;
          },
        },
  );
}

/**
 * A Colour fix-up: removed by colour on every frame, never tracked
 * @param {import('../../shared/edits/model.js').CutoutObject} object
 * @returns {boolean}
 */
export function isColourObject(object) {
  return object.scope === 'colour' && object.mode === 'remove';
}

/** Frames whose pixels stay read (a build reads each frame once; drafts and Show mask re-read the one on screen) */
const PIXEL_CACHE_FRAMES = 4;

/** @type {Map<string, Uint8ClampedArray>} */
const pixelCache = new Map();

/** @type {{ canvas: OffscreenCanvas | HTMLCanvasElement, ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null} */
let pixelCanvas = null;

/**
 * A 2D context to read frame pixels with (null without a canvas)
 * @param {number} width
 * @param {number} height
 */
function getPixelContext(width, height) {
  if (!pixelCanvas) {
    /** @type {OffscreenCanvas | HTMLCanvasElement | null} */
    let canvas = null;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
    else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
    const ctx = /** @type {any} */ (canvas)?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !ctx) return null;
    pixelCanvas = { canvas, ctx };
  }
  const { canvas, ctx } = pixelCanvas;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return ctx;
}

/**
 * The clip's frame pixels at a mask size (what Colour fix-ups read): the
 * frame drawn at that size, RGBA. Null when the frame cannot be drawn.
 * @param {Frame[]} frames - The whole clip
 * @returns {import('../../shared/masks/final-masks.js').PixelSource}
 */
export function getClipPixelSource(frames) {
  return (frameIndex, width, height) => {
    const frame = frames[frameIndex];
    if (!frame?.frame) return null;
    const key = `${frame.id}|${width}x${height}`;
    const hit = pixelCache.get(key);
    if (hit) {
      pixelCache.delete(key);
      pixelCache.set(key, hit);
      return hit;
    }
    const ctx = getPixelContext(width, height);
    if (!ctx) return null;
    /** @type {Uint8ClampedArray} */
    let data;
    try {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(/** @type {any} */ (frame.frame), 0, 0, width, height);
      data = ctx.getImageData(0, 0, width, height).data;
    } catch {
      return null;
    }
    pixelCache.set(key, data);
    while (pixelCache.size > PIXEL_CACHE_FRAMES) {
      pixelCache.delete(/** @type {string} */ (pixelCache.keys().next().value));
    }
    return data;
  };
}

/** Forget the read pixels (a clip's frames were closed) */
export function clearPixelCache() {
  pixelCache.clear();
}

/**
 * The region a Colour fix-up takes on a frame, for Show mask
 * @param {{ frames: Frame[], ai: AiCutout, object: import('../../shared/edits/model.js').CutoutObject, frameIndex: number, maskStore?: MaskStore }} options
 * @returns {import('../../shared/masks/final-masks.js').ProbMask | null}
 */
export function getClipColourRegion({
  frames,
  ai,
  object,
  frameIndex,
  maskStore = getSharedMaskStore(),
}) {
  return getColourRegion(
    {
      frameCount: frames.length,
      getProb: getClipProbSource(frames, maskStore, getAiModelId(ai)),
      ai,
      getPixels: getClipPixelSource(frames),
      sourceWidth: frames[0]?.width,
    },
    {
      id: object.id,
      mode: 'remove',
      getMask: () => null,
      colour: { clicks: object.clicks, tolerance: object.tolerance },
    },
    frameIndex,
  );
}

/**
 * Frames of `range` an object still has to be tracked on: with no mask or
 * unreachable mark of its current clicks and scope (see
 * getStaleObjectFrames). A mask of older clicks or scope does not count,
 * and what eviction or a clear dropped is gone with its marks.
 * @param {Frame[]} frames
 * @param {{ start: number, end: number }} range
 * @param {import('../../shared/edits/model.js').CutoutObject} object
 * @param {import('../ai-cutout/mask-store.js').MaskStore} [maskStore]
 * @param {{ retryLost?: boolean }} [options] - retryLost: frames marked
 *   unreachable count too
 * @returns {number}
 */
export function countUntrackedObjectFrames(
  frames,
  range,
  object,
  maskStore = getSharedMaskStore(),
  options = {},
) {
  if (isColourObject(object)) return 0;
  const tag = getObjectSignature(object);
  return getStaleObjectFrames(frames, range, object.id, tag, maskStore, options).length;
}

/**
 * What a tracked object's masks depend on: its clicks and Whole / Part
 * @param {import('../../shared/edits/model.js').CutoutObject} object
 * @returns {string}
 */
export function getObjectSignature(object) {
  const clicks = object.clicks.map((c) => `${c.frame}:${c.x}:${c.y}:${c.mode}`).join(',');
  const boxes = (object.boxes ?? []).map((b) => `${b.frame}:${b.x0}:${b.y0}:${b.x1}:${b.y1}`);
  return `${object.scope}|${clicks}|${boxes.join(',')}`;
}

/**
 * The objects an export must track before it builds: those with a frame
 * of `range` that has neither a mask nor an unreachable mark of the object
 * as it is now (a run still in flight, cancelled, of older clicks or
 * scope, or evicted). The export queues their tracking behind any run in
 * flight, which it skips if that run covered them.
 * @param {Frame[]} frames
 * @param {{ start: number, end: number }} range
 * @param {import('../../shared/edits/model.js').CutoutObject[]} objects
 * @param {import('../ai-cutout/mask-store.js').MaskStore} [maskStore]
 * @returns {import('../../shared/edits/model.js').CutoutObject[]}
 */
export function getObjectsToTrack(frames, range, objects, maskStore = getSharedMaskStore()) {
  return objects.filter(
    (object) => countUntrackedObjectFrames(frames, range, object, maskStore) > 0,
  );
}

/**
 * What a clip's final masks depend on besides the probability masks. The
 * cache is shared by every clip and screen, so the clip id is part of the
 * key: two clips of the same shape and parameters must never share
 * memoized masks.
 * @param {{ frames: Frame[], ai: AiCutout, clipId?: string }} options
 */
function paramsInputs({ frames, ai, clipId }) {
  return { clipId, frameCount: frames.length, sourceWidth: frames[0]?.width, ai };
}

/**
 * Inputs of a clip's final-mask build
 * @param {{ frames: Frame[], ai: AiCutout, maskStore?: MaskStore, clipId?: string }} options
 */
function buildInputs({ frames, ai, maskStore = getSharedMaskStore(), clipId }) {
  return {
    ...paramsInputs({ frames, ai, clipId }),
    storeVersion: maskStore.version,
    getProb: getClipProbSource(frames, maskStore, getAiModelId(ai)),
    objects: getClipObjectSources(frames, ai, maskStore),
    getPixels: getClipPixelSource(frames),
  };
}

/**
 * Final masks of a clip for these AI parameters (memoized in `cache`)
 * @param {{ frames: Frame[], ai: AiCutout, maskStore?: MaskStore, clipId?: string, cache?: FinalMaskCache, signal?: AbortSignal, onProgress?: (progress: BuildProgress) => void }} options
 * @returns {Promise<MaskSource>}
 * @throws {DOMException} AbortError when `signal` aborts, or when another
 *   build with different inputs supersedes this one in the shared cache
 */
export function buildClipMaskSource({
  frames,
  ai,
  maskStore,
  clipId,
  cache = getSharedFinalMaskCache(),
  signal,
  onProgress,
}) {
  return cache.build({ ...buildInputs({ frames, ai, maskStore, clipId }), signal, onProgress });
}

/** Superseded builds retried before giving up (see buildClipMaskSourceSettled) */
export const MAX_SUPERSEDED_RETRIES = 3;

/**
 * buildClipMaskSource for a caller that must end with masks (the export):
 * when another caller supersedes the shared build, the AbortError is not the
 * user's cancellation, so the build is simply started again. Only an abort
 * of the caller's own `signal` (or repeated supersession) rejects.
 * @param {Parameters<typeof buildClipMaskSource>[0]} options
 * @returns {Promise<MaskSource>}
 */
export async function buildClipMaskSourceSettled(options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await buildClipMaskSource(options);
    } catch (error) {
      if (!isAbortError(error) || options.signal?.aborted || attempt >= MAX_SUPERSEDED_RETRIES) {
        throw error;
      }
    }
  }
}

/**
 * Final masks computed per frame on demand (the preview while an AI slider
 * is dragged; see createDraftMaskSource)
 * @param {{ frames: Frame[], ai: AiCutout, maskStore?: MaskStore, base?: MaskSource | null }} options
 *   base: the last full build (pick selection of the draft)
 * @returns {MaskSource}
 */
export function createClipDraftMaskSource({
  frames,
  ai,
  maskStore = getSharedMaskStore(),
  base = null,
}) {
  return createDraftMaskSource({
    frameCount: frames.length,
    getProb: getClipProbSource(frames, maskStore, getAiModelId(ai)),
    ai,
    objects: getClipObjectSources(frames, ai, maskStore),
    getPixels: getClipPixelSource(frames),
    sourceWidth: frames[0]?.width,
    base,
  });
}

/**
 * The memoized final masks for these inputs, or null (never builds)
 * @param {{ frames: Frame[], ai: AiCutout, maskStore?: MaskStore, clipId?: string, cache?: FinalMaskCache }} options
 * @returns {MaskSource | null}
 */
export function peekClipMaskSource({
  frames,
  ai,
  maskStore,
  clipId,
  cache = getSharedFinalMaskCache(),
}) {
  return cache.peek(buildInputs({ frames, ai, maskStore, clipId }));
}

/**
 * Key of what a final-mask build depends on besides the probability masks
 * (a build with the same key only needs a rerun when masks were added)
 * @param {Frame[]} frames
 * @param {AiCutout} ai
 * @param {string} [clipId]
 * @returns {string}
 */
export function getBuildParamsKey(frames, ai, clipId) {
  return getFinalMaskParamsKey(paramsInputs({ frames, ai, clipId }));
}

/**
 * Analysis coverage of a clip and its selection by one model
 * @param {Frame[]} frames - The whole clip
 * @param {{ start: number, end: number }} range - Selection (inclusive)
 * @param {{ modelId?: string, maskStore?: MaskStore }} [options]
 * @returns {{ selectionFrames: Frame[], pendingInSelection: number, analyzedInClip: number, clipFrames: number }}
 *   pendingInSelection counts distinct frames (holds share one analysis)
 */
export function getAnalysisCoverage(
  frames,
  range,
  { modelId = DEFAULT_MODEL_ID, maskStore = getSharedMaskStore() } = {},
) {
  const selectionFrames = frames.slice(range.start, range.end + 1);
  let analyzedInClip = 0;
  for (const frame of frames) {
    if (maskStore.has(maskKey(frame, modelId))) analyzedInClip++;
  }
  return {
    selectionFrames,
    pendingInSelection: collectPendingFrames(selectionFrames, maskStore, modelId).length,
    analyzedInClip,
    clipFrames: frames.length,
  };
}

/**
 * Whether a frame has a probability mask from one model
 * @param {Frame | null | undefined} frame
 * @param {{ modelId?: string, maskStore?: MaskStore }} [options]
 * @returns {boolean}
 */
export function isFrameAnalyzed(
  frame,
  { modelId = DEFAULT_MODEL_ID, maskStore = getSharedMaskStore() } = {},
) {
  return Boolean(frame) && maskStore.has(maskKey(/** @type {Frame} */ (frame), modelId));
}

/**
 * @typedef {'keep-pick' | 'remove-pick' | 'add-object' | 'remove-object' | 'none'} FixUpKind
 */

/**
 * What a Keep or Remove click becomes (one pair of tools; the app picks
 * the mechanism): Remove on a piece apart from the subject is a remove
 * pick (instant), Remove on the subject itself (something attached to it)
 * a tracked Remove object; Keep on a piece is a keep pick, Keep where the
 * mask is empty a tracked Add object; Remove on nothing does nothing.
 * @param {'none' | 'main' | 'separate'} role - What the click lands on
 * @param {'keep' | 'remove'} tool
 * @returns {FixUpKind}
 */
export function chooseFixUp(role, tool) {
  if (tool === 'keep') return role === 'none' ? 'add-object' : 'keep-pick';
  if (role === 'none') return 'none';
  return role === 'main' ? 'remove-object' : 'remove-pick';
}

/**
 * chooseFixUp for a click on a clip frame, judged on the binary mask the
 * picks read (threshold and smoothing of the build). For Remove with picks
 * the subject is judged after the picks (getSurvivingMask): the picks are
 * tracked up to the frame, so this can take a moment on a long clip.
 * @param {{ frames: Frame[], ai: AiCutout, frameIndex: number, point: { x: number, y: number }, tool: 'keep' | 'remove', maskStore?: MaskStore, signal?: AbortSignal }} options
 * @returns {Promise<FixUpKind>}
 */
export async function classifyFixUp({
  frames,
  ai,
  frameIndex,
  point,
  tool,
  maskStore = getSharedMaskStore(),
  signal,
}) {
  const options = {
    frameCount: frames.length,
    getProb: getClipProbSource(frames, maskStore, getAiModelId(ai)),
    ai,
  };
  const pick = { frame: frameIndex, x: point.x, y: point.y };
  // Keep only needs piece / no piece; without picks the largest raw piece
  // is the subject
  const survivor =
    tool === 'remove' && ai.picks.length > 0
      ? await getSurvivingMask({ ...options, signal }, frameIndex)
      : null;
  return chooseFixUp(getPickedPieceRole(options, pick, survivor), tool);
}

/**
 * Whether a pick on a clip frame lands on a character: the frame's binary
 * mask (same threshold and smoothing as the final-mask build) has a
 * component under the point or within the pick snap radius. A pick that
 * misses would be ignored by the build, so the editor refuses it instead.
 * @param {{ frames: Frame[], ai: AiCutout, frameIndex: number, point: { x: number, y: number }, maskStore?: MaskStore }} options
 *   point: fractions of the source frame
 * @returns {boolean}
 */
export function pickFindsCharacter({
  frames,
  ai,
  frameIndex,
  point,
  maskStore = getSharedMaskStore(),
}) {
  return pickFindsComponent(
    {
      frameCount: frames.length,
      getProb: getClipProbSource(frames, maskStore, getAiModelId(ai)),
      ai,
    },
    { frame: frameIndex, x: point.x, y: point.y },
  );
}

/**
 * Estimated time left of an analysis: measured speed once a frame is done,
 * else the typical speed of the backend (null when unknown)
 * @param {{ framesDone: number, framesTotal: number, elapsedMs: number, backend: 'webgpu' | 'wasm' | null }} progress
 * @returns {number | null}
 */
export function estimateRemainingMs({ framesDone, framesTotal, elapsedMs, backend }) {
  const left = Math.max(0, framesTotal - framesDone);
  if (left === 0) return 0;
  if (framesDone > 0 && elapsedMs > 0) {
    return Math.round((elapsedMs / framesDone) * left);
  }
  return backend ? TYPICAL_FRAME_MS[backend] * left : null;
}

/**
 * Whether a thrown value is a cancellation
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return /** @type {any} */ (error)?.name === 'AbortError';
}

/**
 * Whether an analysis stopped only because it may not run without WebGPU:
 * the browser has no WebGPU (WEBGPU_UNAVAILABLE), or this model could not
 * run on it (WEBGPU_MODEL_FAILED). Both offer the explicit slow choice.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isWasmChoiceError(error) {
  const code = /** @type {any} */ (error)?.code;
  return (
    code === SegmentationErrorCode.WEBGPU_UNAVAILABLE ||
    code === SegmentationErrorCode.WEBGPU_MODEL_FAILED
  );
}

/** User-facing copy per SegmentationErrorCode */
const ERROR_COPY = {
  [SegmentationErrorCode.WEBGPU_UNAVAILABLE]:
    'This browser has no WebGPU, which the fast analysis needs. You can run it without WebGPU instead (very slow).',
  [SegmentationErrorCode.WEBGPU_MODEL_FAILED]:
    'This model could not run on WebGPU in this browser. You can run it without WebGPU instead (very slow).',
  [SegmentationErrorCode.DOWNLOAD_FAILED]:
    'The model could not be downloaded. Check your connection and try again.',
  [SegmentationErrorCode.MODEL_NOT_FOUND]:
    'Couldn’t download the model (not found). Check your connection and try again.',
  [SegmentationErrorCode.MODEL_NOT_CACHED]:
    'The model is not downloaded yet. Analyze downloads it.',
  [SegmentationErrorCode.HASH_MISMATCH]:
    'The downloaded model is damaged or not the expected file, so it was not used. Try again.',
  [SegmentationErrorCode.MODEL_INIT_FAILED]: 'The model could not be started in this browser.',
  [SegmentationErrorCode.INFERENCE_FAILED]: 'Analyzing a frame failed.',
  [SegmentationErrorCode.INVALID_OUTPUT]:
    'The model returned an invalid result for a frame, so the analysis stopped instead of saving an empty cutout. Try another model.',
  [SegmentationErrorCode.WORKER_CRASHED]:
    'The analysis stopped unexpectedly (the browser may be low on memory).',
  [SegmentationErrorCode.FRAME_UNAVAILABLE]:
    'A frame of this clip is no longer available, so it cannot be analyzed.',
};

/**
 * An analysis failure as UI copy
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
export function describeAnalysisError(error) {
  const e = /** @type {any} */ (error);
  const code = typeof e?.code === 'string' ? e.code : 'unknown';
  const copy = /** @type {Record<string, string>} */ (ERROR_COPY)[code];
  const detail = e instanceof Error ? e.message : String(error ?? '');
  if (copy) return { code, message: copy };
  return { code, message: detail ? `The analysis failed: ${detail}` : 'The analysis failed.' };
}

/**
 * Time left as a short phrase
 * @param {number | null} ms
 * @returns {string}
 */
export function formatTimeLeft(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'estimating time left';
  if (ms < 1000) return 'less than a second left';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `about ${seconds} s left`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} min left`;
}

/**
 * One-line description of analysis progress
 * @param {{ phase: string, loadedBytes: number, totalBytes: number, fromCache?: boolean, framesDone: number, framesTotal: number, remainingMs: number | null }} progress
 * @returns {string}
 */
export function describeAnalysisProgress(progress) {
  switch (progress.phase) {
    case 'downloading': {
      if (progress.fromCache) return 'Loading the model from this browser’s cache…';
      const total = progress.totalBytes;
      const pct = total > 0 ? Math.floor((progress.loadedBytes / total) * 100) : 0;
      return `Downloading the model: ${formatModelSize(progress.loadedBytes, 1)} of ${formatModelSize(total, 1)} (${pct}%)`;
    }
    case 'verifying':
      return 'Checking the downloaded model…';
    case 'initializing':
      return 'Starting the model…';
    case 'analyzing':
      return `Analyzed ${progress.framesDone} of ${progress.framesTotal} frames · ${formatTimeLeft(progress.remainingMs)}`;
    default:
      return 'Preparing…';
  }
}

/**
 * Progress bar fraction (0..1) of analysis progress
 * @param {{ phase: string, loadedBytes: number, totalBytes: number, framesDone: number, framesTotal: number }} progress
 * @returns {number}
 */
export function getAnalysisFraction(progress) {
  if (progress.phase === 'downloading') {
    return progress.totalBytes > 0 ? progress.loadedBytes / progress.totalBytes : 0;
  }
  if (progress.phase === 'analyzing') {
    return progress.framesTotal > 0 ? progress.framesDone / progress.framesTotal : 0;
  }
  return 0;
}
