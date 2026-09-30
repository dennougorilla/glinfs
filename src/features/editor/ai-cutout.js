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
  getFinalMaskParamsKey,
  pickFindsComponent,
} from '../../shared/masks/final-masks.js';
import { getSharedMaskStore } from '../ai-cutout/mask-store.js';
import { DEFAULT_MODEL_ID, formatModelSize, getModelEntry } from '../ai-cutout/model-registry.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import { collectPendingFrames, maskKey } from '../ai-cutout/segmentation-manager.js';

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
