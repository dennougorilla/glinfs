/**
 * Export Core - Pure Functions
 * @module features/export/core
 */

/** @type {readonly [1, 2, 3, 4, 5]} */
const VALID_FRAME_SKIPS = /** @type {const} */ ([1, 2, 3, 4, 5]);

/** Valid encoder presets */
const VALID_PRESETS = /** @type {const} */ (['quality', 'balanced', 'fast']);

/** Minimum GIF frame delay in centiseconds */
const MIN_DELAY_CS = 2;

/** GIF color palette constraints */
const COLOR_PALETTE = { min: 16, max: 256 };

/** Size estimation configuration */
const SIZE_ESTIMATION = {
  bytesPerPixelBase: 0.3,
  qualityAdjustment: { base: 0.5, scale: 0.5 },
  compression: { base: 0.4, scale: 0.3 },
  headerOverhead: { base: 1024, perFrame: 20 },
  ditheringMultiplier: 1.2,
};

/** Preset size factors for file size estimation */
const PRESET_SIZE_FACTORS = {
  fast: 0.7,
  balanced: 0.85,
  quality: 1.0,
};

/**
 * Encoder preset configurations
 * @type {readonly import('./encoders/types.js').EncoderPresetConfig[]}
 */
export const ENCODER_PRESETS = /** @type {const} */ ([
  {
    id: 'quality',
    name: 'High Quality',
    description: 'Best visual quality, larger file size',
    format: 'rgb565',
    maxColorsMultiplier: 1.0,
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Good balance of quality and file size',
    format: 'rgb565',
    maxColorsMultiplier: 0.5,
  },
  {
    id: 'fast',
    name: 'Fast / Small',
    description: 'Fastest encoding, smallest files',
    format: 'rgb444',
    maxColorsMultiplier: 0.25,
  },
]);

/**
 * Get encoder preset by ID
 * @param {import('./types.js').EncoderPreset} presetId
 * @returns {import('./encoders/types.js').EncoderPresetConfig}
 */
export function getEncoderPreset(presetId) {
  const preset = ENCODER_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    throw new Error(`Unknown encoder preset: ${presetId}`);
  }
  return preset;
}

/**
 * Calculate maxColors from quality and preset
 * @param {number} quality - 0.1 to 1.0
 * @param {import('./types.js').EncoderPreset} presetId
 * @returns {number}
 */
export function calculateMaxColors(quality, presetId) {
  const preset = getEncoderPreset(presetId);
  const baseColors = Math.max(COLOR_PALETTE.min, Math.min(COLOR_PALETTE.max, Math.round(quality * COLOR_PALETTE.max)));
  return Math.max(COLOR_PALETTE.min, Math.round(baseColors * preset.maxColorsMultiplier));
}

/**
 * Create default export settings
 * @returns {import('./types.js').ExportSettings}
 */
export function createDefaultSettings() {
  return {
    quality: 0.8,
    frameSkip: 1,
    playbackSpeed: 1,
    dithering: true,
    loopCount: 0,
    openInNewTab: false,
    encoderPreset: 'balanced',
    encoderId: 'gifenc-js',
  };
}

/**
 * Validate export settings
 * @param {import('./types.js').ExportSettings} settings
 * @returns {import('../../shared/types.js').ValidationResult}
 */
export function validateSettings(settings) {
  /** @type {string[]} */
  const errors = [];

  // Validate quality
  if (settings.quality < 0.1 || settings.quality > 1.0) {
    errors.push('Quality must be between 0.1 and 1.0');
  }

  // Validate frameSkip
  if (!VALID_FRAME_SKIPS.includes(/** @type {1|2|3|4|5} */ (settings.frameSkip))) {
    errors.push('Frame skip must be 1, 2, 3, 4, or 5');
  }

  // Validate playbackSpeed
  if (settings.playbackSpeed < 0.25 || settings.playbackSpeed > 4.0) {
    errors.push('Playback speed must be between 0.25 and 4.0');
  }

  // Validate loopCount
  if (settings.loopCount < 0) {
    errors.push('Loop count cannot be negative');
  }

  // Validate encoderPreset
  if (!VALID_PRESETS.includes(/** @type {any} */ (settings.encoderPreset))) {
    errors.push('Invalid encoder preset');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * @typedef {Object} SizeParams
 * @property {number} frameCount - Number of frames
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {number} quality - Quality setting
 * @property {boolean} dithering - Dithering enabled
 * @property {number} frameSkip - Frame skip factor
 * @property {import('./types.js').EncoderPreset} [encoderPreset='balanced'] - Encoder preset
 */

/**
 * Estimate output GIF size in bytes
 * @param {SizeParams} params
 * @returns {number} - Estimated bytes
 */
export function estimateSize(params) {
  const { frameCount, width, height, quality, dithering, frameSkip, encoderPreset = 'balanced' } = params;

  // Effective frame count after skip
  const effectiveFrames = Math.ceil(frameCount / frameSkip);

  // Pixels per frame
  const pixelsPerFrame = width * height;

  // Base bytes per pixel, adjusted by quality
  // Higher quality = more color precision = larger file
  const { qualityAdjustment, compression, headerOverhead, ditheringMultiplier: ditherMult } = SIZE_ESTIMATION;
  const bytesPerPixel = SIZE_ESTIMATION.bytesPerPixelBase * (qualityAdjustment.base + quality * qualityAdjustment.scale);

  // Dithering adds some overhead (patterns need more entropy)
  const ditheringMultiplier = dithering ? ditherMult : 1;

  // GIF uses LZW compression, estimate compression ratio
  const compressionRatio = compression.base + quality * compression.scale;

  // Preset-based size factor (fast preset produces smaller files)
  const presetFactor = PRESET_SIZE_FACTORS[encoderPreset] ?? PRESET_SIZE_FACTORS.quality;

  // Calculate estimated size
  const rawSize = effectiveFrames * pixelsPerFrame * bytesPerPixel;
  const estimatedSize = rawSize * ditheringMultiplier * compressionRatio * presetFactor;

  // Add header overhead (color table, metadata)
  const overhead = headerOverhead.base + effectiveFrames * headerOverhead.perFrame;

  return Math.round(estimatedSize + overhead);
}

/**
 * Calculate frame delay from playback speed and source FPS
 * @param {number} fps - Source FPS
 * @param {number} playbackSpeed - Playback multiplier
 * @param {number} frameSkip - Frame skip factor
 * @returns {number} - Delay in centiseconds (GIF format)
 */
export function calculateFrameDelay(fps, playbackSpeed, frameSkip) {
  // Base delay in milliseconds
  const baseDelayMs = 1000 / fps;

  // Adjust for playback speed (faster = shorter delay)
  const speedAdjustedMs = baseDelayMs / playbackSpeed;

  // Adjust for frame skip (compensate to maintain perceived duration)
  const skipAdjustedMs = speedAdjustedMs * frameSkip;

  // Convert to centiseconds (GIF format)
  const delayCs = skipAdjustedMs / 10;

  // Enforce minimum delay
  return Math.max(MIN_DELAY_CS, Math.round(delayCs));
}

/**
 * Apply frame skip to frame array
 * @param {import('../capture/types.js').Frame[]} frames
 * @param {number} skip - Use every Nth frame
 * @returns {import('../capture/types.js').Frame[]}
 */
export function applyFrameSkip(frames, skip) {
  if (skip <= 1) return frames;

  const result = [];
  for (let i = 0; i < frames.length; i += skip) {
    result.push(frames[i]);
  }
  return result;
}

/**
 * @typedef {Object} ProgressInfo
 * @property {number} percent - Completion percentage (0-100)
 * @property {number} estimatedRemaining - Estimated ms remaining
 */

/**
 * Calculate encoding progress
 * @param {number} current - Current frame
 * @param {number} total - Total frames
 * @param {number} startTime - Start timestamp
 * @returns {ProgressInfo}
 */
export function calculateProgress(current, total, startTime) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  // Estimate remaining time
  let estimatedRemaining = 0;
  if (current > 0 && current < total) {
    const elapsed = Date.now() - startTime;
    const msPerFrame = elapsed / current;
    const framesRemaining = total - current;
    estimatedRemaining = Math.round(msPerFrame * framesRemaining);
  }

  return {
    percent,
    estimatedRemaining,
  };
}

// Re-export from shared geometry utilities for backward compatibility
import { getEffectiveDimensions } from '../../shared/utils/geometry.js';

/**
 * Apply crop to frame dimensions
 * @param {import('../capture/types.js').Frame} frame
 * @param {import('../editor/types.js').CropArea | null} crop
 * @returns {{ width: number, height: number }}
 */
export function getCroppedDimensions(frame, crop) {
  return getEffectiveDimensions(frame, crop);
}

/**
 * Generate filename for export
 * @param {string} [prefix='glinfs']
 * @returns {string}
 */
export function generateFilename(prefix = 'glinfs') {
  const date = new Date();
  const timestamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${timestamp}.gif`;
}

/**
 * Calculate effective FPS after frame skip
 * @param {number} sourceFps
 * @param {number} frameSkip
 * @param {number} playbackSpeed
 * @returns {number}
 */
export function calculateEffectiveFps(sourceFps, frameSkip, playbackSpeed) {
  return (sourceFps / frameSkip) * playbackSpeed;
}

