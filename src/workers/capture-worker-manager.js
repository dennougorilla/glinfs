/**
 * Capture Worker Manager
 *
 * Bridge between main thread and capture worker.
 * Handles frame capture using createImageBitmap(video) which works on static screens.
 *
 * @module workers/capture-worker-manager
 */

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

  /**
   * Initialize the worker with a video element
   * @param {HTMLVideoElement} video - Video element to capture from
   * @param {Object} [options]
   * @param {StatsCallback} [options.onStatsUpdate] - Callback for stats updates
   */
  init(video, options = {}) {
    this.#video = video;
    this.#onStatsUpdate = options.onStatsUpdate ?? null;

    // Create worker if not already created
    if (!this.#worker) {
      this.#worker = new Worker(
        new URL('./capture-worker.js', import.meta.url),
        { type: 'module' }
      );
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this);
      this.#worker.onerror = this.#handleWorkerError.bind(this);
    }

    this.#isInitialized = true;
    console.log('[CaptureWorkerManager] Initialized');
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
   * @param {number} fps - Target frames per second
   * @param {number} maxFrames - Maximum frames to buffer
   */
  start(fps, maxFrames) {
    if (!this.#isInitialized) {
      console.error('[CaptureWorkerManager] Not initialized');
      return;
    }

    this.#worker?.postMessage({
      type: 'START',
      payload: { fps, maxFrames },
    });
  }

  /**
   * Stop capturing frames (preserves buffer)
   */
  stop() {
    this.#worker?.postMessage({ type: 'STOP' });
  }

  /**
   * Request all frames from buffer
   * Returns a Promise that resolves with the frames
   * @returns {Promise<TransferredFrame[]>}
   */
  requestFrames() {
    return new Promise((resolve) => {
      if (!this.#isInitialized) {
        console.error('[CaptureWorkerManager] Not initialized');
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
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#video = null;
    this.#onStatsUpdate = null;
    this.#pendingFramesCallback = null;
    this.#isInitialized = false;
    console.log('[CaptureWorkerManager] Terminated');
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
          this.#pendingFramesCallback(payload.frames);
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
  }

  /**
   * Capture a frame from video and send to worker
   * Uses createImageBitmap which works even on static screens!
   * @param {number} timestamp
   */
  async #captureAndSendFrame(timestamp) {
    // Check video is ready
    if (!this.#video || this.#video.readyState < 2) {
      // HTMLMediaElement.HAVE_CURRENT_DATA = 2
      this.#worker?.postMessage({
        type: 'FRAME_RESPONSE',
        payload: { bitmap: null, timestamp },
      });
      return;
    }

    try {
      // createImageBitmap works on static screens!
      // This is the key difference from MediaStreamTrackProcessor.read()
      const bitmap = await createImageBitmap(this.#video);

      // Transfer ownership to worker (zero-copy)
      this.#worker?.postMessage(
        { type: 'FRAME_RESPONSE', payload: { bitmap, timestamp } },
        [bitmap]
      );
    } catch (err) {
      console.error('[CaptureWorkerManager] Frame capture error:', err);
      this.#worker?.postMessage({
        type: 'FRAME_RESPONSE',
        payload: { bitmap: null, timestamp },
      });
    }
  }
}

/**
 * Create a new CaptureWorkerManager instance
 * @returns {CaptureWorkerManager}
 */
export function createCaptureWorkerManager() {
  return new CaptureWorkerManager();
}
