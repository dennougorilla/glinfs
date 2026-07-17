/**
 * Scene Detection Type Definitions
 * @module features/scene-detection/types
 */

/**
 * A detected scene within a clip
 * @typedef {Object} Scene
 * @property {string} id - Unique identifier
 * @property {number} startFrame - Scene start frame index (inclusive)
 * @property {number} endFrame - Scene end frame index (inclusive)
 * @property {number} confidence - Detection confidence (0-1)
 * @property {number} timestamp - Start timestamp in milliseconds
 * @property {number} duration - Scene duration in milliseconds
 */

/**
 * Scene detection result
 * @typedef {Object} SceneDetectionResult
 * @property {Scene[]} scenes - Detected scenes
 * @property {number} totalFrames - Total frames processed
 * @property {number} processingTimeMs - Processing time in milliseconds
 * @property {string} algorithmId - Algorithm used for detection
 */

/**
 * Detection progress information
 * @typedef {Object} DetectionProgress
 * @property {number} percent - Progress percentage (0-100)
 * @property {number} currentFrame - Current frame being processed
 * @property {number} totalFrames - Total frames to process
 * @property {string} stage - Current processing stage
 */

/**
 * Detector configuration options
 * @typedef {Object} DetectorOptions
 * @property {number} threshold - Change detection threshold (0-1), higher = less sensitive
 * @property {number} minSceneDuration - Minimum scene duration in frames
 * @property {number} sampleInterval - Frame sampling interval (1 = every frame, 3 = every 3rd frame)
 * @property {(progress: DetectionProgress) => void} [onProgress] - Progress callback
 */

/**
 * Default detector options
 * @type {DetectorOptions}
 */
export const DEFAULT_DETECTOR_OPTIONS = {
  threshold: 0.3,
  minSceneDuration: 5,
  sampleInterval: 1,
  onProgress: undefined,
};
