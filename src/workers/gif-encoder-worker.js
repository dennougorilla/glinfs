/**
 * GIF Encoder Worker
 * Offload GIF encoding from main thread
 * @module workers/gif-encoder-worker
 */

import { Commands, Events } from './worker-protocol.js';
import { createGifencEncoder } from '../features/export/encoders/gifenc-encoder.js';
import { createGifsicleEncoder } from '../features/export/encoders/gifsicle-encoder.js';

/**
 * Encoder factory map
 * @type {Record<string, () => import('../features/export/encoders/types.js').EncoderInterface>}
 */
const encoderFactories = {
  'gifenc-js': createGifencEncoder,
  'gifsicle-wasm': createGifsicleEncoder,
};

/** @type {import('../features/export/encoders/types.js').EncoderInterface | null} */
let encoder = null;

/** @type {number} */
let totalFrames = 0;

/** @type {number} */
let framesProcessed = 0;

/** @type {number} */
let startTime = 0;

/**
 * Send event to main thread
 * @param {import('./worker-protocol.js').WorkerEvent} event
 * @param {Transferable[]} [transfer]
 */
function postEvent(event, transfer) {
  if (transfer) {
    self.postMessage(event, transfer);
  } else {
    self.postMessage(event);
  }
}

/**
 * Handle initialization command
 * @param {import('./worker-protocol.js').InitMessage} message
 */
async function handleInit(message) {
  try {
    // Dispose existing encoder if any
    if (encoder) {
      encoder.dispose();
    }

    // Select encoder based on encoderId
    const encoderId = message.encoderId || 'gifenc-js';
    const factory = encoderFactories[encoderId];

    if (!factory) {
      throw new Error(`Unknown encoder: ${encoderId}`);
    }

    encoder = factory();

    // Initialize (may be async for WASM encoders)
    await encoder.init({
      width: message.width,
      height: message.height,
      maxColors: message.maxColors,
      frameDelayMs: message.frameDelayMs,
      loopCount: message.loopCount,
      quantizeFormat: message.quantizeFormat,
    });

    totalFrames = message.totalFrames;
    framesProcessed = 0;
    startTime = Date.now();

    postEvent({
      event: Events.READY,
      encoderId: encoderId,
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
 * @param {import('./worker-protocol.js').AddFrameMessage} message
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
 * Message handler
 * @param {MessageEvent<import('./worker-protocol.js').WorkerMessage>} event
 */
self.onmessage = async (event) => {
  const message = event.data;

  switch (message.command) {
    case Commands.INIT:
      await handleInit(message);
      break;

    case Commands.ADD_FRAME:
      handleAddFrame(message);
      break;

    case Commands.FINISH:
      handleFinish();
      break;

    case Commands.CANCEL:
      handleCancel();
      break;

    default:
      postEvent({
        event: Events.ERROR,
        message: `Unknown command: ${/** @type {any} */ (message).command}`,
        code: 'UNKNOWN_COMMAND',
      });
  }
};

/**
 * Error handler
 * @param {ErrorEvent} error
 */
self.onerror = (error) => {
  postEvent({
    event: Events.ERROR,
    message: error.message || 'Unknown worker error',
    code: 'WORKER_ERROR',
  });
};
