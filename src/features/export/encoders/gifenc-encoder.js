/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF encoder
 * @module features/export/encoders/gifenc-encoder
 */

import { GIFEncoder, quantize, applyPalette } from 'gifenc';

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
 * Create gifenc encoder
 * @returns {EncoderInterface}
 */
export function createGifencEncoder() {
  /** @type {ReturnType<typeof GIFEncoder> | null} */
  let encoder = null;

  /** @type {EncoderConfig | null} */
  let config = null;

  return {
    metadata: METADATA,

    /**
     * Initialize encoder
     * @param {EncoderConfig} encoderConfig
     */
    init(encoderConfig) {
      config = encoderConfig;
      encoder = GIFEncoder();
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

      // Color quantization (palette generation) with format option
      const palette = quantize(rgba, config.maxColors, { format });

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
