/**
 * Scene Detection Manager
 * Manages async scene detection using Web Workers
 * @module features/scene-detection/manager
 */

import { getDrawableSource } from '../../shared/utils/canvas.js';
import { DEFAULT_DETECTOR_OPTIONS } from './types.js';

/**
 * @typedef {import('./types.js').SceneDetectionResult} SceneDetectionResult
 * @typedef {import('./types.js').DetectorOptions} DetectorOptions
 * @typedef {import('./types.js').DetectionProgress} DetectionProgress
 * @typedef {import('./types.js').FrameData} FrameData
 * @typedef {import('./types.js').WorkerOutMessage} WorkerOutMessage
 * @typedef {import('../capture/types.js').Frame} Frame
 */

/**
 * Configuration for scene detection
 * @typedef {Object} SceneDetectionConfig
 * @property {string} [algorithmId] - Algorithm to use (defaults to registry default)
 * @property {number} [thumbnailSize=64] - Size for frame thumbnails (smaller = faster, less accurate)
 */

/** Default thumbnail size for frame extraction */
const DEFAULT_THUMBNAIL_SIZE = 64;

/** Initialization timeout in milliseconds */
const INIT_TIMEOUT_MS = 5000;

/**
 * Scene Detection Manager
 * Handles worker lifecycle and frame data extraction
 */
export class SceneDetectionManager {
  constructor() {
    /** @type {Worker | null} */
    this.#worker = null;

    /** @type {boolean} */
    this.#isInitialized = false;

    /** @type {((result: SceneDetectionResult) => void) | null} */
    this.#resolveDetect = null;

    /** @type {((error: Error) => void) | null} */
    this.#rejectDetect = null;

    /** @type {((progress: DetectionProgress) => void) | null} */
    this.#onProgress = null;

    /** @type {boolean} */
    this.#isCancelled = false;

    /** @type {boolean} */
    this.#isDetectionActive = false;

    /** @type {Error | null} */
    this.#workerError = null;

    /** @type {Promise<void> | null} */
    this.#initPromise = null;

    /** @type {(() => void) | null} */
    this.#cancelInit = null;

    /** @type {OffscreenCanvas | null} */
    this.#canvas = null;

    /** @type {OffscreenCanvasRenderingContext2D | null} */
    this.#ctx = null;
  }

  /** @type {Worker | null} */
  #worker;

  /** @type {boolean} */
  #isInitialized;

  /** @type {((result: SceneDetectionResult) => void) | null} */
  #resolveDetect;

  /** @type {((error: Error) => void) | null} */
  #rejectDetect;

  /** @type {((progress: DetectionProgress) => void) | null} */
  #onProgress;

  /** @type {boolean} */
  #isCancelled;

  /** @type {boolean} */
  #isDetectionActive;

  /** @type {Error | null} */
  #workerError;

  /** @type {Promise<void> | null} */
  #initPromise;

  /** @type {(() => void) | null} */
  #cancelInit;

  /** @type {OffscreenCanvas | null} */
  #canvas;

  /** @type {OffscreenCanvasRenderingContext2D | null} */
  #ctx;

  /**
   * Initialize the worker
   * @param {SceneDetectionConfig} [config={}] - Configuration options
   * @returns {Promise<void>}
   */
  async init(config = {}) {
    if (this.#isInitialized) {
      return;
    }

    if (this.#initPromise) {
      return this.#initPromise;
    }

    this.#workerError = null;

    /** @type {() => void} */
    let resolveInit = () => {};
    /** @type {(error: Error) => void} */
    let rejectInit = () => {};
    const initPromise = new Promise((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });
    this.#initPromise = initPromise;

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timeoutId = null;
    let isSettled = false;

    const settle = (type, error) => {
      if (isSettled) return;
      isSettled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      this.#initPromise = null;
      this.#cancelInit = null;
      if (type === 'resolve') {
        resolveInit();
      } else {
        rejectInit(error);
      }
    };

    const fail = (error) => {
      if (isSettled) return;
      settle('reject', error);
      this.#worker?.terminate();
      this.#worker = null;
      this.#isInitialized = false;
    };

    this.#cancelInit = () => {
      fail(new DOMException('Scene detection initialization cancelled', 'AbortError'));
    };

    try {
      this.#worker = new Worker(
        new URL('../../workers/scene-detection-worker.js', import.meta.url),
        { type: 'module' },
      );

      timeoutId = setTimeout(() => {
        fail(new Error('Worker initialization timed out'));
      }, INIT_TIMEOUT_MS);

      const handleReady = (event) => {
        if (isSettled) return;
        const data = event.data;
        if (data.type === 'READY') {
          this.#worker?.removeEventListener('message', handleReady);
          this.#worker?.removeEventListener('error', handleError);
          this.#setupListeners();
          this.#isInitialized = true;
          settle('resolve');
        } else if (data.type === 'ERROR') {
          fail(new Error(data.payload?.message || 'Worker init failed'));
        }
      };

      const handleError = (error) => {
        fail(new Error(error.message || 'Worker creation failed'));
      };

      this.#worker.addEventListener('message', handleReady);
      this.#worker.addEventListener('error', handleError, { once: true });

      // Send init message with algorithm config
      this.#worker.postMessage({
        type: 'INIT',
        payload: { algorithmId: config.algorithmId },
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Failed to create worker'));
    }

    return initPromise;
  }

  /**
   * Set up message listeners
   */
  #setupListeners() {
    if (!this.#worker) return;

    this.#worker.addEventListener(
      'error',
      (event) => {
        const error = new Error(event.message || 'Scene detection worker failed');
        this.#workerError = error;
        this.#rejectDetect?.(error);
        this.#resolveDetect = null;
        this.#rejectDetect = null;
        this.#onProgress = null;
        this.#isDetectionActive = false;
        this.#worker?.terminate();
        this.#worker = null;
        this.#isInitialized = false;
      },
      { once: true },
    );

    this.#worker.addEventListener('message', (event) => {
      /** @type {WorkerOutMessage} */
      const data = event.data;

      switch (data.type) {
        case 'PROGRESS':
          this.#onProgress?.(/** @type {DetectionProgress} */ (data.payload));
          break;

        case 'COMPLETE':
          this.#resolveDetect?.(/** @type {SceneDetectionResult} */ (data.payload));
          this.#resolveDetect = null;
          this.#rejectDetect = null;
          this.#onProgress = null;
          this.#isDetectionActive = false;
          break;

        case 'ERROR':
          this.#rejectDetect?.(new Error(/** @type {{message: string}} */ (data.payload).message));
          this.#resolveDetect = null;
          this.#rejectDetect = null;
          this.#onProgress = null;
          this.#isDetectionActive = false;
          break;
      }
    });
  }

  /**
   * Detect scenes in frames
   * @param {Frame[]} frames - Frames to analyze
   * @param {DetectorOptions} [options] - Detection options
   * @returns {Promise<SceneDetectionResult>}
   */
  async detect(frames, options = DEFAULT_DETECTOR_OPTIONS) {
    if (this.#workerError) {
      throw this.#workerError;
    }

    if (!this.#isInitialized || !this.#worker) {
      throw new Error('Manager not initialized. Call init() first.');
    }

    if (this.#isDetectionActive) {
      throw new Error('Scene detection is already in progress');
    }

    const sampleInterval = options.sampleInterval ?? 1;
    if (!Number.isInteger(sampleInterval) || sampleInterval < 1) {
      throw new RangeError('sampleInterval must be a positive integer');
    }

    this.#isCancelled = false;
    this.#isDetectionActive = true;
    this.#onProgress = options.onProgress ?? null;

    // Report initial progress
    this.#onProgress?.({
      percent: 0,
      currentFrame: 0,
      totalFrames: frames.length,
      stage: 'extracting',
    });

    // Extract frame data in batches to avoid blocking
    let frameData;
    try {
      frameData = await this.#extractFrameData(frames, sampleInterval);
    } catch (error) {
      this.#isDetectionActive = false;
      this.#onProgress = null;
      throw error;
    }

    // A native worker error can happen while thumbnail extraction is yielding
    // to the event loop, before the detection promise installs its rejector.
    if (this.#workerError) {
      this.#isDetectionActive = false;
      this.#onProgress = null;
      throw this.#workerError;
    }

    if (this.#isCancelled) {
      this.#isDetectionActive = false;
      this.#onProgress = null;
      throw new DOMException('Detection cancelled', 'AbortError');
    }

    // Send to worker for detection
    return new Promise((resolve, reject) => {
      this.#resolveDetect = resolve;
      this.#rejectDetect = reject;

      // Transfer ImageData buffers to worker
      const transferables = frameData
        .filter((f) => f.imageData)
        .map((f) => /** @type {ImageData} */ (f.imageData).data.buffer);

      try {
        this.#worker?.postMessage(
          {
            type: 'DETECT',
            payload: {
              frameData,
              options: {
                threshold: options.threshold,
                minSceneDuration: options.minSceneDuration,
                sampleInterval: 1, // Already sampled during extraction
              },
            },
          },
          transferables,
        );
      } catch (error) {
        this.#resolveDetect = null;
        this.#rejectDetect = null;
        this.#onProgress = null;
        this.#isDetectionActive = false;
        reject(error instanceof Error ? error : new Error('Failed to start scene detection'));
      }
    });
  }

  /**
   * Extract lightweight data from frames for detection
   * @param {Frame[]} frames - Source frames
   * @param {number} sampleInterval - Sampling interval
   * @returns {Promise<FrameData[]>}
   */
  async #extractFrameData(frames, sampleInterval) {
    /** @type {FrameData[]} */
    const frameData = [];

    // Initialize canvas for thumbnail extraction
    const thumbnailSize = DEFAULT_THUMBNAIL_SIZE;
    if (!this.#canvas) {
      this.#canvas = new OffscreenCanvas(thumbnailSize, thumbnailSize);
      this.#ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
    }

    const ctx = this.#ctx;
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Process frames with sampling
    for (let i = 0; i < frames.length; i += sampleInterval) {
      if (this.#isCancelled) break;

      const frame = frames[i];

      // Report extraction progress
      this.#onProgress?.({
        percent: Math.round((i / frames.length) * 30), // 0-30% for extraction
        currentFrame: i,
        totalFrames: frames.length,
        stage: 'extracting',
      });

      /** @type {FrameData} */
      const data = {
        index: i,
        timestamp: frame.timestamp,
        imageData: null,
        histogram: null,
      };

      // Extract thumbnail ImageData from VideoFrame
      if (frame.frame && !frame.frame.closed) {
        try {
          // Calculate aspect-aware thumbnail dimensions
          const aspectRatio = frame.width / frame.height;
          let drawWidth = thumbnailSize;
          let drawHeight = thumbnailSize;

          if (aspectRatio > 1) {
            drawHeight = Math.round(thumbnailSize / aspectRatio);
          } else {
            drawWidth = Math.round(thumbnailSize * aspectRatio);
          }

          // Clear and draw scaled frame (supports mock frames)
          ctx.clearRect(0, 0, thumbnailSize, thumbnailSize);
          const source = getDrawableSource(frame);
          if (source) {
            ctx.drawImage(source, 0, 0, drawWidth, drawHeight);
          }

          // Extract ImageData
          data.imageData = ctx.getImageData(0, 0, drawWidth, drawHeight);
        } catch (error) {
          // Frame may be closed or invalid, skip it
          console.warn(`Failed to extract frame ${i}:`, error);
        }
      }

      frameData.push(data);

      // Yield to event loop periodically
      if (i % 5 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return frameData;
  }

  /**
   * Cancel ongoing detection
   */
  cancel() {
    const wasDetectionActive = this.#isDetectionActive;
    this.#isCancelled = true;
    this.#onProgress = null;

    if (this.#rejectDetect) {
      this.#rejectDetect(new DOMException('Detection cancelled', 'AbortError'));
      this.#resolveDetect = null;
      this.#rejectDetect = null;
    }
    this.#isDetectionActive = false;

    // A worker can still be yielding inside an async DETECT handler when it
    // receives CANCEL. Reusing that worker immediately would allow a new
    // DETECT message to clear the worker's cancellation flag and interleave
    // results from both runs. Make cancellation terminal for the active
    // worker; callers can explicitly init() again before starting a new run.
    if (wasDetectionActive && this.#worker) {
      try {
        if (this.#isInitialized) {
          this.#worker.postMessage({ type: 'CANCEL' });
        }
      } finally {
        this.#worker.terminate();
        this.#worker = null;
        this.#isInitialized = false;
      }
    }
  }

  /**
   * Check if detection is in progress
   * @returns {boolean}
   */
  isDetecting() {
    return this.#isDetectionActive;
  }

  /**
   * Dispose resources
   */
  dispose() {
    this.#cancelInit?.();
    this.cancel();

    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }

    this.#canvas = null;
    this.#ctx = null;
    this.#isInitialized = false;
    this.#onProgress = null;
    this.#workerError = null;
    this.#isDetectionActive = false;
    this.#initPromise = null;
    this.#cancelInit = null;
  }
}

/**
 * Create SceneDetectionManager instance
 * @returns {SceneDetectionManager}
 */
export function createSceneDetectionManager() {
  return new SceneDetectionManager();
}
