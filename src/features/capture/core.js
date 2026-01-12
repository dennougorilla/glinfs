/**
 * Capture Core - Pure Functions
 * @module features/capture/core
 */

// Import and re-export VideoFrame utilities
import { safeClose, safeCloseFrame, closeAllFrames } from '../../shared/utils/videoframe.js';
export { safeClose, safeCloseFrame, closeAllFrames };

/**
 * Valid FPS values
 * @type {readonly [15, 30, 60]}
 */
const VALID_FPS = /** @type {const} */ ([15, 30, 60]);

/**
 * Create a new circular buffer
 * @param {number} maxFrames - Maximum frame capacity
 * @returns {import('./types.js').Buffer} New buffer instance
 */
export function createBuffer(maxFrames) {
  return {
    frames: new Array(maxFrames),
    maxFrames,
    maxDurationMs: 0,
    head: 0,
    tail: 0,
    size: 0,
    totalMemoryBytes: 0,
  };
}

/**
 * Add frame to buffer, evicting oldest if full
 * Pure function - caller is responsible for releasing evicted frames via pool
 * Uses incremental memory calculation for O(1) performance
 * Note: Modifies buffer.frames in place for efficiency, but returns new buffer object
 * @param {import('./types.js').Buffer} buffer - Current buffer
 * @param {import('./types.js').Frame} frame - Frame to add
 * @returns {import('./types.js').Buffer} New buffer state
 */
export function addFrame(buffer, frame) {
  const newTail = (buffer.tail + 1) % buffer.maxFrames;
  let newHead = buffer.head;
  let newSize = buffer.size;

  // Calculate memory for new frame (O(1) incremental update)
  // VideoFrames are GPU-resident; CPU overhead is ~1/10 of raw RGBA pixel data
  // Raw: width × height × 4 bytes (RGBA). See: shared/utils/memory-monitor.js
  const frameMemory = (frame.width * frame.height * 4) / 10;
  let newTotalMemoryBytes = buffer.totalMemoryBytes + frameMemory;

  if (buffer.size < buffer.maxFrames) {
    // Buffer has space - just add frame
    buffer.frames[buffer.tail] = frame;
    newSize++;
  } else {
    // Buffer is full - overwrite oldest frame
    // Note: Caller is responsible for releasing evicted frame via pool BEFORE calling addFrame
    const evictedFrame = buffer.frames[buffer.head];
    if (evictedFrame) {
      // Subtract evicted frame's memory (same GPU-resident formula as above)
      const evictedMemory = (evictedFrame.width * evictedFrame.height * 4) / 10;
      newTotalMemoryBytes -= evictedMemory;
    }
    buffer.frames[buffer.tail] = frame;
    // Advance head to evict oldest
    newHead = (buffer.head + 1) % buffer.maxFrames;
  }

  // Return new buffer object (frames array is same reference for efficiency)
  // React detects state change via buffer object reference, not array contents
  return {
    ...buffer,
    head: newHead,
    tail: newTail,
    size: newSize,
    totalMemoryBytes: newTotalMemoryBytes,
  };
}

/**
 * Clear buffer and return empty buffer with same capacity
 * Note: Caller is responsible for releasing frames via releaseAll('capture') BEFORE calling
 * @param {import('./types.js').Buffer} buffer - Buffer to clear
 * @returns {import('./types.js').Buffer} Empty buffer with same capacity
 */
export function clearBuffer(buffer) {
  return createBuffer(buffer.maxFrames);
}

/**
 * Get all frames in chronological order
 * @param {import('./types.js').Buffer} buffer - Buffer to read
 * @returns {import('./types.js').Frame[]} Frames in order
 */
export function getFrames(buffer) {
  const result = [];
  for (let i = 0; i < buffer.size; i++) {
    const index = (buffer.head + i) % buffer.maxFrames;
    const frame = buffer.frames[index];
    if (frame) {
      result.push(frame);
    }
  }
  return result;
}

/**
 * Calculate buffer statistics
 * Uses pre-calculated totalMemoryBytes for O(1) performance
 * @param {import('./types.js').Buffer} buffer - Buffer to analyze
 * @param {number} fps - Frames per second
 * @returns {import('./types.js').BufferStats} Statistics
 */
export function calculateStats(buffer, fps) {
  return {
    frameCount: buffer.size,
    duration: buffer.size / fps,
    memoryMB: buffer.totalMemoryBytes / (1024 * 1024),
    fps,
  };
}

/**
 * Validate capture settings
 * @param {Partial<import('./types.js').CaptureSettings>} settings - Settings to validate
 * @returns {import('../../shared/types.js').ValidationResult} Validation result
 */
export function validateSettings(settings) {
  /** @type {string[]} */
  const errors = [];

  // Validate FPS
  if (settings.fps !== undefined) {
    if (!VALID_FPS.includes(/** @type {15|30|60} */ (settings.fps))) {
      errors.push('FPS must be 15, 30, or 60');
    }
  }

  // Validate buffer duration
  if (settings.bufferDuration !== undefined) {
    if (settings.bufferDuration < 5 || settings.bufferDuration > 60) {
      errors.push('Buffer duration must be between 5 and 60 seconds');
    }
  }

  // Validate thumbnail quality
  if (settings.thumbnailQuality !== undefined) {
    if (settings.thumbnailQuality < 0.1 || settings.thumbnailQuality > 1.0) {
      errors.push('Thumbnail quality must be between 0.1 and 1.0');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Create default capture settings
 * @returns {import('./types.js').CaptureSettings} Default settings
 */
export function createDefaultSettings() {
  return {
    fps: 30,
    bufferDuration: 10,
    thumbnailQuality: 0.5,
    sceneDetection: false,
  };
}

/**
 * Calculate max frames from settings
 * @param {import('./types.js').CaptureSettings} settings - Capture settings
 * @returns {number} Maximum frames
 */
export function calculateMaxFrames(settings) {
  return settings.fps * settings.bufferDuration;
}

/**
 * Extract clip from buffer during active recording
 * Creates cloned VideoFrames - caller is responsible for closing them when done
 * @param {import('./types.js').Buffer} buffer - Current capture buffer
 * @param {number} fps - Frames per second
 * @param {number} [maxDurationMs=10000] - Maximum clip duration in milliseconds
 * @returns {import('./types.js').ClipExtractionResult} Extracted clip data with cloned frames
 */
export function extractClipFromBuffer(buffer, fps, maxDurationMs = 10000) {
  const frames = getFrames(buffer);

  if (frames.length === 0) {
    return {
      frames: [],
      fps,
      duration: 0,
      capturedAt: Date.now(),
      frameCount: 0,
    };
  }

  // Calculate how many frames fit in maxDurationMs
  const maxFrames = Math.ceil((maxDurationMs / 1000) * fps);

  // Slice most recent frames
  const clipFrames = frames.slice(-maxFrames);

  // Clone VideoFrames for the clip (caller responsible for closing)
  const clonedFrames = clipFrames.map((frame) => ({
    id: frame.id,
    frame: frame.frame.clone(),
    timestamp: frame.timestamp,
    width: frame.width,
    height: frame.height,
  }));

  return {
    frames: clonedFrames,
    fps,
    duration: clipFrames.length / fps,
    capturedAt: Date.now(),
    frameCount: clipFrames.length,
  };
}
