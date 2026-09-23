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
   * @param {{ maxBytes?: number }} [options] - Optional total pixel-memory
   *   budget, estimated as width * height * 4 per entry (unbounded by default)
   */
  constructor(maxSize = DEFAULT_CACHE_SIZE, { maxBytes = Infinity } = {}) {
    /** @type {Map<string, HTMLCanvasElement>} */
    this.cache = new Map();

    /** @type {number} */
    this.maxSize = maxSize;

    /** @type {number} */
    this.maxBytes = maxBytes;

    /**
     * Byte estimate per key, recorded at insert time. Kept separately from
     * the canvas because a released canvas reads back as 0x0.
     * @type {Map<string, number>}
     */
    this._entryBytes = new Map();

    /** @type {number} */
    this._bytes = 0;
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
    const bytes = canvas.width * canvas.height * 4;
    this._delete(key);
    // LRU: Remove oldest entries while over the entry or byte budget. An
    // entry larger than the whole byte budget is still stored on its own.
    while (
      this.cache.size > 0 &&
      (this.cache.size >= this.maxSize || this._bytes + bytes > this.maxBytes)
    ) {
      this._delete(this.cache.keys().next().value);
    }
    this.cache.set(key, canvas);
    this._entryBytes.set(key, bytes);
    this._bytes += bytes;
  }

  /**
   * Remove one entry and its byte accounting.
   * @param {string} key
   * @private
   */
  _delete(key) {
    this.cache.delete(key);
    this._bytes -= this._entryBytes.get(key) ?? 0;
    this._entryBytes.delete(key);
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
        this._delete(key);
      }
    }
  }

  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
    this._entryBytes.clear();
    this._bytes = 0;
  }

  /**
   * Zero every cached canvas's backing store, then clear the cache.
   *
   * Only for caches whose canvases never enter the DOM (e.g. the frame
   * grid's, which inserts clones). The shared cache's `generate()` hands out
   * the cached canvas itself, so releasing it would blank live thumbnails.
   */
  release() {
    this.cache.forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    this.clear();
  }

  /**
   * Get cache size
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Estimated pixel memory held by the cache (width * height * 4 per entry)
   * @returns {number}
   */
  get bytes() {
    return this._bytes;
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
 * Budgets for a frame grid mount's cache (see `createGridThumbnailCache`).
 *
 * The byte cap is what actually bounds memory: at the 'ultra' preset (400px
 * longest side) a 1:1 thumbnail is 400*400*4 = 640 KB, so 64 MB holds ~100
 * of them (~180 at 16:9). Smaller presets and denser grids hit the entry cap
 * first. 'ultra' can be forced from settings on any device, so the cap does
 * not assume a large-memory device.
 */
const GRID_CACHE_SIZE = 600;
const GRID_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Create a cache for one frame grid modal mount.
 *
 * Each mount owns its cache and calls `release()` on it when the modal
 * closes, so no grid thumbnail outlives the modal (or its clip), and memory
 * after close returns to what it was before the grid opened (#72). A
 * separate instance also keeps the grid's denser thumbnails from evicting
 * the timeline filmstrip's and scene panel's entries in the shared cache.
 * @returns {ThumbnailCache}
 */
export function createGridThumbnailCache() {
  return new ThumbnailCache(GRID_CACHE_SIZE, { maxBytes: GRID_CACHE_MAX_BYTES });
}

/**
 * Reset the singleton instance. Called by the app store whenever the clip's
 * frames change or are cleared — cached canvases are keyed by the previous
 * clip's frame IDs and can never be reused afterwards. Also used by tests.
 */
export function resetThumbnailCache() {
  if (instance) {
    instance.clear();
    instance = null;
  }
}
