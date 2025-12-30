/**
 * Export Feature Type Definitions
 * @module features/export/types
 */

/**
 * Export settings
 * @typedef {Object} ExportSettings
 * @property {number} quality - 0.1 to 1.0 (affects color quantization)
 * @property {1|2|3|4|5} frameSkip - Use every Nth frame
 * @property {number} playbackSpeed - 0.25 to 4.0
 * @property {boolean} dithering - Enable dithering for smoother gradients
 * @property {number} loopCount - 0 for infinite, 1+ for specific count
 * @property {boolean} openInNewTab - Open result in new tab vs download
 */

/**
 * Encoding status
 * @typedef {'idle'|'preparing'|'encoding'|'complete'|'error'} EncodingStatus
 */

/**
 * Active encoding job
 * @typedef {Object} EncodingJob
 * @property {string} id - Unique job identifier
 * @property {EncodingStatus} status - Current status
 * @property {number} progress - 0 to 100 percent
 * @property {number} currentFrame - Frame being processed
 * @property {number} totalFrames - Total frames to process
 * @property {number} startTime - Encoding start timestamp
 * @property {number|null} estimatedRemaining - Estimated ms remaining
 * @property {'wasm'|'js'} encoder - Active encoder type
 * @property {Blob|null} result - Output GIF blob when complete
 * @property {string|null} error - Error message if failed
 */

/**
 * GIF output
 * @typedef {Object} GifOutput
 * @property {Blob} blob - GIF file blob
 * @property {number} size - File size in bytes
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {number} frameCount - Number of frames
 * @property {number} duration - Duration in seconds
 */

/**
 * Canvas preview state for real-time playback
 * @typedef {Object} PreviewState
 * @property {boolean} isPlaying - Whether preview is currently playing
 */

/**
 * Export feature state
 * @typedef {Object} ExportState
 * @property {boolean} isDialogOpen - Export dialog visible
 * @property {ExportSettings} settings - Current export settings
 * @property {EncodingJob|null} job - Active encoding job
 * @property {number} estimatedSizeMB - Estimated output size
 * @property {'wasm'|'js'|'unavailable'} encoderStatus - Encoder availability
 * @property {PreviewState} preview - Preview state
 */

export {};
