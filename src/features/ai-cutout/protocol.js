/**
 * Segmentation worker protocol and errors
 * @module features/ai-cutout/protocol
 *
 * Shared by the main-thread manager and the segmentation worker (kept free of
 * ORT and DOM code so both sides can import it).
 *
 * Manager -> worker:
 *   { type: 'init', model: ModelSpec, allowWasm: boolean }
 *   { type: 'segment', requestId, jobId, bitmap (transferred), sourceWidth,
 *     sourceHeight, maskWidth, maskHeight }
 *   { type: 'cancel', jobId }  - drop that job's queued frames
 *
 * Worker -> manager:
 *   { type: 'status', phase: 'downloading' | 'verifying' | 'initializing',
 *     loadedBytes, totalBytes, fromCache }
 *   { type: 'ready', backend: 'webgpu' | 'wasm', adapter, fromCache, timings }
 *   { type: 'init-error', error: ErrorPayload }
 *   { type: 'mask', requestId, width, height, data (ArrayBuffer, transferred),
 *     inferenceMs, totalMs }
 *   { type: 'segment-error', requestId, error: ErrorPayload }
 *   { type: 'dropped', requestIds }  - frames removed by 'cancel' (bitmaps closed)
 */

/**
 * Why an analysis failed. The UI maps each code to its own copy.
 * @readonly
 * @enum {string}
 */
export const SegmentationErrorCode = Object.freeze({
  /** No usable WebGPU adapter/session and the WASM fallback was not allowed */
  WEBGPU_UNAVAILABLE: 'webgpu-unavailable',
  /** The model could not be downloaded (network error, HTTP error) */
  DOWNLOAD_FAILED: 'download-failed',
  /** The downloaded model's size or SHA-256 is not the pinned one */
  HASH_MISMATCH: 'hash-mismatch',
  /** ONNX Runtime could not load or create a session for the model */
  MODEL_INIT_FAILED: 'model-init-failed',
  /** Running the model on a frame failed */
  INFERENCE_FAILED: 'inference-failed',
  /** The worker crashed or could not start */
  WORKER_CRASHED: 'worker-crashed',
  /** A frame's pixels are gone (closed VideoFrame) */
  FRAME_UNAVAILABLE: 'frame-unavailable',
});

/**
 * Serializable error shape carried in worker messages.
 * @typedef {Object} ErrorPayload
 * @property {string} code - A SegmentationErrorCode
 * @property {string} message
 */

/** An analysis failure with a machine-readable `code`. */
export class SegmentationError extends Error {
  /**
   * @param {string} code - A SegmentationErrorCode
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SegmentationError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Turn any thrown value into a message payload.
 * @param {unknown} error
 * @param {string} fallbackCode - Code for errors that are not SegmentationErrors
 * @returns {ErrorPayload}
 */
export function toErrorPayload(error, fallbackCode) {
  if (error instanceof SegmentationError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message };
}

/**
 * Rebuild a SegmentationError from a message payload.
 * @param {ErrorPayload | undefined} payload
 * @param {string} fallbackCode
 * @returns {SegmentationError}
 */
export function fromErrorPayload(payload, fallbackCode) {
  return new SegmentationError(
    payload?.code ?? fallbackCode,
    payload?.message ?? 'Segmentation failed',
  );
}

/**
 * The AbortError every cancelled analysis rejects with.
 * @param {string} [message]
 * @returns {DOMException}
 */
export function createAbortError(message = 'Analysis cancelled') {
  return new DOMException(message, 'AbortError');
}
