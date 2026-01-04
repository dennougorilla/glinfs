/**
 * GIF Encoder Worker Handlers
 * Extracted handler logic for testability
 * @module workers/gif-encoder-handlers
 */

import { Events } from './worker-protocol.js';

/**
 * @typedef {import('./worker-protocol.js').InitMessage} InitMessage
 * @typedef {import('./worker-protocol.js').AddFrameMessage} AddFrameMessage
 * @typedef {import('./worker-protocol.js').WorkerEvent} WorkerEvent
 * @typedef {import('../features/export/encoders/types.js').EncoderInterface} EncoderInterface
 */

/**
 * Handler state
 * @typedef {Object} HandlerState
 * @property {EncoderInterface | null} encoder
 * @property {number} totalFrames
 * @property {number} framesProcessed
 * @property {number} startTime
 */

/**
 * Handler dependencies
 * @typedef {Object} HandlerDependencies
 * @property {() => EncoderInterface} createEncoder - Encoder factory function
 * @property {(event: WorkerEvent, transfer?: Transferable[]) => void} postEvent - Event posting function
 */

/**
 * Handler functions interface
 * @typedef {Object} Handlers
 * @property {(message: InitMessage) => void} handleInit
 * @property {(message: AddFrameMessage) => void} handleAddFrame
 * @property {() => void} handleFinish
 * @property {() => void} handleCancel
 * @property {() => HandlerState} getState - For testing purposes
 */

/**
 * Create worker handlers with dependency injection
 * @param {HandlerDependencies} deps - Dependencies
 * @returns {Handlers} Handler functions
 */
export function createHandlers({ createEncoder, postEvent }) {
  /** @type {EncoderInterface | null} */
  let encoder = null;

  /** @type {number} */
  let totalFrames = 0;

  /** @type {number} */
  let framesProcessed = 0;

  /** @type {number} */
  let startTime = 0;

  /**
   * Handle initialization command
   * @param {InitMessage} message
   */
  function handleInit(message) {
    try {
      // Dispose existing encoder if any
      if (encoder) {
        encoder.dispose();
      }

      // Create new encoder
      encoder = createEncoder();

      // Initialize
      encoder.init({
        width: message.width,
        height: message.height,
        maxColors: message.maxColors,
        frameDelayMs: message.frameDelayMs,
        loopCount: message.loopCount,
      });

      totalFrames = message.totalFrames;
      framesProcessed = 0;
      startTime = Date.now();

      postEvent({
        event: Events.READY,
        encoderId: message.encoderId,
      });
    } catch (error) {
      postEvent({
        event: Events.ERROR,
        message: error instanceof Error ? error.message : 'Failed to initialize encoder',
        code: 'INIT_ERROR',
      });
    }
  }

  /**
   * Handle add frame command
   * @param {AddFrameMessage} message
   */
  function handleAddFrame(message) {
    try {
      if (!encoder) {
        throw new Error('Encoder not initialized');
      }

      const rgba = new Uint8ClampedArray(message.rgbaData);

      encoder.addFrame(
        {
          rgba,
          width: message.width,
          height: message.height,
        },
        message.frameIndex
      );

      framesProcessed++;

      // Report progress
      const percent = Math.round((framesProcessed / totalFrames) * 100);
      postEvent({
        event: Events.PROGRESS,
        frameIndex: message.frameIndex,
        totalFrames,
        percent,
      });
    } catch (error) {
      postEvent({
        event: Events.ERROR,
        message: error instanceof Error ? error.message : 'Failed to add frame',
        code: 'FRAME_ERROR',
      });
    }
  }

  /**
   * Handle finish command
   */
  function handleFinish() {
    try {
      if (!encoder) {
        throw new Error('Encoder not initialized');
      }

      const bytes = encoder.finish();
      const duration = Date.now() - startTime;

      // Send ArrayBuffer as Transferable
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

      postEvent(
        {
          event: Events.COMPLETE,
          gifData: buffer,
          duration,
        },
        [buffer]
      );

      // Cleanup
      encoder.dispose();
      encoder = null;
      totalFrames = 0;
      framesProcessed = 0;
    } catch (error) {
      postEvent({
        event: Events.ERROR,
        message: error instanceof Error ? error.message : 'Failed to finish encoding',
        code: 'FINISH_ERROR',
      });
    }
  }

  /**
   * Handle cancel command
   */
  function handleCancel() {
    if (encoder) {
      encoder.dispose();
      encoder = null;
    }

    totalFrames = 0;
    framesProcessed = 0;

    postEvent({
      event: Events.CANCELLED,
    });
  }

  /**
   * Get current state (for testing)
   * @returns {HandlerState}
   */
  function getState() {
    return {
      encoder,
      totalFrames,
      framesProcessed,
      startTime,
    };
  }

  return {
    handleInit,
    handleAddFrame,
    handleFinish,
    handleCancel,
    getState,
  };
}
