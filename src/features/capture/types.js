/**
 * Capture Feature Type Definitions
 * @module features/capture/types
 */

/**
 * A single captured frame from the screen
 * @typedef {Object} Frame
 * @property {string} id - Unique identifier (UUID)
 * @property {VideoFrame} frame - GPU-resident video frame (WebCodecs API)
 * @property {number} timestamp - Capture time (VideoFrame.timestamp in microseconds)
 * @property {number} width - Frame width in pixels (from VideoFrame.codedWidth)
 * @property {number} height - Frame height in pixels (from VideoFrame.codedHeight)
 */

/**
 * User-configurable capture settings
 * @typedef {Object} CaptureSettings
 * @property {15|30|60} fps - Frames per second
 * @property {number} bufferDuration - Buffer duration in seconds (5-60)
 * @property {number} thumbnailQuality - Thumbnail quality 0.1-1.0
 * @property {boolean} sceneDetection - Enable scene detection on clip creation
 */

/**
 * Real-time buffer statistics
 * @typedef {Object} BufferStats
 * @property {number} frameCount - Current frames in buffer
 * @property {number} duration - Buffer duration in seconds
 * @property {number} memoryMB - Estimated memory usage
 * @property {number} fps - Actual capture rate
 */

/**
 * Capture feature state
 * @typedef {Object} CaptureState
 * @property {boolean} isCapturing - Currently capturing
 * @property {boolean} isSharing - Screen share active
 * @property {MediaStream|null} stream - Active media stream
 * @property {CaptureSettings} settings - User settings
 * @property {string|null} error - Current error message
 * @property {BufferStats} stats - Real-time statistics
 */

export {};
