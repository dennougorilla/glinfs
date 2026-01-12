/**
 * Scene Detection Module
 * Public API for scene detection functionality
 * @module features/scene-detection
 */

// Re-export types
export { DEFAULT_DETECTOR_OPTIONS } from './types.js';

// Re-export registry functions
export {
  registerDetector,
  unregisterDetector,
  createDetector,
  getAvailableDetectors,
  getDefaultDetectorId,
  setDefaultDetector,
  isDetectorAvailable,
} from './registry.js';

// Re-export manager
export { SceneDetectionManager, createSceneDetectionManager } from './manager.js';

// Import for initialization
import { registerDetector } from './registry.js';
import { createHistogramDetector } from './algorithms/histogram-detector.js';

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
