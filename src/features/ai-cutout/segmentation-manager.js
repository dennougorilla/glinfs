/**
 * Segmentation manager (main thread)
 * @module features/ai-cutout/segmentation-manager
 *
 * Owns the segmentation worker: creates it on the first analysis that has
 * something to do (so ORT and the model never load before the user asks),
 * feeds it frames and writes the returned probability masks into the mask
 * store. Masks are keyed by (model, frame) — see maskKey — so the anime and
 * the general model never read each other's masks. Frames whose mask for
 * the requested model already exists are skipped, deduped by
 * `frame.sharedKey ?? frame.id` (imported holds share pixels, so they share
 * one mask).
 *
 * preloadModel() creates a model's session ahead of the first analysis
 * (the editor calls it at idle time for a model that is already
 * downloaded); it never downloads: the worker loads it with `cacheOnly`.
 *
 * One worker keeps one session per model it has loaded, so switching
 * between models never reloads ORT, reads the file again or re-runs the
 * warm-up. Two exceptions free memory instead: a WASM session (it shares
 * the worker's heap with any other session) is unloaded before another
 * model loads, and the worker stops once no model is loaded any more.
 * Unloading a model waits for its frames still in the worker — a cancelled
 * job's finished frames are valid masks that the manager keeps.
 *
 * FRAME OWNERSHIP: the manager never closes, clones or transfers a
 * VideoFrame. For each frame it creates an ImageBitmap (scaled to the mask
 * resolution for a letterbox model, to the square model input for a stretch
 * model) and transfers that bitmap to the worker, which closes it. A
 * bitmap that cannot be sent (cancelled job, dead worker) is closed here.
 * At most MAX_FRAMES_IN_FLIGHT bitmaps exist at a time.
 */

import { getDrawableSource } from '../../shared/utils/canvas.js';
import { getSharedMaskStore } from './mask-store.js';
import { DEFAULT_MODEL_ID, getModelSpec, getSpecFiles } from './model-config.js';
import { requestPersistentStorage } from './model-storage.js';
import { computeMaskSize } from './preprocess.js';
import {
  createAbortError,
  fromErrorPayload,
  SegmentationError,
  SegmentationErrorCode,
} from './protocol.js';

/**
 * @typedef {import('../capture/types.js').Frame} Frame
 * @typedef {import('./mask-store.js').MaskStore} MaskStore
 * @typedef {import('./model-config.js').ModelSpec} ModelSpec
 */

/**
 * @typedef {'webgpu' | 'wasm'} SegmentationBackend
 */

/**
 * @typedef {Object} AnalysisProgress
 * @property {'downloading' | 'verifying' | 'initializing' | 'analyzing'} phase
 * @property {number} loadedBytes - Model bytes downloaded so far
 * @property {number} totalBytes - Model size
 * @property {boolean} fromCache - The model came from Cache Storage
 * @property {number} framesDone - Frames analyzed in this call
 * @property {number} framesTotal - Frames this call has to analyze
 * @property {SegmentationBackend | null} backend
 * @property {number | null} frameMs - Worker time for the frame that just finished
 */

/**
 * @typedef {Object} AnalyzeOptions
 * @property {(progress: AnalysisProgress) => void} [onProgress]
 * @property {AbortSignal} [signal] - Aborting rejects with an AbortError and
 *   drops the frames still queued in the worker (finished masks are kept)
 * @property {boolean} [allowWasm=false] - Run on the slow WASM fallback when
 *   WebGPU is unavailable (ask the user first)
 * @property {string} [clipId] - Mask store group (so a deleted clip's masks can be dropped)
 * @property {string} [modelId] - Registry id of the model to run (default: the anime model)
 */

/**
 * @typedef {Object} AnalyzeResult
 * @property {number} analyzed - Frames run through the model
 * @property {number} skipped - Frames whose mask already existed (or shared another frame's)
 * @property {SegmentationBackend | null} backend
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} webgpu - A WebGPU adapter is available
 */

/**
 * @typedef {Object} ReadyInfo
 * @property {string} modelId - The model the session runs
 * @property {SegmentationBackend} backend
 * @property {{ vendor: string, architecture: string, description: string } | null} adapter
 * @property {boolean} fromCache
 * @property {number} modelBytes - Size of the loaded model
 * @property {'letterbox' | 'stretch'} resize - How frames become the model input
 * @property {number} inputSize - Side of the square model input
 * @property {{ loadMs: number, createMs: number, warmupMs?: number | null }} timings
 */

/**
 * @typedef {Object} SegmentationManagerOptions
 * @property {MaskStore} [maskStore]
 * @property {() => Worker} [createWorker]
 * @property {(source: CanvasImageSource, width: number, height: number) => Promise<ImageBitmap>} [createBitmap]
 * @property {(modelId: string) => ModelSpec} [getModelSpec]
 * @property {Navigator} [navigatorImpl] - For getCapabilities()
 * @property {() => Promise<unknown>} [persistStorage] - Called after the
 *   worker downloaded and cached a model (asks for persistent storage)
 */

/** Frames handed to the worker ahead of the one being analyzed */
export const MAX_FRAMES_IN_FLIGHT = 2;

/**
 * DEV/E2E override of the model specs: `sha256`/`bytes` apply to every
 * single-file model unless `models[id]` names that model's own (the stubs;
 * a multi-file model names each file's in `models[id].files`), `allowWasm`
 * runs the WASM fallback without asking, `fetchAllOutputs` makes the
 * worker fetch every graph output (to measure what side outputs cost).
 * @typedef {Object} DevModelOverride
 * @property {string} [sha256]
 * @property {number} [bytes]
 * @property {Record<string, { sha256?: string, bytes?: number, files?: { sha256?: string, bytes?: number }[] }>} [models]
 * @property {boolean} [allowWasm]
 * @property {boolean} [fetchAllOutputs]
 */

/**
 * DEV-only override set by the E2E test hook (see test-hooks.js). Every
 * read is behind `import.meta.env.DEV`, so production builds ignore it.
 * @type {DevModelOverride | null}
 */
let devModelOverride = null;

/**
 * DEV/E2E only: override the expected model sizes/hashes and allow WASM.
 * Takes effect for models loaded afterwards (call dispose() first to
 * re-init).
 * @param {DevModelOverride | null} override
 */
export function setDevModelOverride(override) {
  if (!import.meta.env.DEV) {
    throw new Error('setDevModelOverride is only available in development builds');
  }
  devModelOverride = override;
}

/**
 * `spec` with the DEV override applied (the stubs' sizes and hashes).
 * @param {ModelSpec} spec
 * @param {DevModelOverride} override
 * @returns {ModelSpec}
 */
export function applyModelOverride(spec, override) {
  const own = override.models?.[spec.id];
  const fetchAllOutputs = Boolean(override.fetchAllOutputs);
  const specFiles = getSpecFiles(spec);
  if (specFiles.length > 1) {
    const files = specFiles.map((file, i) => ({
      ...file,
      sha256: own?.files?.[i]?.sha256 ?? file.sha256,
      bytes: own?.files?.[i]?.bytes ?? file.bytes,
    }));
    return {
      ...spec,
      files,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      fetchAllOutputs,
    };
  }
  const sha256 = own?.sha256 ?? override.sha256 ?? spec.sha256;
  const bytes = own?.bytes ?? override.bytes ?? spec.bytes;
  return {
    ...spec,
    sha256,
    bytes,
    files: specFiles.map((file) => ({ ...file, sha256: sha256 ?? file.sha256, bytes })),
    fetchAllOutputs,
  };
}

/**
 * The spec a model loads with: `spec` itself, or in DEV the E2E override
 * applied to it (the stubs' size and hash).
 * @param {ModelSpec} spec
 * @param {boolean} [allowWasm]
 * @returns {{ spec: ModelSpec, allowWasm: boolean }}
 */
function applyDevOverride(spec, allowWasm = false) {
  if (!import.meta.env.DEV || !devModelOverride) return { spec, allowWasm };
  return {
    spec: applyModelOverride(spec, devModelOverride),
    allowWasm: allowWasm || Boolean(devModelOverride.allowWasm),
  };
}

/**
 * The spec a registered model loads with (the DEV override applied): its
 * SHA-256 is the one its Cache Storage key holds.
 * @param {string} modelId
 * @returns {ModelSpec}
 */
export function resolveModelSpec(modelId) {
  return applyDevOverride(getModelSpec(modelId)).spec;
}

/**
 * Pixel identity of a frame (imported holds share one).
 * @param {Frame} frame
 * @returns {string}
 */
export function frameKey(frame) {
  return frame.sharedKey ?? frame.id;
}

/**
 * Mask store key of a frame's mask made by one model. Every mask lookup and
 * write goes through this, so two models never share a mask.
 * @param {Frame} frame
 * @param {string} [modelId]
 * @returns {string}
 */
export function maskKey(frame, modelId = DEFAULT_MODEL_ID) {
  return `${modelId}:${frameKey(frame)}`;
}

/**
 * Frames that still need a mask from `modelId`: one per key, skipping keys
 * already stored.
 * @param {Frame[]} frames
 * @param {{ has: (key: string) => boolean }} maskStore
 * @param {string} [modelId]
 * @returns {{ key: string, frame: Frame }[]}
 */
export function collectPendingFrames(frames, maskStore, modelId = DEFAULT_MODEL_ID) {
  const seen = new Set();
  const pending = [];
  for (const frame of frames) {
    const key = maskKey(frame, modelId);
    if (seen.has(key) || maskStore.has(key)) continue;
    seen.add(key);
    pending.push({ key, frame });
  }
  return pending;
}

/**
 * Resolve with `promise`, or reject with an AbortError as soon as `signal`
 * aborts.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** @returns {Worker} */
function createSegmentationWorker() {
  return new Worker(new URL('../../workers/segmentation-worker.js', import.meta.url), {
    type: 'module',
  });
}

/**
 * @param {CanvasImageSource} source
 * @param {number} width
 * @param {number} height
 * @returns {Promise<ImageBitmap>}
 */
function createScaledBitmap(source, width, height) {
  return createImageBitmap(/** @type {ImageBitmapSource} */ (source), {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });
}

/**
 * @typedef {Object} PendingRequest
 * @property {(result: { totalMs: number, inferenceMs: number }) => void} resolve
 * @property {(error: unknown) => void} reject
 * @property {string} key
 * @property {string | undefined} clipId
 * @property {string} modelId
 * @property {Promise<unknown>} [done] - Settles with the request
 */

/**
 * A model loading or loaded in the worker.
 * @typedef {Object} ModelSlot
 * @property {ModelSpec} spec
 * @property {Promise<ReadyInfo>} ready
 * @property {ReadyInfo | null} info - Set once the session is ready
 * @property {(info: ReadyInfo) => void} resolve
 * @property {(error: unknown) => void} reject
 * @property {((progress: AnalysisProgress) => void) | null} onProgress - Load progress of the analysis waiting for it
 */

/** Main-thread front of the segmentation worker. */
export class SegmentationManager {
  /** @param {SegmentationManagerOptions} [options] */
  constructor(options = {}) {
    this.#maskStore = options.maskStore ?? getSharedMaskStore();
    this.#createWorker = options.createWorker ?? createSegmentationWorker;
    this.#createBitmap = options.createBitmap ?? createScaledBitmap;
    this.#getModelSpec = options.getModelSpec ?? ((modelId) => getModelSpec(modelId));
    this.#navigator = options.navigatorImpl ?? globalThis.navigator;
    this.#persistStorage = options.persistStorage ?? (() => requestPersistentStorage());
  }

  /** @type {() => Promise<unknown>} */
  #persistStorage;
  /** @type {Set<() => void>} */
  #modelListeners = new Set();

  /** @type {MaskStore} */
  #maskStore;
  /** @type {() => Worker} */
  #createWorker;
  /** @type {(source: CanvasImageSource, width: number, height: number) => Promise<ImageBitmap>} */
  #createBitmap;
  /** @type {(modelId: string) => ModelSpec} */
  #getModelSpec;
  /** @type {Navigator | undefined} */
  #navigator;

  /** @type {Worker | null} */
  #worker = null;
  /** Models loading or loaded in the worker @type {Map<string, ModelSlot>} */
  #slots = new Map();
  /** Analyses queued or running, per model @type {Map<string, number>} */
  #busy = new Map();
  /** @type {Set<() => void>} */
  #busyListeners = new Set();
  /** Session of the last analysis @type {ReadyInfo | null} */
  #lastReady = null;
  /** @type {Map<number, PendingRequest>} */
  #requests = new Map();
  /**
   * Cancelled jobs whose requests are still settling (a job id leaves once
   * every request it submitted has settled)
   * @type {Set<number>}
   */
  #cancelledJobs = new Set();
  #requestSeq = 0;
  #jobSeq = 0;
  /** Serializes analyzeFrames calls @type {Promise<unknown>} */
  #tail = Promise.resolve();
  /** @type {Promise<Capabilities> | null} */
  #capabilities = null;
  /**
   * Clips released for good (see forgetClip). Clip ids are never reused,
   * so an id stays here for the page session (one short string per
   * deleted clip).
   * @type {Set<string>}
   */
  #releasedClips = new Set();

  /** The backend the last analysis ran on, or null before the first one. */
  get backend() {
    return this.#lastReady?.backend ?? null;
  }

  /** Details of the model session the last analysis ran with, or null. */
  get readyInfo() {
    return this.#lastReady;
  }

  /**
   * Details of a model's session once it is ready, or null.
   * @param {string} modelId
   * @returns {ReadyInfo | null}
   */
  getReadyInfo(modelId) {
    return this.#slots.get(modelId)?.info ?? null;
  }

  /** The mask store results are written to. */
  get maskStore() {
    return this.#maskStore;
  }

  /** Cancelled jobs with requests still settling (diagnostics). */
  get cancelledJobCount() {
    return this.#cancelledJobs.size;
  }

  /** Models loading or loaded in the worker. */
  get loadedModelIds() {
    return [...this.#slots.keys()];
  }

  /**
   * Whether an analysis with this model is queued or running (its file
   * must not be deleted meanwhile).
   * @param {string} modelId
   * @returns {boolean}
   */
  isModelBusy(modelId) {
    return (this.#busy.get(modelId) ?? 0) > 0;
  }

  /**
   * Call `listener` whenever a model becomes busy or idle.
   * @param {() => void} listener
   * @returns {() => void} Unsubscribe
   */
  onBusyChange(listener) {
    this.#busyListeners.add(listener);
    return () => {
      this.#busyListeners.delete(listener);
    };
  }

  /**
   * Release a model's session when no analysis uses it (its file was
   * deleted: free the session's memory too). Its frames still in the
   * worker finish first; the worker stops when no other model is loaded.
   * @param {string} modelId
   * @returns {boolean} The model was loaded and is being released
   */
  unloadModel(modelId) {
    if (!this.#slots.has(modelId) || this.isModelBusy(modelId)) return false;
    void this.#releaseSlot(modelId, createAbortError('Model unloaded'));
    return true;
  }

  /**
   * Call `listener` whenever a model's session becomes ready or is released
   * (Settings shows "Loaded", the editor "Ready").
   * @param {() => void} listener
   * @returns {() => void} Unsubscribe
   */
  onModelStateChange(listener) {
    this.#modelListeners.add(listener);
    return () => {
      this.#modelListeners.delete(listener);
    };
  }

  #notifyModelState() {
    for (const listener of [...this.#modelListeners]) listener();
  }

  /**
   * Create a model's session ahead of its first analysis, from its cached
   * copy only (never downloads). Does nothing when the model is loading or
   * loaded already, while an analysis runs, when another model runs on WASM
   * (it would have to be unloaded), or when the model could only run on
   * WASM without the user's choice. A failure is silent: the slot is
   * released and the next analysis loads the model as usual.
   * @param {string} modelId
   * @param {{ allowWasm?: boolean }} [options]
   * @returns {Promise<boolean>} The session is ready
   */
  async preloadModel(modelId, { allowWasm = false } = {}) {
    if (this.#slots.has(modelId)) {
      return (
        this.#slots.get(modelId)?.ready.then(
          () => true,
          () => false,
        ) ?? false
      );
    }
    if (this.#busy.size > 0) return false;
    if ([...this.#slots.values()].some((slot) => slot.info?.backend === 'wasm')) return false;
    const resolved = applyDevOverride(this.#getModelSpec(modelId), allowWasm);
    if (!resolved.allowWasm && !(await this.getCapabilities()).webgpu) return false;
    // Re-checked: an analysis may have started or loaded it meanwhile
    if (this.#slots.has(modelId) || this.#busy.size > 0) return false;
    const slot = this.#loadModel(modelId, allowWasm, { cacheOnly: true });
    try {
      await slot.ready;
      return true;
    } catch (error) {
      if (this.#slots.get(modelId) === slot && !slot.info) void this.#releaseSlot(modelId, error);
      return false;
    }
  }

  /**
   * @param {string} modelId
   * @param {1 | -1} delta
   */
  #markBusy(modelId, delta) {
    const count = (this.#busy.get(modelId) ?? 0) + delta;
    if (count > 0) {
      this.#busy.set(modelId, count);
    } else {
      this.#busy.delete(modelId);
    }
    // Only the busy <-> idle transitions matter to listeners
    if (count === 0 || (count === 1 && delta === 1)) {
      for (const listener of [...this.#busyListeners]) listener();
    }
  }

  /**
   * Whether WebGPU is available (checked once).
   * @returns {Promise<Capabilities>}
   */
  getCapabilities() {
    this.#capabilities ??= (async () => {
      const gpu = /** @type {any} */ (this.#navigator)?.gpu;
      if (!gpu) return { webgpu: false };
      try {
        return { webgpu: Boolean(await gpu.requestAdapter()) };
      } catch {
        return { webgpu: false };
      }
    })();
    return this.#capabilities;
  }

  /**
   * Analyze every frame that has no mask yet and store the results. Calls
   * run one after another; a call that finds nothing to do never starts the
   * worker or downloads the model. A call waiting for an earlier one rejects
   * as soon as its signal aborts (the earlier call keeps running, and later
   * calls still wait for it).
   * @param {Frame[]} frames
   * @param {AnalyzeOptions} [options]
   * @returns {Promise<AnalyzeResult>}
   */
  analyzeFrames(frames, options = {}) {
    const modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.#markBusy(modelId, 1);
    const previous = this.#tail;
    const run = raceAbort(previous, options.signal).then(() =>
      this.#analyze(frames, { ...options, modelId }),
    );
    // The queue moves on only once both this call and the one it waited
    // for have settled: an abort while waiting must not let the next call
    // overtake a run that is still going
    this.#tail = Promise.allSettled([previous, run]);
    const settle = () => this.#markBusy(modelId, -1);
    run.then(settle, settle);
    return run;
  }

  /**
   * @param {Frame[]} frames
   * @param {AnalyzeOptions} options
   * @returns {Promise<AnalyzeResult>}
   */
  async #analyze(
    frames,
    { onProgress, signal, allowWasm = false, clipId, modelId = DEFAULT_MODEL_ID } = {},
  ) {
    if (signal?.aborted) throw createAbortError();
    const pending = collectPendingFrames(frames, this.#maskStore, modelId);
    const skipped = frames.length - pending.length;
    if (pending.length === 0) {
      return {
        analyzed: 0,
        skipped,
        backend: this.#slots.get(modelId)?.info?.backend ?? null,
      };
    }

    const ready = await this.#ensureReady(modelId, allowWasm, onProgress, signal, pending.length);
    this.#lastReady = ready;
    const jobId = ++this.#jobSeq;
    let framesDone = 0;
    /** @param {number | null} frameMs */
    const report = (frameMs) =>
      onProgress?.({
        phase: 'analyzing',
        loadedBytes: ready.modelBytes,
        totalBytes: ready.modelBytes,
        fromCache: ready.fromCache,
        framesDone,
        framesTotal: pending.length,
        backend: ready.backend,
        frameMs,
      });
    report(null);

    /** @type {Promise<{ totalMs: number }>[]} */
    const inflight = [];
    let next = 0;
    try {
      while (framesDone < pending.length) {
        while (inflight.length < MAX_FRAMES_IN_FLIGHT && next < pending.length) {
          const request = this.#submitFrame(jobId, pending[next++], clipId, ready);
          request.catch(() => undefined); // awaited below, in order
          inflight.push(request);
        }
        // Stays in `inflight` until it settles, so a cancel can wait for it
        const result = await raceAbort(inflight[0], signal);
        inflight.shift();
        framesDone++;
        report(result.totalMs);
      }
    } catch (error) {
      this.#cancelJob(jobId, inflight);
      if (
        error instanceof SegmentationError &&
        error.code === SegmentationErrorCode.INFERENCE_FAILED
      ) {
        // The session may be unusable (e.g. a lost WebGPU device, which ORT
        // never re-creates, and which every session shares): start a fresh
        // worker on the next call. The model then loads from Cache Storage,
        // so a retry stays cheap.
        this.#teardown(error);
      }
      throw error;
    }
    return { analyzed: pending.length, skipped, backend: ready.backend };
  }

  /**
   * The ready session of `modelId`: loaded once in the worker (started on
   * first use) and kept for later analyses.
   * @param {string} modelId
   * @param {boolean} allowWasm
   * @param {((progress: AnalysisProgress) => void) | undefined} onProgress
   * @param {AbortSignal | undefined} signal
   * @param {number} framesTotal
   * @returns {Promise<ReadyInfo>}
   */
  async #ensureReady(modelId, allowWasm, onProgress, signal, framesTotal) {
    let slot = this.#slots.get(modelId);
    if (slot?.info) return slot.info;
    if (!slot) {
      // A WASM session shares the worker's memory with any other session:
      // unload it (once its frames settled) before loading another model
      const wasm = [...this.#slots]
        .filter(([id, other]) => id !== modelId && other.info?.backend === 'wasm')
        .map(([id]) => this.#releaseSlot(id, createAbortError('Switching models')));
      if (wasm.length > 0) await raceAbort(Promise.all(wasm), signal);
      slot = this.#slots.get(modelId) ?? this.#loadModel(modelId, allowWasm);
    }
    /** @param {AnalysisProgress} progress */
    const progress = (progress) => onProgress?.({ ...progress, framesTotal });
    slot.onProgress = progress;
    try {
      return await raceAbort(slot.ready, signal);
    } catch (error) {
      if (this.#slots.get(modelId) === slot && !slot.info) {
        // Cancelled download or failed init: the worker stops loading it,
        // and the next call starts over
        void this.#releaseSlot(modelId, error);
      }
      throw error;
    } finally {
      if (slot.onProgress === progress) slot.onProgress = null;
    }
  }

  /**
   * Ask the worker (started if needed) to load a model.
   * @param {string} modelId
   * @param {boolean} allowWasm
   * @param {{ cacheOnly?: boolean }} [options] - cacheOnly: never download (preload)
   * @returns {ModelSlot}
   */
  #loadModel(modelId, allowWasm, { cacheOnly = false } = {}) {
    const resolved = applyDevOverride(this.#getModelSpec(modelId), allowWasm);
    /** @type {(info: ReadyInfo) => void} */
    let resolve = () => undefined;
    /** @type {(error: unknown) => void} */
    let reject = () => undefined;
    /** @type {Promise<ReadyInfo>} */
    const ready = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    ready.catch(() => undefined);
    /** @type {ModelSlot} */
    const slot = { spec: resolved.spec, ready, info: null, resolve, reject, onProgress: null };
    this.#slots.set(modelId, slot);
    try {
      this.#ensureWorker().postMessage({
        type: 'init',
        model: resolved.spec,
        allowWasm: resolved.allowWasm,
        ...(cacheOnly ? { cacheOnly: true } : {}),
      });
    } catch (error) {
      slot.reject(error);
    }
    return slot;
  }

  /**
   * The worker, started on first use.
   * @returns {Worker}
   * @throws {SegmentationError} WORKER_CRASHED when it cannot start
   */
  #ensureWorker() {
    if (this.#worker) return this.#worker;
    let worker;
    try {
      worker = this.#createWorker();
    } catch (error) {
      throw new SegmentationError(
        SegmentationErrorCode.WORKER_CRASHED,
        `The segmentation worker could not start: ${error instanceof Error ? error.message : error}`,
      );
    }
    this.#worker = worker;

    worker.addEventListener('message', (event) => {
      if (this.#worker !== worker) return;
      const data = event.data;
      switch (data?.type) {
        case 'status':
          this.#slots.get(data.modelId)?.onProgress?.({
            phase: data.phase,
            loadedBytes: data.loadedBytes,
            totalBytes: data.totalBytes,
            fromCache: data.fromCache,
            framesDone: 0,
            framesTotal: 0,
            backend: null,
            frameMs: null,
          });
          break;
        case 'ready': {
          const slot = this.#slots.get(data.modelId);
          if (!slot || slot.info) break;
          slot.info = {
            modelId: data.modelId,
            backend: data.backend,
            adapter: data.adapter ?? null,
            fromCache: Boolean(data.fromCache),
            modelBytes: slot.spec.bytes,
            resize: slot.spec.preprocess.resize,
            inputSize: slot.spec.inputSize,
            timings: data.timings,
          };
          slot.resolve(slot.info);
          // Downloaded just now: keep it when space runs low
          if (!data.fromCache && data.cached) void this.#persistStorage().catch(() => undefined);
          this.#notifyModelState();
          break;
        }
        case 'init-error': {
          const slot = this.#slots.get(data.modelId);
          if (!slot || slot.info) break;
          slot.reject(fromErrorPayload(data.error, SegmentationErrorCode.MODEL_INIT_FAILED));
          break;
        }
        case 'mask':
          this.#onMask(data);
          break;
        case 'segment-error':
          this.#settleRequest(data.requestId, (request) =>
            request.reject(fromErrorPayload(data.error, SegmentationErrorCode.INFERENCE_FAILED)),
          );
          break;
        case 'dropped':
          for (const requestId of data.requestIds ?? []) {
            this.#settleRequest(requestId, (request) => request.reject(createAbortError()));
          }
          break;
      }
    });

    worker.addEventListener('error', (event) => {
      if (this.#worker !== worker) return;
      event.preventDefault?.();
      const message = (event instanceof ErrorEvent && event.message) || 'unknown error';
      this.#teardown(
        new SegmentationError(
          SegmentationErrorCode.WORKER_CRASHED,
          `The segmentation worker crashed: ${message}`,
        ),
      );
    });
    return worker;
  }

  /**
   * Forget a model now (a pending load rejects with `error`) and release it
   * in the worker once its frames still there have settled: unload it, or
   * stop the worker when nothing else is loaded or in flight. A model
   * loaded again meanwhile keeps its session (the worker answers the new
   * 'init' with 'ready').
   * @param {string} modelId
   * @param {unknown} error
   * @returns {Promise<void>} Resolves once the worker was told
   */
  #releaseSlot(modelId, error) {
    const slot = this.#slots.get(modelId);
    if (!slot) return Promise.resolve();
    this.#slots.delete(modelId);
    if (this.#lastReady?.modelId === modelId) this.#lastReady = null;
    slot.reject(error);
    if (slot.info) this.#notifyModelState();
    const worker = this.#worker;
    const release = () => {
      if (!worker || this.#worker !== worker || this.#slots.has(modelId)) return;
      if (this.#slots.size === 0 && this.#requests.size === 0) {
        this.#teardown(error);
      } else {
        worker.postMessage({ type: 'unload', modelId });
      }
    };
    const inflight = [...this.#requests.values()]
      .filter((request) => request.modelId === modelId)
      .map((request) => request.done);
    if (inflight.length === 0) {
      release();
      return Promise.resolve();
    }
    return Promise.allSettled(inflight).then(release);
  }

  /**
   * A clip is gone for good (its deletion can no longer be undone): masks
   * of its frames that are still in the worker are dropped when they
   * arrive, instead of recreating the clip's group in the mask store after
   * its masks were deleted (nothing would ever release them again).
   * @param {string} clipId
   */
  forgetClip(clipId) {
    this.#releasedClips.add(clipId);
  }

  /**
   * Store a finished mask (even for a cancelled job: it is valid work),
   * unless its clip was released meanwhile.
   * @param {{ requestId: number, width: number, height: number, data: ArrayBuffer, totalMs: number, inferenceMs: number }} data
   */
  #onMask(data) {
    this.#settleRequest(data.requestId, (request) => {
      if (request.clipId === undefined || !this.#releasedClips.has(request.clipId)) {
        this.#maskStore.set(
          request.key,
          { data: new Uint8Array(data.data), width: data.width, height: data.height },
          request.clipId,
          request.modelId,
        );
      }
      request.resolve({ totalMs: data.totalMs, inferenceMs: data.inferenceMs });
    });
  }

  /**
   * @param {number} requestId
   * @param {(request: PendingRequest) => void} settle
   */
  #settleRequest(requestId, settle) {
    const request = this.#requests.get(requestId);
    if (!request) return;
    this.#requests.delete(requestId);
    settle(request);
  }

  /**
   * Create a frame's bitmap and hand it to the worker.
   * @param {number} jobId
   * @param {{ key: string, frame: Frame }} item
   * @param {string | undefined} clipId
   * @param {ReadyInfo} ready - The session the frame is for
   * @returns {Promise<{ totalMs: number, inferenceMs: number }>}
   */
  async #submitFrame(jobId, { key, frame }, clipId, ready) {
    const source = getDrawableSource(frame);
    // A closed VideoFrame has no `closed` flag in browsers; close() zeroes its
    // coded size (format can be null for open GPU-backed frames, so not that)
    if (!source || /** @type {{ codedWidth?: number }} */ (source).codedWidth === 0) {
      throw new SegmentationError(
        SegmentationErrorCode.FRAME_UNAVAILABLE,
        `Frame ${frame.id} has no pixels (its VideoFrame is closed)`,
      );
    }
    const { width, height } = computeMaskSize(frame.width, frame.height);
    // A letterbox model sees the frame at the mask resolution (its long side
    // is the input side). A stretch model resizes the frame straight to its
    // square input, like upstream: going through the mask resolution first
    // would throw away rows (1024×576 stretched to 1024×1024).
    const [bitmapWidth, bitmapHeight] =
      ready.resize === 'stretch' ? [ready.inputSize, ready.inputSize] : [width, height];
    let bitmap;
    try {
      bitmap = await this.#createBitmap(source, bitmapWidth, bitmapHeight);
    } catch (error) {
      // e.g. InvalidStateError: the VideoFrame was closed while waiting
      throw new SegmentationError(
        SegmentationErrorCode.FRAME_UNAVAILABLE,
        `Frame ${frame.id} could not be read: ${error instanceof Error ? error.message : error}`,
      );
    }
    const worker = this.#worker;
    if (!worker || this.#cancelledJobs.has(jobId)) {
      bitmap.close();
      throw createAbortError();
    }
    const requestId = ++this.#requestSeq;
    const { modelId } = ready;
    /** @type {PendingRequest | undefined} */
    let request;
    /** @type {Promise<{ totalMs: number, inferenceMs: number }>} */
    const done = new Promise((resolve, reject) => {
      request = { resolve, reject, key, clipId, modelId };
      this.#requests.set(requestId, request);
      try {
        worker.postMessage(
          {
            type: 'segment',
            requestId,
            jobId,
            modelId,
            bitmap,
            sourceWidth: frame.width,
            sourceHeight: frame.height,
            maskWidth: width,
            maskHeight: height,
          },
          [bitmap],
        );
      } catch (error) {
        this.#requests.delete(requestId);
        bitmap.close();
        reject(error);
      }
    });
    if (request) request.done = done.catch(() => undefined);
    return done;
  }

  /**
   * Stop a job: frames not yet sent are never sent, queued ones are dropped
   * by the worker (which closes their bitmaps). The job is remembered as
   * cancelled until every request it submitted has settled.
   * @param {number} jobId
   * @param {Promise<unknown>[]} submitted - The job's requests that may still be pending
   */
  #cancelJob(jobId, submitted) {
    this.#cancelledJobs.add(jobId);
    this.#worker?.postMessage({ type: 'cancel', jobId });
    Promise.allSettled(submitted).then(() => this.#cancelledJobs.delete(jobId));
  }

  /**
   * Terminate the worker and fail everything pending.
   * @param {unknown} error
   */
  #teardown(error) {
    this.#worker?.terminate();
    this.#worker = null;
    this.#lastReady = null;
    const slots = [...this.#slots.values()];
    this.#slots.clear();
    for (const slot of slots) slot.reject(error);
    if (slots.some((slot) => slot.info)) this.#notifyModelState();
    const requests = [...this.#requests.values()];
    this.#requests.clear();
    for (const request of requests) {
      request.reject(error);
    }
  }

  /** Terminate the worker; pending analyses reject with an AbortError. */
  dispose() {
    this.#teardown(createAbortError('Segmentation manager disposed'));
    this.#cancelledJobs.clear();
  }
}

/**
 * Create a segmentation manager.
 * @param {SegmentationManagerOptions} [options]
 * @returns {SegmentationManager}
 */
export function createSegmentationManager(options) {
  return new SegmentationManager(options);
}

/** @type {SegmentationManager | null} */
let sharedManager = null;

/**
 * The app-wide manager (writes into the shared mask store).
 * @returns {SegmentationManager}
 */
export function getSegmentationManager() {
  sharedManager ??= new SegmentationManager();
  return sharedManager;
}
