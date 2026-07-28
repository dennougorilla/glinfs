/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF encoder
 * @module features/export/encoders/gifenc-encoder
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';

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
 * 0 = only when no palette exists yet (first frame / after init).
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

  return {
    metadata: METADATA,

    /**
     * Initialize encoder
     * @param {EncoderConfig} encoderConfig
     */
    init(encoderConfig) {
      config = encoderConfig;
      encoder = GIFEncoder();
      palette = null;
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
      if (shouldQuantize(frameIndex, config.paletteInterval ?? 1, palette !== null)) {
        palette = quantize(rgba, config.maxColors, { format });
      }

      // Map pixels to palette indices with same format
      const index = applyPalette(rgba, palette, format);

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
