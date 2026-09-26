/**
 * Export Core - Pure Functions
 * @module features/export/core
 */

import { ALPHA_THRESHOLD } from '../../shared/edits/color-key.js';
import { scaleOutputSize } from '../../shared/edits/compose.js';
import { getActiveTextLayers, getActiveTouchUps } from '../../shared/edits/model.js';
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
      scale: normalizeOutputScale(userSettings.export.scale),
      targetSizeMB: normalizeTargetSizeMB(userSettings.export.targetSizeMB),
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
      scale: 1,
      targetSizeMB: null,
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
 * Absolute clip frame indices an export encodes: frames[k] after frame skip
 * is clip frame rangeStart + k * frameSkip (the index text ranges and AI
 * masks are looked up by)
 * @param {number} frameCount - Frames handed to the export (before skip)
 * @param {number} frameSkip - Keep every Nth frame (<= 1 keeps all)
 * @param {number} [rangeStart=0] - Absolute clip index of the first frame
 * @returns {number[]}
 */
export function getExportedFrameIndices(frameCount, frameSkip, rangeStart = 0) {
  // Same stepping as applyFrameSkip (any skip <= 1 keeps every frame)
  const step = frameSkip > 1 ? frameSkip : 1;
  const indices = [];
  for (let i = 0; i < frameCount; i += step) {
    indices.push(rangeStart + i);
  }
  return indices;
}

/**
 * Exported frames the AI cutout has no final mask for
 * @param {number[]} frameIndices - Absolute clip frame indices
 * @param {{ getFinalMask: (frameIndex: number) => unknown } | null | undefined} maskSource
 * @returns {number[]} The indices without a mask (all of them without a source)
 */
export function findFramesMissingMasks(frameIndices, maskSource) {
  if (!maskSource) return [...frameIndices];
  return frameIndices.filter((index) => !maskSource.getFinalMask(index));
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

/**
 * The encoder an export actually uses. The WASM encoder cannot write a
 * transparent index, and its lossy compression is fixed (no color count to
 * lower), so transparent exports and exports aiming at a target size always
 * use gifenc, whatever the stored preference says (the preference itself is
 * left untouched). Shared by encodeGif and the export UI so the selected
 * card, the job label and the encoder that runs can never disagree.
 * @param {import('./types.js').ExportSettings} settings
 * @param {boolean} [transparent]
 * @param {boolean} [sizeLimited] - A target file size is set
 * @returns {import('./encoders/types.js').EncoderId}
 */
export function getEffectiveEncoderId(settings, transparent, sizeLimited = false) {
  return transparent || sizeLimited ? 'gifenc-js' : settings.encoderId;
}

// ============================================================
// Output scale, speed limits, GIF facts
// ============================================================

/**
 * Output scales the export offers, largest first
 * @type {ReadonlyArray<{ value: number, label: string }>}
 */
export const OUTPUT_SCALES = Object.freeze([
  { value: 1, label: '100 %' },
  { value: 0.75, label: '75 %' },
  { value: 0.5, label: '50 %' },
  { value: 1 / 3, label: '33 %' },
  { value: 0.25, label: '25 %' },
]);

/**
 * A stored scale snapped to the nearest offered one (1 for anything invalid)
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeOutputScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 1;
  let best = OUTPUT_SCALES[0].value;
  for (const { value: candidate } of OUTPUT_SCALES) {
    if (Math.abs(candidate - n) < Math.abs(best - n)) best = candidate;
  }
  return best;
}

/**
 * GIF dimensions at an output scale (each side rounded, at least 1 px) —
 * the same rounding the compositor uses
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=1]
 * @returns {{ width: number, height: number }}
 */
export function getScaledDimensions(width, height, scale = 1) {
  return scaleOutputSize(width, height, scale);
}

/**
 * A stored target size in MB, or null for "off" (non-positive, missing or
 * not a number)
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeTargetSizeMB(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether GIF delays can express a playback speed. A GIF frame lasts a whole
 * number of centiseconds and at least MIN_DELAY_CS, so above some speed the
 * frames cannot get shorter and the GIF plays slower than asked.
 * @param {number} fps - Source FPS
 * @param {number} speed - Playback speed multiplier
 * @param {number} frameSkip - Frame skip factor
 * @returns {{ limited: boolean, effectiveSpeed: number, minDelayCs: number }}
 *   effectiveSpeed: the speed the GIF actually plays at
 */
export function getSpeedLimitInfo(fps, speed, frameSkip) {
  const skip = Math.max(1, frameSkip);
  const idealCs = (100 * skip) / (fps * speed);
  const delayCs = calculateFrameDelay(fps, speed, skip);
  const limited = idealCs < MIN_DELAY_CS;
  return {
    limited,
    effectiveSpeed: limited ? (speed * idealCs) / delayCs : speed,
    minDelayCs: MIN_DELAY_CS,
  };
}

/**
 * Size, dimensions and image count of an encoded GIF, read from its block
 * stream (header, logical screen descriptor, then one image descriptor per
 * frame). Pixel data is skipped, so this is cheap even for large GIFs.
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, frameCount: number } | null}
 *   null when the bytes are not a well-formed GIF
 */
export function readGifInfo(bytes) {
  if (!bytes || bytes.length < 13) return null;
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== 'GIF89a' && header !== 'GIF87a') return null;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const fields = bytes[10];
  let pos = 13 + (fields & 0x80 ? 3 * (1 << ((fields & 7) + 1)) : 0);
  let frameCount = 0;

  /** Skip data sub-blocks; false when they run past the end */
  const skipSubBlocks = () => {
    while (pos < bytes.length && bytes[pos] !== 0) pos += bytes[pos] + 1;
    if (pos >= bytes.length) return false;
    pos++;
    return true;
  };

  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) return { width, height, frameCount };
    if (block === 0x21) {
      pos++; // extension label
      if (!skipSubBlocks()) return null;
    } else if (block === 0x2c) {
      if (pos + 9 > bytes.length) return null;
      const imageFields = bytes[pos + 8];
      pos += 9 + (imageFields & 0x80 ? 3 * (1 << ((imageFields & 7) + 1)) : 0);
      pos++; // LZW minimum code size
      if (!skipSubBlocks()) return null;
      frameCount++;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * How many GIF frames identical-frame merging will leave, estimated without
 * rendering: consecutive exported frames share pixels when they share a
 * pixel key (imported holds are clones of one decoded frame, see
 * Frame.sharedKey), and a text layer or a touch-up stroke starting or
 * ending between them splits the run. Used for size estimates only (the encoder compares the
 * real output bytes).
 * @param {number[]} frameIndices - Absolute clip indices the export encodes
 * @param {import('../capture/types.js').Frame[]} clipFrames
 * @param {import('../../shared/edits/model.js').ClipEdits | null} edits
 * @returns {{ count: number, representatives: number[], runLengths: number[] }}
 *   representatives: the first absolute index of each run
 */
export function estimateMergedRuns(frameIndices, clipFrames, edits) {
  /** @type {number[]} */
  const representatives = [];
  /** @type {number[]} */
  const runLengths = [];
  let previousKey = null;
  let previousText = '';
  for (const index of frameIndices) {
    const frame = clipFrames[index];
    const key = frame ? (frame.sharedKey ?? frame.id ?? frame) : index;
    const text = [...getActiveTextLayers(edits, index), ...getActiveTouchUps(edits, index)]
      .map((layer) => layer.id)
      .join('|');
    if (representatives.length > 0 && key === previousKey && text === previousText) {
      runLengths[runLengths.length - 1]++;
    } else {
      representatives.push(index);
      runLengths.push(1);
    }
    previousKey = key;
    previousText = text;
  }
  return { count: representatives.length, representatives, runLengths };
}
