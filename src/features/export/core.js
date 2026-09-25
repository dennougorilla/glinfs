/**
 * Export Core - Pure Functions
 * @module features/export/core
 */

import { ALPHA_THRESHOLD } from '../../shared/edits/color-key.js';
import { loadSettings } from '../../shared/user-settings.js';
import { stratifiedPixelIndices } from './pixel-sampling.js';

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
    paletteInterval: 1,
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Good balance of quality and file size',
    format: 'rgb565',
    maxColorsMultiplier: 0.5,
    paletteInterval: 10,
  },
  {
    id: 'fast',
    name: 'Fast / Small',
    description: 'Fastest encoding, smallest files',
    format: 'rgb444',
    maxColorsMultiplier: 0.25,
    paletteInterval: 0,
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
  const baseColors = Math.max(
    COLOR_PALETTE.min,
    Math.min(COLOR_PALETTE.max, Math.round(quality * COLOR_PALETTE.max)),
  );
  return Math.max(COLOR_PALETTE.min, Math.round(baseColors * preset.maxColorsMultiplier));
}

/**
 * Global palette sampling for presets with paletteInterval 0 (#99).
 *
 * The palette is quantized once from pixels gathered across the whole clip
 * instead of from the first frame alone, so later scenes with different
 * colors still map well. Both limits bound the retained sample independently
 * of clip length and resolution; each sample frame is still one full-frame
 * readback, so the pre-pass time scales with resolution. Measured at
 * 1280x720 in Chromium on a 6-scene clip: palette error flattens from 8
 * frames on and is flat across 32K-1M sampled pixels, so the cost is mostly the ~2ms extraction per
 * sample frame (~30ms total for 16; one full-frame quantize is ~8ms).
 */
export const PALETTE_SAMPLE = /** @type {const} */ ({
  /** Frames extracted for the sample (evenly spaced, first and last included) */
  maxFrames: 16,
  /** Total sampled pixels across all sample frames (256KB of RGBA) */
  maxPixels: 65536,
});

/**
 * Pick evenly spaced frame indices spanning the whole clip.
 * @param {number} totalFrames
 * @param {number} [maxSamples=PALETTE_SAMPLE.maxFrames]
 * @returns {number[]} Ascending, unique indices; includes 0 and totalFrames-1
 */
export function selectPaletteSampleIndices(totalFrames, maxSamples = PALETTE_SAMPLE.maxFrames) {
  const count = Math.min(Math.floor(totalFrames), Math.floor(maxSamples));
  if (count <= 0) return [];
  if (count === 1) return [0];
  const last = totalFrames - 1;
  return Array.from({ length: count }, (_, k) => Math.round((k * last) / (count - 1)));
}

/**
 * Cell size so that sampling one pixel per step x step cell of
 * `frameCount` frames stays within `maxPixels`.
 * @param {number} width
 * @param {number} height
 * @param {number} frameCount
 * @param {number} [maxPixels=PALETTE_SAMPLE.maxPixels]
 * @returns {number} Step >= 1
 */
export function computePaletteSampleStep(
  width,
  height,
  frameCount,
  maxPixels = PALETTE_SAMPLE.maxPixels,
) {
  const perFrameBudget = maxPixels / Math.max(1, frameCount);
  let step = Math.max(1, Math.ceil(Math.sqrt((width * height) / perFrameBudget)));
  // ceil() per axis can overshoot the budget slightly; step up until it fits
  while (
    step < Math.max(width, height) &&
    sampledPixelCount(width, height, step) > perFrameBudget
  ) {
    step++;
  }
  return step;
}

/**
 * Number of pixels sampleFramePixels takes from one frame (one per cell).
 * @param {number} width
 * @param {number} height
 * @param {number} step
 * @returns {number}
 */
export function sampledPixelCount(width, height, step) {
  return Math.ceil(width / step) * Math.ceil(height / step);
}

/**
 * Copy one jittered pixel from each step x step cell of an RGBA frame into
 * `out` (stratified sampling). A fixed grid would alias: content repeating
 * with the grid's period (e.g. 4 black / 4 white rows at step 8) would be
 * sampled on one phase only and lose a whole color.
 * @param {Uint8ClampedArray} rgba - Source frame
 * @param {number} width
 * @param {number} height
 * @param {number} step
 * @param {Uint8ClampedArray} out - Destination sample buffer
 * @param {number} offset - Byte offset in `out` to start writing at
 * @param {number} seed - PRNG seed for the jitter (same seed, same pixels)
 * @param {boolean} [opaqueOnly=false] - Skip pixels with alpha < 128 (transparent
 *   exports: they become the transparent index and must not take palette slots)
 * @returns {number} Byte offset after the last written pixel
 */
export function sampleFramePixels(
  rgba,
  width,
  height,
  step,
  out,
  offset,
  seed,
  opaqueOnly = false,
) {
  let o = offset;
  for (const pixel of stratifiedPixelIndices(width, height, step, seed)) {
    const p = pixel * 4;
    if (opaqueOnly && rgba[p + 3] < ALPHA_THRESHOLD) continue;
    out[o] = rgba[p];
    out[o + 1] = rgba[p + 1];
    out[o + 2] = rgba[p + 2];
    out[o + 3] = rgba[p + 3];
    o += 4;
  }
  return o;
}

/**
 * Create default export settings
 * Loads from user settings if available
 * @returns {import('./types.js').ExportSettings}
 */
export function createDefaultSettings() {
  // Try to load from user settings
  try {
    const userSettings = loadSettings();
    return {
      quality: userSettings.export.quality,
      frameSkip: userSettings.export.frameSkip,
      playbackSpeed: userSettings.export.playbackSpeed,
      dithering: userSettings.export.dithering,
      loopCount: userSettings.export.loopCount,
      openInNewTab: userSettings.export.openInNewTab,
      encoderPreset: userSettings.export.encoderPreset,
      encoderId: userSettings.export.encoderId,
    };
  } catch {
    // Fallback to hardcoded defaults if import fails
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
  const {
    frameCount,
    width,
    height,
    quality,
    dithering,
    frameSkip,
    encoderPreset = 'balanced',
  } = params;

  // Effective frame count after skip
  const effectiveFrames = Math.ceil(frameCount / frameSkip);

  // Pixels per frame
  const pixelsPerFrame = width * height;

  // Base bytes per pixel, adjusted by quality
  // Higher quality = more color precision = larger file
  const {
    qualityAdjustment,
    compression,
    headerOverhead,
    ditheringMultiplier: ditherMult,
  } = SIZE_ESTIMATION;
  const bytesPerPixel =
    SIZE_ESTIMATION.bytesPerPixelBase *
    (qualityAdjustment.base + quality * qualityAdjustment.scale);

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
 *
 * `runLength` > 1 is the delay of one GIF frame standing in for that many
 * consecutive identical source frames (identical-frame merging): the run is
 * rounded as a whole, so merged holds keep their total duration instead of
 * accumulating per-frame rounding. runLength 1 computes exactly the same
 * value as before merging existed (1000 * 1 === 1000).
 *
 * @param {number} fps - Source FPS
 * @param {number} playbackSpeed - Playback multiplier
 * @param {number} frameSkip - Frame skip factor
 * @param {number} [runLength=1] - Source frames (after frame skip) this GIF frame covers
 * @returns {number} - Delay in centiseconds (GIF format)
 */
export function calculateFrameDelay(fps, playbackSpeed, frameSkip, runLength = 1) {
  // Base delay in milliseconds
  const baseDelayMs = (1000 * runLength) / fps;

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
 * Whether two extracted frames are byte-identical (same size and RGBA).
 * Compares 4 bytes at a time when both views are 4-byte aligned, and exits
 * at the first difference.
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} a
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} b
 * @returns {boolean}
 */
export function areFramesIdentical(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = a.data;
  const y = b.data;
  if (x.length !== y.length) return false;

  const aligned = x.byteOffset % 4 === 0 && y.byteOffset % 4 === 0 && x.byteLength % 4 === 0;
  if (aligned) {
    const x32 = new Uint32Array(x.buffer, x.byteOffset, x.byteLength / 4);
    const y32 = new Uint32Array(y.buffer, y.byteOffset, y.byteLength / 4);
    for (let i = 0; i < x32.length; i++) {
      if (x32[i] !== y32[i]) return false;
    }
    return true;
  }

  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
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
