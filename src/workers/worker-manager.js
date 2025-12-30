/**
 * Worker Manager
 * メインスレッド側の Worker 管理
 * @module workers/worker-manager
 */

import {
  Events,
  createInitMessage,
  createAddFrameMessage,
  createFinishMessage,
  createCancelMessage,
} from './worker-protocol.js';

/**
 * @typedef {import('./worker-protocol.js').ProgressEvent} ProgressEvent
 * @typedef {import('./worker-protocol.js').WorkerEvent} WorkerEvent
 */

/**
 * エンコーダー設定
 * @typedef {Object} EncoderManagerConfig
 * @property {string} [encoderId='gifenc-js'] - 使用するエンコーダーID
 * @property {number} width - 出力幅
 * @property {number} height - 出力高さ
 * @property {number} totalFrames - 合計フレーム数
 * @property {number} maxColors - 最大色数
 * @property {number} frameDelayMs - フレーム間隔 (ms)
 * @property {number} loopCount - ループ回数
 */

/**
 * 進捗コールバック
 * @callback ProgressCallback
 * @param {ProgressEvent} progress
 */

/**
 * GIF Encoder Manager
 * Worker を使用した非同期 GIF エンコード管理
 */
export class GifEncoderManager {
  constructor() {
    /** @type {Worker | null} */
    this.worker = null;

    /** @type {ProgressCallback | null} */
    this.onProgress = null;

    /** @type {((data: ArrayBuffer) => void) | null} */
    this._resolveComplete = null;

    /** @type {((error: Error) => void) | null} */
    this._rejectComplete = null;

    /** @type {boolean} */
    this._isInitialized = false;
  }

  /**
   * Worker を初期化
   * @param {EncoderManagerConfig} config
   * @returns {Promise<void>}
   */
  async init(config) {
    return new Promise((resolve, reject) => {
      try {
        // Worker を作成（Vite の特別な構文を使用）
        this.worker = new Worker(
          new URL('./gif-encoder-worker.js', import.meta.url),
          { type: 'module' }
        );

        /**
         * 初期化完了を待つハンドラー
         * @param {MessageEvent<WorkerEvent>} event
         */
        const handleReady = (event) => {
          const data = event.data;

          if (data.event === Events.READY) {
            this.worker?.removeEventListener('message', handleReady);
            this._setupListeners();
            this._isInitialized = true;
            resolve();
          } else if (data.event === Events.ERROR) {
            this.worker?.removeEventListener('message', handleReady);
            reject(new Error(data.message));
          }
        };

        this.worker.addEventListener('message', handleReady);
        this.worker.addEventListener('error', (error) => {
          reject(new Error(error.message || 'Worker initialization failed'));
        });

        // 初期化メッセージを送信
        const initMessage = createInitMessage({
          encoderId: config.encoderId ?? 'gifenc-js',
          width: config.width,
          height: config.height,
          totalFrames: config.totalFrames,
          maxColors: config.maxColors,
          frameDelayMs: config.frameDelayMs,
          loopCount: config.loopCount,
        });

        this.worker.postMessage(initMessage);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Failed to create worker'));
      }
    });
  }

  /**
   * フレームを追加
   * @param {Uint8ClampedArray} rgba - RGBA ピクセルデータ
   * @param {number} width - フレーム幅
   * @param {number} height - フレーム高さ
   * @param {number} frameIndex - フレームインデックス
   */
  addFrame(rgba, width, height, frameIndex) {
    if (!this.worker || !this._isInitialized) {
      throw new Error('Worker not initialized. Call init() first.');
    }

    const { message, transfer } = createAddFrameMessage(rgba, width, height, frameIndex);
    this.worker.postMessage(message, transfer);
  }

  /**
   * エンコードを完了して結果を取得
   * @returns {Promise<Blob>}
   */
  async finish() {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this._isInitialized) {
        reject(new Error('Worker not initialized. Call init() first.'));
        return;
      }

      this._resolveComplete = (gifData) => {
        resolve(new Blob([gifData], { type: 'image/gif' }));
      };

      this._rejectComplete = reject;

      this.worker.postMessage(createFinishMessage());
    });
  }

  /**
   * エンコードをキャンセル
   */
  cancel() {
    if (this.worker && this._isInitialized) {
      this.worker.postMessage(createCancelMessage());
    }
  }

  /**
   * リソースを解放
   */
  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.onProgress = null;
    this._resolveComplete = null;
    this._rejectComplete = null;
    this._isInitialized = false;
  }

  /**
   * イベントリスナーをセットアップ
   * @private
   */
  _setupListeners() {
    if (!this.worker) return;

    this.worker.addEventListener('message', (event) => {
      const data = /** @type {WorkerEvent} */ (event.data);

      switch (data.event) {
        case Events.PROGRESS:
          this.onProgress?.(data);
          break;

        case Events.COMPLETE:
          this._resolveComplete?.(data.gifData);
          this._resolveComplete = null;
          this._rejectComplete = null;
          break;

        case Events.ERROR:
          this._rejectComplete?.(new Error(data.message));
          this._resolveComplete = null;
          this._rejectComplete = null;
          break;

        case Events.CANCELLED:
          this._rejectComplete?.(new DOMException('Encoding cancelled', 'AbortError'));
          this._resolveComplete = null;
          this._rejectComplete = null;
          break;
      }
    });
  }
}

/**
 * GifEncoderManager インスタンスを作成
 * @returns {GifEncoderManager}
 */
export function createEncoderManager() {
  return new GifEncoderManager();
}
