/**
 * Encoder Type Definitions
 * Modular design allowing WASM support to be added later
 * @module features/export/encoders/types
 */

/**
 * Quantization format for color reduction
 * @typedef {'rgb565'|'rgb444'} QuantizeFormat
 */

/**
 * Encoder preset configuration
 * @typedef {Object} EncoderPresetConfig
 * @property {string} id - Preset identifier
 * @property {string} name - Display name
 * @property {string} description - User-facing description
 * @property {QuantizeFormat} format - Quantization format
 * @property {number} maxColorsMultiplier - Multiplier for quality-based maxColors
 */

/**
 * Encoder initialization config
 * @typedef {Object} EncoderConfig
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {number} maxColors - Maximum colors (16-256)
 * @property {number} frameDelayMs - Frame delay (ms)
 * @property {number} loopCount - Loop count (0 = infinite)
 * @property {QuantizeFormat} [quantizeFormat='rgb565'] - Quantization format
 */

/**
 * Frame data
 * @typedef {Object} FrameData
 * @property {Uint8ClampedArray} rgba - RGBA pixel data
 * @property {number} width - Frame width
 * @property {number} height - Frame height
 */

/**
 * Progress report
 * @typedef {Object} EncoderProgress
 * @property {number} frameIndex - Frame index being processed
 * @property {number} totalFrames - Total frame count
 * @property {number} percent - Progress percentage (0-100)
 */

/**
 * Encoder capabilities - what features the encoder supports
 * @typedef {Object} EncoderCapabilities
 * @property {boolean} supportsMaxColors - Supports color count limit
 * @property {boolean} supportsQuantizeFormat - Supports quantization format selection
 * @property {boolean} supportsDithering - Supports dithering option
 */

/**
 * Encoder metadata
 * @typedef {Object} EncoderMetadata
 * @property {EncoderId} id - Encoder identifier
 * @property {string} name - Display name
 * @property {string} description - User-facing description
 * @property {boolean} isWasm - Whether WASM encoder
 * @property {string} version - Version
 * @property {EncoderCapabilities} capabilities - Supported features
 */

/**
 * Encoder ID
 * @typedef {'gifenc-js'|'gifsicle-wasm'} EncoderId
 */

/**
 * Encoder interface
 * Allows adding WASM encoders in the future
 *
 * @typedef {Object} EncoderInterface
 * @property {EncoderMetadata} metadata - Encoder metadata
 * @property {(config: EncoderConfig) => void | Promise<void>} init - Initialize (sync or async)
 * @property {(frameData: FrameData, frameIndex: number) => void} addFrame - Add frame
 * @property {() => Uint8Array} finish - Complete encoding and get byte array
 * @property {() => void} dispose - Release resources
 */

/**
 * Encoder factory function
 * @callback EncoderFactory
 * @returns {EncoderInterface}
 */

export {};
