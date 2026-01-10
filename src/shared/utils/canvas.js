/**
 * Canvas Utilities
 * @module shared/utils/canvas
 *
 * Common canvas operations used across editor and export features.
 * Includes both pure validation functions and side-effect utilities for canvas manipulation.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Options for getting a canvas 2D context
 * @typedef {Object} ContextOptions
 * @property {boolean} [willReadFrequently=false] - Optimize for frequent getImageData calls
 * @property {boolean} [alpha=true] - Whether the canvas contains alpha channel
 */

/**
 * Options for rendering frame placeholder
 * @typedef {Object} PlaceholderOptions
 * @property {string} [backgroundColor='#333'] - Background fill color
 * @property {string} [textColor='white'] - Text color
 * @property {string} [message='Frame unavailable'] - Message to display
 * @property {string} [font='16px sans-serif'] - Font for message
 * @property {boolean} [showMessage=true] - Whether to show text message
 */

// ============================================================================
// Canvas Setup Utilities
// ============================================================================

/**
 * Get 2D rendering context from canvas with error handling
 *
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas - Target canvas
 * @param {ContextOptions} [options={}] - Context options
 * @returns {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} The 2D context
 * @throws {Error} If context cannot be obtained
 *
 * @example
 * const ctx = getContext2D(canvas);
 * const ctx = getContext2D(canvas, { willReadFrequently: true });
 */
export function getContext2D(canvas, options = {}) {
  const ctx = canvas.getContext('2d', options);
  if (!ctx) {
    throw new Error('Failed to get canvas 2D context');
  }
  return ctx;
}

/**
 * Synchronize canvas dimensions to target size if different
 * Returns true if dimensions were changed
 *
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas - Target canvas
 * @param {number} width - Desired width
 * @param {number} height - Desired height
 * @returns {boolean} True if dimensions were changed
 *
 * @example
 * const changed = syncCanvasSize(canvas, frame.width, frame.height);
 * if (changed) { // re-render overlays }
 */
export function syncCanvasSize(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

// ============================================================================
// Frame Validation Utilities
// ============================================================================

/**
 * Check if a VideoFrame is valid (exists and not closed)
 *
 * @param {VideoFrame | null | undefined} videoFrame - VideoFrame to validate
 * @returns {boolean} True if VideoFrame is usable
 *
 * @example
 * if (!isVideoFrameValid(frame.frame)) {
 *   renderPlaceholder(ctx);
 * }
 */
export function isVideoFrameValid(videoFrame) {
  return videoFrame != null && !videoFrame.closed;
}

/**
 * Check if a Frame object is valid (has valid VideoFrame)
 *
 * @param {import('../../features/capture/types.js').Frame | null | undefined} frame - Frame to validate
 * @returns {boolean} True if frame and its VideoFrame are usable
 *
 * @example
 * if (!isFrameValid(frame)) {
 *   renderPlaceholder(ctx);
 *   return;
 * }
 */
export function isFrameValid(frame) {
  return frame != null && isVideoFrameValid(frame.frame);
}

// ============================================================================
// Placeholder Rendering
// ============================================================================

/** @type {PlaceholderOptions} */
const DEFAULT_PLACEHOLDER_OPTIONS = {
  backgroundColor: '#333',
  textColor: 'white',
  message: 'Frame unavailable',
  font: '16px sans-serif',
  showMessage: true,
};

/**
 * Render a placeholder for missing or invalid frames
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx - Canvas context
 * @param {number} width - Placeholder width
 * @param {number} height - Placeholder height
 * @param {PlaceholderOptions} [options={}] - Rendering options
 *
 * @example
 * // Full placeholder with message
 * renderFramePlaceholder(ctx, 640, 480);
 *
 * // Simple gray fill for thumbnails
 * renderFramePlaceholder(ctx, 120, 90, { showMessage: false });
 */
export function renderFramePlaceholder(ctx, width, height, options = {}) {
  const opts = { ...DEFAULT_PLACEHOLDER_OPTIONS, ...options };
  const canvas = ctx.canvas;

  // Sync canvas size
  syncCanvasSize(canvas, width, height);

  // Fill background
  ctx.fillStyle = opts.backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // Render message if enabled
  if (opts.showMessage && opts.message) {
    ctx.fillStyle = opts.textColor;
    ctx.font = opts.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.message, width / 2, height / 2);
  }
}
