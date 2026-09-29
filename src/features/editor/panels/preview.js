/**
 * Editor preview panel: base + overlay canvases and the overlay's pointer
 * interaction. Pointer priority on the overlay: (1) an AI pick tool adds a
 * Keep/Remove pick at the clicked point, (2) eyedropper mode picks the
 * background key color, (3) a text layer drawn on the current frame is
 * selected and dragged, (4) otherwise the crop interaction (clicking empty
 * space also deselects the text layer).
 * @module features/editor/panels/preview
 */

import { isComposingEvent, isEditableTarget } from '../../../shared/hotkeys.js';
import { createElement } from '../../../shared/utils/dom.js';
import { getCursorForHandle, hitTestCropHandle, renderFrameOnly, renderOverlay } from '../api.js';
import { calculateCropFromDrag, detectBoundaryHit, moveCrop, resizeCropByHandle } from '../core.js';
import {
  getOutputRegion,
  getSelectedTextOverlay,
  hitTestEditorText,
  sampleSourcePixel,
} from '../edits-preview.js';

/** Overlay name outside the pick tools */
const CROP_OVERLAY_LABEL = 'Crop overlay';

/** Overlay name while a pick tool is on (it is then keyboard-focusable) */
export const PICK_OVERLAY_LABEL =
  'Pick position. Arrow keys move the marker (Shift for bigger steps), Enter picks the character under it, Escape cancels.';

/** Marker step per arrow key press, as a fraction of the frame (Shift: big) */
export const PICK_MARKER_STEP = /** @type {const} */ ({ small: 0.02, big: 0.1 });

/**
 * Make the overlay a keyboard pick target while a pick tool is on: the
 * pointer is not the only way to place a Keep/Remove pick
 * @param {HTMLElement} overlayCanvas
 * @param {boolean} picking
 */
export function setOverlayPickMode(overlayCanvas, picking) {
  if (picking) {
    overlayCanvas.tabIndex = 0;
    overlayCanvas.setAttribute('role', 'application');
    overlayCanvas.setAttribute('aria-label', PICK_OVERLAY_LABEL);
  } else {
    overlayCanvas.removeAttribute('tabindex');
    overlayCanvas.removeAttribute('role');
    overlayCanvas.setAttribute('aria-label', CROP_OVERLAY_LABEL);
  }
}

/**
 * Crosshair of the keyboard pick marker
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - Frame pixels
 * @param {number} y - Frame pixels
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function drawPickMarker(ctx, x, y, frameWidth, frameHeight) {
  const unit = Math.max(1, Math.round(Math.max(frameWidth, frameHeight) / 400));
  const arm = 12 * unit;
  ctx.save();
  ctx.lineCap = 'round';
  for (const [color, width] of /** @type {const} */ ([
    ['rgba(0, 0, 0, 0.8)', 4 * unit],
    ['#ffffff', 2 * unit],
  ])) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, arm / 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

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
  const canvasContainer = createElement('div', {
    className: `editor-canvas-container${state.pickingKeyColor ? ' editor-bg-picking' : ''}${
      state.aiPickTool ? ' editor-ai-picking' : ''
    }`,
  });

  // AI cutout status of the current frame (e.g. not analyzed yet); filled
  // by editor/index.js
  const aiNote = createElement('p', {
    className: 'editor-ai-preview-note',
    id: 'ai-preview-note',
    role: 'status',
    hidden: 'true',
  });

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
      'aria-label': CROP_OVERLAY_LABEL,
    })
  );
  setOverlayPickMode(overlayCanvas, state.aiPickTool !== null);

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
  canvasContainer.appendChild(aiNote);
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
  /**
   * Text layer drag in progress (crop dragMode stays null meanwhile)
   * @type {{ id: string, start: { x: number, y: number }, layerX: number, layerY: number, outW: number, outH: number } | null}
   */
  let textDrag = null;
  /** Keyboard pick marker, fractions of the source frame (see onKeyDown) */
  const pickMarker = { x: 0.5, y: 0.5 };

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
      selectedText: getSelectedTextOverlay(ctx, state, frame),
    });
    if (state.aiPickTool && document.activeElement === overlayCanvas) {
      drawPickMarker(
        ctx,
        pickMarker.x * frame.width,
        pickMarker.y * frame.height,
        frame.width,
        frame.height,
      );
    }
  }

  /**
   * Keyboard picks while a pick tool is on and the overlay has focus: the
   * arrow keys move a marker (fractions of the source frame), Enter or
   * Space picks under it. The keys are claimed (preventDefault) so the
   * editor's frame-step and playback shortcuts do not also run; Escape is
   * left to the editor, which leaves the tool.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    const state = getCurrentState();
    if (!state?.aiPickTool || e.altKey || e.ctrlKey || e.metaKey || isComposingEvent(e)) return;
    const step = e.shiftKey ? PICK_MARKER_STEP.big : PICK_MARKER_STEP.small;
    const clamp = (/** @type {number} */ v) => Math.min(1, Math.max(0, v));
    switch (e.key) {
      case 'ArrowLeft':
        pickMarker.x = clamp(pickMarker.x - step);
        break;
      case 'ArrowRight':
        pickMarker.x = clamp(pickMarker.x + step);
        break;
      case 'ArrowUp':
        pickMarker.y = clamp(pickMarker.y - step);
        break;
      case 'ArrowDown':
        pickMarker.y = clamp(pickMarker.y + step);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!e.repeat) handlers.onAiPick?.({ x: pickMarker.x, y: pickMarker.y });
        return;
      default:
        return;
    }
    e.preventDefault();
    renderOverlayWithState();
  }

  /**
   * Topmost text layer on the current frame under the pointer
   * @param {{ x: number, y: number }} coords - Frame pixels
   * @returns {string | null}
   */
  function hitTestText(coords) {
    const state = getCurrentState();
    const frame = getCurrentFrame();
    const ctx = overlayCanvas.getContext('2d');
    if (!state?.edits || !frame || !ctx) return null;
    return hitTestEditorText(ctx, state, frame, coords);
  }

  /**
   * Eyedropper click: sample the SOURCE frame (not the keyed/texted
   * preview) under the pointer. An already transparent pixel has no color
   * to remove (its RGB reads as black): stay in the mode and say so.
   * @param {{ x: number, y: number }} coords
   */
  function pickKeyColor(coords) {
    const frame = getCurrentFrame();
    if (!frame) return;
    const pixel = sampleSourcePixel(frame, coords);
    if (!pixel) {
      handlers.onSetPickingKeyColor?.(false);
    } else if (pixel.transparent) {
      handlers.onPickTransparentArea?.();
    } else {
      handlers.onPickKeyColor?.(pixel.color);
    }
  }

  /**
   * Start dragging a text layer
   * @param {string} id
   * @param {{ x: number, y: number }} coords
   */
  function startTextDrag(id, coords) {
    const state = getCurrentState();
    const frame = getCurrentFrame();
    const layer = state?.edits.textLayers.find((l) => l.id === id);
    if (!state || !frame || !layer) return;
    const region = getOutputRegion(frame, state.cropArea);
    textDrag = {
      id,
      start: coords,
      layerX: layer.x,
      layerY: layer.y,
      outW: Math.max(1, region.width),
      outH: Math.max(1, region.height),
    };
    handlers.onSelectText?.(id);
    overlayCanvas.style.cursor = 'move';
  }

  /**
   * Handle mouse down
   * @param {MouseEvent} e
   */
  function onMouseDown(e) {
    e.preventDefault();
    // preventDefault keeps focus where it was; a panel field (e.g. the
    // caption being typed) would then swallow the editor shortcuts. Working
    // on the preview means the keyboard belongs to the editor again.
    const active = document.activeElement;
    if (active instanceof HTMLElement && isEditableTarget(active)) {
      active.blur();
    }
    const state = getCurrentState();
    const coords = getFrameCoords(e);

    if (state?.aiPickTool) {
      const frame = getCurrentFrame();
      if (frame?.width > 0 && frame.height > 0) {
        handlers.onAiPick?.({
          x: Math.min(1, Math.max(0, coords.x / frame.width)),
          y: Math.min(1, Math.max(0, coords.y / frame.height)),
        });
      }
      return;
    }

    if (state?.pickingKeyColor) {
      pickKeyColor(coords);
      return;
    }

    const textId = hitTestText(coords);
    if (textId) {
      startTextDrag(textId, coords);
      return;
    }
    if (state?.selectedTextId) {
      handlers.onSelectText?.(null);
    }

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

    if (textDrag) {
      e.preventDefault();
      const x = textDrag.layerX + (coords.x - textDrag.start.x) / textDrag.outW;
      const y = textDrag.layerY + (coords.y - textDrag.start.y) / textDrag.outH;
      handlers.onMoveText?.(textDrag.id, x, y);
      return;
    }

    if (!dragStart || !dragMode) {
      // Not dragging - update cursor and hover state
      // Pick tools, the eyedropper and text layers outrank the crop
      // handles (same order as onMouseDown), so no handle highlights
      // under them
      const picking = Boolean(state?.aiPickTool || state?.pickingKeyColor);
      const overEdit = picking || hitTestText(coords) !== null;
      let newHoveredHandle = null;
      if (overEdit) {
        overlayCanvas.style.cursor = picking ? 'crosshair' : 'move';
      } else if (state?.cropArea) {
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
      handlers.onCropChange(newCrop, { dragging: true });
      // Immediately render overlay with visual feedback
      renderOverlayWithState();
    }
  }

  /**
   * Handle mouse up
   * @param {MouseEvent} e
   */
  function onMouseUp(e) {
    if (textDrag) {
      textDrag = null;
      overlayCanvas.style.cursor = 'move';
      return;
    }
    const wasCropDrag = dragMode !== null;
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
    if (wasCropDrag) {
      handlers.onCropDragEnd?.();
    }
  }

  overlayCanvas.addEventListener('mousedown', onMouseDown);
  overlayCanvas.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  overlayCanvas.addEventListener('keydown', onKeyDown);
  // The marker shows only while the overlay has focus
  overlayCanvas.addEventListener('focus', renderOverlayWithState);
  overlayCanvas.addEventListener('blur', renderOverlayWithState);

  return () => {
    overlayCanvas.removeEventListener('mousedown', onMouseDown);
    overlayCanvas.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    overlayCanvas.removeEventListener('keydown', onKeyDown);
    overlayCanvas.removeEventListener('focus', renderOverlayWithState);
    overlayCanvas.removeEventListener('blur', renderOverlayWithState);
  };
}
