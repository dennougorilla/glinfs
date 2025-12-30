/**
 * Encoder Module Public API
 * @module features/export/encoders
 */

// Type re-exports
export * from './types.js';

// Registry functions
export {
  registerEncoder,
  unregisterEncoder,
  createEncoder,
  getAvailableEncoders,
  getDefaultEncoderId,
  setDefaultEncoder,
  isEncoderAvailable,
  clearRegistry,
} from './encoder-registry.js';

// Encoder implementations
export { createGifencEncoder, getGifencMetadata } from './gifenc-encoder.js';

// Initialize default encoder
import { registerEncoder } from './encoder-registry.js';
import { createGifencEncoder } from './gifenc-encoder.js';

/**
 * デフォルトエンコーダーを登録
 * モジュール読み込み時に自動実行
 */
function initializeDefaultEncoders() {
  // gifenc (JS) をデフォルトエンコーダーとして登録
  registerEncoder('gifenc-js', createGifencEncoder, true);
}

// 初期化実行
initializeDefaultEncoders();
