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
export {
  createGifsicleEncoder,
  getGifsicleMetadata,
  isGifsicleAvailable,
} from './gifsicle-encoder.js';

// Initialize default encoder
import { registerEncoder } from './encoder-registry.js';
import { createGifencEncoder } from './gifenc-encoder.js';
import { createGifsicleEncoder } from './gifsicle-encoder.js';

/**
 * Register default encoders
 * Automatically executed on module load
 */
function initializeDefaultEncoders() {
  // Register gifenc (JS) as default encoder
  registerEncoder('gifenc-js', createGifencEncoder, true);

  // Register gifsicle (WASM) encoder
  registerEncoder('gifsicle-wasm', createGifsicleEncoder, false);
}

// Execute initialization
initializeDefaultEncoders();
