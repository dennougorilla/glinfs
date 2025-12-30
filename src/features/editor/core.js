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
 * Apply aspect ratio constraint to resize operation
 * @param {{x: number, y: number, width: number, height: number}} proposed - Proposed dimensions after resize
 * @param {import('./types.js').CropArea} original - Original crop before resize
 * @param {import('./types.js').HandlePosition} handle - Which handle is being dragged
 * @param {string} ratio - Aspect ratio to apply
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function applyAspectRatioToResize(proposed, original, handle, ratio) {
  const targetRatio = ASPECT_RATIOS[ratio];
  if (!targetRatio) return proposed;

  const isHorizontalHandle = handle === 'left' || handle === 'right';
  const isVerticalHandle = handle === 'top' || handle === 'bottom';

  let { x, y, width, height } = proposed;

  // Ensure minimum size before ratio calculation
  width = Math.max(MIN_CROP_SIZE, width);
  height = Math.max(MIN_CROP_SIZE, height);

  if (isHorizontalHandle) {
    // Width is primary axis: adjust height to match
    height = Math.round(width / targetRatio);
    const heightDiff = height - original.height;
    y = original.y - heightDiff / 2;
  } else if (isVerticalHandle) {
    // Height is primary axis: adjust width to match
    width = Math.round(height * targetRatio);
    const widthDiff = width - original.width;
    x = original.x - widthDiff / 2;
  } else {
    // Corner handle: use larger change as primary axis
    const widthChange = Math.abs(proposed.width - original.width);
    const heightChange = Math.abs(proposed.height - original.height);

    if (widthChange >= heightChange) {
      height = Math.round(width / targetRatio);
    } else {
      width = Math.round(height * targetRatio);
    }

    // Adjust position based on anchor point
    if (handle.includes('left')) {
      x = original.x + original.width - width;
    }
    if (handle.includes('top')) {
      y = original.y + original.height - height;
    }
  }

  return { x, y, width, height };
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
  let x = crop.x;
  let y = crop.y;
  let width = crop.width;
  let height = crop.height;

  switch (handle) {
    case 'top-left':
      x = crop.x + dx;
      y = crop.y + dy;
      width = crop.width - dx;
      height = crop.height - dy;
      break;
    case 'top-right':
      y = crop.y + dy;
      width = crop.width + dx;
      height = crop.height - dy;
      break;
    case 'bottom-left':
      x = crop.x + dx;
      width = crop.width - dx;
      height = crop.height + dy;
      break;
    case 'bottom-right':
      width = crop.width + dx;
      height = crop.height + dy;
      break;
    case 'top':
      y = crop.y + dy;
      height = crop.height - dy;
      break;
    case 'bottom':
      height = crop.height + dy;
      break;
    case 'left':
      x = crop.x + dx;
      width = crop.width - dx;
      break;
    case 'right':
      width = crop.width + dx;
      break;
  }

  // Apply aspect ratio constraint if not free
  if (crop.aspectRatio !== 'free') {
    const adjusted = applyAspectRatioToResize(
      { x, y, width, height },
      crop,
      handle,
      crop.aspectRatio
    );
    x = adjusted.x;
    y = adjusted.y;
    width = adjusted.width;
    height = adjusted.height;
  }

  return clampCropArea(
    { x, y, width, height, aspectRatio: crop.aspectRatio },
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
