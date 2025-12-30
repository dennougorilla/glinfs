/**
 * Editor UI Components - Professional Layout
 * @module features/editor/ui
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { frameToTimecode, formatDurationPrecise } from '../../shared/utils/format.js';
import { navigate } from '../../shared/router.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';
import { calculateSelection, calculateSelectionInfo, getOutputDimensions, calculateCropFromDrag, clampCropArea, resizeCropByHandle, moveCrop, detectBoundaryHit } from './core.js';
import { renderFrameOnly, renderOverlay, hitTestCropHandle, getCursorForHandle } from './api.js';
import { renderFrameGridModal } from './frame-grid.js';

/**
 * Create SVG scissors icon for editor empty state
 * @returns {SVGElement}
 */
function createScissorsIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = `
    <circle cx="6" cy="6" r="3"/>
    <circle cx="6" cy="18" r="3"/>
    <line x1="20" y1="4" x2="8.12" y2="15.88"/>
    <line x1="14.47" y1="14.48" x2="20" y2="20"/>
    <line x1="8.12" y1="8.12" x2="12" y2="12"/>
  `;
  return svg;
}

/**
 * @typedef {Object} EditorUIHandlers
 * @property {() => void} onTogglePlay - Toggle playback
 * @property {(frame: number) => void} onFrameChange - Frame changed
 * @property {(range: import('./types.js').FrameRange) => void} onRangeChange - Range changed
 * @property {(crop: import('./types.js').CropArea | null) => void} onCropChange - Crop changed
 * @property {() => void} onToggleGrid - Toggle grid
 * @property {(ratio: string) => void} onAspectRatioChange - Aspect ratio changed
 * @property {(speed: number) => void} onSpeedChange - Speed changed
 * @property {() => void} onExport - Export clicked
 * @property {() => import('./types.js').EditorState} [getState] - Get current state
 * @property {() => import('../capture/types.js').Frame} [getFrame] - Get current frame
 */

/** @type {string[]} */
const ASPECT_RATIOS = ['free', '1:1', '16:9', '4:3', '9:16'];

/** @type {number[]} */
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/**
 * Render the editor screen
 * @param {HTMLElement} container
 * @param {import('./types.js').EditorState} state
 * @param {EditorUIHandlers} handlers
 * @param {number} fps
 * @returns {{ cleanup: () => void, baseCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement }}
 */
export function renderEditorScreen(container, state, handlers, fps) {
  const cleanups = [];

  // Update step indicator
  updateStepIndicator('editor');

  if (!state.clip || state.clip.frames.length === 0) {
    const backBtn = createElement('button', {
      className: 'btn btn-primary',
      type: 'button',
    }, ['\u2190 Back to Capture']);

    const cleanupBackBtn = on(backBtn, 'click', () => navigate('/capture'));

    container.innerHTML = '';
    container.appendChild(
      createElement('div', { className: 'editor-screen screen' }, [
        createElement('div', { className: 'editor-content' }, [
          createElement('div', { className: 'editor-preview-panel' }, [
            createElement('div', { className: 'editor-preview-wrapper' }, [
              createElement('div', { className: 'empty-state editor-empty' }, [
                createElement('div', { className: 'empty-state-icon' }, [
                  createScissorsIcon(),
                ]),
                createElement('h2', { className: 'empty-state-title' }, ['No Clip to Edit']),
                createElement('p', { className: 'empty-state-description' }, [
                  'Capture some content first, then come back to trim and crop your clip.',
                ]),
                createElement('div', { className: 'empty-state-actions' }, [
                  backBtn,
                ]),
              ]),
            ]),
          ]),
        ]),
      ])
    );
    return { cleanup: () => cleanupBackBtn(), canvas: document.createElement('canvas') };
  }

  const frame = state.clip.frames[state.currentFrame];
  const selection = calculateSelection(state.selectedRange, fps);
  const dimensions = getOutputDimensions(state.cropArea, frame);
  const totalFrames = state.clip.frames.length;

  // Main layout
  const screen = createElement('div', { className: 'editor-screen screen' });

  // Toolbar
  const toolbar = createElement('div', { className: 'editor-toolbar' });

  // Toolbar left - Back button
  const toolbarLeft = createElement('div', { className: 'editor-toolbar-left' }, [
    createElement(
      'button',
      {
        className: 'btn btn-ghost',
        type: 'button',
        'aria-label': 'Back to capture',
      },
      ['\u2190 Capture']
    ),
  ]);
  cleanups.push(
    on(toolbarLeft.querySelector('button'), 'click', () => navigate('/capture'))
  );

  // Toolbar center - Playback controls
  const playbackControls = createElement('div', { className: 'playback-controls' });

  // First frame
  const firstBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Go to first frame',
      title: 'First frame (Home)',
    },
    ['\u23EE']
  );
  cleanups.push(
    on(firstBtn, 'click', () => handlers.onFrameChange(state.selectedRange.start))
  );
  playbackControls.appendChild(firstBtn);

  // Previous frame
  const prevBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Previous frame',
      title: 'Previous frame (\u2190)',
    },
    ['\u23F4']
  );
  cleanups.push(on(prevBtn, 'click', () => handlers.onFrameChange(state.currentFrame - 1)));
  playbackControls.appendChild(prevBtn);

  // Play/Pause
  const playBtn = createElement(
    'button',
    {
      className: `btn-play ${state.isPlaying ? 'playing' : ''}`,
      type: 'button',
      'aria-label': state.isPlaying ? 'Pause' : 'Play',
      title: 'Play/Pause (Space)',
    },
    [state.isPlaying ? '\u23F8' : '\u25B6']
  );
  cleanups.push(on(playBtn, 'click', () => handlers.onTogglePlay()));
  playbackControls.appendChild(playBtn);

  // Next frame
  const nextBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Next frame',
      title: 'Next frame (\u2192)',
    },
    ['\u23F5']
  );
  cleanups.push(on(nextBtn, 'click', () => handlers.onFrameChange(state.currentFrame + 1)));
  playbackControls.appendChild(nextBtn);

  // Last frame
  const lastBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Go to last frame',
      title: 'Last frame (End)',
    },
    ['\u23ED']
  );
  cleanups.push(
    on(lastBtn, 'click', () => handlers.onFrameChange(state.selectedRange.end))
  );
  playbackControls.appendChild(lastBtn);

  // Frame Grid button and modal state
  /** @type {(() => void) | null} */
  let frameGridCleanup = null;

  /**
   * Open frame grid modal
   */
  function handleOpenFrameGrid() {
    if (state.clip && state.clip.frames.length > 0 && !frameGridCleanup) {
      frameGridCleanup = openFrameGridModal(container, state, handlers, () => {
        frameGridCleanup = null;
      });
    }
  }

  // Track cleanup for modal when editor closes
  cleanups.push(() => {
    if (frameGridCleanup) {
      frameGridCleanup();
      frameGridCleanup = null;
    }
  });

  // Time display - show current position within selection range
  const selectionFrameCount = state.selectedRange.end - state.selectedRange.start + 1;
  const currentInSelection = Math.max(
    0,
    Math.min(state.currentFrame - state.selectedRange.start, selectionFrameCount - 1)
  );
  const timeDisplay = createElement('div', { className: 'time-display' }, [
    createElement('span', { className: 'current' }, [
      frameToTimecode(currentInSelection, fps),
    ]),
    createElement('span', { className: 'separator' }, [' / ']),
    createElement('span', {}, [frameToTimecode(selectionFrameCount, fps)]),
  ]);
  playbackControls.appendChild(timeDisplay);

  // Toolbar right - Export button
  const toolbarRight = createElement('div', { className: 'editor-toolbar-right' });
  const exportBtn = createElement(
    'button',
    {
      className: 'btn btn-primary',
      type: 'button',
      'aria-label': 'Export as GIF',
    },
    ['Export \u2192']
  );
  cleanups.push(
    on(exportBtn, 'click', () => {
      handlers.onExport();
      navigate('/export');
    })
  );
  toolbarRight.appendChild(exportBtn);

  toolbar.appendChild(toolbarLeft);
  toolbar.appendChild(playbackControls);
  toolbar.appendChild(toolbarRight);
  screen.appendChild(toolbar);

  // Content area (preview + sidebar)
  const content = createElement('div', { className: 'editor-content' });

  // Preview Panel
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
  content.appendChild(previewPanel);

  // Sidebar
  const sidebar = createElement('div', { className: 'editor-sidebar' });

  // Panel content (tabs removed - all controls shown together for simplicity)
  const panelContent = createElement('div', { className: 'panel-content' });

  // Speed control
  const speedGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Playback']),
    createElement('div', { className: 'property-row' }, [
      createElement('span', { className: 'property-label' }, ['Speed']),
    ]),
  ]);
  const speedSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      {},
      PLAYBACK_SPEEDS.map((speed) =>
        createElement('option', { value: String(speed) }, [`${speed}x`])
      )
    )
  );
  speedSelect.value = String(state.playbackSpeed);
  cleanups.push(
    on(speedSelect, 'change', () => handlers.onSpeedChange(Number(speedSelect.value)))
  );
  speedGroup.querySelector('.property-row').appendChild(speedSelect);
  panelContent.appendChild(speedGroup);

  // Crop/Aspect ratio controls
  const cropGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Aspect Ratio']),
  ]);
  const ratioButtons = createElement('div', { className: 'aspect-ratio-buttons' });
  ASPECT_RATIOS.forEach((ratio) => {
    const btn = createElement(
      'button',
      {
        className: `aspect-btn ${(state.selectedAspectRatio || 'free') === ratio ? 'active' : ''}`,
        type: 'button',
      },
      [ratio === 'free' ? 'Free' : ratio]
    );
    cleanups.push(on(btn, 'click', () => handlers.onAspectRatioChange(ratio)));
    ratioButtons.appendChild(btn);
  });
  cropGroup.appendChild(ratioButtons);
  panelContent.appendChild(cropGroup);

  // Grid toggle
  const gridGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Overlay']),
    createElement('div', { className: 'property-row' }, [
      createElement('span', { className: 'property-label' }, ['Show Grid']),
    ]),
  ]);
  const gridBtn = createElement(
    'button',
    {
      className: `btn btn-secondary ${state.showGrid ? 'active' : ''}`,
      type: 'button',
      'aria-pressed': String(state.showGrid),
    },
    [state.showGrid ? 'On' : 'Off']
  );
  cleanups.push(on(gridBtn, 'click', () => handlers.onToggleGrid()));
  gridGroup.querySelector('.property-row').appendChild(gridBtn);
  panelContent.appendChild(gridGroup);

  // Clear crop button
  if (state.cropArea) {
    const clearBtn = createElement(
      'button',
      {
        className: 'btn btn-secondary',
        type: 'button',
        style: 'width: 100%; margin-top: var(--space-4);',
      },
      ['Clear Crop']
    );
    cleanups.push(on(clearBtn, 'click', () => handlers.onCropChange(null)));
    panelContent.appendChild(clearBtn);
  }

  sidebar.appendChild(panelContent);
  content.appendChild(sidebar);
  screen.appendChild(content);

  // Timeline section
  const timelineSection = createElement('div', { className: 'editor-timeline' });

  // Calculate selection info using the new utility function
  const selectionInfo = calculateSelectionInfo(state.selectedRange, fps);
  const inPoint = frameToTimecode(state.selectedRange.start, fps);
  const outPoint = frameToTimecode(state.selectedRange.end, fps);

  // Frame Grid button for timeline header
  const frameGridBtn = createElement('button', {
    className: 'btn-frame-grid-compact',
    type: 'button',
    'aria-label': 'Open frame grid for selection',
    title: 'Frame Grid (F)',
  }, ['Open Grid']);
  cleanups.push(on(frameGridBtn, 'click', handleOpenFrameGrid));

  timelineSection.appendChild(
    createElement('div', { className: 'timeline-header' }, [
      createElement('div', { className: 'timeline-header-left' }, [
        createElement('span', { className: 'timeline-title' }, ['Clip Range']),
        frameGridBtn,
      ]),
      createElement('div', { className: 'timeline-info' }, [
        createElement('span', { className: 'timeline-point' }, [
          createElement('span', { className: 'label' }, ['IN']),
          createElement('span', { className: 'value timeline-in-value' }, [inPoint]),
        ]),
        createElement('span', { className: 'timeline-point' }, [
          createElement('span', { className: 'label' }, ['OUT']),
          createElement('span', { className: 'value timeline-out-value' }, [outPoint]),
        ]),
        // Selection info using calculateSelectionInfo formatted values
        createElement('span', { className: 'timeline-point timeline-selection-info' }, [
          createElement('span', { className: 'label' }, ['SEL']),
          createElement('span', { className: 'value timeline-sel-value' }, [selectionInfo.formattedDuration]),
          createElement('span', { className: 'frames timeline-sel-frames' }, [`(${selectionInfo.formattedFrameCount})`]),
        ]),
      ]),
    ])
  );

  // Timeline container - rendered by timeline.js with thumbnails
  const timelineContainer = createElement('div', { className: 'editor-timeline-container' });
  timelineSection.appendChild(timelineContainer);
  screen.appendChild(timelineSection);

  // Status bar
  screen.appendChild(
    createElement('div', { className: 'editor-status-bar' }, [
      createElement('div', { className: 'status-section' }, [
        createElement('div', { className: 'shortcuts-hint' }, [
          createElement('span', { className: 'shortcut' }, [
            createElement('span', { className: 'kbd' }, ['Space']),
            ' Play',
          ]),
          createElement('span', { className: 'shortcut' }, [
            createElement('span', { className: 'kbd' }, ['\u2190\u2192']),
            ' Frames',
          ]),
          createElement('span', { className: 'shortcut' }, [
            createElement('span', { className: 'kbd' }, ['F']),
            ' Frame Grid',
          ]),
          createElement('span', { className: 'shortcut' }, [
            createElement('span', { className: 'kbd' }, ['G']),
            ' Grid',
          ]),
        ]),
      ]),
      createElement('div', { className: 'status-section' }, [
        createElement('div', { className: 'status-item' }, [
          'Output: ',
          createElement('span', { className: 'value' }, [
            `${dimensions.width}\u00D7${dimensions.height}`,
          ]),
        ]),
      ]),
    ])
  );

  container.innerHTML = '';
  container.appendChild(screen);

  // Setup keyboard shortcuts
  cleanups.push(setupKeyboardShortcuts(handlers, state, { onOpenFrameGrid: handleOpenFrameGrid }));

  return {
    cleanup: () => cleanups.forEach((fn) => fn()),
    baseCanvas,
    overlayCanvas,
  };
}


/**
 * Setup keyboard shortcuts
 * @param {EditorUIHandlers} handlers
 * @param {import('./types.js').EditorState} state
 * @param {{ onOpenFrameGrid?: () => void }} [options]
 * @returns {() => void} Cleanup function
 */
function setupKeyboardShortcuts(handlers, state, options = {}) {
  const onKeyDown = (e) => {
    // Don't handle if focused on form element
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLSelectElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        handlers.onTogglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        handlers.onFrameChange(state.currentFrame - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        handlers.onFrameChange(state.currentFrame + 1);
        break;
      case 'Home':
        e.preventDefault();
        handlers.onFrameChange(state.selectedRange.start);
        break;
      case 'End':
        e.preventDefault();
        handlers.onFrameChange(state.selectedRange.end);
        break;
      case 'g':
      case 'G':
        e.preventDefault();
        handlers.onToggleGrid();
        break;
      case 'Escape':
        e.preventDefault();
        handlers.onCropChange(null);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        options.onOpenFrameGrid?.();
        break;
      case 'e':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          handlers.onExport();
          navigate('/export');
        }
        break;
    }
  };

  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}

/**
 * Update base canvas with new frame only (no overlays)
 * @param {HTMLCanvasElement} canvas
 * @param {import('../capture/types.js').Frame} frame
 */
export function updateBaseCanvas(canvas, frame) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  renderFrameOnly(ctx, frame);
}

/**
 * Update overlay canvas with crop and grid
 * @param {HTMLCanvasElement} canvas
 * @param {import('./types.js').CropArea | null} crop
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {boolean} showGrid
 */
export function updateOverlayCanvas(canvas, crop, frameWidth, frameHeight, showGrid) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const hasCrop = crop !== null;
  renderOverlay(ctx, crop, frameWidth, frameHeight, {
    showCropOverlay: hasCrop,
    showGrid,
    gridDivisions: 3,
  });
}

/**
 * Setup crop mouse interaction on overlay canvas with visual feedback
 * @param {HTMLCanvasElement} overlayCanvas - Overlay canvas for interaction
 * @param {HTMLCanvasElement} baseCanvas - Base canvas for coordinate reference
 * @param {EditorUIHandlers} handlers
 * @param {import('../capture/types.js').Frame} initialFrame
 * @returns {() => void} Cleanup function
 */
function setupCropInteraction(overlayCanvas, baseCanvas, handlers, initialFrame) {
  /** @type {import('./types.js').HandlePosition} */
  let dragMode = null;
  /** @type {{ x: number, y: number } | null} */
  let dragStart = null;
  /** @type {import('./types.js').CropArea | null} */
  let initialCrop = null;
  /** @type {import('./types.js').HandlePosition} */
  let hoveredHandle = null;
  /** @type {import('./types.js').HandlePosition} */
  let activeHandle = null;
  /** @type {import('./types.js').BoundaryHit | null} */
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

/**
 * Update timeline header info (SEL, IN, OUT, FRAME)
 * Called when selection range or current frame changes
 * @param {HTMLElement} container - The editor screen container
 * @param {import('./types.js').FrameRange} selectedRange - Current selection range
 * @param {number} currentFrame - Current playhead position
 * @param {number} fps - Frames per second
 */
export function updateTimelineHeader(container, selectedRange, currentFrame, fps) {
  const selectionInfo = calculateSelectionInfo(selectedRange, fps);
  const inPoint = frameToTimecode(selectedRange.start, fps);
  const outPoint = frameToTimecode(selectedRange.end, fps);

  // Update IN value
  const inEl = container.querySelector('.timeline-in-value');
  if (inEl) inEl.textContent = inPoint;

  // Update OUT value
  const outEl = container.querySelector('.timeline-out-value');
  if (outEl) outEl.textContent = outPoint;

  // Update SEL value
  const selEl = container.querySelector('.timeline-sel-value');
  if (selEl) selEl.textContent = selectionInfo.formattedDuration;

  // Update SEL frames count
  const selFramesEl = container.querySelector('.timeline-sel-frames');
  if (selFramesEl) selFramesEl.textContent = `(${selectionInfo.formattedFrameCount})`;
}

/**
 * Open Frame Grid Modal
 * @param {HTMLElement} container - Container to render modal into
 * @param {import('./types.js').EditorState} state - Current editor state
 * @param {EditorUIHandlers} handlers - UI handlers
 * @param {() => void} [onClose] - Callback when modal closes
 * @returns {() => void} Cleanup function
 */
function openFrameGridModal(container, state, handlers, onClose) {
  if (!state.clip) return () => {};

  const { cleanup } = renderFrameGridModal({
    container: document.body,
    frames: state.clip.frames,
    initialRange: state.selectedRange,
    callbacks: {
      onApply: (range) => {
        handlers.onRangeChange(range);
        cleanup();
        onClose?.();
      },
      onCancel: () => {
        cleanup();
        onClose?.();
      },
    },
  });

  return cleanup;
}
