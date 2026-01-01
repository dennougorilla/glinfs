/**
 * Encoder Type Definitions
 * Modular design allowing WASM support to be added later
 * @module features/export/encoders/types
 */

/**
 * Encoder initialization config
 * @typedef {Object} EncoderConfig
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {number} maxColors - Maximum colors (16-256)
 * @property {number} frameDelayMs - Frame delay (ms)
 * @property {number} loopCount - Loop count (0 = infinite)
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
 * Encoder metadata
 * @typedef {Object} EncoderMetadata
 * @property {string} id - Encoder identifier
 * @property {string} name - Display name
 * @property {boolean} isWasm - Whether WASM encoder
 * @property {string} version - Version
 */

/**
 * Encoder interface
 * Allows adding WASM encoders in the future
 *
 * @typedef {Object} EncoderInterface
 * @property {EncoderMetadata} metadata - Encoder metadata
 * @property {(config: EncoderConfig) => void} init - Initialize
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
