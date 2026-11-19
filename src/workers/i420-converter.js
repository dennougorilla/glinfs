/**
 * Main-thread client of the I420 converter worker (D3's cheap half)
 *
 * The open clip's GPU RGBA frames (clones of them) go to the worker, and
 * CPU I420 bytes come back one frame at a time (see
 * features/capture/clip-frames-i420.js). The worker is made on first use
 * and kept: it holds a small WebGL2 context between clips and frees the
 * per-size buffers after each one.
 *
 * When the worker cannot run (no Worker / OffscreenCanvas), fails, or dies,
 * the frames it did not convert are returned (their sources still open) and
 * the worker is not used again in this session.
 *
 * @module workers/i420-converter
 */

/**
 * @typedef {Object} ConvertedFrame
 * @property {number} index - Position in the input
 * @property {string} id
 * @property {number} timestamp - As given (ms)
 * @property {number} width
 * @property {number} height
 * @property {ArrayBuffer} data - I420 bytes (see shared/i420.js)
 */

/**
 * @typedef {Object} ConversionResult
 * @property {ConvertedFrame[]} converted - In input order
 * @property {Array<{ index: number, item: any }>} rest - Input items not
 *   converted, still holding an open source (the caller's again)
 * @property {number} lost - Frames neither converted nor returned (the
 *   worker died holding them)
 * @property {'webgpu' | 'webgl2' | 'js' | null} engine
 */

/** @type {Worker | null} */
let worker = null;
let failed = false;
let nextJobId = 1;

/**
 * @type {Map<number, { items: any[], converted: ConvertedFrame[], onFrame?: (frame: ConvertedFrame) => void, settle: (result: ConversionResult) => void }>}
 */
const jobs = new Map();

/**
 * Whether clip frames will be CPU I420: the budget counts them at 1.5 B/px
 * @returns {boolean}
 */
export function isCpuFrameConversionAvailable() {
  return !failed && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/**
 * Stop using the worker: settle every job with what it has
 * @param {(job: { items: any[], converted: ConvertedFrame[] }) => Array<{ index: number, item: any }>} restOf
 */
function giveUp(restOf) {
  failed = true;
  worker?.terminate();
  worker = null;
  for (const [jobId, job] of jobs) {
    jobs.delete(jobId);
    const rest = restOf(job);
    job.settle({
      converted: sortByIndex(job.converted),
      rest,
      lost: job.items.length - job.converted.length - rest.length,
      engine: null,
    });
  }
}

/**
 * @template {{ index: number }} T
 * @param {T[]} list
 * @returns {T[]}
 */
function sortByIndex(list) {
  return [...list].sort((a, b) => a.index - b.index);
}

/** @returns {Worker | null} */
function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./i420-worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[i420-converter] Worker unavailable:', err);
    failed = true;
    return null;
  }
  worker.onmessage = (event) => {
    const message = event.data ?? {};
    const job = jobs.get(message.jobId);
    if (!job) return;
    if (message.type === 'FRAME') {
      const item = job.items[message.index];
      /** @type {ConvertedFrame} */
      const frame = {
        index: message.index,
        id: item.id,
        timestamp: item.timestamp,
        width: message.width,
        height: message.height,
        data: message.data,
      };
      job.converted.push(frame);
      job.onFrame?.(frame);
    } else if (message.type === 'DONE') {
      jobs.delete(message.jobId);
      job.settle({
        converted: sortByIndex(job.converted),
        rest: [],
        lost: 0,
        engine: message.engine,
      });
    } else if (message.type === 'FAILED') {
      console.warn('[i420-converter] Conversion failed:', message.error);
      jobs.delete(message.jobId);
      const rest = (message.rest ?? []).map(
        (/** @type {{ index: number, source: ImageBitmap | VideoFrame }} */ back) => ({
          index: back.index,
          item: { ...job.items[back.index], source: back.source },
        }),
      );
      job.settle({
        converted: sortByIndex(job.converted),
        rest: sortByIndex(rest),
        lost: job.items.length - job.converted.length - rest.length,
        engine: null,
      });
      // Any other job is settled the same way: nothing comes back from it
      giveUp(() => []);
    }
  };
  worker.onerror = (event) => {
    console.error('[i420-converter] Worker error:', event.message);
    // The sources the worker held are gone with it
    giveUp(() => []);
  };
  return worker;
}

/**
 * Start the worker and its GPU device now, so the first clip does not wait
 * for them (sharing started: a clip may follow)
 */
export function warmI420Converter() {
  if (worker || !isCpuFrameConversionAvailable()) return;
  getWorker()?.postMessage({ type: 'WARM' });
}

/**
 * Convert RGBA frames to CPU I420. The sources belong to the worker once
 * sent (it closes them); those in `rest` are the caller's again.
 * @param {Array<{ id: string, timestamp: number, source: ImageBitmap | VideoFrame }>} items
 *   - One frame size
 * @param {{ engines?: Array<'webgpu' | 'webgl2' | 'js'>, onFrame?: (frame: ConvertedFrame) => void }} [options]
 *   - `engines` limits and orders the worker's engines (tests); `onFrame`
 *   is called with each frame as it arrives (the result lists them too)
 * @returns {Promise<ConversionResult>}
 */
export function convertToI420(items, { engines, onFrame } = {}) {
  const target = isCpuFrameConversionAvailable() && items.length > 0 ? getWorker() : null;
  if (!target) {
    return Promise.resolve({
      converted: [],
      rest: items.map((item, index) => ({ index, item })),
      lost: 0,
      engine: null,
    });
  }
  const jobId = nextJobId++;
  return new Promise((settle) => {
    jobs.set(jobId, { items, converted: [], onFrame, settle });
    target.postMessage(
      {
        type: 'CONVERT',
        jobId,
        ...(engines ? { engines } : {}),
        frames: items.map(({ id, timestamp, source }) => ({ id, timestamp, source })),
      },
      items.map((item) => item.source),
    );
  });
}
