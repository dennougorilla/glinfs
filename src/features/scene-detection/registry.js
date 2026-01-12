/**
 * Scene Detector Registry
 * Manages detector registration and retrieval with Strategy pattern
 * Allows adding new detection algorithms without modifying existing code
 * @module features/scene-detection/registry
 */

/**
 * @typedef {import('./types.js').SceneDetectorInterface} SceneDetectorInterface
 * @typedef {import('./types.js').DetectorFactory} DetectorFactory
 * @typedef {import('./types.js').DetectorMetadata} DetectorMetadata
 */

/** @type {Map<string, DetectorFactory>} */
const detectorFactories = new Map();

/** @type {string | null} */
let defaultDetectorId = null;

/**
 * Register a detector factory
 * @param {string} id - Detector identifier
 * @param {DetectorFactory} factory - Factory function that creates detector instances
 * @param {boolean} [setAsDefault=false] - Whether to set as default detector
 */
export function registerDetector(id, factory, setAsDefault = false) {
  detectorFactories.set(id, factory);

  if (setAsDefault || defaultDetectorId === null) {
    defaultDetectorId = id;
  }
}

/**
 * Unregister a detector
 * @param {string} id - Detector identifier
 * @returns {boolean} Whether unregistration succeeded
 */
export function unregisterDetector(id) {
  const removed = detectorFactories.delete(id);

  if (removed && defaultDetectorId === id) {
    const firstKey = detectorFactories.keys().next().value;
    defaultDetectorId = firstKey ?? null;
  }

  return removed;
}

/**
 * Create a detector instance
 * @param {string} [id] - Detector identifier (defaults to default detector)
 * @returns {SceneDetectorInterface}
 * @throws {Error} If detector not found
 */
export function createDetector(id) {
  const detectorId = id ?? defaultDetectorId;

  if (!detectorId) {
    throw new Error('No detector registered');
  }

  const factory = detectorFactories.get(detectorId);

  if (!factory) {
    throw new Error(`Detector "${detectorId}" not found`);
  }

  return factory();
}

/**
 * Get list of all registered detectors
 * @returns {DetectorMetadata[]}
 */
export function getAvailableDetectors() {
  const detectors = [];

  for (const [, factory] of detectorFactories) {
    try {
      const detector = factory();
      detectors.push(detector.metadata);
      detector.dispose();
    } catch (error) {
      console.warn('Failed to get detector metadata:', error);
    }
  }

  return detectors;
}

/**
 * Get default detector ID
 * @returns {string | null}
 */
export function getDefaultDetectorId() {
  return defaultDetectorId;
}

/**
 * Set default detector ID
 * @param {string} id - Detector identifier
 * @throws {Error} If detector not found
 */
export function setDefaultDetector(id) {
  if (!detectorFactories.has(id)) {
    throw new Error(`Detector "${id}" not found`);
  }
  defaultDetectorId = id;
}

/**
 * Check if detector is available
 * @param {string} id - Detector identifier
 * @returns {boolean}
 */
export function isDetectorAvailable(id) {
  return detectorFactories.has(id);
}

/**
 * Clear all detector registrations (for testing)
 */
export function clearRegistry() {
  detectorFactories.clear();
  defaultDetectorId = null;
}
