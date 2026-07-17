/**
 * Scene Detection Module
 * Public API for scene detection functionality
 * @module features/scene-detection
 */

// Re-export manager
export { createSceneDetectionManager, SceneDetectionManager } from './manager.js';

// Re-export registry functions
export {
  createDetector,
  getAvailableDetectors,
  getDefaultDetectorId,
  isDetectorAvailable,
  registerDetector,
  setDefaultDetector,
  unregisterDetector,
} from './registry.js';
// Re-export types
export { DEFAULT_DETECTOR_OPTIONS } from './types.js';

import { createHistogramDetector } from './algorithms/histogram-detector.js';
// Import for initialization
import { registerDetector } from './registry.js';

/**
 * Initialize scene detection module
 * Registers default detectors
 */
export function initSceneDetection() {
  // Register histogram detector as default
  registerDetector('histogram', createHistogramDetector, true);

  // Future algorithms can be registered here:
  // registerDetector('pixel-diff', createPixelDiffDetector);
  // registerDetector('ml-based', createMLDetector);
}

// Auto-initialize when module is imported
initSceneDetection();

/**
 * @typedef {import('./types.js').Scene} Scene
 * @typedef {import('./types.js').SceneDetectionResult} SceneDetectionResult
 * @typedef {import('./types.js').DetectorOptions} DetectorOptions
 * @typedef {import('./types.js').DetectionProgress} DetectionProgress
 * @typedef {import('./types.js').SceneDetectionStatus} SceneDetectionStatus
 */
