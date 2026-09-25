/**
 * Segmentation manager (main thread)
 * @module features/ai-cutout/segmentation-manager
 *
 * Owns the segmentation worker: creates it on the first analysis that has
 * something to do (so ORT and the model never load before the user asks),
 * feeds it frames and writes the returned probability masks into the mask
 * store. Frames whose mask already exists are skipped, deduped by
 * `frame.sharedKey ?? frame.id` (imported holds share pixels, so they share
 * one mask).
 *
 * FRAME OWNERSHIP: the manager never closes, clones or transfers a
 * VideoFrame. For each frame it creates an ImageBitmap (scaled to the mask
 * resolution) and transfers that bitmap to the worker, which closes it. A
 * bitmap that cannot be sent (cancelled job, dead worker) is closed here.
 * At most MAX_FRAMES_IN_FLIGHT bitmaps exist at a time.
 */

import { getDrawableSource } from '../../shared/utils/canvas.js';
import { getSharedMaskStore } from './mask-store.js';
import { getModelSpec } from './model-config.js';
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
 * @property {SegmentationBackend} backend
 * @property {{ vendor: string, architecture: string, description: string } | null} adapter
 * @property {boolean} fromCache
 * @property {number} modelBytes - Size of the loaded model
 * @property {{ loadMs: number, createMs: number }} timings
 */

/**
 * @typedef {Object} SegmentationManagerOptions
 * @property {MaskStore} [maskStore]
 * @property {() => Worker} [createWorker]
 * @property {(source: CanvasImageSource, width: number, height: number) => Promise<ImageBitmap>} [createBitmap]
 * @property {() => ModelSpec} [getModelSpec]
 * @property {Navigator} [navigatorImpl] - For getCapabilities()
 */

/** Frames handed to the worker ahead of the one being analyzed */
export const MAX_FRAMES_IN_FLIGHT = 2;

/**
 * DEV-only override set by the E2E test hook (see test-hooks.js): accept the
 * stub model's size/hash and allow the WASM fallback without asking. Every
 * read is behind `import.meta.env.DEV`, so production builds ignore it.
 * @type {{ sha256?: string, bytes?: number, allowWasm?: boolean } | null}
 */
let devModelOverride = null;

/**
 * DEV/E2E only: override the expected model size/hash and allow WASM. Takes
 * effect for workers created afterwards (call dispose() first to re-init).
 * @param {{ sha256?: string, bytes?: number, allowWasm?: boolean } | null} override
 */
export function setDevModelOverride(override) {
  if (!import.meta.env.DEV) {
    throw new Error('setDevModelOverride is only available in development builds');
  }
  devModelOverride = override;
}

/**
 * Mask store key of a frame.
 * @param {Frame} frame
 * @returns {string}
 */
export function frameKey(frame) {
  return frame.sharedKey ?? frame.id;
}

/**
 * Frames that still need a mask: one per key, skipping keys already stored.
 * @param {Frame[]} frames
 * @param {{ has: (key: string) => boolean }} maskStore
 * @returns {{ key: string, frame: Frame }[]}
 */
export function collectPendingFrames(frames, maskStore) {
  const seen = new Set();
  const pending = [];
  for (const frame of frames) {
    const key = frameKey(frame);
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
 */

/** Main-thread front of the segmentation worker. */
export class SegmentationManager {
  /** @param {SegmentationManagerOptions} [options] */
  constructor(options = {}) {
    this.#maskStore = options.maskStore ?? getSharedMaskStore();
    this.#createWorker = options.createWorker ?? createSegmentationWorker;
    this.#createBitmap = options.createBitmap ?? createScaledBitmap;
    this.#getModelSpec = options.getModelSpec ?? (() => getModelSpec());
    this.#navigator = options.navigatorImpl ?? globalThis.navigator;
  }

  /** @type {MaskStore} */
  #maskStore;
  /** @type {() => Worker} */
  #createWorker;
  /** @type {(source: CanvasImageSource, width: number, height: number) => Promise<ImageBitmap>} */
  #createBitmap;
  /** @type {() => ModelSpec} */
  #getModelSpec;
  /** @type {Navigator | undefined} */
  #navigator;

  /** @type {Worker | null} */
  #worker = null;
  /** @type {Promise<ReadyInfo> | null} */
  #ready = null;
  /** @type {ReadyInfo | null} */
  #readyInfo = null;
  /** @type {((error: unknown) => void) | null} */
  #rejectInit = null;
  /** @type {((progress: AnalysisProgress) => void) | null} */
  #initProgress = null;
  /** @type {Map<number, PendingRequest>} */
  #requests = new Map();
  /** @type {Set<number>} */
  #cancelledJobs = new Set();
  #requestSeq = 0;
  #jobSeq = 0;
  /** Serializes analyzeFrames calls @type {Promise<unknown>} */
  #tail = Promise.resolve();
  /** @type {Promise<Capabilities> | null} */
  #capabilities = null;

  /** The backend the loaded model runs on, or null before the first analysis. */
  get backend() {
    return this.#readyInfo?.backend ?? null;
  }

  /** Details of the loaded model session, or null. */
  get readyInfo() {
    return this.#readyInfo;
  }

  /** The mask store results are written to. */
  get maskStore() {
    return this.#maskStore;
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
   * worker or downloads the model.
   * @param {Frame[]} frames
   * @param {AnalyzeOptions} [options]
   * @returns {Promise<AnalyzeResult>}
   */
  analyzeFrames(frames, options = {}) {
    const run = this.#tail.then(() => this.#analyze(frames, options));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {Frame[]} frames
   * @param {AnalyzeOptions} options
   * @returns {Promise<AnalyzeResult>}
   */
  async #analyze(frames, { onProgress, signal, allowWasm = false, clipId } = {}) {
    if (signal?.aborted) throw createAbortError();
    const pending = collectPendingFrames(frames, this.#maskStore);
    const skipped = frames.length - pending.length;
    if (pending.length === 0) {
      return { analyzed: 0, skipped, backend: this.backend };
    }

    const ready = await this.#ensureReady(allowWasm, onProgress, signal, pending.length);
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
          const request = this.#submitFrame(jobId, pending[next++], clipId);
          request.catch(() => undefined); // awaited below, in order
          inflight.push(request);
        }
        const result = await raceAbort(
          /** @type {Promise<{ totalMs: number }>} */ (inflight.shift()),
          signal,
        );
        framesDone++;
        report(result.totalMs);
      }
    } catch (error) {
      this.#cancelJob(jobId);
      throw error;
    }
    this.#cancelledJobs.delete(jobId);
    return { analyzed: pending.length, skipped, backend: ready.backend };
  }

  /**
   * Start the worker and load the model once.
   * @param {boolean} allowWasm
   * @param {((progress: AnalysisProgress) => void) | undefined} onProgress
   * @param {AbortSignal | undefined} signal
   * @param {number} framesTotal
   * @returns {Promise<ReadyInfo>}
   */
  async #ensureReady(allowWasm, onProgress, signal, framesTotal) {
    if (this.#readyInfo) return this.#readyInfo;
    this.#initProgress = (progress) => onProgress?.({ ...progress, framesTotal });
    if (!this.#ready) {
      let wasmAllowed = allowWasm;
      /** @type {ModelSpec} */
      let spec = this.#getModelSpec();
      if (import.meta.env.DEV && devModelOverride) {
        spec = {
          ...spec,
          sha256: devModelOverride.sha256 ?? spec.sha256,
          bytes: devModelOverride.bytes ?? spec.bytes,
        };
        wasmAllowed ||= Boolean(devModelOverride.allowWasm);
      }
      this.#ready = this.#startWorker(spec, wasmAllowed);
    }
    try {
      return await raceAbort(this.#ready, signal);
    } catch (error) {
      if (!this.#readyInfo) {
        // Cancelled download or failed init: start over on the next call
        this.#teardown(error);
      }
      throw error;
    } finally {
      this.#initProgress = null;
    }
  }

  /**
   * @param {ModelSpec} spec
   * @param {boolean} allowWasm
   * @returns {Promise<ReadyInfo>}
   */
  #startWorker(spec, allowWasm) {
    return new Promise((resolve, reject) => {
      this.#rejectInit = reject;
      let worker;
      try {
        worker = this.#createWorker();
      } catch (error) {
        reject(
          new SegmentationError(
            SegmentationErrorCode.WORKER_CRASHED,
            `The segmentation worker could not start: ${error instanceof Error ? error.message : error}`,
          ),
        );
        return;
      }
      this.#worker = worker;

      worker.addEventListener('message', (event) => {
        if (this.#worker !== worker) return;
        const data = event.data;
        switch (data?.type) {
          case 'status':
            this.#initProgress?.({
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
          case 'ready':
            this.#readyInfo = {
              backend: data.backend,
              adapter: data.adapter ?? null,
              fromCache: Boolean(data.fromCache),
              modelBytes: spec.bytes,
              timings: data.timings,
            };
            this.#rejectInit = null;
            resolve(this.#readyInfo);
            break;
          case 'init-error':
            this.#rejectInit = null;
            reject(fromErrorPayload(data.error, SegmentationErrorCode.MODEL_INIT_FAILED));
            break;
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

      worker.postMessage({ type: 'init', model: spec, allowWasm });
    });
  }

  /**
   * Store a finished mask (even for a cancelled job: it is valid work).
   * @param {{ requestId: number, width: number, height: number, data: ArrayBuffer, totalMs: number, inferenceMs: number }} data
   */
  #onMask(data) {
    this.#settleRequest(data.requestId, (request) => {
      this.#maskStore.set(
        request.key,
        { data: new Uint8Array(data.data), width: data.width, height: data.height },
        request.clipId,
      );
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
   * @returns {Promise<{ totalMs: number, inferenceMs: number }>}
   */
  async #submitFrame(jobId, { key, frame }, clipId) {
    const source = getDrawableSource(frame);
    if (!source) {
      throw new SegmentationError(
        SegmentationErrorCode.FRAME_UNAVAILABLE,
        `Frame ${frame.id} has no pixels (its VideoFrame is closed)`,
      );
    }
    const { width, height } = computeMaskSize(frame.width, frame.height);
    const bitmap = await this.#createBitmap(source, width, height);
    const worker = this.#worker;
    if (!worker || this.#cancelledJobs.has(jobId)) {
      bitmap.close();
      throw createAbortError();
    }
    const requestId = ++this.#requestSeq;
    return new Promise((resolve, reject) => {
      this.#requests.set(requestId, { resolve, reject, key, clipId });
      try {
        worker.postMessage(
          {
            type: 'segment',
            requestId,
            jobId,
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
  }

  /**
   * Stop a job: frames not yet sent are never sent, queued ones are dropped
   * by the worker (which closes their bitmaps).
   * @param {number} jobId
   */
  #cancelJob(jobId) {
    this.#cancelledJobs.add(jobId);
    this.#worker?.postMessage({ type: 'cancel', jobId });
  }

  /**
   * Terminate the worker and fail everything pending.
   * @param {unknown} error
   */
  #teardown(error) {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = null;
    this.#readyInfo = null;
    this.#rejectInit?.(error);
    this.#rejectInit = null;
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
