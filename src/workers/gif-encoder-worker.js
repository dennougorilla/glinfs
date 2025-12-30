/**
 * GIF Encoder Worker
 * メインスレッドからオフロードして GIF エンコードを実行
 * @module workers/gif-encoder-worker
 */

import { Commands, Events } from './worker-protocol.js';
import { createGifencEncoder } from '../features/export/encoders/gifenc-encoder.js';

/** @type {import('../features/export/encoders/types.js').EncoderInterface | null} */
let encoder = null;

/** @type {number} */
let totalFrames = 0;

/** @type {number} */
let framesProcessed = 0;

/** @type {number} */
let startTime = 0;

/**
 * イベントをメインスレッドに送信
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
 * 初期化コマンドを処理
 * @param {import('./worker-protocol.js').InitMessage} message
 */
function handleInit(message) {
  try {
    // 既存のエンコーダーがあれば破棄
    if (encoder) {
      encoder.dispose();
    }

    // 新しいエンコーダーを作成
    // TODO: encoderId に基づいてエンコーダーを選択（WASM対応時）
    encoder = createGifencEncoder();

    // 初期化
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
 * フレーム追加コマンドを処理
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

    // 進捗報告
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
 * 完了コマンドを処理
 */
function handleFinish() {
  try {
    if (!encoder) {
      throw new Error('Encoder not initialized');
    }

    const bytes = encoder.finish();
    const duration = Date.now() - startTime;

    // ArrayBuffer を Transferable として送信
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    postEvent(
      {
        event: Events.COMPLETE,
        gifData: buffer,
        duration,
      },
      [buffer]
    );

    // クリーンアップ
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
 * キャンセルコマンドを処理
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
 * メッセージハンドラー
 * @param {MessageEvent<import('./worker-protocol.js').WorkerMessage>} event
 */
self.onmessage = (event) => {
  const message = event.data;

  switch (message.command) {
    case Commands.INIT:
      handleInit(message);
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
 * エラーハンドラー
 * @param {ErrorEvent} error
 */
self.onerror = (error) => {
  postEvent({
    event: Events.ERROR,
    message: error.message || 'Unknown worker error',
    code: 'WORKER_ERROR',
  });
};
