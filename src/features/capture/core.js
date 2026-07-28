/**
 * Capture Core - Pure Functions
 * @module features/capture/core
 */

import { loadSettings } from '../../shared/user-settings.js';

/**
 * Valid FPS values
 * @type {readonly [15, 30, 60]}
 */
const VALID_FPS = /** @type {const} */ ([15, 30, 60]);

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
 * Loads from user settings if available
 * @returns {import('./types.js').CaptureSettings} Default settings
 */
export function createDefaultSettings() {
  // Try to load from user settings
  try {
    const userSettings = loadSettings();
    return {
      fps: userSettings.capture.fps,
      bufferDuration: userSettings.capture.bufferDuration,
      thumbnailQuality: 0.5, // This is managed separately in quality-settings.js
      sceneDetection: userSettings.capture.sceneDetection,
    };
  } catch {
    // Fallback to hardcoded defaults if import fails
    return {
      fps: 30,
      bufferDuration: 15,
      thumbnailQuality: 0.5,
      sceneDetection: true,
    };
  }
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
 * Share of the memory budget the ring buffer may occupy. The rest is
 * headroom for the active clip, the queue, and the transient
 * ImageBitmap->VideoFrame double-hold during clip creation (#96).
 */
const BUFFER_BUDGET_SHARE = 0.6;

/**
 * Max frames the ring buffer may hold, clamped by the memory budget.
 *
 * The requested fps x bufferDuration is honored only while it fits in the
 * buffer's share of the budget at the ACTUAL captured frame size (after the
 * resolution limit). A Retina fullscreen at native size can push the naive
 * figure past 10 GB — the clamp is what keeps "defaults on a big screen"
 * from taking the machine down (#96).
 *
 * @param {import('./types.js').CaptureSettings} settings - fps / bufferDuration
 * @param {{ width: number, height: number } | null} frameDims - Actual
 *   captured frame dimensions; null (metadata not ready) skips the clamp
 * @param {number} memoryBudgetMB - Total frame-memory budget
 * @returns {{ maxFrames: number, requestedFrames: number, clamped: boolean,
 *   effectiveDuration: number }}
 */
export function calculateEffectiveMaxFrames(settings, frameDims, memoryBudgetMB) {
  const requestedFrames = calculateMaxFrames(settings);

  if (!frameDims?.width || !frameDims?.height || !memoryBudgetMB) {
    return {
      maxFrames: requestedFrames,
      requestedFrames,
      clamped: false,
      effectiveDuration: settings.bufferDuration,
    };
  }

  const bytesPerFrame = frameDims.width * frameDims.height * 4;
  const budgetBytes = memoryBudgetMB * BUFFER_BUDGET_SHARE * 1024 * 1024;
  const budgetFrames = Math.max(1, Math.floor(budgetBytes / bytesPerFrame));
  const maxFrames = Math.min(requestedFrames, budgetFrames);

  return {
    maxFrames,
    requestedFrames,
    clamped: maxFrames < requestedFrames,
    effectiveDuration: maxFrames / settings.fps,
  };
}
