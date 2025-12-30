/**
 * Worker Communication Protocol
 * Worker とメインスレッド間の通信プロトコル定義
 * @module workers/worker-protocol
 */

/**
 * Worker コマンド種別
 * @readonly
 * @enum {string}
 */
export const Commands = {
  /** エンコーダー初期化 */
  INIT: 'init',
  /** フレーム追加 */
  ADD_FRAME: 'add-frame',
  /** エンコード完了 */
  FINISH: 'finish',
  /** エンコードキャンセル */
  CANCEL: 'cancel',
};

/**
 * Worker イベント種別
 * @readonly
 * @enum {string}
 */
export const Events = {
  /** 初期化完了 */
  READY: 'ready',
  /** 進捗更新 */
  PROGRESS: 'progress',
  /** エンコード完了 */
  COMPLETE: 'complete',
  /** エラー発生 */
  ERROR: 'error',
  /** キャンセル完了 */
  CANCELLED: 'cancelled',
};

/**
 * 初期化メッセージ
 * @typedef {Object} InitMessage
 * @property {typeof Commands.INIT} command
 * @property {string} encoderId - 使用するエンコーダーID
 * @property {number} width - 出力幅
 * @property {number} height - 出力高さ
 * @property {number} totalFrames - 合計フレーム数
 * @property {number} maxColors - 最大色数
 * @property {number} frameDelayMs - フレーム間隔 (ms)
 * @property {number} loopCount - ループ回数
 */

/**
 * フレーム追加メッセージ
 * @typedef {Object} AddFrameMessage
 * @property {typeof Commands.ADD_FRAME} command
 * @property {ArrayBuffer} rgbaData - RGBA ピクセルデータ (Transferable)
 * @property {number} width - フレーム幅
 * @property {number} height - フレーム高さ
 * @property {number} frameIndex - フレームインデックス
 */

/**
 * 完了メッセージ
 * @typedef {Object} FinishMessage
 * @property {typeof Commands.FINISH} command
 */

/**
 * キャンセルメッセージ
 * @typedef {Object} CancelMessage
 * @property {typeof Commands.CANCEL} command
 */

/**
 * Worker への送信メッセージ
 * @typedef {InitMessage | AddFrameMessage | FinishMessage | CancelMessage} WorkerMessage
 */

/**
 * 準備完了イベント
 * @typedef {Object} ReadyEvent
 * @property {typeof Events.READY} event
 * @property {string} encoderId - 使用中のエンコーダーID
 */

/**
 * 進捗イベント
 * @typedef {Object} ProgressEvent
 * @property {typeof Events.PROGRESS} event
 * @property {number} frameIndex - 処理中のフレーム
 * @property {number} totalFrames - 合計フレーム数
 * @property {number} percent - 進捗率 (0-100)
 */

/**
 * 完了イベント
 * @typedef {Object} CompleteEvent
 * @property {typeof Events.COMPLETE} event
 * @property {ArrayBuffer} gifData - GIF データ (Transferable)
 * @property {number} duration - エンコード時間 (ms)
 */

/**
 * エラーイベント
 * @typedef {Object} ErrorEvent
 * @property {typeof Events.ERROR} event
 * @property {string} message - エラーメッセージ
 * @property {string} [code] - エラーコード
 */

/**
 * キャンセル完了イベント
 * @typedef {Object} CancelledEvent
 * @property {typeof Events.CANCELLED} event
 */

/**
 * Worker からの受信イベント
 * @typedef {ReadyEvent | ProgressEvent | CompleteEvent | ErrorEvent | CancelledEvent} WorkerEvent
 */

/**
 * InitMessage を作成
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
 * AddFrameMessage を作成
 * @param {Uint8ClampedArray} rgba - RGBA データ
 * @param {number} width
 * @param {number} height
 * @param {number} frameIndex
 * @returns {{ message: AddFrameMessage, transfer: ArrayBuffer[] }}
 */
export function createAddFrameMessage(rgba, width, height, frameIndex) {
  // ArrayBuffer をコピーして Transferable にする
  const buffer = rgba.buffer.slice(0);

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
 * FinishMessage を作成
 * @returns {FinishMessage}
 */
export function createFinishMessage() {
  return { command: Commands.FINISH };
}

/**
 * CancelMessage を作成
 * @returns {CancelMessage}
 */
export function createCancelMessage() {
  return { command: Commands.CANCEL };
}
