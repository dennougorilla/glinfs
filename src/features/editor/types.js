/**
 * Editor Feature Type Definitions
 * @module features/editor/types
 */

/**
 * Selected range of frames
 * @typedef {Object} FrameRange
 * @property {number} start - Start frame index (inclusive)
 * @property {number} end - End frame index (inclusive)
 */

/**
 * Aspect ratio constraint type
 * @typedef {'free'|'1:1'|'16:9'|'4:3'|'9:16'|'3:4'} AspectRatio
 */

/**
 * Crop area within a frame
 * @typedef {Object} CropArea
 * @property {number} x - Left offset in pixels
 * @property {number} y - Top offset in pixels
 * @property {number} width - Crop width in pixels
 * @property {number} height - Crop height in pixels
 * @property {AspectRatio} aspectRatio - Constraint
 */

/**
 * A clip being edited
 * @typedef {Object} Clip
 * @property {string} id - Unique identifier
 * @property {import('../capture/types.js').Frame[]} frames - Copied frames from buffer
 * @property {FrameRange} selectedRange - Start/end selection
 * @property {CropArea|null} cropArea - Optional crop region
 * @property {number} createdAt - Creation timestamp
 * @property {number} fps - Source FPS (default: 30)
 */

/**
 * Editor interaction mode
 * @typedef {'select'|'crop'|'preview'} EditorMode
 */

/**
 * Handle position for crop resize operations
 * @typedef {'top-left'|'top-right'|'bottom-left'|'bottom-right'|'top'|'bottom'|'left'|'right'|'move'|'draw'|null} HandlePosition
 */

/**
 * Crop interaction state for visual feedback
 * @typedef {Object} CropInteractionState
 * @property {HandlePosition} hoveredHandle - Handle currently under cursor
 * @property {HandlePosition} activeHandle - Handle being dragged
 * @property {BoundaryHit|null} boundaryHit - Current boundary collision state
 */

/**
 * Boundary hit detection result
 * @typedef {Object} BoundaryHit
 * @property {boolean} top - Crop touches top boundary
 * @property {boolean} bottom - Crop touches bottom boundary
 * @property {boolean} left - Crop touches left boundary
 * @property {boolean} right - Crop touches right boundary
 */

/**
 * Selection information (basic)
 * @typedef {Object} SelectionInfo
 * @property {number} frameCount - Number of selected frames
 * @property {number} duration - Duration in seconds
 * @property {import('../shared/types.js').Dimensions} outputDimensions - Output size
 */

/**
 * Selection info with formatted display strings
 * @typedef {Object} SelectionDisplayInfo
 * @property {number} frameCount - Number of frames in selection
 * @property {number} duration - Selection duration in seconds
 * @property {string} formattedDuration - Human-readable duration (e.g., "1.5s")
 * @property {string} formattedFrameCount - Human-readable frame count (e.g., "45 frames")
 */

/**
 * Editor feature state
 * @typedef {Object} EditorState
 * @property {Clip|null} clip - Active clip being edited
 * @property {number} currentFrame - Currently displayed frame index
 * @property {FrameRange} selectedRange - Selected frame range
 * @property {CropArea|null} cropArea - Active crop selection
 * @property {AspectRatio} selectedAspectRatio - Currently selected aspect ratio (independent of cropArea)
 * @property {boolean} isPlaying - Playback in progress
 * @property {number} playbackSpeed - Current playback speed
 * @property {EditorMode} mode - Current interaction mode
 * @property {boolean} showGrid - Grid overlay enabled
 */

/**
 * Frame Grid Modal state (local, not persisted to global store)
 * @typedef {Object} FrameGridState
 * @property {boolean} isOpen - Modal visibility
 * @property {number | null} startFrame - Selected start frame index (null if not set)
 * @property {number | null} endFrame - Selected end frame index (null if not set)
 * @property {number | null} hoveredFrame - Currently hovered frame index
 * @property {number} focusedFrame - Currently focused frame for keyboard nav (default: 0)
 */

export {};
