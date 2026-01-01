/**
 * Thumbnail Cache
 * LRU cache for thumbnail management
 * @module shared/utils/thumbnail-cache
 */

import { getThumbnailSizes } from './quality-settings.js';

/** @type {number} Default cache size */
const DEFAULT_CACHE_SIZE = 300;

/** @type {number} Default thumbnail size (device adaptive) */
const DEFAULT_THUMBNAIL_SIZE = getThumbnailSizes().timeline;

/**
 * LRU Thumbnail Cache
 * Efficient thumbnail generation using OffscreenCanvas
 */
export class ThumbnailCache {
  /**
   * @param {number} [maxSize=300] - Maximum cache entries
   */
  constructor(maxSize = DEFAULT_CACHE_SIZE) {
    /** @type {Map<string, HTMLCanvasElement>} */
    this.cache = new Map();

    /** @type {number} */
    this.maxSize = maxSize;
  }

  /**
   * Get thumbnail from cache
   * @param {string} frameId - Frame ID
   * @returns {HTMLCanvasElement | null}
   */
  get(frameId) {
    const cached = this.cache.get(frameId);
    if (cached) {
      // LRU: Move accessed entry to end
      this.cache.delete(frameId);
      this.cache.set(frameId, cached);
      return cached;
    }
    return null;
  }

  /**
   * Check if thumbnail exists
   * @param {string} frameId - Frame ID
   * @returns {boolean}
   */
  has(frameId) {
    return this.cache.has(frameId);
  }

  /**
   * Generate thumbnail and cache
   * @param {import('../../features/capture/types.js').Frame} frame - Frame
   * @param {number} [maxDimension=80] - Maximum size
   * @returns {Promise<HTMLCanvasElement>}
   */
  async generate(frame, maxDimension = DEFAULT_THUMBNAIL_SIZE) {
    // Return if cached
    const cached = this.get(frame.id);
    if (cached) return cached;

    // Calculate scale
    const scale = Math.min(maxDimension / frame.width, maxDimension / frame.height);
    const thumbWidth = Math.round(frame.width * scale);
    const thumbHeight = Math.round(frame.height * scale);

    // Draw with OffscreenCanvas (can be processed in background)
    const offscreen = new OffscreenCanvas(thumbWidth, thumbHeight);
    const ctx = offscreen.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get OffscreenCanvas context');
    }

    if (!frame?.frame) {
      // Invalid frame gets placeholder
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, thumbWidth, thumbHeight);
    } else {
      ctx.drawImage(frame.frame, 0, 0, thumbWidth, thumbHeight);
    }

    // Convert to regular Canvas (for DOM display)
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const canvasCtx = canvas.getContext('2d');

    if (!canvasCtx) {
      throw new Error('Failed to get canvas context');
    }

    canvasCtx.drawImage(offscreen, 0, 0);

    // Add to cache
    this._addToCache(frame.id, canvas);

    return canvas;
  }

  /**
   * Batch generate thumbnails for multiple frames
   * Non-blocking processing with requestIdleCallback
   * @param {import('../../features/capture/types.js').Frame[]} frames - Frame array
   * @param {number} [maxDimension=80] - Maximum size
   * @param {(progress: number) => void} [onProgress] - Progress callback
   * @returns {Promise<void>}
   */
  async generateBatch(frames, maxDimension = DEFAULT_THUMBNAIL_SIZE, onProgress) {
    const uncached = frames.filter((f) => !this.cache.has(f.id));

    if (uncached.length === 0) {
      onProgress?.(100);
      return;
    }

    const BATCH_SIZE = 10;
    let processed = 0;

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
      const batch = uncached.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map((f) => this.generate(f, maxDimension)));

      processed += batch.length;
      onProgress?.(Math.round((processed / uncached.length) * 100));

      // Yield to main thread
      await new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(resolve, { timeout: 16 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }

  /**
   * Add to cache (LRU)
   * @param {string} frameId
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  _addToCache(frameId, canvas) {
    // LRU: Remove oldest entry when over capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(frameId, canvas);
  }

  /**
   * Invalidate cache for specific frame
   * @param {string} frameId
   */
  invalidate(frameId) {
    this.cache.delete(frameId);
  }

  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache size
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }
}

/** @type {ThumbnailCache | null} */
let instance = null;

/**
 * Get singleton instance
 * @returns {ThumbnailCache}
 */
export function getThumbnailCache() {
  if (!instance) {
    instance = new ThumbnailCache();
  }
  return instance;
}

/**
 * Reset singleton instance (for testing)
 */
export function resetThumbnailCache() {
  if (instance) {
    instance.clear();
    instance = null;
  }
}
