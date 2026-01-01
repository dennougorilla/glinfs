/**
 * Encoder Registry
 * Manages encoder registration and retrieval
 * WASM encoders can be added later
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
 * Register encoder factory
 * @param {string} id - Encoder identifier
 * @param {EncoderFactory} factory - Encoder factory function
 * @param {boolean} [setAsDefault=false] - Whether to set as default
 */
export function registerEncoder(id, factory, setAsDefault = false) {
  encoderFactories.set(id, factory);

  if (setAsDefault || defaultEncoderId === null) {
    defaultEncoderId = id;
  }
}

/**
 * Unregister encoder
 * @param {string} id - Encoder identifier
 * @returns {boolean} Whether unregistration succeeded
 */
export function unregisterEncoder(id) {
  const removed = encoderFactories.delete(id);

  if (removed && defaultEncoderId === id) {
    // Set another encoder as default
    const firstKey = encoderFactories.keys().next().value;
    defaultEncoderId = firstKey ?? null;
  }

  return removed;
}

/**
 * Create encoder instance
 * @param {string} [id] - Encoder identifier (defaults to default encoder)
 * @returns {EncoderInterface}
 * @throws {Error} If encoder not found
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
 * Get list of registered encoders
 * @returns {EncoderMetadata[]}
 */
export function getAvailableEncoders() {
  const encoders = [];

  for (const [, factory] of encoderFactories) {
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
 * Get default encoder ID
 * @returns {string | null}
 */
export function getDefaultEncoderId() {
  return defaultEncoderId;
}

/**
 * Set default encoder ID
 * @param {string} id - Encoder identifier
 * @throws {Error} If encoder not found
 */
export function setDefaultEncoder(id) {
  if (!encoderFactories.has(id)) {
    throw new Error(`Encoder "${id}" not found`);
  }
  defaultEncoderId = id;
}

/**
 * Check if encoder is available
 * @param {string} id - Encoder identifier
 * @returns {boolean}
 */
export function isEncoderAvailable(id) {
  return encoderFactories.has(id);
}

/**
 * Clear all encoder registrations (for testing)
 */
export function clearRegistry() {
  encoderFactories.clear();
  defaultEncoderId = null;
}
