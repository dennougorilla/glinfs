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

/**
 * Detector metadata for UI display
 * @typedef {Object} DetectorMetadata
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} description - Algorithm description
 * @property {boolean} supportsWorker - Whether algorithm can run in Web Worker
 */

/**
 * Scene detector interface
 * @typedef {Object} SceneDetectorInterface
 * @property {DetectorMetadata} metadata - Detector information
 * @property {(frameData: FrameData[], options: DetectorOptions) => Promise<SceneDetectionResult>} detect - Detection method
 * @property {() => void} dispose - Cleanup resources
 */

/**
 * Factory function for creating detectors
 * @typedef {() => SceneDetectorInterface} DetectorFactory
 */

/**
 * Lightweight frame data for detection (avoids VideoFrame transfer)
 * @typedef {Object} FrameData
 * @property {number} index - Frame index in original array
 * @property {number} timestamp - Frame timestamp in microseconds
 * @property {ImageData | null} imageData - Optional raw pixel data (for Worker)
 * @property {Uint8Array | null} histogram - Optional pre-computed histogram
 */

/**
 * Worker message types
 * @typedef {'DETECT' | 'PROGRESS' | 'COMPLETE' | 'ERROR' | 'CANCEL'} WorkerMessageType
 */

/**
 * Message sent to Worker
 * @typedef {Object} WorkerInMessage
 * @property {'DETECT' | 'CANCEL'} type - Message type
 * @property {Object} [payload] - Message payload
 * @property {FrameData[]} [payload.frameData] - Frame data for detection
 * @property {DetectorOptions} [payload.options] - Detection options
 * @property {string} [payload.algorithmId] - Algorithm to use
 */

/**
 * Message from Worker
 * @typedef {Object} WorkerOutMessage
 * @property {'PROGRESS' | 'COMPLETE' | 'ERROR'} type - Message type
 * @property {DetectionProgress | SceneDetectionResult | { message: string }} payload - Message payload
 */

/**
 * Scene detection status
 * @typedef {'idle' | 'detecting' | 'completed' | 'error' | 'cancelled'} SceneDetectionStatus
 */

export {};
