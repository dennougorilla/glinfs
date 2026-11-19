/**
 * Runs frame trials (encode both ways, keep the smaller) on a second worker,
 * for the gifenc encoder. Created by the GIF encoder worker; one per worker
 * lifetime, shared by its export sessions.
 * @module workers/gif-trial-runner
 */

/**
 * @typedef {Object} TrialJob
 * @property {number} id
 * @property {number} width
 * @property {number} height
 * @property {ArrayBuffer} index - The whole frame's palette indices
 * @property {ArrayBuffer} differenced - The indices with kept pixels transparent
 * @property {import('../features/export/encoders/gif-frame.js').FrameOptions} wholeOptions
 * @property {import('../features/export/encoders/gif-frame.js').FrameOptions} keptOptions
 */

/**
 * @typedef {Object} TrialResult
 * @property {Uint8Array} bytes - The smaller encoding of the frame
 * @property {ArrayBuffer} index - The job's buffers, back for reuse
 * @property {ArrayBuffer} differenced
 */

/**
 * @typedef {Object} TrialRunner
 * @property {number} pending - Jobs sent and not yet answered
 * @property {(job: Omit<TrialJob, 'id'>) => Promise<TrialResult>} run - The
 *   buffers in the job are transferred, and come back with the result
 * @property {() => void} terminate
 */

/**
 * @param {() => Worker} [createWorker]
 * @returns {TrialRunner}
 */
export function createTrialRunner(
  createWorker = () =>
    new Worker(new URL('./gif-trial-worker.js', import.meta.url), { type: 'module' }),
) {
  /** @type {Worker | null} */
  let worker = null;
  let nextId = 1;
  /** @type {Map<number, { resolve: (result: TrialResult) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();

  /** @param {Error} error */
  const failAll = (error) => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };

  const ensureWorker = () => {
    if (worker) return worker;
    const created = createWorker();
    created.onmessage = (event) => {
      const { id, bytes, index, differenced, error } = event.data;
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve({ bytes: new Uint8Array(bytes), index, differenced });
    };
    created.onerror = (event) => {
      event.preventDefault?.();
      // A broken worker is replaced on the next job
      created.terminate();
      if (worker === created) worker = null;
      failAll(new Error(event.message || 'Trial worker failed'));
    };
    worker = created;
    return created;
  };

  return {
    get pending() {
      return waiting.size;
    },
    run(job) {
      const id = nextId++;
      const target = ensureWorker();
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        target.postMessage({ ...job, id }, [job.index, job.differenced]);
      });
    },
    terminate() {
      worker?.terminate();
      worker = null;
      failAll(new Error('Trial worker terminated'));
    },
  };
}
