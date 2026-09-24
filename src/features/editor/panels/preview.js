/**
 * Editor preview panel: base + overlay canvases and crop mouse interaction
 * @module features/editor/panels/preview
 */

import { createElement } from '../../../shared/utils/dom.js';
import { getCursorForHandle, hitTestCropHandle, renderFrameOnly, renderOverlay } from '../api.js';
import { calculateCropFromDrag, detectBoundaryHit, moveCrop, resizeCropByHandle } from '../core.js';

/**
 * Render the preview panel and draw the initial frame + overlay
 * @param {import('../types.js').EditorState} state - Render-time state (initial values only)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @param {import('../../capture/types.js').Frame | undefined} frame - Frame at state.currentFrame
 * @returns {{ element: HTMLElement, baseCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement, cleanups: (() => void)[] }}
 */
export function renderEditorPreview(state, handlers, frame) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  const previewPanel = createElement('div', { className: 'editor-preview-panel' });
  const previewWrapper = createElement('div', { className: 'editor-preview-wrapper' });

  // Canvas container
  const canvasContainer = createElement('div', { className: 'editor-canvas-container' });

  // Base canvas (frame only)
  const baseCanvas = /** @type {HTMLCanvasElement} */ (
    createElement('canvas', {
      className: 'editor-canvas',
      'aria-label': 'Frame preview',
    })
  );

  // Overlay canvas (crop, grid, handles)
  const overlayCanvas = /** @type {HTMLCanvasElement} */ (
    createElement('canvas', {
      className: 'editor-canvas-overlay',
      'aria-label': 'Crop overlay',
    })
  );

  // Setup canvas rendering
  const baseCtx = baseCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');
  if (baseCtx && overlayCtx && frame) {
    // Render frame to base canvas
    renderFrameOnly(baseCtx, frame);

    // Render overlay to overlay canvas
    const hasCrop = state.cropArea !== null;
    renderOverlay(overlayCtx, state.cropArea, frame.width, frame.height, {
      showCropOverlay: hasCrop,
      showGrid: state.showGrid,
      gridDivisions: 3,
    });
  }

  // Setup crop mouse interaction on overlay canvas
  cleanups.push(setupCropInteraction(overlayCanvas, baseCanvas, handlers, frame));

  canvasContainer.appendChild(baseCanvas);
  canvasContainer.appendChild(overlayCanvas);
  previewWrapper.appendChild(canvasContainer);
  previewPanel.appendChild(previewWrapper);

  return { element: previewPanel, baseCanvas, overlayCanvas, cleanups };
}

/**
 * Setup crop mouse interaction on overlay canvas with visual feedback
 * @param {HTMLCanvasElement} overlayCanvas - Overlay canvas for interaction
 * @param {HTMLCanvasElement} baseCanvas - Base canvas for coordinate reference
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @param {import('../../capture/types.js').Frame} initialFrame
 * @returns {() => void} Cleanup function
 */
function setupCropInteraction(overlayCanvas, baseCanvas, handlers, initialFrame) {
  /** @type {import('../types.js').HandlePosition} */
  let dragMode = null;
  /** @type {{ x: number, y: number } | null} */
  let dragStart = null;
  /** @type {import('../types.js').CropArea | null} */
  let initialCrop = null;
  /** @type {import('../types.js').HandlePosition} */
  let hoveredHandle = null;
  /** @type {import('../types.js').HandlePosition} */
  let activeHandle = null;
  /** @type {import('../types.js').BoundaryHit | null} */
  let boundaryHit = null;

  // Get current state and frame via handlers (avoids stale closure)
  const getCurrentState = () => handlers.getState?.();
  const getCurrentFrame = () => handlers.getFrame?.() ?? initialFrame;

  /**
   * Get mouse coordinates relative to frame (using base canvas for coordinate reference)
   * @param {MouseEvent} e
   * @returns {{ x: number, y: number }}
   */
  function getFrameCoords(e) {
    const frame = getCurrentFrame();
    const rect = baseCanvas.getBoundingClientRect();
    const scaleX = frame.width / rect.width;
    const scaleY = frame.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }

  /**
   * Re-render the overlay canvas with current visual state
   */
  function renderOverlayWithState() {
    const state = getCurrentState();
    const frame = getCurrentFrame();
    if (!state || !frame) return;

    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;

    const crop = state.cropArea;
    const hasCrop = crop !== null;

    renderOverlay(ctx, crop, frame.width, frame.height, {
      showCropOverlay: hasCrop,
      showGrid: state.showGrid,
      gridDivisions: 3,
      hoveredHandle,
      activeHandle,
      boundaryHit,
    });
  }

  /**
   * Handle mouse down
   * @param {MouseEvent} e
   */
  function onMouseDown(e) {
    e.preventDefault();
    const state = getCurrentState();
    const coords = getFrameCoords(e);
    dragStart = coords;

    if (state?.cropArea) {
      // Check if clicking on a handle
      const handle = hitTestCropHandle(coords.x, coords.y, state.cropArea, 15);
      if (handle) {
        dragMode = handle;
        activeHandle = handle;
        initialCrop = { ...state.cropArea };
      } else {
        // Start drawing new crop
        dragMode = 'draw';
        activeHandle = 'draw';
        initialCrop = null;
      }
    } else {
      // No crop exists, start drawing
      dragMode = 'draw';
      activeHandle = 'draw';
      initialCrop = null;
    }

    overlayCanvas.style.cursor = getCursorForHandle(dragMode);
    renderOverlayWithState();
  }

  /**
   * Handle mouse move
   * @param {MouseEvent} e
   */
  function onMouseMove(e) {
    const state = getCurrentState();
    const frame = getCurrentFrame();
    const coords = getFrameCoords(e);

    if (!dragStart || !dragMode) {
      // Not dragging - update cursor and hover state
      let newHoveredHandle = null;
      if (state?.cropArea) {
        const handle = hitTestCropHandle(coords.x, coords.y, state.cropArea, 15);
        newHoveredHandle = handle;
        overlayCanvas.style.cursor = getCursorForHandle(handle || 'draw');
      } else {
        overlayCanvas.style.cursor = 'crosshair';
      }

      // Update visual feedback if hover state changed
      if (newHoveredHandle !== hoveredHandle) {
        hoveredHandle = newHoveredHandle;
        if (state?.cropArea) {
          renderOverlayWithState();
        }
      }
      return;
    }

    e.preventDefault();
    const aspectRatio = state?.selectedAspectRatio || 'free';
    let newCrop = null;

    if (dragMode === 'draw') {
      // Drawing new crop
      newCrop = calculateCropFromDrag(dragStart, coords, frame, aspectRatio);
    } else if (dragMode === 'move' && initialCrop) {
      // Moving existing crop using core moveCrop function
      const delta = { x: coords.x - dragStart.x, y: coords.y - dragStart.y };
      newCrop = moveCrop(initialCrop, delta, frame);
    } else if (initialCrop) {
      // Resizing via handle using core resizeCropByHandle function
      newCrop = resizeCropByHandle(initialCrop, dragMode, dragStart, coords, frame);
    }

    if (newCrop) {
      // Update boundary hit detection
      boundaryHit = detectBoundaryHit(newCrop, frame.width, frame.height);
      handlers.onCropChange(newCrop);
      // Immediately render overlay with visual feedback
      renderOverlayWithState();
    }
  }

  /**
   * Handle mouse up
   * @param {MouseEvent} e
   */
  function onMouseUp(e) {
    dragMode = null;
    dragStart = null;
    initialCrop = null;
    activeHandle = null;
    boundaryHit = null;

    // Reset cursor to reflect current hover state
    const state = getCurrentState();
    const coords = getFrameCoords(e);
    if (state?.cropArea) {
      const handle = hitTestCropHandle(coords.x, coords.y, state.cropArea, 15);
      hoveredHandle = handle;
      overlayCanvas.style.cursor = getCursorForHandle(handle || 'draw');
    } else {
      hoveredHandle = null;
      overlayCanvas.style.cursor = 'crosshair';
    }

    renderOverlayWithState();
  }

  overlayCanvas.addEventListener('mousedown', onMouseDown);
  overlayCanvas.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  return () => {
    overlayCanvas.removeEventListener('mousedown', onMouseDown);
    overlayCanvas.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
}
