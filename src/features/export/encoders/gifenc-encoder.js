/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF エンコーダー
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
  isWasm: false,
  version: '1.0.3',
};

/**
 * gifenc エンコーダーを作成
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
     * エンコーダーを初期化
     * @param {EncoderConfig} encoderConfig
     */
    init(encoderConfig) {
      config = encoderConfig;
      encoder = GIFEncoder();
    },

    /**
     * フレームを追加
     * @param {FrameData} frameData
     * @param {number} frameIndex
     */
    addFrame(frameData, frameIndex) {
      if (!encoder || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const { rgba, width, height } = frameData;

      // 色量子化（パレット生成）
      const palette = quantize(rgba, config.maxColors);

      // ピクセルをパレットインデックスにマップ
      const index = applyPalette(rgba, palette);

      // フレームを書き込み
      encoder.writeFrame(index, width, height, {
        palette,
        delay: config.frameDelayMs,
        repeat: config.loopCount,
      });
    },

    /**
     * エンコード完了・バイト配列取得
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
     * リソース解放
     */
    dispose() {
      encoder = null;
      config = null;
    },
  };
}

/**
 * gifenc エンコーダーのメタデータを取得
 * @returns {EncoderMetadata}
 */
export function getGifencMetadata() {
  return METADATA;
}
