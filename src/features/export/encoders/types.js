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
 * @property {number} paletteInterval - How often quantize() rebuilds the
 *   palette: 1 = every frame (best color fidelity), N>1 = every Nth frame
 *   (reused between), 0 = once for the whole clip, from pixels sampled
 *   across it (fastest; first frame if no sample is given). Palette
 *   rebuilding dominates encode time (#99), so this is the preset's main
 *   speed lever.
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
 * @property {number} [paletteInterval=1] - Palette rebuild schedule (see EncoderPresetConfig)
 * @property {Uint8ClampedArray} [paletteSample] - RGBA pixels sampled across the
 *   clip; with paletteInterval 0 the palette is quantized once from this
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
