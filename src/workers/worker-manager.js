/**
 * Worker Manager
 * Main thread side Worker management
 * @module workers/worker-manager
 */

import {
  Events,
  createInitMessage,
  createAddFrameMessage,
  createFinishMessage,
  createCancelMessage,
} from './worker-protocol.js';

/**
 * Error codes for worker-related errors
 * @readonly
 * @enum {string}
 */
export const WorkerErrorCode = {
  INIT_TIMEOUT: 'INIT_TIMEOUT',
  INIT_FAILED: 'INIT_FAILED',
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  ENCODING_FAILED: 'ENCODING_FAILED',
  WORKER_TERMINATED: 'WORKER_TERMINATED',
};

/**
 * Create a structured error with code and context
 * @param {string} message - Error message
 * @param {string} code - Error code from WorkerErrorCode
 * @param {Record<string, unknown>} [context] - Additional context
 * @returns {Error}
 */
function createWorkerError(message, code, context) {
  const error = new Error(message);
  error.name = 'WorkerError';
  /** @type {any} */ (error).code = code;
  /** @type {any} */ (error).context = context;
  return error;
}

/**
 * @typedef {import('./worker-protocol.js').ProgressEvent} ProgressEvent
 * @typedef {import('./worker-protocol.js').WorkerEvent} WorkerEvent
 */

/**
 * Encoder configuration
 * @typedef {Object} EncoderManagerConfig
 * @property {string} [encoderId='gifenc-js'] - Encoder ID to use
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {number} totalFrames - Total frame count
 * @property {number} maxColors - Maximum colors
 * @property {number} frameDelayMs - Frame delay (ms)
 * @property {number} loopCount - Loop count
 * @property {import('../features/export/encoders/types.js').QuantizeFormat} [quantizeFormat] - Quantization format
 */

/**
 * Progress callback
 * @callback ProgressCallback
 * @param {ProgressEvent} progress
 */

/** Default initialization timeout in milliseconds */
const INIT_TIMEOUT_MS = 10000;

/**
 * GIF Encoder Manager
 * Asynchronous GIF encoding management using Worker
 */
export class GifEncoderManager {
  constructor() {
    /** @type {Worker | null} */
    this.worker = null;

    /** @type {ProgressCallback | null} */
    this.onProgress = null;

    /** @type {((data: ArrayBuffer) => void) | null} */
    this._resolveComplete = null;

    /** @type {((error: Error) => void) | null} */
    this._rejectComplete = null;

    /** @type {boolean} */
    this._isInitialized = false;

    /** @type {((error: Error) => void) | null} */
    this._globalErrorHandler = null;
  }

  /**
   * Initialize Worker
   * @param {EncoderManagerConfig} config
   * @param {number} [timeoutMs=INIT_TIMEOUT_MS] - Initialization timeout in ms
   * @returns {Promise<void>}
   */
  async init(config, timeoutMs = INIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timeoutId = null;
      let isSettled = false;

      /**
       * Cleanup function to clear timeout and remove listeners
       */
      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      /**
       * Settle the promise (resolve or reject) only once
       * @param {'resolve' | 'reject'} type
       * @param {Error} [error]
       */
      const settle = (type, error) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        if (type === 'resolve') {
          resolve();
        } else {
          reject(error);
        }
      };

      try {
        // Create Worker (using Vite's special syntax)
        this.worker = new Worker(
          new URL('./gif-encoder-worker.js', import.meta.url),
          { type: 'module' }
        );

        // Set up initialization timeout
        timeoutId = setTimeout(() => {
          settle('reject', createWorkerError(
            `Worker initialization timed out after ${timeoutMs}ms`,
            WorkerErrorCode.INIT_TIMEOUT,
            { timeoutMs, encoderId: config.encoderId }
          ));
          this.dispose();
        }, timeoutMs);

        /**
         * Handler to wait for initialization completion
         * @param {MessageEvent<WorkerEvent>} event
         */
        const handleReady = (event) => {
          const data = event.data;

          if (data.event === Events.READY) {
            this.worker?.removeEventListener('message', handleReady);
            this._setupListeners();
            this._setupGlobalErrorHandler();
            this._isInitialized = true;
            settle('resolve');
          } else if (data.event === Events.ERROR) {
            this.worker?.removeEventListener('message', handleReady);
            settle('reject', createWorkerError(
              data.message || 'Worker initialization failed',
              WorkerErrorCode.INIT_FAILED,
              { encoderId: config.encoderId, originalMessage: data.message }
            ));
          }
        };

        /**
         * Handle Worker creation errors
         * @param {ErrorEvent} error
         */
        const handleError = (error) => {
          settle('reject', new Error(error.message || 'Worker initialization failed'));
        };

        this.worker.addEventListener('message', handleReady);
        this.worker.addEventListener('error', handleError, { once: true });

        // Send initialization message
        const initMessage = createInitMessage({
          encoderId: config.encoderId ?? 'gifenc-js',
          width: config.width,
          height: config.height,
          totalFrames: config.totalFrames,
          maxColors: config.maxColors,
          frameDelayMs: config.frameDelayMs,
          loopCount: config.loopCount,
          quantizeFormat: config.quantizeFormat,
        });

        this.worker.postMessage(initMessage);
      } catch (error) {
        settle('reject', error instanceof Error ? error : new Error('Failed to create worker'));
      }
    });
  }

  /**
   * Set up global error handler for post-initialization errors
   * @private
   */
  _setupGlobalErrorHandler() {
    if (!this.worker) return;

    this._globalErrorHandler = (event) => {
      const error = event instanceof ErrorEvent
        ? new Error(event.message || 'Worker error')
        : new Error('Unknown worker error');

      // Reject any pending finish operation
      if (this._rejectComplete) {
        this._rejectComplete(error);
        this._resolveComplete = null;
        this._rejectComplete = null;
      }
    };

    this.worker.addEventListener('error', this._globalErrorHandler);
  }

  /**
   * Add frame
   * @param {Uint8ClampedArray} rgba - RGBA pixel data
   * @param {number} width - Frame width
   * @param {number} height - Frame height
   * @param {number} frameIndex - Frame index
   */
  addFrame(rgba, width, height, frameIndex) {
    if (!this.worker || !this._isInitialized) {
      throw createWorkerError(
        'Worker not initialized. Call init() first.',
        WorkerErrorCode.NOT_INITIALIZED,
        { frameIndex }
      );
    }

    const { message, transfer } = createAddFrameMessage(rgba, width, height, frameIndex);
    this.worker.postMessage(message, transfer);
  }

  /**
   * Complete encoding and get result
   * @returns {Promise<Blob>}
   */
  async finish() {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this._isInitialized) {
        reject(createWorkerError(
          'Worker not initialized. Call init() first.',
          WorkerErrorCode.NOT_INITIALIZED
        ));
        return;
      }

      this._resolveComplete = (gifData) => {
        resolve(new Blob([gifData], { type: 'image/gif' }));
      };

      this._rejectComplete = reject;

      this.worker.postMessage(createFinishMessage());
    });
  }

  /**
   * Cancel encoding
   */
  cancel() {
    if (this.worker && this._isInitialized) {
      this.worker.postMessage(createCancelMessage());
    }
  }

  /**
   * Release resources
   */
  dispose() {
    if (this.worker) {
      // Remove global error handler before terminating
      if (this._globalErrorHandler) {
        this.worker.removeEventListener('error', this._globalErrorHandler);
        this._globalErrorHandler = null;
      }
      this.worker.terminate();
      this.worker = null;
    }

    this.onProgress = null;
    this._resolveComplete = null;
    this._rejectComplete = null;
    this._isInitialized = false;
  }

  /**
   * Set up event listeners
   * @private
   */
  _setupListeners() {
    if (!this.worker) return;

    this.worker.addEventListener('message', (event) => {
      const data = /** @type {WorkerEvent} */ (event.data);

      switch (data.event) {
        case Events.PROGRESS:
          this.onProgress?.(data);
          break;

        case Events.COMPLETE:
          this._resolveComplete?.(data.gifData);
          this._resolveComplete = null;
          this._rejectComplete = null;
          break;

        case Events.ERROR:
          this._rejectComplete?.(createWorkerError(
            data.message || 'Encoding failed',
            WorkerErrorCode.ENCODING_FAILED,
            { originalMessage: data.message }
          ));
          this._resolveComplete = null;
          this._rejectComplete = null;
          break;

        case Events.CANCELLED:
          this._rejectComplete?.(new DOMException('Encoding cancelled', 'AbortError'));
          this._resolveComplete = null;
          this._rejectComplete = null;
          break;
      }
    });
  }
}

/**
 * Create GifEncoderManager instance
 * @returns {GifEncoderManager}
 */
export function createEncoderManager() {
  return new GifEncoderManager();
}
