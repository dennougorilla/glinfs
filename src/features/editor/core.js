/**
 * Editor Core - Pure Functions
 * @module features/editor/core
 */

import { formatCompactDuration } from '../../shared/utils/format.js';

/** @type {Object<string, number>} */
const ASPECT_RATIOS = {
  'free': 0,
  '1:1': 1,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
  '3:4': 3 / 4,
};

/** Minimum crop dimension */
const MIN_CROP_SIZE = 10;

/** Handle hit detection radius in pixels */
export const HANDLE_HIT_ZONE = 15;

/** Handle visual size in pixels */
export const HANDLE_SIZE = 10;

/** Default FPS if not provided */
const DEFAULT_FPS = 30;

// ============================================================================
// Handle Resize Configuration
// ============================================================================

/**
 * @typedef {Object} HandleConfig
 * @property {boolean} affectsX - Does this handle move the X position?
 * @property {boolean} affectsY - Does this handle move the Y position?
 * @property {number} widthSign - Multiplier for dx when calculating width change (+1, -1, or 0)
 * @property {number} heightSign - Multiplier for dy when calculating height change (+1, -1, or 0)
 */

/**
 * Handle resize configuration
 * Each handle defines how dx/dy affect position and dimensions
 * @type {Record<import('./types.js').HandlePosition, HandleConfig>}
 */
const HANDLE_CONFIG = {
  'top-left':     { affectsX: true,  affectsY: true,  widthSign: -1, heightSign: -1 },
  'top':          { affectsX: false, affectsY: true,  widthSign:  0, heightSign: -1 },
  'top-right':    { affectsX: false, affectsY: true,  widthSign: +1, heightSign: -1 },
  'left':         { affectsX: true,  affectsY: false, widthSign: -1, heightSign:  0 },
  'right':        { affectsX: false, affectsY: false, widthSign: +1, heightSign:  0 },
  'bottom-left':  { affectsX: true,  affectsY: false, widthSign: -1, heightSign: +1 },
  'bottom':       { affectsX: false, affectsY: false, widthSign:  0, heightSign: +1 },
  'bottom-right': { affectsX: false, affectsY: false, widthSign: +1, heightSign: +1 },
};

/**
 * @typedef {'horizontal' | 'vertical' | 'corner'} HandleType
 */

/**
 * @typedef {Object} CornerAnchor
 * @property {boolean} anchorRight - X is anchored to right edge
 * @property {boolean} anchorBottom - Y is anchored to bottom edge
 */

/**
 * Position anchor configuration for corner handles
 * Defines which edge is anchored (fixed) during resize
 * @type {Record<string, CornerAnchor>}
 */
const CORNER_ANCHORS = {
  'top-left':     { anchorRight: true,  anchorBottom: true },
  'top-right':    { anchorRight: false, anchorBottom: true },
  'bottom-left':  { anchorRight: true,  anchorBottom: false },
  'bottom-right': { anchorRight: false, anchorBottom: false },
};

/**
 * Determine handle type for aspect ratio calculation
 * @param {import('./types.js').HandlePosition} handle
 * @returns {HandleType}
 */
function getHandleType(handle) {
  if (handle === 'left' || handle === 'right') return 'horizontal';
  if (handle === 'top' || handle === 'bottom') return 'vertical';
  return 'corner';
}

/**
 * Apply handle drag to crop dimensions using config-driven approach
 * @param {import('./types.js').CropArea} crop - Current crop
 * @param {HandleConfig} config - Handle configuration
 * @param {number} dx - Horizontal delta
 * @param {number} dy - Vertical delta
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function applyHandleDrag(crop, config, dx, dy) {
  return {
    x: config.affectsX ? crop.x + dx : crop.x,
    y: config.affectsY ? crop.y + dy : crop.y,
    width: crop.width + config.widthSign * dx,
    height: crop.height + config.heightSign * dy,
  };
}

/**
 * Create a clip from buffer frames
 * @param {import('../capture/types.js').Frame[]} frames - Source frames
 * @param {number} [fps] - Source FPS (default: 30)
 * @returns {import('./types.js').Clip}
 */
export function createClip(frames, fps = DEFAULT_FPS) {
  return {
    id: crypto.randomUUID(),
    frames,
    selectedRange: {
      start: 0,
      end: Math.max(0, frames.length - 1),
    },
    cropArea: null,
    createdAt: Date.now(),
    fps,
  };
}

/**
 * Update frame range selection
 * @param {import('./types.js').Clip} clip
 * @param {import('./types.js').FrameRange} range
 * @returns {import('./types.js').Clip}
 */
export function setFrameRange(clip, range) {
  return {
    ...clip,
    selectedRange: range,
  };
}

/**
 * Validate frame range
 * @param {import('./types.js').FrameRange} range
 * @param {number} totalFrames
 * @returns {import('../../shared/types.js').ValidationResult}
 */
export function validateFrameRange(range, totalFrames) {
  /** @type {string[]} */
  const errors = [];

  if (range.start < 0) {
    errors.push('Start frame cannot be negative');
  }

  if (range.end >= totalFrames) {
    errors.push('End frame exceeds total frames');
  }

  if (range.start > range.end) {
    errors.push('Start frame must be less than or equal to end frame');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Create or update crop area
 * @param {import('./types.js').CropArea | null} current
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {import('../capture/types.js').Frame} frame
 * @returns {import('./types.js').CropArea}
 */
export function setCropArea(current, rect, frame) {
  const aspectRatio = current?.aspectRatio ?? 'free';

  const crop = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    aspectRatio,
  };

  // Clamp to frame bounds
  return clampCropArea(crop, frame.width, frame.height);
}

/**
 * Constrain crop to aspect ratio
 * @param {import('./types.js').CropArea} crop
 * @param {string} ratio
 * @returns {import('./types.js').CropArea}
 */
export function constrainAspectRatio(crop, ratio) {
  if (ratio === 'free') {
    return { ...crop, aspectRatio: 'free' };
  }

  const targetRatio = ASPECT_RATIOS[ratio];
  if (!targetRatio) {
    return { ...crop, aspectRatio: 'free' };
  }

  const currentRatio = crop.width / crop.height;
  let newWidth = crop.width;
  let newHeight = crop.height;

  if (currentRatio > targetRatio) {
    // Too wide, reduce width
    newWidth = Math.round(crop.height * targetRatio);
  } else {
    // Too tall, reduce height
    newHeight = Math.round(crop.width / targetRatio);
  }

  return {
    ...crop,
    width: newWidth,
    height: newHeight,
    aspectRatio: /** @type {import('./types.js').CropArea['aspectRatio']} */ (ratio),
  };
}

/**
 * Clamp crop area to frame bounds
 * @param {import('./types.js').CropArea} crop
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {import('./types.js').CropArea}
 */
export function clampCropArea(crop, frameWidth, frameHeight) {
  // Clamp position
  let x = Math.max(0, crop.x);
  let y = Math.max(0, crop.y);

  // Clamp dimensions
  let width = Math.max(MIN_CROP_SIZE, Math.min(crop.width, frameWidth));
  let height = Math.max(MIN_CROP_SIZE, Math.min(crop.height, frameHeight));

  // Adjust position if crop extends beyond frame
  if (x + width > frameWidth) {
    x = frameWidth - width;
  }
  if (y + height > frameHeight) {
    y = frameHeight - height;
  }

  // Final clamp of position
  x = Math.max(0, x);
  y = Math.max(0, y);

  return {
    x,
    y,
    width,
    height,
    aspectRatio: crop.aspectRatio,
  };
}

/**
 * Calculate selected frame count and duration
 * @param {import('./types.js').FrameRange} range
 * @param {number} fps
 * @returns {import('./types.js').SelectionInfo}
 */
export function calculateSelection(range, fps) {
  const count = range.end - range.start + 1;
  const duration = count / fps;

  return {
    count,
    duration,
    outputDimensions: { width: 0, height: 0 }, // Filled by caller with frame info
  };
}

// Import from shared geometry utilities
import { getEffectiveDimensions } from '../../shared/utils/geometry.js';

/**
 * Get output dimensions after crop
 * @param {import('./types.js').CropArea | null} crop
 * @param {import('../capture/types.js').Frame} frame
 * @returns {import('../../shared/types.js').Dimensions}
 */
export function getOutputDimensions(crop, frame) {
  // Note: parameter order preserved for backward compatibility (crop, frame)
  // but internally uses shared utility with (source, crop) order
  return getEffectiveDimensions(frame, crop);
}

/**
 * Get frames in selected range
 * @param {import('./types.js').Clip} clip
 * @returns {import('../capture/types.js').Frame[]}
 */
export function getSelectedFrames(clip) {
  const { start, end } = clip.selectedRange;
  return clip.frames.slice(start, end + 1);
}

/**
 * Calculate crop area from drag coordinates
 * @param {{ x: number, y: number }} start - Start point
 * @param {{ x: number, y: number }} end - End point
 * @param {import('../capture/types.js').Frame} frame
 * @param {string} aspectRatio
 * @returns {import('./types.js').CropArea}
 */
export function calculateCropFromDrag(start, end, frame, aspectRatio = 'free') {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  let crop = {
    x,
    y,
    width: Math.max(MIN_CROP_SIZE, width),
    height: Math.max(MIN_CROP_SIZE, height),
    aspectRatio: /** @type {import('./types.js').CropArea['aspectRatio']} */ ('free'),
  };

  // Apply aspect ratio constraint if not free
  if (aspectRatio !== 'free') {
    crop = constrainAspectRatio(crop, aspectRatio);
  }

  return clampCropArea(crop, frame.width, frame.height);
}

/**
 * Calculate selection metadata for display
 * Returns frame count, duration, and formatted strings for UI display
 * @param {import('./types.js').FrameRange} selection - Current selection range
 * @param {number} fps - Frames per second
 * @returns {import('./types.js').SelectionDisplayInfo} Computed selection information
 */
export function calculateSelectionInfo(selection, fps) {
  const frameCount = selection.end - selection.start + 1;
  const duration = frameCount / fps;

  return {
    frameCount,
    duration,
    formattedDuration: formatCompactDuration(duration),
    formattedFrameCount: `${frameCount} frame${frameCount !== 1 ? 's' : ''}`,
  };
}

/**
 * Get handle positions for a crop area
 * @param {import('./types.js').CropArea} crop - Crop area
 * @returns {Object<string, {x: number, y: number}>} - Handle coordinates
 */
export function getHandlePositions(crop) {
  return {
    'top-left': { x: crop.x, y: crop.y },
    'top': { x: crop.x + crop.width / 2, y: crop.y },
    'top-right': { x: crop.x + crop.width, y: crop.y },
    'left': { x: crop.x, y: crop.y + crop.height / 2 },
    'right': { x: crop.x + crop.width, y: crop.y + crop.height / 2 },
    'bottom-left': { x: crop.x, y: crop.y + crop.height },
    'bottom': { x: crop.x + crop.width / 2, y: crop.y + crop.height },
    'bottom-right': { x: crop.x + crop.width, y: crop.y + crop.height },
  };
}

/**
 * Apply aspect ratio for horizontal handle (left/right)
 * Width is primary axis, height adjusts and centers vertically
 * @param {{x: number, y: number, width: number, height: number}} proposed
 * @param {import('./types.js').CropArea} original
 * @param {number} targetRatio
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function applyRatioForHorizontalHandle(proposed, original, targetRatio) {
  const width = Math.max(MIN_CROP_SIZE, proposed.width);
  const height = Math.round(width / targetRatio);
  const heightDiff = height - original.height;

  return {
    x: proposed.x,
    y: original.y - heightDiff / 2,
    width,
    height,
  };
}

/**
 * Apply aspect ratio for vertical handle (top/bottom)
 * Height is primary axis, width adjusts and centers horizontally
 * @param {{x: number, y: number, width: number, height: number}} proposed
 * @param {import('./types.js').CropArea} original
 * @param {number} targetRatio
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function applyRatioForVerticalHandle(proposed, original, targetRatio) {
  const height = Math.max(MIN_CROP_SIZE, proposed.height);
  const width = Math.round(height * targetRatio);
  const widthDiff = width - original.width;

  return {
    x: original.x - widthDiff / 2,
    y: proposed.y,
    width,
    height,
  };
}

/**
 * Apply aspect ratio for corner handle
 * Uses larger change as primary axis, anchors to opposite corner
 * @param {{x: number, y: number, width: number, height: number}} proposed
 * @param {import('./types.js').CropArea} original
 * @param {import('./types.js').HandlePosition} handle
 * @param {number} targetRatio
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function applyRatioForCornerHandle(proposed, original, handle, targetRatio) {
  let width = Math.max(MIN_CROP_SIZE, proposed.width);
  let height = Math.max(MIN_CROP_SIZE, proposed.height);

  // Determine primary axis from larger change
  const widthChange = Math.abs(proposed.width - original.width);
  const heightChange = Math.abs(proposed.height - original.height);

  if (widthChange >= heightChange) {
    height = Math.round(width / targetRatio);
  } else {
    width = Math.round(height * targetRatio);
  }

  // Calculate position based on anchor
  const anchor = CORNER_ANCHORS[handle];
  const x = anchor.anchorRight ? original.x + original.width - width : proposed.x;
  const y = anchor.anchorBottom ? original.y + original.height - height : proposed.y;

  return { x, y, width, height };
}

/**
 * Apply aspect ratio constraint to resize operation
 * Dispatches to appropriate handler based on handle type
 * @param {{x: number, y: number, width: number, height: number}} proposed
 * @param {import('./types.js').CropArea} original
 * @param {import('./types.js').HandlePosition} handle
 * @param {string} ratio
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function applyAspectRatioToResize(proposed, original, handle, ratio) {
  const targetRatio = ASPECT_RATIOS[ratio];
  if (!targetRatio) return proposed;

  const handleType = getHandleType(handle);

  switch (handleType) {
    case 'horizontal':
      return applyRatioForHorizontalHandle(proposed, original, targetRatio);
    case 'vertical':
      return applyRatioForVerticalHandle(proposed, original, targetRatio);
    case 'corner':
      return applyRatioForCornerHandle(proposed, original, handle, targetRatio);
    default:
      return proposed;
  }
}

/**
 * Resize crop by dragging a handle
 * @param {import('./types.js').CropArea} crop - Current crop area
 * @param {import('./types.js').HandlePosition} handle - Which handle is being dragged
 * @param {{x: number, y: number}} start - Drag start position (frame coords)
 * @param {{x: number, y: number}} current - Current mouse position (frame coords)
 * @param {import('../capture/types.js').Frame} frame - Source frame for bounds
 * @returns {import('./types.js').CropArea} - Resized crop area
 */
export function resizeCropByHandle(crop, handle, start, current, frame) {
  const dx = current.x - start.x;
  const dy = current.y - start.y;

  // Get handle configuration and apply drag
  const config = HANDLE_CONFIG[handle];
  let proposed = applyHandleDrag(crop, config, dx, dy);

  // Apply aspect ratio constraint if not free
  if (crop.aspectRatio !== 'free') {
    proposed = applyAspectRatioToResize(proposed, crop, handle, crop.aspectRatio);
  }

  return clampCropArea(
    { ...proposed, aspectRatio: crop.aspectRatio },
    frame.width,
    frame.height
  );
}

/**
 * Move crop area by delta
 * @param {import('./types.js').CropArea} crop - Current crop area
 * @param {{x: number, y: number}} delta - Movement delta
 * @param {import('../capture/types.js').Frame} frame - Source frame for bounds
 * @returns {import('./types.js').CropArea} - Moved crop area
 */
export function moveCrop(crop, delta, frame) {
  return clampCropArea(
    {
      x: crop.x + delta.x,
      y: crop.y + delta.y,
      width: crop.width,
      height: crop.height,
      aspectRatio: crop.aspectRatio,
    },
    frame.width,
    frame.height
  );
}

/**
 * Detect which boundaries the crop is touching
 * @param {import('./types.js').CropArea} crop - Crop area to check
 * @param {number} frameWidth - Frame width
 * @param {number} frameHeight - Frame height
 * @returns {import('./types.js').BoundaryHit} - Which boundaries are hit
 */
export function detectBoundaryHit(crop, frameWidth, frameHeight) {
  return {
    top: crop.y <= 0,
    bottom: crop.y + crop.height >= frameHeight,
    left: crop.x <= 0,
    right: crop.x + crop.width >= frameWidth,
  };
}

// ============================================================
// Frame Grid Selection Functions
// ============================================================

/**
 * Normalize selection range ensuring start ≤ end and bounds are valid
 * @param {number | null} start - Start frame index
 * @param {number | null} end - End frame index
 * @param {number} totalFrames - Total frames in clip
 * @returns {import('./types.js').FrameRange | null} - Valid range or null if no start
 */
export function normalizeSelectionRange(start, end, totalFrames) {
  // If start is null, no valid selection
  if (start === null) return null;

  // If end is null, use start as both start and end (single frame selection)
  const effectiveEnd = end ?? start;

  // Swap if start > end
  const [min, max] = start <= effectiveEnd
    ? [start, effectiveEnd]
    : [effectiveEnd, start];

  // Clamp to valid bounds [0, totalFrames - 1]
  return {
    start: Math.max(0, Math.min(min, totalFrames - 1)),
    end: Math.max(0, Math.min(max, totalFrames - 1)),
  };
}

/**
 * Check if frame is within selection range
 * @param {number} frameIndex - Frame to check
 * @param {number | null} start - Selection start
 * @param {number | null} end - Selection end
 * @returns {boolean}
 */
export function isFrameInRange(frameIndex, start, end) {
  // If start is null, nothing is in range
  if (start === null) return false;

  // If end is null, only start frame is "in range" (single frame selection)
  const effectiveEnd = end ?? start;

  // Normalize in case start > end
  const [min, max] = start <= effectiveEnd
    ? [start, effectiveEnd]
    : [effectiveEnd, start];

  return frameIndex >= min && frameIndex <= max;
}
