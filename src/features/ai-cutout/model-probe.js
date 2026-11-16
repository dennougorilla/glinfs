/**
 * Main-thread side of the model probe worker (Settings → Add model)
 * @module features/ai-cutout/model-probe
 *
 * One probe per Add model dialog: open a file or URL, test settings on a
 * generated frame, save the bytes into the model cache. dispose()
 * terminates the worker, which frees the file and its session. The worker
 * factory is injectable for unit tests.
 */

import { fromErrorPayload, SegmentationErrorCode } from './protocol.js';

/** @typedef {import('./custom-models.js').GraphInfo} GraphInfo */
/** @typedef {import('./custom-models.js').TestAssessment} TestAssessment */

/**
 * @typedef {Object} OpenedModel
 * @property {number} bytes
 * @property {string} sha256
 * @property {'webgpu' | 'wasm'} backend - Where the graph was read
 * @property {boolean} hasAdapter - The browser has a WebGPU adapter
 * @property {string | null} webgpuError - Why WebGPU could not load it
 * @property {GraphInfo} graph
 */

/**
 * @typedef {{ needsConfirm: number | null, downloaded?: boolean }} SizeQuestion
 *   - The file is above 1 GB (or of unknown size): ask before reading it
 */

/**
 * @typedef {TestAssessment & { backend: 'webgpu' | 'wasm', inferenceMs?: number, preview?: { size: number, data: ArrayBuffer } | null }} TestResult
 *   - `problem` may also be 'webgpu', 'run' or 'shape' (the model did not run)
 */

/** @returns {Worker} */
function defaultCreateWorker() {
  return new Worker(new URL('../../workers/model-probe-worker.js', import.meta.url), {
    type: 'module',
  });
}

/**
 * @param {{ createWorker?: () => Worker }} [deps]
 */
export function createModelProbe({ createWorker = defaultCreateWorker } = {}) {
  /** @type {Worker | null} */
  let worker = null;
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: unknown) => void, onProgress?: (p: { loadedBytes: number, totalBytes: number | null }) => void }>} */
  const pending = new Map();

  const failAll = (/** @type {unknown} */ error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const getWorker = () => {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (event) => {
      const message = event.data;
      const call = pending.get(message?.id);
      if (!call) return;
      if (message.type === 'progress') {
        call.onProgress?.({ loadedBytes: message.loadedBytes, totalBytes: message.totalBytes });
        return;
      }
      if (message.type !== 'result') return;
      pending.delete(message.id);
      if (message.ok) call.resolve(message.value);
      else call.reject(fromErrorPayload(message.error, SegmentationErrorCode.MODEL_INIT_FAILED));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      failAll(
        fromErrorPayload(
          {
            code: SegmentationErrorCode.WORKER_CRASHED,
            message: 'The model check stopped (the worker crashed)',
          },
          SegmentationErrorCode.WORKER_CRASHED,
        ),
      );
      worker?.terminate();
      worker = null;
    };
    return worker;
  };

  /**
   * @param {Record<string, unknown>} message
   * @param {(p: { loadedBytes: number, totalBytes: number | null }) => void} [onProgress]
   * @returns {Promise<any>}
   */
  const call = (message, onProgress) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ ...message, id });
    });

  return {
    /**
     * Read a file or download a URL, hash it and read its graph
     * @param {{ kind: 'file', file: File } | { kind: 'url', url: string }} source
     * @param {{ allowLarge?: boolean, expect?: { bytes: number, sha256: string }, onProgress?: (p: { loadedBytes: number, totalBytes: number | null }) => void }} [options]
     * @returns {Promise<OpenedModel | SizeQuestion>}
     */
    open(source, { allowLarge = false, expect, onProgress } = {}) {
      return call({ type: 'open', source, allowLarge, expect }, onProgress);
    },
    /**
     * Go on with a downloaded file of unannounced size above 1 GB
     * @returns {Promise<OpenedModel>}
     */
    confirmDownloaded() {
      return call({ type: 'confirm-downloaded' });
    },
    /**
     * Run the test frame with these settings
     * @param {{ inputName: string, outputName: string, inputSize: number, normalization: string, output: string }} settings
     * @returns {Promise<TestResult>}
     */
    test(settings) {
      return call({ type: 'test', settings });
    },
    /**
     * Store the bytes in the model cache
     * @param {string} cacheKey
     * @returns {Promise<{ cached: boolean }>}
     */
    save(cacheKey) {
      return call({ type: 'save', cacheKey });
    },
    /** Stop a running download */
    cancel() {
      worker?.postMessage({ type: 'cancel' });
    },
    /** Terminate the worker (frees the file and its session) */
    dispose() {
      failAll(new DOMException('The model check was closed', 'AbortError'));
      worker?.terminate();
      worker = null;
    },
  };
}
