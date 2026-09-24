/**
 * Frame Grid Modal Component
 * Displays all captured frames in a grid layout for visual selection of Start/End points
 *
 * The modal is assembled from focused modules under `./frame-grid/`: DOM
 * construction (`dom.js`), item/thumbnail lifecycle and virtualization
 * (`virtualizer.js`), pointer/touch/keyboard input (`input.js`), plus the
 * pure geometry and selection models. This file owns the selection state and
 * wires them together.
 * @module features/editor/frame-grid
 */

import { on } from '../../shared/utils/dom.js';
import { getThumbnailSizes } from '../../shared/utils/quality-settings.js';
import { normalizeSelectionRange } from './core.js';
import { buildFrameGridShell, renderItemSelectionState } from './frame-grid/dom.js';
import { calculateOptimalThumbnailSize, getArrowKeyTarget } from './frame-grid/geometry.js';
import {
  attachGridPointer,
  attachTabTrap,
  attachTouchLongPress,
  registerGridHotkeys,
} from './frame-grid/input.js';
import {
  formatSelectionInfo,
  getAffectedRangeIndices,
  getFrameSelectionState,
  isSceneSelected,
  selectByClick,
  selectEnd,
  selectSingleFrame,
  selectStart,
} from './frame-grid/selection.js';
import { createFrameGridVirtualizer } from './frame-grid/virtualizer.js';

export { calculateThumbnailRenderSize } from './frame-grid/virtualizer.js';

/**
 * @typedef {Object} FrameGridCallbacks
 * @property {(range: import('./types.js').FrameRange) => void} onApply - Called when user clicks Apply
 * @property {() => void} onCancel - Called when user cancels (Escape, click outside, Cancel button)
 */

/**
 * Render Frame Grid Modal
 * @param {Object} params
 * @param {HTMLElement} params.container - Container to render into
 * @param {import('../capture/types.js').Frame[]} params.frames - All clip frames
 * @param {import('./types.js').FrameRange} params.initialRange - Current selection from editor
 * @param {import('../scene-detection/types.js').Scene[]} [params.scenes] - Detected scenes
 * @param {FrameGridCallbacks} params.callbacks - Event callbacks
 * @returns {{ cleanup: () => void }} - Cleanup function
 */
export function renderFrameGridModal({ container, frames, initialRange, scenes = [], callbacks }) {
  const cleanups = [];

  // Thumbnail size bounds from quality settings (device-adaptive). Read on
  // every call rather than cached at module load so a mid-session quality
  // preference change is picked up the next time the modal opens.
  const {
    gridDefault: DEFAULT_THUMBNAIL_SIZE,
    gridMin: MIN_THUMBNAIL_SIZE,
    gridMax: MAX_THUMBNAIL_SIZE,
  } = getThumbnailSizes();

  // Local state
  let startFrame = initialRange.start;
  let endFrame = initialRange.end;
  let focusedFrame = startFrame;
  let disposed = false;

  // Track previous selection for optimized updates (null initially to trigger full update)
  /** @type {number | null} */
  let prevStartFrame = null;
  /** @type {number | null} */
  let prevEndFrame = null;

  /** @type {number | null} */
  let autoFitFrame = null;

  const {
    backdrop,
    modal,
    sizeSlider,
    sizeValue,
    closeBtn,
    sceneButtons,
    body,
    gridContainer,
    selectionInfo,
    cancelBtn,
    applyBtn,
  } = buildFrameGridShell({
    frames,
    scenes,
    thumbnailSize: DEFAULT_THUMBNAIL_SIZE,
    minThumbnailSize: MIN_THUMBNAIL_SIZE,
    maxThumbnailSize: MAX_THUMBNAIL_SIZE,
    applyDisabled: startFrame === null,
  });

  cleanups.push(on(closeBtn, 'click', () => callbacks.onCancel()));

  sceneButtons.forEach((sceneBtn, index) => {
    const scene = scenes[index];
    // Click to select entire scene
    cleanups.push(
      on(sceneBtn, 'click', () => {
        setStartFrame(scene.startFrame);
        setEndFrame(scene.endFrame);
        // Update scene button states
        updateSceneButtonStates();
        // Scroll to scene start
        grid.scrollToFrame(scene.startFrame, { block: 'center' });
      }),
    );
  });

  const grid = createFrameGridVirtualizer({
    frames,
    body,
    gridContainer,
    initialRange,
    thumbnailSize: DEFAULT_THUMBNAIL_SIZE,
    maxThumbnailSize: MAX_THUMBNAIL_SIZE,
    isMounted: () => backdrop.isConnected,
    onItemMaterialized: updateSingleItemVisualState,
    onItemEvicted: (item) => touch.forgetItem(item),
  });

  const touch = attachTouchLongPress(gridContainer);
  cleanups.push(touch.cleanup);

  cleanups.push(
    attachGridPointer(gridContainer, {
      onFocusFrame: (index) => {
        focusedFrame = index;
      },
      onStartButton: (index) => {
        setStartFrame(index);
        updateSceneButtonStates();
      },
      onEndButton: (index) => {
        setEndFrame(index);
        updateSceneButtonStates();
      },
      onFrameClick: (index, shiftKey) => {
        handleFrameClick(index, shiftKey);
        updateSceneButtonStates();
      },
      onFrameDoubleClick: (index) => {
        handleFrameDoubleClick(index);
        updateSceneButtonStates();
      },
    }),
  );

  updateSelectionInfo();

  cleanups.push(on(cancelBtn, 'click', () => callbacks.onCancel()));
  cleanups.push(on(applyBtn, 'click', handleApply));

  // Initial scene button states
  updateSceneButtonStates();

  // Add to container
  container.appendChild(backdrop);

  grid.renderVirtualWindow();

  // Update visual state
  updateVisualState();

  // Auto-fit grid size after DOM is ready
  autoFitFrame = -1;
  const autoFitFrameId = window.requestAnimationFrame(() => {
    autoFitFrame = null;
    if (!backdrop.isConnected) return;

    const optimalSize = calculateOptimalThumbnailSize(
      frames.length,
      gridContainer.offsetWidth,
      body.offsetHeight - 32, // padding
      MIN_THUMBNAIL_SIZE,
      MAX_THUMBNAIL_SIZE,
    );
    sizeSlider.value = String(optimalSize);
    sizeValue.textContent = `${optimalSize}px`;
    grid.setThumbnailSize(optimalSize);

    // Focus first selected item (materializing its row when virtualized).
    grid.focusInitialFrame(focusedFrame);
  });
  if (autoFitFrame === -1) {
    autoFitFrame = autoFitFrameId;
  }

  // Slider change handler
  cleanups.push(
    on(sizeSlider, 'input', () => {
      const thumbnailSize = parseInt(sizeSlider.value, 10);
      sizeValue.textContent = `${thumbnailSize}px`;
      grid.setThumbnailSize(thumbnailSize);
    }),
  );

  const handleResize = () => grid.updateLayout();
  window.addEventListener('resize', handleResize);
  cleanups.push(() => window.removeEventListener('resize', handleResize));

  cleanups.push(
    registerGridHotkeys({
      onEscape: () => callbacks.onCancel(),
      onNavigate: navigateGrid,
      onSelect: (shiftKey) => handleFrameClick(focusedFrame, shiftKey),
    }),
  );

  // Click outside to close
  cleanups.push(
    on(backdrop, 'click', (e) => {
      if (e.target === backdrop) {
        callbacks.onCancel();
      }
    }),
  );

  cleanups.push(attachTabTrap(modal));

  // =========================================
  // Internal handlers
  // =========================================

  /**
   * Update scene button active states
   */
  function updateSceneButtonStates() {
    const selection = currentSelection();
    sceneButtons.forEach((btn, index) => {
      btn.classList.toggle('is-active', isSceneSelected(selection, scenes[index]));
    });
  }

  /**
   * Current Start/End selection as a selection-model value.
   * @returns {import('./frame-grid/selection.js').GridSelection}
   */
  function currentSelection() {
    return { start: startFrame, end: endFrame };
  }

  /**
   * Commit a selection transition, focus the acted-on frame and refresh the UI.
   * @param {import('./frame-grid/selection.js').GridSelection} next
   * @param {number} index - Frame that triggered the transition
   */
  function applySelection(next, index) {
    startFrame = next.start;
    endFrame = next.end;
    focusedFrame = index;
    updateVisualState();
    updateSelectionInfo();
  }

  /**
   * Set start frame
   * @param {number} index
   */
  function setStartFrame(index) {
    applySelection(selectStart(currentSelection(), index), index);
  }

  /**
   * Set end frame
   * @param {number} index
   */
  function setEndFrame(index) {
    applySelection(selectEnd(currentSelection(), index), index);
  }

  /**
   * Handle frame click (legacy behavior)
   * @param {number} index
   * @param {boolean} shiftKey
   */
  function handleFrameClick(index, shiftKey) {
    applySelection(selectByClick(currentSelection(), index, shiftKey), index);
  }

  /**
   * Handle double-click (single frame selection)
   * @param {number} index
   */
  function handleFrameDoubleClick(index) {
    applySelection(selectSingleFrame(index), index);
  }

  /**
   * Navigate grid with arrow keys
   * @param {string} key
   */
  function navigateGrid(key) {
    const itemsPerRow = grid.getGridMetrics().columns;
    const newIndex = getArrowKeyTarget(key, focusedFrame, itemsPerRow, frames.length);

    if (newIndex !== focusedFrame) {
      focusedFrame = newIndex;
      grid.scrollToFrame(focusedFrame, { focus: true });
    }
  }

  /**
   * Handle apply button click
   */
  function handleApply() {
    const range = normalizeSelectionRange(startFrame, endFrame, frames.length);
    if (range) {
      callbacks.onApply(range);
    }
  }

  /**
   * Update visual state of a single grid item
   * @param {HTMLElement} item
   * @param {number} index
   */
  function updateSingleItemVisualState(item, index) {
    renderItemSelectionState(item, getFrameSelectionState(index, currentSelection()));
  }

  /**
   * Update visual state of grid items (optimized: only changed items)
   */
  function updateVisualState() {
    if (grid.isVirtualized) {
      // The visible window is bounded, so updating every materialized item is
      // cheaper than constructing sets spanning thousands of selected frames.
      grid.forEachMaterialized((index) => {
        const item = grid.getItem(index);
        if (item) updateSingleItemVisualState(item, index);
      });
    } else {
      const changedIndices = getAffectedRangeIndices(
        prevStartFrame,
        prevEndFrame,
        startFrame,
        endFrame,
      );

      changedIndices.forEach((index) => {
        const item = grid.getItem(index);
        if (item) updateSingleItemVisualState(item, index);
      });
    }

    // Update tracking state
    prevStartFrame = startFrame;
    prevEndFrame = endFrame;

    // Update apply button state
    applyBtn.disabled = startFrame === null;
  }

  /**
   * Update selection info text
   */
  function updateSelectionInfo() {
    selectionInfo.textContent = formatSelectionInfo(currentSelection());
  }

  // Cleanup function
  function cleanup() {
    if (disposed) return;
    disposed = true;

    cleanups.forEach((fn) => {
      fn();
    });
    if (autoFitFrame !== null && autoFitFrame >= 0) {
      window.cancelAnimationFrame(autoFitFrame);
      autoFitFrame = null;
    }
    // Releases every grid thumbnail and the per-mount thumbnail cache.
    grid.dispose();
    // Scene thumbnails are outside the grid. Release every remaining
    // backing store as well so closing the modal drops canvas memory now,
    // instead of waiting for detached DOM to be garbage-collected.
    backdrop.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    backdrop.remove();
  }

  return { cleanup };
}
