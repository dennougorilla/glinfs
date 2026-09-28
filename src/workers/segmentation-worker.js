/**
 * Segmentation Worker
 * Runs the AI cutout model (ONNX Runtime Web) off the main thread.
 * @module workers/segmentation-worker
 *
 * ORT loads only here, so the main bundle never carries it. The WebGPU
 * build (`onnxruntime-web/webgpu`, ORT's native WebGPU execution provider)
 * also contains the CPU/WASM provider, so one binary serves both:
 * - WebGPU when an adapter exists and a WebGPU session can be created AND
 *   survives a warm-up run (see features/ai-cutout/session-init.js);
 * - WASM only when the caller allowed it (GitHub Pages cannot send
 *   COOP/COEP, so it is single-threaded and very slow).
 * One worker runs one model (the spec in its 'init' message: file, input
 * and output names, preprocessing); the manager starts a new worker to
 * switch models.
 * The document CSP does not apply here (a worker takes its policy from its
 * own response), which matters because ORT's WebGPU glue uses `new Function`.
 *
 * The binary is emitted by Vite as an asset (`?url`) and handed to ORT via
 * `env.wasm.wasmPaths`; the JS glue is inlined in the ORT bundle, so no
 * extra module is fetched. `numThreads = 1` and no proxy worker.
 *
 * Frames arrive as transferred ImageBitmaps already scaled (to the mask
 * resolution for a letterbox model, to the square input for a stretch
 * model: drawing either into the input rectangle needs no further loss of
 * detail); this worker owns them and closes each exactly once. It never
 * sees a VideoFrame. Protocol: see features/ai-cutout/protocol.js.
 */

import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import * as ort from 'onnxruntime-web/webgpu';
import { loadModelBytes } from '../features/ai-cutout/model-loader.js';
import {
  computeInputGeometry,
  probabilityToMask,
  rgbaToChw,
} from '../features/ai-cutout/preprocess.js';
import {
  SegmentationError,
  SegmentationErrorCode,
  toErrorPayload,
} from '../features/ai-cutout/protocol.js';
import { createModelSession, runModel } from '../features/ai-cutout/session-init.js';

/** @typedef {import('../features/ai-cutout/model-config.js').ModelSpec} ModelSpec */

/**
 * @typedef {Object} SegmentRequest
 * @property {number} requestId
 * @property {number} jobId
 * @property {ImageBitmap | null} bitmap - Owned by this worker; null once closed
 * @property {number} sourceWidth
 * @property {number} sourceHeight
 * @property {number} maskWidth
 * @property {number} maskHeight
 */

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

/** Minimum interval between download progress messages */
const PROGRESS_INTERVAL_MS = 100;

/** @type {import('onnxruntime-web').InferenceSession | null} */
let session = null;
/** @type {ModelSpec | null} */
let model = null;
/** @type {'webgpu' | 'wasm' | null} */
let backend = null;
/** @type {Promise<void> | null} */
let initPromise = null;

/** @type {SegmentRequest[]} */
const queue = [];
let processing = false;

/** @type {OffscreenCanvas | null} */
let inputCanvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let inputCtx = null;
/** @type {Float32Array | null} */
let inputTensorData = null;

/**
 * @param {Object} message
 * @param {Transferable[]} [transfer]
 */
function post(message, transfer = []) {
  self.postMessage(message, transfer);
}

/**
 * The WebGPU adapter ORT would use, or null.
 * @returns {Promise<GPUAdapter | null>}
 */
async function requestAdapter() {
  const gpu = /** @type {any} */ (self.navigator).gpu;
  if (!gpu) return null;
  try {
    return (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {GPUAdapter | null} adapter
 * @returns {{ vendor: string, architecture: string, description: string } | null}
 */
function describeAdapter(adapter) {
  const info = /** @type {any} */ (adapter)?.info;
  if (!info) return null;
  return {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    description: info.description ?? '',
  };
}

/**
 * Load the model and create the session.
 * @param {ModelSpec} spec
 * @param {boolean} allowWasm
 */
async function initialize(spec, allowWasm) {
  const adapter = await requestAdapter();
  if (!adapter && !allowWasm) {
    // Fail before downloading a model (about 90 MB) the user cannot run
    throw new SegmentationError(
      SegmentationErrorCode.WEBGPU_UNAVAILABLE,
      'WebGPU is not available in this browser',
    );
  }

  const loadStart = performance.now();
  let lastProgressAt = 0;
  const loaded = await loadModelBytes(spec, {
    onProgress(progress) {
      const now = performance.now();
      const final = progress.loadedBytes === progress.totalBytes;
      if (
        progress.phase === 'downloading' &&
        !final &&
        now - lastProgressAt < PROGRESS_INTERVAL_MS
      ) {
        return;
      }
      lastProgressAt = now;
      post({ type: 'status', ...progress });
    },
  });
  const loadMs = performance.now() - loadStart;

  post({
    type: 'status',
    phase: 'initializing',
    loadedBytes: loaded.bytes.byteLength,
    totalBytes: spec.bytes,
    fromCache: loaded.fromCache,
  });

  const createStart = performance.now();
  // Allocated here so the warm-up reuses the buffer every frame fills later
  getInputContext(spec.inputSize);
  const created = await createModelSession({
    ort: /** @type {any} */ (ort),
    bytes: loaded.bytes,
    spec,
    adapter,
    allowWasm,
    warmupInput: /** @type {Float32Array} */ (inputTensorData),
  });
  session = /** @type {any} */ (created.session);
  backend = created.backend;
  if (created.webgpuError) {
    console.warn(`[segmentation] ${created.webgpuError}; running on WASM`);
  }

  model = spec;
  post({
    type: 'ready',
    backend,
    adapter: backend === 'webgpu' ? describeAdapter(adapter) : null,
    fromCache: loaded.fromCache,
    cached: loaded.cached,
    timings: {
      loadMs,
      createMs: performance.now() - createStart,
      warmupMs: created.warmupMs,
    },
  });
}

/**
 * The reused s×s input canvas.
 * @param {number} size
 * @returns {OffscreenCanvasRenderingContext2D}
 */
function getInputContext(size) {
  if (!inputCanvas || inputCanvas.width !== size) {
    inputCanvas = new OffscreenCanvas(size, size);
    inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });
    inputTensorData = new Float32Array(3 * size * size);
  }
  if (!inputCtx) throw new Error('OffscreenCanvas 2D context unavailable');
  return inputCtx;
}

/**
 * Run the model on one frame and post its mask.
 * @param {SegmentRequest} request
 */
async function segment(request) {
  if (!session || !model) throw new Error('Model not initialized');
  const start = performance.now();
  const size = model.inputSize;
  const { preprocess } = model;
  const geometry = computeInputGeometry(
    preprocess.resize,
    request.sourceWidth,
    request.sourceHeight,
    size,
  );

  // Black (zero) canvas, frame scaled into the input rectangle: the centred
  // letterbox rectangle, or the whole square for a stretch
  const ctx = getInputContext(size);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (!request.bitmap) throw new Error('Frame bitmap missing');
  ctx.drawImage(request.bitmap, geometry.padX, geometry.padY, geometry.width, geometry.height);
  request.bitmap.close();
  request.bitmap = null;
  const rgba = ctx.getImageData(0, 0, size, size).data;
  const inputData = rgbaToChw(
    rgba,
    size,
    size,
    /** @type {Float32Array} */ (inputTensorData),
    preprocess,
  );

  const inferenceStart = performance.now();
  const probability = await runModel(/** @type {any} */ (ort), session, model, inputData);
  const inferenceMs = performance.now() - inferenceStart;

  const mask = probabilityToMask(probability, geometry, request.maskWidth, request.maskHeight);
  post(
    {
      type: 'mask',
      requestId: request.requestId,
      width: mask.width,
      height: mask.height,
      data: mask.data.buffer,
      inferenceMs,
      totalMs: performance.now() - start,
    },
    [mask.data.buffer],
  );
}

/** Run queued frames one at a time. */
async function drainQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const request = /** @type {SegmentRequest} */ (queue.shift());
      try {
        await initPromise;
        await segment(request);
      } catch (error) {
        post({
          type: 'segment-error',
          requestId: request.requestId,
          error: toErrorPayload(error, SegmentationErrorCode.INFERENCE_FAILED),
        });
      } finally {
        request.bitmap?.close();
        request.bitmap = null;
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Drop every queued frame of a job (the running one finishes normally).
 * @param {number} jobId
 */
function cancelJob(jobId) {
  const requestIds = [];
  for (let i = queue.length - 1; i >= 0; i--) {
    const request = queue[i];
    if (request.jobId !== jobId) continue;
    queue.splice(i, 1);
    request.bitmap?.close();
    request.bitmap = null;
    requestIds.push(request.requestId);
  }
  if (requestIds.length > 0) post({ type: 'dropped', requestIds });
}

self.onmessage = (event) => {
  const message = event.data;
  switch (message?.type) {
    case 'init':
      if (!initPromise) {
        initPromise = initialize(message.model, Boolean(message.allowWasm));
        initPromise.catch((error) => {
          post({
            type: 'init-error',
            error: toErrorPayload(error, SegmentationErrorCode.MODEL_INIT_FAILED),
          });
        });
      }
      break;
    case 'segment':
      queue.push({
        requestId: message.requestId,
        jobId: message.jobId,
        bitmap: message.bitmap,
        sourceWidth: message.sourceWidth,
        sourceHeight: message.sourceHeight,
        maskWidth: message.maskWidth,
        maskHeight: message.maskHeight,
      });
      void drainQueue();
      break;
    case 'cancel':
      cancelJob(message.jobId);
      break;
  }
};
