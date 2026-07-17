/**
 * Worker Communication Protocol
 * Communication protocol definition between Worker and main thread
 * @module workers/worker-protocol
 */

/**
 * Worker command types
 * @readonly
 * @enum {string}
 */
export const Commands = {
  /** Initialize encoder */
  INIT: 'init',
  /** Add frame */
  ADD_FRAME: 'add-frame',
  /** Complete encoding */
  FINISH: 'finish',
  /** Cancel encoding */
  CANCEL: 'cancel',
};

/**
 * Worker event types
 * @readonly
 * @enum {string}
 */
export const Events = {
  /** Initialization complete */
  READY: 'ready',
  /** Progress update */
  PROGRESS: 'progress',
  /** Encoding complete */
  COMPLETE: 'complete',
  /** Error occurred */
  ERROR: 'error',
  /** Cancel complete */
  CANCELLED: 'cancelled',
};

/**
 * Initialization message
 * @typedef {Object} InitMessage
 * @property {typeof Commands.INIT} command
 * @property {string} encoderId - Encoder ID to use
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {number} totalFrames - Total frame count
 * @property {number} maxColors - Maximum colors
 * @property {number} frameDelayMs - Frame delay (ms)
 * @property {number} loopCount - Loop count
 * @property {import('../features/export/encoders/types.js').QuantizeFormat} [quantizeFormat] - Quantization format
 */

/**
 * Add frame message
 * @typedef {Object} AddFrameMessage
 * @property {typeof Commands.ADD_FRAME} command
 * @property {ArrayBuffer} rgbaData - RGBA pixel data (Transferable)
 * @property {number} width - Frame width
 * @property {number} height - Frame height
 * @property {number} frameIndex - Frame index
 */

/**
 * Finish message
 * @typedef {Object} FinishMessage
 * @property {typeof Commands.FINISH} command
 */

/**
 * Cancel message
 * @typedef {Object} CancelMessage
 * @property {typeof Commands.CANCEL} command
 */

/**
 * Message sent to Worker
 * @typedef {InitMessage | AddFrameMessage | FinishMessage | CancelMessage} WorkerMessage
 */

/**
 * Ready event
 * @typedef {Object} ReadyEvent
 * @property {typeof Events.READY} event
 * @property {string} encoderId - Encoder ID in use
 */

/**
 * Progress event
 * @typedef {Object} ProgressEvent
 * @property {typeof Events.PROGRESS} event
 * @property {number} frameIndex - Frame being processed
 * @property {number} totalFrames - Total frame count
 * @property {number} percent - Progress percentage (0-100)
 */

/**
 * Complete event
 * @typedef {Object} CompleteEvent
 * @property {typeof Events.COMPLETE} event
 * @property {ArrayBuffer} gifData - GIF data (Transferable)
 * @property {number} duration - Encoding time (ms)
 */

/**
 * Error event
 * @typedef {Object} ErrorEvent
 * @property {typeof Events.ERROR} event
 * @property {string} message - Error message
 * @property {string} [code] - Error code
 */

/**
 * Cancel complete event
 * @typedef {Object} CancelledEvent
 * @property {typeof Events.CANCELLED} event
 */

/**
 * Event received from Worker
 * @typedef {ReadyEvent | ProgressEvent | CompleteEvent | ErrorEvent | CancelledEvent} WorkerEvent
 */

/**
 * Create InitMessage
 * @param {Object} config
 * @param {string} config.encoderId
 * @param {number} config.width
 * @param {number} config.height
 * @param {number} config.totalFrames
 * @param {number} config.maxColors
 * @param {number} config.frameDelayMs
 * @param {number} config.loopCount
 * @returns {InitMessage}
 */
export function createInitMessage(config) {
  return {
    command: Commands.INIT,
    ...config,
  };
}

/**
 * Create AddFrameMessage
 *
 * The underlying ArrayBuffer is transferred directly (zero-copy) instead of
 * being duplicated — frames are ~8.3MB at 1080p and copying doubled the peak
 * memory usage (#39). The buffer is detached (neutered) once the message is
 * posted, so callers MUST NOT reuse `rgba` after sending.
 *
 * @param {Uint8ClampedArray} rgba - RGBA data (consumed; do not reuse)
 * @param {number} width
 * @param {number} height
 * @param {number} frameIndex
 * @returns {{ message: AddFrameMessage, transfer: ArrayBuffer[] }}
 */
export function createAddFrameMessage(rgba, width, height, frameIndex) {
  // Transfer the buffer directly when the view spans it entirely; only a
  // view into a larger buffer needs the exact byte range copied out.
  const coversWholeBuffer = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength;
  const buffer = coversWholeBuffer
    ? rgba.buffer
    : rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);

  return {
    message: {
      command: Commands.ADD_FRAME,
      rgbaData: buffer,
      width,
      height,
      frameIndex,
    },
    transfer: [buffer],
  };
}

/**
 * Create FinishMessage
 * @returns {FinishMessage}
 */
export function createFinishMessage() {
  return { command: Commands.FINISH };
}

/**
 * Create CancelMessage
 * @returns {CancelMessage}
 */
export function createCancelMessage() {
  return { command: Commands.CANCEL };
}
