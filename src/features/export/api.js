/**
 * Export API - Side Effect Functions
 * @module features/export/api
 */

import { applyFrameSkip, calculateFrameDelay, calculateProgress } from './core.js';
import { createEncoderManager } from '../../workers/worker-manager.js';

/**
 * Extract RGBA pixel data from a VideoFrame
 * Handles both full-frame (copyTo) and cropped (OffscreenCanvas) cases
 * @param {import('../capture/types.js').Frame} frame - Frame containing VideoFrame
 * @param {import('../editor/types.js').CropArea | null} crop - Optional crop region
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number }>}
 */
export async function getFrameRGBA(frame, crop) {
  // Validate frame
  if (!frame?.frame) {
    throw new Error('Invalid frame: VideoFrame is missing or closed');
  }

  const videoFrame = frame.frame;

  // Full-frame extraction: use VideoFrame.copyTo() for best performance
  if (!crop) {
    const width = videoFrame.codedWidth;
    const height = videoFrame.codedHeight;
    const byteLength = width * height * 4;
    const buffer = new Uint8ClampedArray(byteLength);

    await videoFrame.copyTo(buffer, {
      rect: { x: 0, y: 0, width, height },
      format: 'RGBA',
    });

    return { data: buffer, width, height };
  }

  // Cropped extraction: use OffscreenCanvas for GPU-accelerated crop
  const outputWidth = crop.width;
  const outputHeight = crop.height;

  const offscreen = new OffscreenCanvas(outputWidth, outputHeight);
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get OffscreenCanvas 2d context');
  }

  // Draw cropped region from VideoFrame
  ctx.drawImage(
    videoFrame,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    outputWidth,
    outputHeight
  );

  const imageData = ctx.getImageData(0, 0, outputWidth, outputHeight);
  return { data: imageData.data, width: outputWidth, height: outputHeight };
}

/**
 * @typedef {'wasm'|'js'|'unavailable'} EncoderStatus
 */

/**
 * Check encoder availability
 * @returns {Promise<EncoderStatus>}
 */
export async function checkEncoderStatus() {
  // gifenc is a pure JS encoder
  return 'js';
}

/**
 * @typedef {Object} EncodeParams
 * @property {import('../capture/types.js').Frame[]} frames - Frames to encode
 * @property {import('../editor/types.js').CropArea | null} crop - Crop region
 * @property {import('./types.js').ExportSettings} settings - Export settings
 * @property {number} fps - Source FPS for frame delay calculation
 * @property {(progress: { percent: number, current: number, total: number }) => void} onProgress
 */

/**
 * Encode frames to GIF using Worker
 * @param {EncodeParams} params
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation
 * @returns {Promise<Blob>}
 * @throws {DOMException} Throws AbortError if cancelled via signal
 */
/** Default FPS fallback */
const DEFAULT_FPS = 30;

export async function encodeGif(params, signal) {
  const { frames, crop, settings, fps = DEFAULT_FPS, onProgress } = params;

  // Apply frame skip
  const skippedFrames = applyFrameSkip(frames, settings.frameSkip);

  if (skippedFrames.length === 0) {
    throw new Error('No frames to encode');
  }

  // Convert centiseconds to milliseconds for gifenc
  const frameDelayCs = calculateFrameDelay(fps, settings.playbackSpeed, settings.frameSkip);
  const frameDelayMs = frameDelayCs * 10;

  // Determine output dimensions
  const firstFrame = skippedFrames[0];
  const width = crop ? crop.width : firstFrame.width;
  const height = crop ? crop.height : firstFrame.height;

  // Calculate max colors based on quality
  const maxColors = Math.max(16, Math.min(256, Math.round(settings.quality * 256)));

  // Create worker manager
  const manager = createEncoderManager();

  // Handle cancellation
  const abortHandler = () => {
    manager.cancel();
    manager.dispose();
  };
  signal?.addEventListener('abort', abortHandler);

  try {
    // Initialize worker
    await manager.init({
      encoderId: 'gifenc-js',
      width,
      height,
      totalFrames: skippedFrames.length,
      maxColors,
      frameDelayMs,
      loopCount: settings.loopCount,
    });

    // Setup progress callback
    manager.onProgress = ({ percent, frameIndex, totalFrames }) => {
      onProgress({
        percent,
        current: frameIndex + 1,
        total: totalFrames,
      });
    };

    // Extract and send frames to worker
    for (let i = 0; i < skippedFrames.length; i++) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new DOMException('Encoding cancelled', 'AbortError');
      }

      const frame = skippedFrames[i];

      // Extract RGBA data (handles crop internally)
      const { data: rgba, width: frameWidth, height: frameHeight } = await getFrameRGBA(frame, crop);

      // Send frame to worker
      manager.addFrame(rgba, frameWidth, frameHeight, i);
    }

    // Finish and return result
    return await manager.finish();
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    manager.dispose();
  }
}

/**
 * Download blob as file
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Delay before revoking blob URL in new tab (ms) - allows tab to load content */
const BLOB_URL_REVOKE_DELAY_MS = 60000;

/**
 * Open blob in new tab
 * @param {Blob} blob
 */
export function openInNewTab(blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  // Revoke URL after delay to prevent memory leak while allowing tab to load
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_DELAY_MS);
}

// Note: cancelEncoding function was removed - use AbortController pattern instead
// Pass AbortSignal to encodeGif() and call controller.abort() to cancel

/**
 * Copy blob to clipboard (if supported)
 * @param {Blob} blob
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(blob) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get file size from blob
 * @param {Blob} blob
 * @returns {{ bytes: number, formatted: string }}
 */
export function getBlobSize(blob) {
  const bytes = blob.size;
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return {
    bytes,
    formatted: `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`,
  };
}

/**
 * Scale a frame to target dimensions using Canvas
 * @param {ImageData} imageData - Source image data
 * @param {number} targetWidth - Target width
 * @param {number} targetHeight - Target height
 * @returns {ImageData} Scaled image data
 */
export function scaleFrame(imageData, targetWidth, targetHeight) {
  // Create source canvas with original image
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = imageData.width;
  srcCanvas.height = imageData.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) {
    throw new Error('Failed to get source canvas context');
  }
  srcCtx.putImageData(imageData, 0, 0);

  // Create destination canvas with target dimensions
  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = targetWidth;
  dstCanvas.height = targetHeight;
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) {
    throw new Error('Failed to get destination canvas context');
  }

  // Use high-quality image scaling
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = 'high';
  dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);

  return dstCtx.getImageData(0, 0, targetWidth, targetHeight);
}

