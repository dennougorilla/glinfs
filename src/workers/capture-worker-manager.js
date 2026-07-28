/**
 * Capture Worker Manager
 *
 * Bridge between main thread and capture worker.
 * Handles frame capture using createImageBitmap(video) which works on static screens.
 *
 * @module workers/capture-worker-manager
 */

import { fitWithinLongEdge } from '../shared/utils/geometry.js';

/**
 * @typedef {Object} CaptureStats
 * @property {number} frameCount - Current frame count in buffer
 * @property {number} maxFrames - Maximum buffer capacity
 * @property {number} fps - Frames per second
 */

/**
 * @typedef {Object} TransferredFrame
 * @property {string} id - Unique frame identifier
 * @property {ImageBitmap} bitmap - The captured frame (transferred from worker)
 * @property {number} timestamp - Capture timestamp (ms)
 */

/**
 * @callback StatsCallback
 * @param {CaptureStats} stats
 */

/**
 * Manager for capture worker
 */
export class CaptureWorkerManager {
  /** @type {Worker | null} */
  #worker = null;

  /** @type {HTMLVideoElement | null} */
  #video = null;

  /** @type {StatsCallback | null} */
  #onStatsUpdate = null;

  /** @type {((frames: TransferredFrame[]) => void) | null} */
  #pendingFramesCallback = null;

  /** @type {boolean} */
  #isInitialized = false;

  /** @type {boolean} Mirrors the worker's own START/STOP state, kept on this side too so
   * callers (e.g. the capture feature's restore path) can skip a redundant START message
   * instead of relying solely on the worker's internal `isCapturing` guard. */
  #isRunning = false;

  /** @type {number} Maximum long edge for grabbed frames; 0 = native (#96) */
  #maxEdge = 0;

  /**
   * Initialize the worker with a video element
   * @param {HTMLVideoElement} video - Video element to capture from
   * @param {Object} [options]
   * @param {StatsCallback} [options.onStatsUpdate] - Callback for stats updates
   * @param {number} [options.maxEdge] - Downscale grabbed frames so their
   *   long edge does not exceed this; 0/omitted captures at native size.
   *   Applied at createImageBitmap time so oversized (Retina) frames never
   *   exist, rather than being shrunk after the memory was already spent.
   */
  init(video, options = {}) {
    this.#video = video;
    this.#onStatsUpdate = options.onStatsUpdate ?? null;
    this.#maxEdge = options.maxEdge ?? 0;

    // Create worker if not already created
    if (!this.#worker) {
      this.#worker = new Worker(new URL('./capture-worker.js', import.meta.url), {
        type: 'module',
      });
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this);
      this.#worker.onerror = this.#handleWorkerError.bind(this);
    }

    this.#isInitialized = true;
  }

  /**
   * Update the stats callback
   * @param {StatsCallback | null} callback
   */
  setStatsCallback(callback) {
    this.#onStatsUpdate = callback;
  }

  /**
   * Start capturing frames
   *
   * Idempotent: a second call while already running is a no-op, so restoring
   * a background capture session that was never paused doesn't re-issue a
   * redundant START (the worker itself guards against a second interval, but
   * skipping the message here avoids an unnecessary resizeBuffer() pass too).
   * @param {number} fps - Target frames per second
   * @param {number} maxFrames - Maximum frames to buffer
   */
  start(fps, maxFrames) {
    if (!this.#isInitialized || this.#isRunning) {
      return;
    }

    this.#isRunning = true;
    this.#worker?.postMessage({
      type: 'START',
      payload: { fps, maxFrames },
    });
  }

  /**
   * Stop capturing frames (preserves buffer)
   */
  stop() {
    this.#isRunning = false;
    this.#worker?.postMessage({ type: 'STOP' });
  }

  /**
   * Whether the capture loop is currently running (mirrors worker START/STOP)
   * @returns {boolean}
   */
  get isRunning() {
    return this.#isRunning;
  }

  /**
   * Request all frames from buffer
   * Returns a Promise that resolves with the frames
   * @returns {Promise<TransferredFrame[]>}
   */
  requestFrames() {
    return new Promise((resolve) => {
      if (!this.#isInitialized) {
        resolve([]);
        return;
      }

      // Store callback to be called when frames arrive
      this.#pendingFramesCallback = resolve;
      this.#worker?.postMessage({ type: 'GET_FRAMES' });
    });
  }

  /**
   * Clear the frame buffer
   */
  clear() {
    this.#worker?.postMessage({ type: 'CLEAR' });
  }

  /**
   * Terminate the worker and cleanup
   */
  terminate() {
    const pendingFramesCallback = this.#pendingFramesCallback;
    this.#pendingFramesCallback = null;

    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#video = null;
    this.#onStatsUpdate = null;
    this.#isInitialized = false;
    this.#isRunning = false;

    // Do not leave requestFrames() callers waiting forever when teardown wins
    // the race with a worker response.
    pendingFramesCallback?.([]);
  }

  /**
   * Terminate worker with proper cleanup of ImageBitmap resources
   * Sends CLEAR message and waits for completion before terminating
   * @returns {Promise<void>}
   */
  async terminateWithCleanup() {
    if (!this.#worker || !this.#isInitialized) {
      this.terminate();
      return;
    }

    // Send CLEAR and wait for STATS_UPDATE with frameCount=0
    await new Promise((resolve) => {
      const CLEANUP_TIMEOUT_MS = 100;
      const worker = this.#worker;
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timeoutId = null;

      /** Finish waiting and remove the temporary listener on every path. */
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        worker.removeEventListener('message', handler);
        resolve();
      };

      const handler = (e) => {
        if (e.data.type === 'STATS_UPDATE' && e.data.payload.frameCount === 0) {
          finish();
        }
      };

      timeoutId = setTimeout(finish, CLEANUP_TIMEOUT_MS);

      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'CLEAR' });
    });

    this.terminate();
  }

  /**
   * Check if manager is initialized
   * @returns {boolean}
   */
  get isInitialized() {
    return this.#isInitialized;
  }

  /**
   * Handle messages from worker
   * @param {MessageEvent} e
   */
  async #handleWorkerMessage(e) {
    const { type, payload } = e.data;

    switch (type) {
      case 'FRAME_REQUEST':
        await this.#captureAndSendFrame(payload.timestamp);
        break;

      case 'STATS_UPDATE':
        this.#onStatsUpdate?.(payload);
        break;

      case 'FRAMES_RESPONSE':
        // Call pending callback with received frames
        if (this.#pendingFramesCallback) {
          this.#pendingFramesCallback(payload.frames || []);
          this.#pendingFramesCallback = null;
        }
        break;
    }
  }

  /**
   * Handle worker errors
   * @param {ErrorEvent} e
   */
  #handleWorkerError(e) {
    console.error('[CaptureWorkerManager] Worker error:', e.message);

    // Reject any pending frame requests with empty result
    if (this.#pendingFramesCallback) {
      this.#pendingFramesCallback([]);
      this.#pendingFramesCallback = null;
    }

    // Mark as uninitialized to prevent further operations
    this.#isInitialized = false;
  }

  /**
   * Send frame response to worker
   * @param {ImageBitmap | null} bitmap
   * @param {number} timestamp
   */
  #sendFrameResponse(bitmap, timestamp) {
    if (!this.#worker) {
      // Terminated while a capture was in flight: nothing can receive the
      // bitmap, so close it here instead of leaking it to GC (#40).
      bitmap?.close();
      return;
    }
    const message = { type: 'FRAME_RESPONSE', payload: { bitmap, timestamp } };
    if (bitmap) {
      this.#worker.postMessage(message, [bitmap]);
    } else {
      this.#worker.postMessage(message);
    }
  }

  /**
   * Capture a frame from video and send to worker
   * Uses createImageBitmap which works even on static screens!
   * @param {number} timestamp
   */
  async #captureAndSendFrame(timestamp) {
    // Check video is ready (HTMLMediaElement.HAVE_CURRENT_DATA = 2)
    if (!this.#video || this.#video.readyState < 2) {
      this.#sendFrameResponse(null, timestamp);
      return;
    }

    try {
      // createImageBitmap works on static screens!
      // This is the key difference from MediaStreamTrackProcessor.read()
      const target = this.getEffectiveFrameDimensions();
      const bitmap = target?.scaled
        ? await createImageBitmap(this.#video, {
            resizeWidth: target.width,
            resizeHeight: target.height,
            resizeQuality: 'high',
          })
        : await createImageBitmap(this.#video);
      this.#sendFrameResponse(bitmap, timestamp);
    } catch {
      this.#sendFrameResponse(null, timestamp);
    }
  }

  /**
   * Dimensions frames are actually captured at, after the resolution limit.
   * Memory budgeting must use these, not the source's native size — the
   * whole point of the limit is that native-sized frames never exist.
   * @returns {{ width: number, height: number, scaled: boolean } | null}
   *   null before init or before video metadata is available
   */
  getEffectiveFrameDimensions() {
    const w = this.#video?.videoWidth ?? 0;
    const h = this.#video?.videoHeight ?? 0;
    if (!w || !h) return null;
    return fitWithinLongEdge(w, h, this.#maxEdge);
  }
}
