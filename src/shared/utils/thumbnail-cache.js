/**
 * Thumbnail Cache
 * LRU cache for thumbnail management
 * @module shared/utils/thumbnail-cache
 */

import { getDrawableSource } from './canvas.js';
import { getThumbnailSizes } from './quality-settings.js';

/** @type {number} Default cache size */
const DEFAULT_CACHE_SIZE = 300;

/**
 * Default thumbnail size (device adaptive).
 *
 * Read lazily (only when a caller omits `maxDimension`) rather than once at
 * module load. Callers that always pass an explicit size — e.g. the frame
 * grid, which sizes thumbnails from live grid density — never trigger this,
 * so it also avoids forcing `getThumbnailSizes()` to resolve before a
 * consumer has finished setting up quality-settings mocks/state in tests.
 * @returns {number}
 */
function getDefaultThumbnailSize() {
  return getThumbnailSizes().timeline;
}

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
   * Build the internal cache key for a frame at a given thumbnail size.
   * A frame requested at two different sizes must not collide, otherwise
   * whichever size was generated first "wins" silently for every later
   * request at a different size.
   * @param {string} frameId - Frame ID
   * @param {number} maxDimension - Maximum thumbnail dimension
   * @returns {string}
   * @private
   */
  _key(frameId, maxDimension) {
    return `${frameId}@${maxDimension}`;
  }

  /**
   * Get thumbnail from cache
   * @param {string} frameId - Frame ID
   * @param {number} [maxDimension] - Maximum size this thumbnail was generated at
   * @returns {HTMLCanvasElement | null}
   */
  get(frameId, maxDimension = getDefaultThumbnailSize()) {
    const key = this._key(frameId, maxDimension);
    const cached = this.cache.get(key);
    if (cached) {
      // LRU: Move accessed entry to end
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    return null;
  }

  /**
   * Check if thumbnail exists
   * @param {string} frameId - Frame ID
   * @param {number} [maxDimension] - Maximum size this thumbnail was generated at
   * @returns {boolean}
   */
  has(frameId, maxDimension = getDefaultThumbnailSize()) {
    return this.cache.has(this._key(frameId, maxDimension));
  }

  /**
   * Generate thumbnail and cache
   * @param {import('../../features/capture/types.js').Frame} frame - Frame
   * @param {number} [maxDimension=80] - Maximum size
   * @returns {Promise<HTMLCanvasElement>}
   */
  async generate(frame, maxDimension = getDefaultThumbnailSize()) {
    // Return if cached at this exact size
    const cached = this.get(frame.id, maxDimension);
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

    // Get drawable source (supports both real VideoFrames and mock frames)
    const source = getDrawableSource(frame);
    if (source) {
      ctx.drawImage(source, 0, 0, thumbWidth, thumbHeight);
    } else {
      // Invalid frame gets placeholder
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, thumbWidth, thumbHeight);
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
    this._addToCache(frame.id, canvas, maxDimension);

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
  async generateBatch(frames, maxDimension = getDefaultThumbnailSize(), onProgress) {
    const uncached = frames.filter((f) => !this.has(f.id, maxDimension));

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
   * @param {number} [maxDimension] - Maximum size this thumbnail was generated at
   * @private
   */
  _addToCache(frameId, canvas, maxDimension = getDefaultThumbnailSize()) {
    const key = this._key(frameId, maxDimension);
    // LRU: Remove oldest entry when over capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, canvas);
  }

  /**
   * Add an externally-rendered canvas to the cache (LRU).
   *
   * Public counterpart to the private `_addToCache`, for callers (e.g. the
   * timeline filmstrip) that draw their own thumbnail canvas via a
   * different code path than `generate()` but still need cache/eviction
   * semantics consistent with the rest of this class.
   * @param {string} frameId - Frame ID
   * @param {number} maxDimension - Maximum size this thumbnail was generated at
   * @param {HTMLCanvasElement} canvas - Pre-rendered thumbnail canvas
   */
  addCanvas(frameId, maxDimension, canvas) {
    this._addToCache(frameId, canvas, maxDimension);
  }

  /**
   * Invalidate cache for specific frame (all cached sizes)
   * @param {string} frameId
   */
  invalidate(frameId) {
    const prefix = `${frameId}@`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
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
 * Entry budget for the frame grid's dedicated cache (see
 * `getGridThumbnailCache`).
 *
 * A single modal open materializes its virtual window twice — once at an
 * initial size estimate, once more after the auto-fit pass settles on the
 * final grid density — and a dense, wide viewport can materialize on the
 * order of 150-200 visible+overscan items per pass. Sizing the budget at
 * roughly 2-3x that (rather than the shared timeline/scene-panel cache's
 * 300) keeps the *current* mount's thumbnails resident and leaves headroom
 * for scrolling back through recent rows, at the cost of a larger memory
 * ceiling than the shared cache.
 *
 * Worst case memory (quality preset 'ultra', 400px max dimension, 16:9
 * thumbnails): 600 * 400*225*4 bytes ≈ 205 MB. Standard/high presets
 * (<=320px) stay under ~145 MB. 'ultra' is only auto-selected on devices
 * reporting >=8GB memory, and this cache exists only while a clip with an
 * open (or previously opened) frame grid is loaded, so this is an accepted
 * trade-off rather than a tuned-to-the-byte figure — revisit alongside the
 * frame-grid virtualization work in #74 if it proves too large in practice.
 */
const GRID_CACHE_SIZE = 600;

/** @type {ThumbnailCache | null} */
let gridInstance = null;

/**
 * Get the frame grid's dedicated cache instance.
 *
 * A separate instance (rather than reusing `getThumbnailCache()`) keeps the
 * grid's much larger, denser set of thumbnails from evicting the timeline
 * filmstrip's and scene panel's entries out of the shared 300-entry budget
 * whenever the frame grid modal is open.
 * @returns {ThumbnailCache}
 */
export function getGridThumbnailCache() {
  if (!gridInstance) {
    gridInstance = new ThumbnailCache(GRID_CACHE_SIZE);
  }
  return gridInstance;
}

/**
 * Reset both singleton instances. Called by the app store whenever the
 * clip's frames change or are cleared — cached canvases are keyed by the
 * previous clip's frame IDs and can never be reused afterwards. Also used
 * by tests.
 */
export function resetThumbnailCache() {
  if (instance) {
    instance.clear();
    instance = null;
  }
  if (gridInstance) {
    gridInstance.clear();
    gridInstance = null;
  }
}
