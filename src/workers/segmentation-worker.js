/**
 * Segmentation Worker
 * Runs the AI cutout models (ONNX Runtime Web) off the main thread.
 * @module workers/segmentation-worker
 *
 * ORT loads only here, so the main bundle never carries it. The WebGPU
 * build (`onnxruntime-web/webgpu`, ORT's native WebGPU execution provider)
 * also contains the CPU/WASM provider, so one binary serves both:
 * - WebGPU when an adapter exists and a WebGPU session can be created AND
 *   survives a warm-up run (see features/ai-cutout/session-init.js);
 * - WASM only when the caller allowed it (GitHub Pages cannot send
 *   COOP/COEP, so it is single-threaded and very slow).
 *
 * One session per model: each 'init' message loads one model (the spec:
 * file, input and output names, preprocessing) next to the ones already
 * loaded, and 'unload' releases one. Switching between models therefore
 * never reloads ORT, re-verifies the file or re-runs the warm-up. Every ORT
 * call (session creation with its warm-up, a frame's run, a release) goes
 * through one queue: the sessions share the input buffer, and a WebGPU
 * device runs one graph at a time anyway.
 *
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
  createAbortError,
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
 * @property {string} modelId
 * @property {ImageBitmap | null} bitmap - Owned by this worker; null once closed
 * @property {number} sourceWidth
 * @property {number} sourceHeight
 * @property {number} maskWidth
 * @property {number} maskHeight
 */

/**
 * A model loading or loaded in this worker.
 * @typedef {Object} LoadedModel
 * @property {ModelSpec} spec
 * @property {AbortController} controller - Aborted by 'unload'
 * @property {Promise<void>} ready - Settles once the session exists (or failed)
 * @property {import('onnxruntime-web').InferenceSession | null} session
 * @property {Object | null} readyMessage - The 'ready' message, sent again to a repeated 'init'
 */

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

/** Minimum interval between download progress messages */
const PROGRESS_INTERVAL_MS = 100;

/** Models by id @type {Map<string, LoadedModel>} */
const models = new Map();

/** @type {Promise<GPUAdapter | null> | null} */
let adapterPromise = null;

/** Tail of the ORT call queue @type {Promise<unknown>} */
let ortTail = Promise.resolve();

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
 * Run `task` after every ORT call queued before it.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withOrt(task) {
  const run = ortTail.then(task);
  ortTail = run.catch(() => undefined);
  return run;
}

/**
 * The WebGPU adapter ORT would use, or null (asked once).
 * @returns {Promise<GPUAdapter | null>}
 */
function getAdapter() {
  adapterPromise ??= (async () => {
    const gpu = /** @type {any} */ (self.navigator).gpu;
    if (!gpu) return null;
    try {
      return (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? null;
    } catch {
      return null;
    }
  })();
  return adapterPromise;
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
 * Load a model and create its session.
 * @param {LoadedModel} entry
 * @param {boolean} allowWasm
 * @returns {Promise<Object>} The 'ready' message
 */
async function initialize(entry, allowWasm) {
  const { spec } = entry;
  const { signal } = entry.controller;
  const modelId = spec.id;
  const adapter = await getAdapter();
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
    signal,
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
      post({ type: 'status', modelId, ...progress });
    },
  });
  const loadMs = performance.now() - loadStart;

  post({
    type: 'status',
    modelId,
    phase: 'initializing',
    loadedBytes: loaded.bytes.byteLength,
    totalBytes: spec.bytes,
    fromCache: loaded.fromCache,
  });

  const createStart = performance.now();
  const created = await withOrt(async () => {
    if (signal.aborted) throw createAbortError('Model unloaded');
    // Allocated here so the warm-up reuses the buffer every frame fills later
    getInputContext(spec.inputSize);
    return createModelSession({
      ort: /** @type {any} */ (ort),
      bytes: loaded.bytes,
      spec,
      adapter,
      allowWasm,
      warmupInput: /** @type {Float32Array} */ (inputTensorData),
    });
  });
  if (signal.aborted) {
    // Unloaded while the session was being created
    await withOrt(() => created.session.release?.() ?? Promise.resolve()).catch(() => undefined);
    throw createAbortError('Model unloaded');
  }
  entry.session = /** @type {any} */ (created.session);
  if (created.webgpuError) {
    console.warn(`[segmentation] ${created.webgpuError}; running on WASM`);
  }

  return {
    type: 'ready',
    modelId,
    backend: created.backend,
    adapter: created.backend === 'webgpu' ? describeAdapter(adapter) : null,
    fromCache: loaded.fromCache,
    cached: loaded.cached,
    timings: {
      loadMs,
      createMs: performance.now() - createStart,
      warmupMs: created.warmupMs,
    },
  };
}

/**
 * Handle 'init': load a model unless it is loading or loaded already (a
 * loaded one answers with its 'ready' again).
 * @param {ModelSpec} spec
 * @param {boolean} allowWasm
 */
function loadModel(spec, allowWasm) {
  const existing = models.get(spec.id);
  if (existing) {
    if (existing.readyMessage) post(existing.readyMessage);
    return;
  }
  /** @type {LoadedModel} */
  const entry = {
    spec,
    controller: new AbortController(),
    ready: Promise.resolve(),
    session: null,
    readyMessage: null,
  };
  models.set(spec.id, entry);
  entry.ready = initialize(entry, allowWasm).then(
    (message) => {
      entry.readyMessage = message;
      post(message);
    },
    (error) => {
      if (models.get(spec.id) === entry) models.delete(spec.id);
      // An unloaded model's failure concerns nobody
      if (!entry.controller.signal.aborted) {
        post({
          type: 'init-error',
          modelId: spec.id,
          error: toErrorPayload(error, SegmentationErrorCode.MODEL_INIT_FAILED),
        });
      }
      throw error;
    },
  );
  entry.ready.catch(() => undefined);
}

/**
 * Handle 'unload': stop loading a model, or release its session.
 * @param {string} modelId
 */
function unloadModel(modelId) {
  const entry = models.get(modelId);
  if (!entry) return;
  models.delete(modelId);
  entry.controller.abort();
  const session = entry.session;
  entry.session = null;
  // A session still being created is released by initialize()
  if (session) void withOrt(() => session.release?.() ?? Promise.resolve()).catch(() => undefined);
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
 * Run a model on one frame and post its mask.
 * @param {SegmentRequest} request
 */
async function segment(request) {
  const entry = models.get(request.modelId);
  if (!entry) throw new Error(`The model "${request.modelId}" is not loaded`);
  await entry.ready;
  const { spec: model } = entry;
  const start = performance.now();
  const size = model.inputSize;
  const { preprocess } = model;
  const geometry = computeInputGeometry(
    preprocess.resize,
    request.sourceWidth,
    request.sourceHeight,
    size,
  );

  const { probability, inferenceMs } = await withOrt(async () => {
    const session = entry.session;
    if (!session) throw new Error(`The model "${request.modelId}" was unloaded`);
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
    const output = await runModel(/** @type {any} */ (ort), session, model, inputData);
    return { probability: output, inferenceMs: performance.now() - inferenceStart };
  });

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
      loadModel(message.model, Boolean(message.allowWasm));
      break;
    case 'unload':
      unloadModel(message.modelId);
      break;
    case 'segment':
      queue.push({
        requestId: message.requestId,
        jobId: message.jobId,
        modelId: message.modelId,
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
