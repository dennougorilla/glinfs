/**
 * Scene Detection Manager
 * Manages async scene detection using Web Workers
 * @module features/scene-detection/manager
 */

import { DEFAULT_DETECTOR_OPTIONS } from './types.js';
import { getDrawableSource } from '../../shared/utils/canvas.js';

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

    return new Promise((resolve, reject) => {
      let timeoutId = null;
      let isSettled = false;

      const settle = (type, error) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (type === 'resolve') {
          resolve();
        } else {
          reject(error);
        }
      };

      try {
        this.#worker = new Worker(
          new URL('../../workers/scene-detection-worker.js', import.meta.url),
          { type: 'module' }
        );

        timeoutId = setTimeout(() => {
          settle('reject', new Error('Worker initialization timed out'));
          this.dispose();
        }, INIT_TIMEOUT_MS);

        const handleReady = (event) => {
          const data = event.data;
          if (data.type === 'READY') {
            this.#worker?.removeEventListener('message', handleReady);
            this.#setupListeners();
            this.#isInitialized = true;
            settle('resolve');
          } else if (data.type === 'ERROR') {
            this.#worker?.removeEventListener('message', handleReady);
            settle('reject', new Error(data.payload?.message || 'Worker init failed'));
          }
        };

        const handleError = (error) => {
          settle('reject', new Error(error.message || 'Worker creation failed'));
        };

        this.#worker.addEventListener('message', handleReady);
        this.#worker.addEventListener('error', handleError, { once: true });

        // Send init message with algorithm config
        this.#worker.postMessage({
          type: 'INIT',
          payload: { algorithmId: config.algorithmId },
        });
      } catch (error) {
        settle('reject', error instanceof Error ? error : new Error('Failed to create worker'));
      }
    });
  }

  /**
   * Set up message listeners
   */
  #setupListeners() {
    if (!this.#worker) return;

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
          break;

        case 'ERROR':
          this.#rejectDetect?.(new Error(/** @type {{message: string}} */ (data.payload).message));
          this.#resolveDetect = null;
          this.#rejectDetect = null;
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
    if (!this.#isInitialized || !this.#worker) {
      throw new Error('Manager not initialized. Call init() first.');
    }

    this.#isCancelled = false;
    this.#onProgress = options.onProgress ?? null;

    // Report initial progress
    this.#onProgress?.({
      percent: 0,
      currentFrame: 0,
      totalFrames: frames.length,
      stage: 'extracting',
    });

    // Extract frame data in batches to avoid blocking
    const frameData = await this.#extractFrameData(frames, options.sampleInterval ?? 1);

    if (this.#isCancelled) {
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
        transferables
      );
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
    this.#isCancelled = true;

    if (this.#worker && this.#isInitialized) {
      this.#worker.postMessage({ type: 'CANCEL' });
    }

    if (this.#rejectDetect) {
      this.#rejectDetect(new DOMException('Detection cancelled', 'AbortError'));
      this.#resolveDetect = null;
      this.#rejectDetect = null;
    }
  }

  /**
   * Check if detection is in progress
   * @returns {boolean}
   */
  isDetecting() {
    return this.#resolveDetect !== null;
  }

  /**
   * Dispose resources
   */
  dispose() {
    this.cancel();

    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }

    this.#canvas = null;
    this.#ctx = null;
    this.#isInitialized = false;
    this.#onProgress = null;
  }
}

/**
 * Create SceneDetectionManager instance
 * @returns {SceneDetectionManager}
 */
export function createSceneDetectionManager() {
  return new SceneDetectionManager();
}
