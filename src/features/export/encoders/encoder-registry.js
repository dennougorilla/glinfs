/**
 * Encoder Registry
 * エンコーダーの登録・取得を管理
 * WASM エンコーダーを後から追加可能
 * @module features/export/encoders/encoder-registry
 */

/**
 * @typedef {import('./types.js').EncoderInterface} EncoderInterface
 * @typedef {import('./types.js').EncoderFactory} EncoderFactory
 * @typedef {import('./types.js').EncoderMetadata} EncoderMetadata
 */

/** @type {Map<string, EncoderFactory>} */
const encoderFactories = new Map();

/** @type {string | null} */
let defaultEncoderId = null;

/**
 * エンコーダーファクトリーを登録
 * @param {string} id - エンコーダー識別子
 * @param {EncoderFactory} factory - エンコーダーファクトリー関数
 * @param {boolean} [setAsDefault=false] - デフォルトとして設定するか
 */
export function registerEncoder(id, factory, setAsDefault = false) {
  if (encoderFactories.has(id)) {
    console.warn(`[EncoderRegistry] Encoder "${id}" is already registered, overwriting`);
  }

  encoderFactories.set(id, factory);

  if (setAsDefault || defaultEncoderId === null) {
    defaultEncoderId = id;
  }
}

/**
 * エンコーダーの登録を解除
 * @param {string} id - エンコーダー識別子
 * @returns {boolean} 解除成功かどうか
 */
export function unregisterEncoder(id) {
  const removed = encoderFactories.delete(id);

  if (removed && defaultEncoderId === id) {
    // 別のエンコーダーをデフォルトに設定
    const firstKey = encoderFactories.keys().next().value;
    defaultEncoderId = firstKey ?? null;
  }

  return removed;
}

/**
 * エンコーダーインスタンスを作成
 * @param {string} [id] - エンコーダー識別子（省略時はデフォルト）
 * @returns {EncoderInterface}
 * @throws {Error} エンコーダーが見つからない場合
 */
export function createEncoder(id) {
  const encoderId = id ?? defaultEncoderId;

  if (!encoderId) {
    throw new Error('No encoder registered');
  }

  const factory = encoderFactories.get(encoderId);

  if (!factory) {
    throw new Error(`Encoder "${encoderId}" not found`);
  }

  return factory();
}

/**
 * 登録されているエンコーダー一覧を取得
 * @returns {EncoderMetadata[]}
 */
export function getAvailableEncoders() {
  const encoders = [];

  for (const [id, factory] of encoderFactories) {
    try {
      const encoder = factory();
      encoders.push(encoder.metadata);
      encoder.dispose();
    } catch {
      // Skip broken encoders
    }
  }

  return encoders;
}

/**
 * デフォルトエンコーダーIDを取得
 * @returns {string | null}
 */
export function getDefaultEncoderId() {
  return defaultEncoderId;
}

/**
 * デフォルトエンコーダーIDを設定
 * @param {string} id - エンコーダー識別子
 * @throws {Error} エンコーダーが見つからない場合
 */
export function setDefaultEncoder(id) {
  if (!encoderFactories.has(id)) {
    throw new Error(`Encoder "${id}" not found`);
  }
  defaultEncoderId = id;
}

/**
 * エンコーダーが利用可能かチェック
 * @param {string} id - エンコーダー識別子
 * @returns {boolean}
 */
export function isEncoderAvailable(id) {
  return encoderFactories.has(id);
}

/**
 * すべてのエンコーダー登録をクリア（テスト用）
 */
export function clearRegistry() {
  encoderFactories.clear();
  defaultEncoderId = null;
}
