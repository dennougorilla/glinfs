/**
 * Encoder Type Definitions
 * WASM対応を後から追加可能な分離設計
 * @module features/export/encoders/types
 */

/**
 * エンコーダー初期化設定
 * @typedef {Object} EncoderConfig
 * @property {number} width - 出力幅
 * @property {number} height - 出力高さ
 * @property {number} maxColors - 最大色数 (16-256)
 * @property {number} frameDelayMs - フレーム間隔 (ms)
 * @property {number} loopCount - ループ回数 (0 = 無限)
 */

/**
 * フレームデータ
 * @typedef {Object} FrameData
 * @property {Uint8ClampedArray} rgba - RGBA ピクセルデータ
 * @property {number} width - フレーム幅
 * @property {number} height - フレーム高さ
 */

/**
 * 進捗報告
 * @typedef {Object} EncoderProgress
 * @property {number} frameIndex - 処理中のフレームインデックス
 * @property {number} totalFrames - 合計フレーム数
 * @property {number} percent - 進捗率 (0-100)
 */

/**
 * エンコーダーメタデータ
 * @typedef {Object} EncoderMetadata
 * @property {string} id - エンコーダー識別子
 * @property {string} name - 表示名
 * @property {boolean} isWasm - WASM エンコーダーかどうか
 * @property {string} version - バージョン
 */

/**
 * エンコーダーインターフェース
 * 将来的に WASM エンコーダーを追加可能
 *
 * @typedef {Object} EncoderInterface
 * @property {EncoderMetadata} metadata - エンコーダーメタデータ
 * @property {(config: EncoderConfig) => void} init - 初期化
 * @property {(frameData: FrameData, frameIndex: number) => void} addFrame - フレーム追加
 * @property {() => Uint8Array} finish - エンコード完了・バイト配列取得
 * @property {() => void} dispose - リソース解放
 */

/**
 * エンコーダーファクトリー関数
 * @callback EncoderFactory
 * @returns {EncoderInterface}
 */

export {};
