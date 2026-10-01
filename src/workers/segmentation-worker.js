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
 * never reloads ORT, reads the file again or re-runs the warm-up. A model
 * read from Cache Storage is not hashed again (see model-loader.js); an
 * 'init' with `cacheOnly` (preloading) never downloads. Every ORT
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
 *
 * A click-to-select (SAM) model has two sessions: its image encoder runs
 * once per frame ('prompt' with a frame not seen yet) and its embedding is
 * kept per frame in a byte-bounded LRU (EMBEDDING_CACHE_BYTES), so a new
 * click, Whole / Part or tracking again after a change only runs the small
 * prompt decoder on frames seen before. The decoder answers four masks at
 * the requested mask size; they go back as 0..255 probabilities and the
 * manager chooses (see click-tracker.js).
 */

import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import * as ort from 'onnxruntime-web/webgpu';
import { createByteLru } from '../features/ai-cutout/byte-lru.js';
import { getSpecFiles } from '../features/ai-cutout/model-config.js';
import {
  evictCachedModel,
  isModelIntact,
  loadModelBytes,
} from '../features/ai-cutout/model-loader.js';
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
import {
  rgbaToHwc,
  runSamDecoder,
  runSamEncoder,
  samDecoderWarmup,
  samEncoderWarmup,
  toCandidates,
} from '../features/ai-cutout/sam-session.js';
import {
  combineBackends,
  createModelSession,
  loadAndCreateSession,
  runModel,
} from '../features/ai-cutout/session-init.js';

/** @typedef {import('../features/ai-cutout/model-config.js').ModelSpec} ModelSpec */

/**
 * A click-to-select prompt on one frame.
 * @typedef {Object} PromptRequest
 * @property {'prompt'} kind
 * @property {number} requestId
 * @property {number} jobId
 * @property {string} modelId
 * @property {string} frameKey - Embedding cache key (pixel identity of the frame)
 * @property {ImageBitmap | null} bitmap - The frame at encoderWidth × encoderHeight
 *   (closed here; unused when the embedding is cached)
 * @property {number} encoderWidth
 * @property {number} encoderHeight
 * @property {number} maskWidth
 * @property {number} maskHeight
 * @property {Float32Array} coords
 * @property {Float32Array} labels
 * @property {Float32Array | null} maskInput
 * @property {boolean} wantLowRes
 */

/**
 * @typedef {Object} SegmentRequest
 * @property {'segment'} [kind]
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

/** @type {(SegmentRequest | PromptRequest)[]} */
const queue = [];

/**
 * Click-to-select image embeddings per model and frame: 48 frames, held as
 * float16 (2 MB each, 4 MB as float32 where Float16Array is missing: 24).
 * A tracking job scopes the embeddings it uses (see byte-lru.js): on a clip
 * longer than the cache, tracking again finds the frames the last job kept
 * instead of none.
 */
export const EMBEDDING_CACHE_BYTES = 96 * 1024 * 1024;

/** Float16Array where the browser has it (Chrome 135+) */
const Half = /** @type {Float32ArrayConstructor | undefined} */ (
  /** @type {any} */ (globalThis).Float16Array
);

/** @type {import('../features/ai-cutout/byte-lru.js').ByteLru<Float32Array>} */
const embeddings = createByteLru(EMBEDDING_CACHE_BYTES, {
  onEvict: (key) => embeddingKeysByModel.get(key.slice(0, key.indexOf('\u0000')))?.delete(key),
});

/** @type {OffscreenCanvas | null} */
let samCanvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let samCtx = null;
/** @type {Float32Array | null} */
let samHwc = null;
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
 * Load one model file and create its session (a damaged cached copy is
 * replaced once: see loadAndCreateSession).
 * @param {Object} options
 * @param {LoadedModel} options.entry
 * @param {import('../features/ai-cutout/model-config.js').ModelFileSpec} options.file
 * @param {number} options.offset - Bytes of the model's files before this one (progress)
 * @param {boolean} options.allowWasm
 * @param {boolean} options.cacheOnly
 * @param {GPUAdapter | null} options.adapter
 * @param {((session: any) => Promise<unknown>) | undefined} options.warmup - SAM graphs
 * @param {{ loadMs: number, createStart: number, lastProgressAt: number }} options.clock
 */
async function loadFileSession({
  entry,
  file,
  offset,
  allowWasm,
  cacheOnly,
  adapter,
  warmup,
  clock,
}) {
  const { spec } = entry;
  const { signal } = entry.controller;
  const modelId = spec.id;
  const result = await loadAndCreateSession({
    signal,
    cacheOnly,
    async load({ skipCache }) {
      const start = performance.now();
      const loaded = await loadModelBytes(file, {
        signal,
        cacheOnly,
        skipCache,
        onProgress(progress) {
          const now = performance.now();
          const final = progress.loadedBytes === progress.totalBytes;
          if (
            progress.phase === 'downloading' &&
            !final &&
            now - clock.lastProgressAt < PROGRESS_INTERVAL_MS
          ) {
            return;
          }
          clock.lastProgressAt = now;
          post({
            type: 'status',
            modelId,
            ...progress,
            loadedBytes: offset + progress.loadedBytes,
            totalBytes: spec.bytes,
          });
        },
      });
      clock.loadMs += performance.now() - start;
      return loaded;
    },
    async create(model) {
      post({
        type: 'status',
        modelId,
        phase: 'initializing',
        loadedBytes: offset + model.bytes.byteLength,
        totalBytes: spec.bytes,
        fromCache: model.fromCache,
      });
      clock.createStart = performance.now();
      const session = await withOrt(async () => {
        if (signal.aborted) throw createAbortError('Model unloaded');
        // Allocated here so the warm-up reuses the buffer every frame fills later
        if (!warmup) getInputContext(spec.inputSize);
        return createModelSession({
          ort: /** @type {any} */ (ort),
          bytes: model.bytes,
          spec,
          adapter,
          allowWasm,
          warmupInput: warmup ? undefined : /** @type {Float32Array} */ (inputTensorData),
          warmup,
        });
      });
      if (signal.aborted) {
        // Unloaded while the session was being created
        await withOrt(() => session.session.release?.() ?? Promise.resolve()).catch(
          () => undefined,
        );
        throw createAbortError('Model unloaded');
      }
      return session;
    },
    onVerify() {
      post({
        type: 'status',
        modelId,
        phase: 'verifying',
        loadedBytes: offset + file.bytes,
        totalBytes: spec.bytes,
        fromCache: true,
      });
    },
    isIntact: (bytes) => isModelIntact(bytes, /** @type {any} */ (file)),
    evict: () => evictCachedModel(/** @type {any} */ (file)),
  });
  if (result.reloaded) {
    console.warn('[segmentation] The cached model was damaged; it was downloaded again');
  }
  if (result.created.webgpuError) {
    console.warn(`[segmentation] ${result.created.webgpuError}; running on WASM`);
  }
  return result;
}

/**
 * Load a model (every file of it) and create its session(s). A SAM model
 * gets an encoder and a decoder session.
 * @param {LoadedModel} entry
 * @param {boolean} allowWasm
 * @param {boolean} cacheOnly - Preloading: never download
 * @returns {Promise<Object>} The 'ready' message
 */
async function initialize(entry, allowWasm, cacheOnly) {
  const { spec } = entry;
  const modelId = spec.id;
  const adapter = await getAdapter();
  if (!adapter && !allowWasm) {
    // Fail before downloading a model (about 90 MB) the user cannot run
    throw new SegmentationError(
      SegmentationErrorCode.WEBGPU_UNAVAILABLE,
      'WebGPU is not available in this browser',
    );
  }

  const sam = spec.kind === 'sam';
  const files = getSpecFiles(spec);
  const clock = { loadMs: 0, createStart: performance.now(), lastProgressAt: 0 };
  /** @type {Awaited<ReturnType<typeof loadFileSession>>[]} */
  const results = [];
  let offset = 0;
  try {
    for (const file of files) {
      const warmup = sam
        ? file.role === 'encoder'
          ? samEncoderWarmup(/** @type {any} */ (ort))
          : samDecoderWarmup(/** @type {any} */ (ort))
        : undefined;
      results.push(
        await loadFileSession({
          entry,
          file,
          offset,
          allowWasm,
          cacheOnly,
          adapter,
          warmup,
          clock,
        }),
      );
      offset += file.bytes;
    }
  } catch (error) {
    // A SAM model whose decoder failed: release the encoder session
    for (const { created } of results) {
      void withOrt(() => created.session.release?.() ?? Promise.resolve()).catch(() => undefined);
    }
    throw error;
  }
  const [first] = results;
  if (sam) {
    const byRole = (/** @type {string} */ role) =>
      /** @type {any} */ (results[files.findIndex((f) => f.role === role)]).created.session;
    entry.session = /** @type {any} */ ({ encoder: byRole('encoder'), decoder: byRole('decoder') });
  } else {
    entry.session = /** @type {any} */ (first.created.session);
  }

  const backend = combineBackends(results.map((r) => r.created.backend));
  return {
    type: 'ready',
    modelId,
    backend,
    adapter: backend === 'webgpu' ? describeAdapter(adapter) : null,
    fromCache: results.every((r) => r.loaded.fromCache),
    cached: results.every((r) => r.loaded.cached),
    timings: {
      loadMs: clock.loadMs,
      createMs: performance.now() - clock.createStart,
      warmupMs: results.reduce((sum, r) => sum + (r.created.warmupMs ?? 0), 0) || null,
    },
  };
}

/**
 * Handle 'init': load a model unless it is loading or loaded already (a
 * loaded one answers with its 'ready' again).
 * @param {ModelSpec} spec
 * @param {boolean} allowWasm
 * @param {boolean} [cacheOnly] - Preloading: fail instead of downloading
 */
function loadModel(spec, allowWasm, cacheOnly = false) {
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
  entry.ready = initialize(entry, allowWasm, cacheOnly).then(
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
  const session = /** @type {any} */ (entry.session);
  entry.session = null;
  if (entry.spec.kind === 'sam') {
    for (const key of [...embeddingKeys(modelId)]) embeddings.delete(key);
  }
  // A session still being created is released by initialize()
  const sessions = session?.encoder ? [session.encoder, session.decoder] : session ? [session] : [];
  for (const one of sessions) {
    void withOrt(() => one.release?.() ?? Promise.resolve()).catch(() => undefined);
  }
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

/** Keys of the embeddings of a model @type {Map<string, Set<string>>} */
const embeddingKeysByModel = new Map();

/**
 * @param {string} modelId
 * @returns {Set<string>}
 */
function embeddingKeys(modelId) {
  let keys = embeddingKeysByModel.get(modelId);
  if (!keys) {
    keys = new Set();
    embeddingKeysByModel.set(modelId, keys);
  }
  return keys;
}

/**
 * The reused encoder input canvas and HWC buffer for a size
 * @param {number} width
 * @param {number} height
 */
function getSamInput(width, height) {
  if (!samCanvas || samCanvas.width !== width || samCanvas.height !== height) {
    samCanvas = new OffscreenCanvas(width, height);
    samCtx = samCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!samHwc || samHwc.length < width * height * 3) samHwc = new Float32Array(width * height * 3);
  if (!samCtx) throw new Error('OffscreenCanvas 2D context unavailable');
  return { ctx: samCtx, hwc: samHwc };
}

/**
 * Run a click-to-select prompt on one frame (encoding it first unless its
 * embedding is cached) and post the four candidate masks.
 * @param {PromptRequest} request
 */
async function prompt(request) {
  const entry = models.get(request.modelId);
  if (!entry) throw new Error(`The model "${request.modelId}" is not loaded`);
  await entry.ready;
  const start = performance.now();
  const key = `${request.modelId}\u0000${request.frameKey}\u0000${request.encoderWidth}x${request.encoderHeight}`;
  const stored = embeddings.get(key, request.jobId);
  const cached = stored !== undefined;
  /** @type {Float32Array | undefined} */
  let embedding = stored && (stored instanceof Float32Array ? stored : new Float32Array(stored));
  let encodeMs = 0;
  if (!embedding) {
    embedding = await withOrt(async () => {
      const session = /** @type {any} */ (entry.session);
      if (!session?.encoder) throw new Error(`The model "${request.modelId}" was unloaded`);
      if (!request.bitmap) throw new Error('Frame bitmap missing');
      const { encoderWidth: w, encoderHeight: h } = request;
      const { ctx, hwc } = getSamInput(w, h);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(request.bitmap, 0, 0, w, h);
      request.bitmap.close();
      request.bitmap = null;
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const encodeStart = performance.now();
      const result = await runSamEncoder(
        /** @type {any} */ (ort),
        session.encoder,
        rgbaToHwc(rgba, w, h, hwc),
        w,
        h,
      );
      encodeMs = performance.now() - encodeStart;
      return result;
    });
    const keep = Half ? new Half(embedding) : embedding;
    if (embeddings.set(key, keep, keep.byteLength, request.jobId))
      embeddingKeys(request.modelId).add(key);
  }
  request.bitmap?.close();
  request.bitmap = null;

  const decodeStart = performance.now();
  const result = await withOrt(async () => {
    const session = /** @type {any} */ (entry.session);
    if (!session?.decoder) throw new Error(`The model "${request.modelId}" was unloaded`);
    return runSamDecoder(/** @type {any} */ (ort), session.decoder, {
      embedding: /** @type {Float32Array} */ (embedding),
      coords: request.coords,
      labels: request.labels,
      maskWidth: request.maskWidth,
      maskHeight: request.maskHeight,
      maskInput: request.maskInput,
      wantLowRes: request.wantLowRes,
    });
  });
  const decodeMs = performance.now() - decodeStart;
  const candidates = toCandidates(result, request.maskWidth, request.maskHeight);
  const buffers = candidates.map((c) => c.data.buffer);
  post(
    {
      type: 'prompt-result',
      requestId: request.requestId,
      width: request.maskWidth,
      height: request.maskHeight,
      masks: buffers,
      scores: candidates.map((c) => c.score),
      lowRes: result.lowRes?.buffer ?? null,
      cached,
      encodeMs,
      decodeMs,
      totalMs: performance.now() - start,
    },
    result.lowRes ? [...buffers, result.lowRes.buffer] : buffers,
  );
}

/** Run queued frames one at a time. */
async function drainQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const request = /** @type {SegmentRequest | PromptRequest} */ (queue.shift());
      try {
        if (request.kind === 'prompt') {
          await prompt(request);
        } else {
          await segment(/** @type {SegmentRequest} */ (request));
        }
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
      loadModel(message.model, Boolean(message.allowWasm), Boolean(message.cacheOnly));
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
    case 'prompt':
      queue.push({
        kind: 'prompt',
        requestId: message.requestId,
        jobId: message.jobId,
        modelId: message.modelId,
        frameKey: message.frameKey,
        bitmap: message.bitmap ?? null,
        encoderWidth: message.encoderWidth,
        encoderHeight: message.encoderHeight,
        maskWidth: message.maskWidth,
        maskHeight: message.maskHeight,
        coords: message.coords,
        labels: message.labels,
        maskInput: message.maskInput ?? null,
        wantLowRes: Boolean(message.wantLowRes),
      });
      void drainQueue();
      break;
    case 'cancel':
      cancelJob(message.jobId);
      break;
  }
};
