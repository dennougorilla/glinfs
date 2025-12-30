/**
 * Editor API - Side Effect Functions
 * @module features/editor/api
 */

/**
 * @typedef {Object} RenderOptions
 * @property {boolean} [showCropOverlay] - Show crop overlay
 * @property {boolean} [showGrid] - Show grid overlay
 * @property {number} [gridDivisions] - Grid divisions (3, 6, 9)
 * @property {string} [cropColor] - Crop overlay color
 * @property {import('./types.js').HandlePosition} [hoveredHandle] - Currently hovered handle
 * @property {import('./types.js').HandlePosition} [activeHandle] - Currently active (dragging) handle
 * @property {import('./types.js').BoundaryHit} [boundaryHit] - Boundary collision state
 */

/**
 * @typedef {Object} OverlayOptions
 * @property {boolean} [showCropOverlay] - Show crop overlay
 * @property {boolean} [showGrid] - Show grid overlay
 * @property {number} [gridDivisions] - Grid divisions (3, 6, 9)
 * @property {string} [cropColor] - Crop overlay color
 * @property {import('./types.js').HandlePosition} [hoveredHandle] - Currently hovered handle
 * @property {import('./types.js').HandlePosition} [activeHandle] - Currently active (dragging) handle
 * @property {import('./types.js').BoundaryHit} [boundaryHit] - Boundary collision state
 */

/** Handle visual size in pixels */
const HANDLE_SIZE = 8;

/** Handle hover scale factor */
const HANDLE_HOVER_SCALE = 1.15;

/** Handle active scale factor */
const HANDLE_ACTIVE_SCALE = 1.3;

/**
 * Render placeholder for missing or invalid frames
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 */
function renderFramePlaceholder(ctx, width, height) {
  const canvas = ctx.canvas;

  // Ensure canvas is sized
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // Gray background (#333)
  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, width, height);

  // White "Frame unavailable" text, centered
  ctx.fillStyle = 'white';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Frame unavailable', width / 2, height / 2);
}

/**
 * Render frame to canvas with optional overlays
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../capture/types.js').Frame} frame
 * @param {import('./types.js').CropArea | null} crop
 * @param {RenderOptions} options
 */
export function renderFrame(ctx, frame, crop, options = {}) {
  const canvas = ctx.canvas;

  // Handle missing or invalid frame
  if (!frame?.frame) {
    renderFramePlaceholder(ctx, canvas.width || 640, canvas.height || 480);
    return;
  }

  // Resize canvas if needed
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }

  // Draw VideoFrame directly to canvas
  ctx.drawImage(frame.frame, 0, 0);

  // Draw crop overlay
  if (crop && options.showCropOverlay) {
    renderCropOverlay(ctx, crop, {
      color: options.cropColor || 'rgba(77, 166, 255, 0.8)',
      hoveredHandle: options.hoveredHandle,
      activeHandle: options.activeHandle,
      boundaryHit: options.boundaryHit,
    });
  }

  // Draw grid overlay
  if (options.showGrid) {
    const divisions = options.gridDivisions || 3;
    const area = crop || { x: 0, y: 0, width: frame.width, height: frame.height };
    renderGridInArea(ctx, area, divisions);
  }
}

/**
 * @typedef {Object} CropOverlayOptions
 * @property {string} [color] - Crop overlay color
 * @property {import('./types.js').HandlePosition} [hoveredHandle] - Currently hovered handle
 * @property {import('./types.js').HandlePosition} [activeHandle] - Currently active handle
 * @property {import('./types.js').BoundaryHit} [boundaryHit] - Boundary collision state
 */

/**
 * Render a single circular handle with optional hover/active effects
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - Center X coordinate
 * @param {number} y - Center Y coordinate
 * @param {string} color - Fill color
 * @param {boolean} isHovered - Whether handle is hovered
 * @param {boolean} isActive - Whether handle is being dragged
 */
function renderHandle(ctx, x, y, color, isHovered, isActive) {
  // Calculate size based on state
  let size = HANDLE_SIZE;
  if (isActive) {
    size = HANDLE_SIZE * HANDLE_ACTIVE_SCALE;
  } else if (isHovered) {
    size = HANDLE_SIZE * HANDLE_HOVER_SCALE;
  }

  // Save context state
  ctx.save();

  // Add glow effect for hover/active states
  if (isHovered || isActive) {
    ctx.shadowColor = color;
    ctx.shadowBlur = isActive ? 12 : 8;
  }

  // Draw circular handle
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Draw white border
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Restore context state
  ctx.restore();
}

/**
 * Render boundary hit feedback (edge flash effect)
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./types.js').CropArea} crop
 * @param {import('./types.js').BoundaryHit} boundaryHit
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function renderBoundaryFeedback(ctx, crop, boundaryHit, frameWidth, frameHeight) {
  ctx.save();
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
  ctx.lineWidth = 3;

  if (boundaryHit.top && crop.y <= 0) {
    ctx.beginPath();
    ctx.moveTo(crop.x, 0);
    ctx.lineTo(crop.x + crop.width, 0);
    ctx.stroke();
  }

  if (boundaryHit.bottom && crop.y + crop.height >= frameHeight) {
    ctx.beginPath();
    ctx.moveTo(crop.x, frameHeight);
    ctx.lineTo(crop.x + crop.width, frameHeight);
    ctx.stroke();
  }

  if (boundaryHit.left && crop.x <= 0) {
    ctx.beginPath();
    ctx.moveTo(0, crop.y);
    ctx.lineTo(0, crop.y + crop.height);
    ctx.stroke();
  }

  if (boundaryHit.right && crop.x + crop.width >= frameWidth) {
    ctx.beginPath();
    ctx.moveTo(frameWidth, crop.y);
    ctx.lineTo(frameWidth, crop.y + crop.height);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Render crop overlay with handles
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./types.js').CropArea} crop
 * @param {CropOverlayOptions|string} [options] - Options or color string for backwards compat
 */
export function renderCropOverlay(ctx, crop, options = {}) {
  // Handle backwards compatibility with string color parameter
  const opts = typeof options === 'string'
    ? { color: options }
    : options;

  const color = opts.color || 'rgba(77, 166, 255, 0.8)';
  const { hoveredHandle, activeHandle, boundaryHit } = opts;
  const canvas = ctx.canvas;

  // Draw semi-transparent overlay outside crop area
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';

  // Top region
  ctx.fillRect(0, 0, canvas.width, crop.y);
  // Bottom region
  ctx.fillRect(0, crop.y + crop.height, canvas.width, canvas.height - crop.y - crop.height);
  // Left region
  ctx.fillRect(0, crop.y, crop.x, crop.height);
  // Right region
  ctx.fillRect(crop.x + crop.width, crop.y, canvas.width - crop.x - crop.width, crop.height);

  // Draw boundary feedback if hitting edges
  if (boundaryHit) {
    renderBoundaryFeedback(ctx, crop, boundaryHit, canvas.width, canvas.height);
  }

  // Draw crop border
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);

  // Handle positions with their identifiers
  const handles = [
    { id: 'top-left', x: crop.x, y: crop.y },
    { id: 'top-right', x: crop.x + crop.width, y: crop.y },
    { id: 'bottom-left', x: crop.x, y: crop.y + crop.height },
    { id: 'bottom-right', x: crop.x + crop.width, y: crop.y + crop.height },
    { id: 'top', x: crop.x + crop.width / 2, y: crop.y },
    { id: 'bottom', x: crop.x + crop.width / 2, y: crop.y + crop.height },
    { id: 'left', x: crop.x, y: crop.y + crop.height / 2 },
    { id: 'right', x: crop.x + crop.width, y: crop.y + crop.height / 2 },
  ];

  // Draw all handles
  for (const handle of handles) {
    const isHovered = hoveredHandle === handle.id;
    const isActive = activeHandle === handle.id;
    renderHandle(ctx, handle.x, handle.y, color, isHovered, isActive);
  }
}

/**
 * Render grid overlay
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} divisions - Grid divisions (3, 6, or 9)
 */
export function renderGrid(ctx, divisions = 3) {
  const canvas = ctx.canvas;
  renderGridInArea(
    ctx,
    { x: 0, y: 0, width: canvas.width, height: canvas.height },
    divisions
  );
}

/**
 * Render grid in specific area
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, width: number, height: number }} area
 * @param {number} divisions
 */
function renderGridInArea(ctx, area, divisions) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;

  const cellWidth = area.width / divisions;
  const cellHeight = area.height / divisions;

  // Vertical lines
  for (let i = 1; i < divisions; i++) {
    const x = area.x + i * cellWidth;
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.height);
    ctx.stroke();
  }

  // Horizontal lines
  for (let i = 1; i < divisions; i++) {
    const y = area.y + i * cellHeight;
    ctx.beginPath();
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.width, y);
    ctx.stroke();
  }
}

/**
 * Create a scaled canvas thumbnail from a frame
 * Uses direct VideoFrame rendering without intermediate canvas
 * @param {import('../capture/types.js').Frame} frame
 * @param {number} maxDimension - Maximum width or height (default: 80)
 * @returns {HTMLCanvasElement}
 */
export function createThumbnailCanvas(frame, maxDimension = 80) {
  // Calculate scaled dimensions maintaining aspect ratio
  const scale = Math.min(maxDimension / frame.width, maxDimension / frame.height);
  const thumbWidth = Math.round(frame.width * scale);
  const thumbHeight = Math.round(frame.height * scale);

  // Create thumbnail canvas at scaled size
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbWidth;
  thumbCanvas.height = thumbHeight;
  const thumbCtx = thumbCanvas.getContext('2d');
  if (!thumbCtx) {
    throw new Error('Failed to get thumbnail canvas context');
  }

  // Handle missing or invalid frame
  if (!frame?.frame) {
    // Gray placeholder for invalid frames
    thumbCtx.fillStyle = '#333';
    thumbCtx.fillRect(0, 0, thumbWidth, thumbHeight);
    return thumbCanvas;
  }

  // Draw VideoFrame directly with scaling (no intermediate canvas needed)
  thumbCtx.drawImage(frame.frame, 0, 0, thumbWidth, thumbHeight);

  return thumbCanvas;
}

/**
 * Get hit test result for crop handles
 * @param {number} x
 * @param {number} y
 * @param {import('./types.js').CropArea} crop
 * @param {number} handleSize
 * @returns {'top-left'|'top-right'|'bottom-left'|'bottom-right'|'top'|'bottom'|'left'|'right'|'move'|null}
 */
export function hitTestCropHandle(x, y, crop, handleSize = 10) {
  const halfHandle = handleSize / 2;

  // Check corners first
  if (
    Math.abs(x - crop.x) <= halfHandle &&
    Math.abs(y - crop.y) <= halfHandle
  ) {
    return 'top-left';
  }
  if (
    Math.abs(x - (crop.x + crop.width)) <= halfHandle &&
    Math.abs(y - crop.y) <= halfHandle
  ) {
    return 'top-right';
  }
  if (
    Math.abs(x - crop.x) <= halfHandle &&
    Math.abs(y - (crop.y + crop.height)) <= halfHandle
  ) {
    return 'bottom-left';
  }
  if (
    Math.abs(x - (crop.x + crop.width)) <= halfHandle &&
    Math.abs(y - (crop.y + crop.height)) <= halfHandle
  ) {
    return 'bottom-right';
  }

  // Check edges
  if (
    x >= crop.x &&
    x <= crop.x + crop.width &&
    Math.abs(y - crop.y) <= halfHandle
  ) {
    return 'top';
  }
  if (
    x >= crop.x &&
    x <= crop.x + crop.width &&
    Math.abs(y - (crop.y + crop.height)) <= halfHandle
  ) {
    return 'bottom';
  }
  if (
    y >= crop.y &&
    y <= crop.y + crop.height &&
    Math.abs(x - crop.x) <= halfHandle
  ) {
    return 'left';
  }
  if (
    y >= crop.y &&
    y <= crop.y + crop.height &&
    Math.abs(x - (crop.x + crop.width)) <= halfHandle
  ) {
    return 'right';
  }

  // Check inside crop area
  if (
    x >= crop.x &&
    x <= crop.x + crop.width &&
    y >= crop.y &&
    y <= crop.y + crop.height
  ) {
    return 'move';
  }

  return null;
}

/**
 * Get CSS cursor for handle position
 * @param {import('./types.js').HandlePosition} handle - Handle identifier
 * @returns {string} - CSS cursor value
 */
export function getCursorForHandle(handle) {
  switch (handle) {
    case 'top-left':
    case 'bottom-right':
      return 'nwse-resize';
    case 'top-right':
    case 'bottom-left':
      return 'nesw-resize';
    case 'top':
    case 'bottom':
      return 'ns-resize';
    case 'left':
    case 'right':
      return 'ew-resize';
    case 'move':
      return 'move';
    case 'draw':
      return 'crosshair';
    default:
      return 'crosshair';
  }
}

/**
 * Render only the frame data to base canvas (no overlays)
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../capture/types.js').Frame} frame
 */
export function renderFrameOnly(ctx, frame) {
  const canvas = ctx.canvas;

  // Handle missing or invalid frame
  if (!frame?.frame) {
    renderFramePlaceholder(ctx, canvas.width || 640, canvas.height || 480);
    return;
  }

  // Resize canvas if needed
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }

  // Draw VideoFrame directly to canvas
  ctx.drawImage(frame.frame, 0, 0);
}

/**
 * Render crop overlay and grid to overlay canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./types.js').CropArea | null} crop
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {OverlayOptions} options
 */
export function renderOverlay(ctx, crop, frameWidth, frameHeight, options = {}) {
  const canvas = ctx.canvas;

  // Resize canvas if needed
  if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
    canvas.width = frameWidth;
    canvas.height = frameHeight;
  }

  // Clear overlay
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw crop overlay
  if (crop && options.showCropOverlay) {
    renderCropOverlay(ctx, crop, {
      color: options.cropColor || 'rgba(77, 166, 255, 0.8)',
      hoveredHandle: options.hoveredHandle,
      activeHandle: options.activeHandle,
      boundaryHit: options.boundaryHit,
    });
  }

  // Draw grid
  if (options.showGrid) {
    const divisions = options.gridDivisions || 3;
    const area = crop || { x: 0, y: 0, width: frameWidth, height: frameHeight };
    renderGridInArea(ctx, area, divisions);
  }
}
