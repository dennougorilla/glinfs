/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF encoder
 * @module features/export/encoders/gifenc-encoder
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { stratifiedPixelIndices } from '../pixel-sampling.js';

/**
 * @typedef {import('./types.js').EncoderInterface} EncoderInterface
 * @typedef {import('./types.js').EncoderConfig} EncoderConfig
 * @typedef {import('./types.js').FrameData} FrameData
 * @typedef {import('./types.js').EncoderMetadata} EncoderMetadata
 */

/** @type {EncoderMetadata} */
const METADATA = {
  id: 'gifenc-js',
  name: 'gifenc (JavaScript)',
  description: 'Fast JavaScript encoder with quality controls',
  isWasm: false,
  version: '1.0.3',
  capabilities: {
    supportsMaxColors: true,
    supportsQuantizeFormat: true,
    supportsDithering: true,
  },
};

/**
 * Whether addFrame should rebuild the palette for this frame.
 *
 * interval semantics: 1 = every frame; N>1 = frames 0, N, 2N, ...;
 * 0 = only when no palette exists yet (i.e. never once init() built one
 * from a clip-wide paletteSample; otherwise from the first frame).
 * Exported for unit tests - the schedule IS the perf contract (#99).
 *
 * @param {number} frameIndex
 * @param {number} interval
 * @param {boolean} hasPalette
 * @returns {boolean}
 */
export function shouldQuantize(frameIndex, interval, hasPalette) {
  if (!hasPalette) return true;
  if (interval <= 0) return false;
  if (interval === 1) return true;
  return frameIndex % interval === 0;
}

/**
 * Palette staleness check for scheduled reuse (paletteInterval > 1, #99).
 *
 * Between scheduled rebuilds, a scene cut would otherwise be drawn with the
 * previous scene's palette until the next rebuild (up to interval-1 frames).
 * After mapping each frame, its mean palette error is measured on a small
 * stratified subsample and compared with the error of the frame the palette
 * was built from; a jump past the threshold rebuilds the palette early.
 * The error comes from the frame's own applyPalette indices, so steady
 * frames pay only ~samplePixels lookups (~0.05ms); a stale frame pays one
 * extra quantize + applyPalette.
 *
 * Thresholds, measured in Chromium at 640x360 with 16-128 colors: across
 * steady content (moving gradients, scrolling UI, noise) the error rose at
 * most 2.1 above the palette frame's (ratio <= 1.95, only where that error
 * was ~2), a slow fade drifted up to ~9 over 9 frames, and hard cuts
 * jumped by 8.2 (light -> dark UI) to 170 (red -> blue).
 */
export const PALETTE_STALENESS = /** @type {const} */ ({
  /** Pixels checked per frame */
  samplePixels: 2048,
  /** Stale when error > baseline * ratio (relative, for few-color palettes) ... */
  ratio: 2,
  /** ... and error > baseline + margin (mean per-channel error, 0-255) */
  margin: 4,
  /** Fixed jitter seed, so encoding is deterministic */
  seed: 0x5eed,
});

/**
 * Mean per-channel absolute RGB error of a mapped frame at `pixels`.
 * @param {Uint8ClampedArray} rgba - Source frame
 * @param {Uint8Array} index - applyPalette output for `rgba`
 * @param {number[][]} palette
 * @param {Uint32Array} pixels - Pixel indices to measure
 * @returns {number}
 */
export function paletteError(rgba, index, palette, pixels) {
  if (pixels.length === 0) return 0;
  let sum = 0;
  for (const pixel of pixels) {
    const color = palette[index[pixel]];
    const p = pixel * 4;
    sum +=
      Math.abs(rgba[p] - color[0]) +
      Math.abs(rgba[p + 1] - color[1]) +
      Math.abs(rgba[p + 2] - color[2]);
  }
  return sum / (pixels.length * 3);
}

/**
 * Whether a reused palette has gone stale for the current frame.
 * @param {number} error - Current frame's paletteError
 * @param {number} baselineError - paletteError of the frame the palette was built from
 * @returns {boolean}
 */
export function isPaletteStale(error, baselineError) {
  return (
    error > baselineError * PALETTE_STALENESS.ratio &&
    error > baselineError + PALETTE_STALENESS.margin
  );
}

/**
 * Create gifenc encoder
 * @returns {EncoderInterface}
 */
export function createGifencEncoder() {
  /** @type {ReturnType<typeof GIFEncoder> | null} */
  let encoder = null;

  /** @type {EncoderConfig | null} */
  let config = null;

  /** @type {ReturnType<typeof quantize> | null} Palette reused between scheduled rebuilds (#99) */
  let palette = null;

  /** Palette error of the frame the current palette was built from */
  let baselineError = 0;

  /** @type {{ width: number, height: number, pixels: Uint32Array } | null} */
  let stalenessPixels = null;

  /**
   * Staleness-check pixels for this frame size (computed once per size)
   * @param {number} width
   * @param {number} height
   * @returns {Uint32Array}
   */
  function getStalenessPixels(width, height) {
    if (stalenessPixels?.width !== width || stalenessPixels.height !== height) {
      const step = Math.max(
        1,
        Math.ceil(Math.sqrt((width * height) / PALETTE_STALENESS.samplePixels)),
      );
      const pixels = stratifiedPixelIndices(width, height, step, PALETTE_STALENESS.seed);
      stalenessPixels = { width, height, pixels };
    }
    return stalenessPixels.pixels;
  }

  return {
    metadata: METADATA,

    /**
     * Initialize encoder
     * @param {EncoderConfig} encoderConfig
     */
    init(encoderConfig) {
      config = encoderConfig;
      encoder = GIFEncoder();
      baselineError = 0;
      // A clip-wide sample yields one global palette up front, so later
      // scenes are not forced onto frame 0's colors (#99).
      palette = encoderConfig.paletteSample?.length
        ? quantize(encoderConfig.paletteSample, encoderConfig.maxColors, {
            format: encoderConfig.quantizeFormat || 'rgb565',
          })
        : null;
    },

    /**
     * Add frame
     * @param {FrameData} frameData
     * @param {number} frameIndex
     */
    addFrame(frameData, frameIndex) {
      if (!encoder || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const { rgba, width, height } = frameData;
      const format = config.quantizeFormat || 'rgb565';

      // Palette rebuilding (quantize) dominates encode time (#99); the
      // preset's paletteInterval schedules how often it actually runs.
      // Consecutive frames share most of their colors, so reusing the
      // palette between rebuilds trades negligible fidelity for the bulk
      // of the encode cost on balanced/fast presets.
      const interval = config.paletteInterval ?? 1;
      const scheduled = shouldQuantize(frameIndex, interval, palette !== null);
      if (scheduled) {
        palette = quantize(rgba, config.maxColors, { format });
      }

      // Map pixels to palette indices with same format
      let index = applyPalette(rgba, palette, format);

      // A scene cut between scheduled rebuilds makes the reused palette
      // stale; rebuild early instead of waiting for the schedule. Interval
      // 0 keeps its clip-wide palette: rebuilding from one frame would
      // replace it with a worse, single-scene palette.
      if (interval > 1) {
        const pixels = getStalenessPixels(width, height);
        const error = paletteError(rgba, index, palette, pixels);
        if (scheduled) {
          baselineError = error;
        } else if (isPaletteStale(error, baselineError)) {
          palette = quantize(rgba, config.maxColors, { format });
          index = applyPalette(rgba, palette, format);
          baselineError = paletteError(rgba, index, palette, pixels);
        }
      }

      // Write frame
      encoder.writeFrame(index, width, height, {
        palette,
        delay: config.frameDelayMs,
        repeat: config.loopCount,
      });
    },

    /**
     * Complete encoding and get byte array
     * @returns {Uint8Array}
     */
    finish() {
      if (!encoder) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      encoder.finish();
      const bytes = encoder.bytes();

      return bytes;
    },

    /**
     * Release resources
     */
    dispose() {
      encoder = null;
      config = null;
      palette = null;
      stalenessPixels = null;
    },
  };
}

/**
 * Get gifenc encoder metadata
 * @returns {EncoderMetadata}
 */
export function getGifencMetadata() {
  return METADATA;
}
