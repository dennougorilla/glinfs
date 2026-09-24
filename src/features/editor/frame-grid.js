/**
 * Frame Grid Modal Component
 * Displays all captured frames in a grid layout for visual selection of Start/End points
 * @module features/editor/frame-grid
 */

import { registerHotkey } from '../../shared/hotkeys.js';
import { createElement, on } from '../../shared/utils/dom.js';
import { getThumbnailSizes } from '../../shared/utils/quality-settings.js';
import { createGridThumbnailCache } from '../../shared/utils/thumbnail-cache.js';
import { createThumbnailCanvas } from './api.js';
import { normalizeSelectionRange } from './core.js';
import {
  calculateOptimalThumbnailSize,
  computeGridMetrics,
  computeScrollTopForFrame,
  computeVirtualWindow,
  GRID_PADDING,
  getVirtualItemRect,
  shouldVirtualize,
} from './frame-grid/geometry.js';
import {
  clampFrameIndex,
  formatSelectionInfo,
  getAffectedRangeIndices,
  getFrameSelectionState,
  isSceneSelected,
  selectByClick,
  selectEnd,
  selectSingleFrame,
  selectStart,
} from './frame-grid/selection.js';

/**
 * Copy a rendered thumbnail's pixel content into a brand-new canvas.
 *
 * An evicted row zeroes its canvas's width/height to force immediate
 * backing-store release (see `releaseThumbnail`), so the row's thumbnail is
 * cloned into the cache first. A cache hit `take()`s the entry out, so a
 * canvas is never held by both the cache and the DOM.
 * @param {HTMLCanvasElement} source
 * @returns {HTMLCanvasElement}
 */
function cloneThumbnailCanvas(source) {
  const clone = document.createElement('canvas');
  clone.width = source.width;
  clone.height = source.height;
  const ctx = clone.getContext('2d');
  if (ctx) {
    ctx.drawImage(source, 0, 0);
  }
  return clone;
}

/** Controls that must retain their native keyboard behavior inside the modal. */
const INTERACTIVE_ELEMENT_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ');

/**
 * Check whether a keyboard event came from a control with its own key semantics.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isInteractiveElement(target) {
  return target instanceof Element && target.closest(INTERACTIVE_ELEMENT_SELECTOR) !== null;
}

/**
 * Calculate the backing-store size for a thumbnail displayed at a CSS width.
 * The quality preset remains an upper bound, while high-DPI displays receive
 * enough source pixels to avoid unnecessary upscaling.
 * @param {number} displayWidth
 * @param {number} [devicePixelRatio]
 * @param {number} [maximumSize]
 * @returns {number}
 */
export function calculateThumbnailRenderSize(
  displayWidth,
  devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  maximumSize = getThumbnailSizes().gridMax,
) {
  const safeWidth = Number.isFinite(displayWidth) ? Math.max(1, displayWidth) : 1;
  const safePixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(1, devicePixelRatio) : 1;
  const safeMaximum = Number.isFinite(maximumSize) ? Math.max(1, maximumSize) : 1;
  return Math.min(safeMaximum, Math.ceil(safeWidth * safePixelRatio));
}

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
  let thumbnailSize = DEFAULT_THUMBNAIL_SIZE;
  const hasScenes = scenes.length > 0;
  let disposed = false;

  // Track previous selection for optimized updates (null initially to trigger full update)
  /** @type {number | null} */
  let prevStartFrame = null;
  /** @type {number | null} */
  let prevEndFrame = null;

  // Touch device support
  /** @type {number | null} */
  let touchTimer = null;
  /** @type {HTMLElement | null} */
  let touchPendingItem = null;
  /** @type {HTMLElement | null} */
  let touchActiveItem = null;

  /**
   * Clear touch-active state from any item
   */
  function clearTouchActive() {
    if (touchActiveItem) {
      touchActiveItem.classList.remove('touch-active');
      touchActiveItem = null;
    }
  }

  // Create backdrop
  const backdrop = createElement('div', {
    className: 'frame-grid-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'frame-grid-title',
  });

  // Create modal
  const modal = createElement('div', { className: 'frame-grid-modal' });

  // Header
  const header = createElement('div', { className: 'frame-grid-header' });

  const headerLeft = createElement('div', { className: 'frame-grid-header-left' }, [
    createElement('h2', { id: 'frame-grid-title', className: 'frame-grid-title' }, ['Frame Grid']),
  ]);

  const headerRight = createElement('div', { className: 'frame-grid-header-right' });

  // Grid size control
  const sizeControl = createElement('div', { className: 'grid-size-control' });
  const sizeLabel = createElement('span', { className: 'size-label' }, ['Grid:']);
  const sizeSlider = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      min: String(MIN_THUMBNAIL_SIZE),
      max: String(MAX_THUMBNAIL_SIZE),
      value: String(thumbnailSize),
      className: 'grid-size-slider',
    })
  );
  const sizeValue = createElement('span', { className: 'size-value' }, [`${thumbnailSize}px`]);

  sizeControl.appendChild(sizeLabel);
  sizeControl.appendChild(sizeSlider);
  sizeControl.appendChild(sizeValue);

  const closeBtn = createElement(
    'button',
    {
      className: 'frame-grid-close',
      type: 'button',
      'aria-label': 'Close',
    },
    ['\u00D7'],
  );

  headerRight.appendChild(sizeControl);
  headerRight.appendChild(closeBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  modal.appendChild(header);

  cleanups.push(on(closeBtn, 'click', () => callbacks.onCancel()));

  // Layout container (scenes panel + main content)
  const layout = createElement('div', { className: 'frame-grid-layout' });

  // Scenes panel (left sidebar) - only show if scenes exist
  /** @type {HTMLElement[]} */
  const sceneButtons = [];

  if (hasScenes) {
    const scenesPanel = createElement('div', { className: 'frame-grid-scenes-panel' });
    scenesPanel.appendChild(
      createElement('div', { className: 'frame-grid-scenes-header' }, ['Scenes']),
    );

    const scenesList = createElement('div', { className: 'frame-grid-scenes-list' });

    scenes.forEach((scene, index) => {
      const sceneBtn = createElement('button', {
        className: 'frame-grid-scene-btn',
        type: 'button',
        'data-scene-index': String(index),
        'aria-label': `Scene ${index + 1}, frames ${scene.startFrame} to ${scene.endFrame}, ${scene.endFrame - scene.startFrame + 1} frames`,
      });

      // Add thumbnail from first frame of scene
      const thumbContainer = createElement('div', { className: 'frame-grid-scene-thumb' });
      const frame = frames[scene.startFrame];
      if (frame) {
        try {
          const canvas = createThumbnailCanvas(frame, 120);
          canvas.className = 'frame-grid-scene-thumb-canvas';
          thumbContainer.appendChild(canvas);
        } catch {
          thumbContainer.appendChild(
            createElement('div', { className: 'frame-grid-scene-thumb-placeholder' }, [
              '\uD83C\uDFA5',
            ]),
          );
        }
      } else {
        thumbContainer.appendChild(
          createElement('div', { className: 'frame-grid-scene-thumb-placeholder' }, [
            '\uD83C\uDFA5',
          ]),
        );
      }
      sceneBtn.appendChild(thumbContainer);

      // Scene content (header + range)
      const sceneContent = createElement('div', { className: 'frame-grid-scene-content' }, [
        createElement('div', { className: 'frame-grid-scene-header' }, [
          createElement('span', { className: 'frame-grid-scene-num' }, [String(index + 1)]),
          createElement('span', { className: 'frame-grid-scene-frames' }, [
            `${scene.endFrame - scene.startFrame + 1}f`,
          ]),
        ]),
        createElement('div', { className: 'frame-grid-scene-range' }, [
          `${scene.startFrame} \u2192 ${scene.endFrame}`,
        ]),
      ]);
      sceneBtn.appendChild(sceneContent);

      sceneButtons.push(sceneBtn);

      // Click to select entire scene
      cleanups.push(
        on(sceneBtn, 'click', () => {
          setStartFrame(scene.startFrame);
          setEndFrame(scene.endFrame);
          // Update scene button states
          updateSceneButtonStates();
          // Scroll to scene start
          scrollToFrame(scene.startFrame, { block: 'center' });
        }),
      );

      scenesList.appendChild(sceneBtn);
    });

    scenesPanel.appendChild(scenesList);
    layout.appendChild(scenesPanel);
  }

  /**
   * Update scene button active states
   */
  function updateSceneButtonStates() {
    const selection = currentSelection();
    sceneButtons.forEach((btn, index) => {
      btn.classList.toggle('is-active', isSceneSelected(selection, scenes[index]));
    });
  }

  // Main content area
  const mainContent = createElement('div', { className: 'frame-grid-main' });

  // Body with grid
  const body = createElement('div', { className: 'frame-grid-body' });
  // tabindex="-1" makes the container a valid programmatic-focus target
  // (not a Tab stop) so eviction can safely relocate focus without leaving
  // the modal's focus trap.
  const gridContainer = createElement('div', {
    className: 'frame-grid-container',
    tabindex: '-1',
  });
  const isVirtualized = shouldVirtualize(frames.length);
  if (isVirtualized) {
    gridContainer.classList.add('is-virtualized');
  }

  // Sparse array: large clips only keep visible items materialized.
  /** @type {(HTMLElement | undefined)[]} */
  const gridItems = [];
  const materializedIndices = new Set();
  // Thumbnails of evicted virtual rows, so scrolling back reuses them instead
  // of re-rendering from the source frame (issue #76). Owned by this mount
  // and released in cleanup(), so closing the modal frees it (#72).
  const thumbnailCache = createGridThumbnailCache();
  /** @type {number | null} */
  let virtualRenderFrame = null;
  /** @type {number | null} */
  let autoFitFrame = null;

  /**
   * Get current grid geometry for both CSS-grid and virtualized layouts.
   */
  function getGridMetrics() {
    const measuredWidth =
      gridContainer.clientWidth ||
      gridContainer.offsetWidth ||
      Math.max(0, body.clientWidth - GRID_PADDING * 2);
    return computeGridMetrics(measuredWidth, thumbnailSize, frames.length);
  }

  /**
   * Release a canvas backing store immediately instead of waiting for GC.
   * @param {HTMLElement} item
   */
  function releaseThumbnail(item) {
    item.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    });
  }

  /**
   * Add a placeholder when an item does not yet have a thumbnail.
   * @param {HTMLElement} item
   */
  function ensureThumbnailPlaceholder(item) {
    if (
      !item.querySelector('canvas') &&
      !item.querySelector('.frame-grid-placeholder') &&
      !item.querySelector('.frame-grid-thumbnail-error')
    ) {
      item.insertBefore(
        createElement('div', { className: 'frame-grid-placeholder' }),
        item.firstChild,
      );
    }
  }

  /**
   * Render thumbnail for a grid item
   * @param {HTMLElement} item
   * @param {number} [displayWidthOverride] - Known CSS width for virtual items
   */
  function renderThumbnail(item, displayWidthOverride) {
    if (disposed) return;

    const index = Number.parseInt(item.dataset.index, 10);
    const frame = frames[index];
    if (!frame) return;

    const measuredWidth = displayWidthOverride ?? item.getBoundingClientRect().width;
    const displayWidth = measuredWidth > 0 ? measuredWidth : getGridMetrics().cellWidth;
    const renderSize = calculateThumbnailRenderSize(displayWidth, undefined, MAX_THUMBNAIL_SIZE);
    const existingCanvas = /** @type {HTMLCanvasElement | null} */ (item.querySelector('canvas'));
    if (existingCanvas?.dataset.renderSize === String(renderSize)) {
      return;
    }

    releaseThumbnail(item);
    item.querySelector('.frame-grid-placeholder')?.remove();
    item.querySelector('.frame-grid-thumbnail-error')?.remove();

    try {
      const canvas =
        thumbnailCache.take(frame.id, renderSize) ?? createThumbnailCanvas(frame, renderSize);
      canvas.dataset.renderSize = String(renderSize);
      item.insertBefore(canvas, item.firstChild);
    } catch {
      const errorPlaceholder = createElement(
        'div',
        {
          className: 'frame-grid-thumbnail-error',
          style:
            'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;',
        },
        ['\u26A0'],
      );
      item.insertBefore(errorPlaceholder, item.firstChild);
    }
  }

  /**
   * Create one frame item without registering per-item listeners.
   * @param {number} index
   * @returns {HTMLElement}
   */
  function createGridItem(index) {
    const item = createElement('div', {
      className: 'frame-grid-item',
      tabIndex: 0,
      'data-index': String(index),
      'aria-label': `Frame ${index + 1}`,
    });

    ensureThumbnailPlaceholder(item);
    item.appendChild(
      createElement('div', { className: 'frame-hover-actions' }, [
        createElement(
          'button',
          {
            className: 'frame-action-btn action-start',
            type: 'button',
            title: 'Set as Start',
          },
          ['S'],
        ),
        createElement(
          'button',
          {
            className: 'frame-action-btn action-end',
            type: 'button',
            title: 'Set as End',
          },
          ['E'],
        ),
      ]),
    );
    item.appendChild(
      createElement('span', { className: 'frame-grid-number' }, [String(index + 1)]),
    );
    return item;
  }

  /**
   * Position an item in the virtual grid.
   * @param {HTMLElement} item
   * @param {number} index
   * @param {ReturnType<typeof getGridMetrics>} metrics
   */
  function positionVirtualItem(item, index, metrics) {
    const rect = getVirtualItemRect(index, metrics);
    item.style.left = `${rect.left}px`;
    item.style.top = `${rect.top}px`;
    item.style.width = `${rect.width}px`;
    item.style.height = `${rect.height}px`;
  }

  /**
   * Materialize a virtual item and its thumbnail.
   * @param {number} index
   * @param {ReturnType<typeof getGridMetrics>} metrics
   */
  function materializeGridItem(index, metrics) {
    let item = gridItems[index];
    if (!item) {
      item = createGridItem(index);
      gridItems[index] = item;
      materializedIndices.add(index);
      gridContainer.appendChild(item);
      updateSingleItemVisualState(item, index);
    }

    positionVirtualItem(item, index, metrics);
    // The virtual layout already calculated this width. Passing it through
    // avoids a layout read after writing position/size for every visible cell.
    renderThumbnail(item, metrics.cellWidth);
  }

  /**
   * Remove a virtual item and release its canvas memory.
   * @param {number} index
   */
  function evictGridItem(index) {
    const item = gridItems[index];
    if (!item) return;

    if (touchPendingItem === item) {
      cancelTouchTimer();
    }
    if (touchActiveItem === item) {
      touchActiveItem = null;
    }
    // Removing a focused item drops focus to <body>, silently escaping the
    // modal's Tab trap. Relocate focus to the (non-tab-stop) grid container
    // first so it stays inside the modal.
    if (item.contains(document.activeElement)) {
      gridContainer.focus();
    }
    // Cache a copy before the row's canvas is zeroed. Caching only here (not
    // on every render) skips the pre-auto-fit size pass and never holds a
    // second copy of a thumbnail that is still on screen.
    const canvas = /** @type {HTMLCanvasElement | null} */ (item.querySelector('canvas'));
    const frame = frames[index];
    if (canvas && canvas.width > 0 && frame) {
      const renderSize = Number.parseInt(canvas.dataset.renderSize, 10);
      if (!thumbnailCache.has(frame.id, renderSize)) {
        thumbnailCache.addCanvas(frame.id, renderSize, cloneThumbnailCanvas(canvas));
      }
    }
    releaseThumbnail(item);
    item.remove();
    gridItems[index] = undefined;
    materializedIndices.delete(index);
  }

  /** Materialize visible virtual rows plus a small overscan buffer. */
  function renderVirtualWindow() {
    if (!isVirtualized || disposed) return;

    const metrics = getGridMetrics();
    gridContainer.style.height = `${metrics.totalHeight}px`;
    const visibleRange = computeVirtualWindow(
      metrics,
      body.scrollTop,
      body.clientHeight || 600,
      frames.length,
    );
    if (!visibleRange) return;
    const { firstIndex, lastIndex } = visibleRange;

    materializedIndices.forEach((index) => {
      if (index < firstIndex || index > lastIndex) {
        evictGridItem(index);
      }
    });

    for (let index = firstIndex; index <= lastIndex; index++) {
      materializeGridItem(index, metrics);
    }
  }

  /** Coalesce rapid scroll events into one virtual-window update per frame. */
  function scheduleVirtualWindowRender() {
    if (!isVirtualized || virtualRenderFrame !== null) return;

    // -1 keeps this correct even in tests where requestAnimationFrame executes synchronously.
    virtualRenderFrame = -1;
    const frameId = window.requestAnimationFrame(() => {
      virtualRenderFrame = null;
      if (disposed || !backdrop.isConnected) return;
      renderVirtualWindow();
    });
    if (virtualRenderFrame === -1) {
      virtualRenderFrame = frameId;
    }
  }

  /** Re-render loaded thumbnails after grid width or density changes. */
  function refreshMaterializedThumbnails() {
    materializedIndices.forEach((index) => {
      const item = gridItems[index];
      if (!item) return;
      if (isVirtualized || item.querySelector('canvas, .frame-grid-thumbnail-error')) {
        renderThumbnail(item);
      }
    });
  }

  // Lazy loading with IntersectionObserver (with fallback for unsupported environments)
  const supportsIntersectionObserver =
    !isVirtualized && typeof window !== 'undefined' && 'IntersectionObserver' in window;

  /** @type {IntersectionObserver | null} */
  const thumbnailObserver = supportsIntersectionObserver
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const item = /** @type {HTMLElement} */ (entry.target);

              // Render thumbnail if not already rendered
              if (!item.querySelector('canvas')) {
                renderThumbnail(item);
              }

              thumbnailObserver.unobserve(item);
            }
          });
        },
        {
          root: body, // Scroll container
          rootMargin: '200px', // Pre-load 200px before visible
        },
      )
    : null;

  // Cleanup observer on unmount (only if observer exists)
  if (thumbnailObserver) {
    cleanups.push(() => thumbnailObserver.disconnect());
  }

  if (!isVirtualized) {
    frames.forEach((_frame, index) => {
      const item = createGridItem(index);
      gridItems[index] = item;
      materializedIndices.add(index);
      gridContainer.appendChild(item);

      const isInitiallySelected = index === initialRange.start || index === initialRange.end;
      if (isInitiallySelected || !thumbnailObserver) {
        renderThumbnail(item);
      } else {
        thumbnailObserver.observe(item);
      }
    });
  }

  /** Cancel a pending long-press timer. */
  function cancelTouchTimer() {
    if (touchTimer !== null) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    touchPendingItem = null;
  }

  // Touch handlers are delegated so the listener count stays constant even
  // for non-virtualized clips near the threshold.
  cleanups.push(
    on(
      gridContainer,
      'touchstart',
      (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const item = /** @type {HTMLElement | null} */ (target?.closest('.frame-grid-item'));
        if (!item) return;

        cancelTouchTimer();
        clearTouchActive();
        touchPendingItem = item;
        touchTimer = window.setTimeout(() => {
          touchTimer = null;
          touchPendingItem = null;
          if (!item.isConnected) return;
          item.classList.add('touch-active');
          touchActiveItem = item;
        }, 400);
      },
      { passive: true },
    ),
  );
  cleanups.push(on(gridContainer, 'touchend', cancelTouchTimer));
  cleanups.push(on(gridContainer, 'touchmove', cancelTouchTimer));
  cleanups.push(on(gridContainer, 'touchcancel', cancelTouchTimer));
  cleanups.push(cancelTouchTimer);

  if (isVirtualized) {
    cleanups.push(on(body, 'scroll', scheduleVirtualWindowRender, { passive: true }));
  }

  // Delegate focus and mouse events instead of registering them per item.
  cleanups.push(
    on(gridContainer, 'focusin', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.classList.contains('frame-grid-item')) return;
      focusedFrame = Number.parseInt(/** @type {HTMLElement} */ (target).dataset.index, 10);
    }),
  );

  cleanups.push(
    on(gridContainer, 'click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const item = target.closest('.frame-grid-item');
      if (!item) return;

      const index = parseInt(item.dataset.index, 10);

      // [S] button click
      if (target.closest('.action-start')) {
        e.stopPropagation();
        setStartFrame(index);
        updateSceneButtonStates();
        return;
      }

      // [E] button click
      if (target.closest('.action-end')) {
        e.stopPropagation();
        setEndFrame(index);
        updateSceneButtonStates();
        return;
      }

      // Frame item click (shift+click support)
      const shiftKey = /** @type {MouseEvent} */ (e).shiftKey;
      handleFrameClick(index, shiftKey);
      updateSceneButtonStates();
    }),
  );

  cleanups.push(
    on(gridContainer, 'dblclick', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const item = target.closest('.frame-grid-item');
      if (!item) return;

      const index = parseInt(item.dataset.index, 10);
      handleFrameDoubleClick(index);
      updateSceneButtonStates();
    }),
  );

  body.appendChild(gridContainer);
  mainContent.appendChild(body);

  // Footer (inside mainContent)
  const footer = createElement('div', { className: 'frame-grid-footer' });

  const selectionInfo = createElement('div', { className: 'frame-grid-selection-info' });
  updateSelectionInfo();

  const actions = createElement('div', { className: 'frame-grid-actions' });

  const cancelBtn = createElement(
    'button',
    {
      className: 'frame-grid-btn frame-grid-btn-cancel',
      type: 'button',
    },
    ['Cancel'],
  );
  cleanups.push(on(cancelBtn, 'click', () => callbacks.onCancel()));

  const applyBtn = createElement(
    'button',
    {
      className: 'frame-grid-btn frame-grid-btn-apply',
      type: 'button',
      disabled: startFrame === null,
    },
    ['Apply'],
  );
  cleanups.push(on(applyBtn, 'click', handleApply));

  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  footer.appendChild(selectionInfo);
  footer.appendChild(actions);
  mainContent.appendChild(footer);

  layout.appendChild(mainContent);
  modal.appendChild(layout);

  // Initial scene button states
  updateSceneButtonStates();

  backdrop.appendChild(modal);

  // Add to container
  container.appendChild(backdrop);

  if (isVirtualized) {
    renderVirtualWindow();
  }

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
    thumbnailSize = optimalSize;
    sizeSlider.value = String(optimalSize);
    sizeValue.textContent = `${optimalSize}px`;
    updateGridSize();

    // Focus first selected item (materializing its row when virtualized).
    if (isVirtualized) {
      scrollToFrame(focusedFrame, { focus: true });
    } else {
      gridItems[focusedFrame]?.focus();
    }
  });
  if (autoFitFrame === -1) {
    autoFitFrame = autoFitFrameId;
  }

  // Slider change handler
  cleanups.push(
    on(sizeSlider, 'input', () => {
      thumbnailSize = parseInt(sizeSlider.value, 10);
      sizeValue.textContent = `${thumbnailSize}px`;
      updateGridSize();
    }),
  );

  const handleResize = () => updateGridSize();
  window.addEventListener('resize', handleResize);
  cleanups.push(() => window.removeEventListener('resize', handleResize));

  // Grid keys go through the app dispatcher in the modal scope for as long
  // as the modal is open (#102): the dispatcher skips IME keystrokes, lets
  // Cmd/Ctrl/Alt combos (Cmd+F, Alt+Arrow) reach the browser, and keeps
  // route/overlay shortcuts (Delete, 1-9, crop Escape) off the page below.
  // Shift is accepted: Shift+Enter/Space set End, Shift+Arrow navigates.
  // allowInEditable because isInteractiveElement is the grid's own, broader
  // guard; returning without handling still claims the key for the modal.
  /**
   * @param {string} key
   * @param {(e: KeyboardEvent) => void} handler
   */
  const gridHotkey = (key, handler) =>
    registerHotkey({
      key,
      modifiers: { shift: 'any' },
      scope: 'modal',
      allowInEditable: true,
      handler,
    });

  // Escape closes even from a focused control (e.g. the size slider)
  cleanups.push(
    gridHotkey('Escape', (e) => {
      e.preventDefault();
      callbacks.onCancel();
    }),
  );

  /** @param {KeyboardEvent} e */
  const isFromInteractiveControl = (e) =>
    isInteractiveElement(e.target instanceof Element ? e.target : document.activeElement);

  // Arrow key navigation
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    cleanups.push(
      gridHotkey(key, (e) => {
        if (isFromInteractiveControl(e)) return;
        e.preventDefault();
        navigateGrid(key);
      }),
    );
  }

  // Enter/Space to select
  for (const key of ['Enter', ' ']) {
    cleanups.push(
      gridHotkey(key, (e) => {
        if (isFromInteractiveControl(e)) return;
        e.preventDefault();
        handleFrameClick(focusedFrame, e.shiftKey);
      }),
    );
  }

  // Click outside to close
  cleanups.push(
    on(backdrop, 'click', (e) => {
      if (e.target === backdrop) {
        callbacks.onCancel();
      }
    }),
  );

  // Trap focus within modal
  const handleTabTrap = (e) => {
    if (e.key !== 'Tab') return;

    const focusableElements = modal.querySelectorAll(
      'button, input, [tabindex]:not([tabindex="-1"])',
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable?.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable?.focus();
      }
    }
  };
  modal.addEventListener('keydown', handleTabTrap);
  cleanups.push(() => modal.removeEventListener('keydown', handleTabTrap));

  // =========================================
  // Internal handlers
  // =========================================

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
   * Update grid template columns based on thumbnail size
   */
  function updateGridSize() {
    if (isVirtualized) {
      renderVirtualWindow();
    } else {
      gridContainer.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`;
      refreshMaterializedThumbnails();
    }
  }

  /**
   * Scroll a frame into view, materializing it first for large clips.
   * @param {number} index
   * @param {{ block?: 'nearest' | 'center', focus?: boolean }} [options]
   */
  function scrollToFrame(index, options = {}) {
    const { block = 'nearest', focus = false } = options;
    const safeIndex = clampFrameIndex(index, frames.length);

    if (!isVirtualized) {
      const item = gridItems[safeIndex];
      if (!item) return;
      if (focus) item.focus();
      item.scrollIntoView({ block, behavior: 'smooth' });
      return;
    }

    const nextScrollTop = computeScrollTopForFrame(
      safeIndex,
      getGridMetrics(),
      body.scrollTop,
      body.clientHeight || 600,
      block,
    );
    if (nextScrollTop !== null) {
      body.scrollTop = nextScrollTop;
    }

    renderVirtualWindow();
    const item = gridItems[safeIndex];
    if (focus) item?.focus();
  }

  /**
   * Navigate grid with arrow keys
   * @param {string} key
   */
  function navigateGrid(key) {
    const itemsPerRow = getGridMetrics().columns;
    let newIndex = focusedFrame;

    switch (key) {
      case 'ArrowLeft':
        newIndex = Math.max(0, focusedFrame - 1);
        break;
      case 'ArrowRight':
        newIndex = Math.min(frames.length - 1, focusedFrame + 1);
        break;
      case 'ArrowUp':
        newIndex = Math.max(0, focusedFrame - itemsPerRow);
        break;
      case 'ArrowDown':
        newIndex = Math.min(frames.length - 1, focusedFrame + itemsPerRow);
        break;
    }

    if (newIndex !== focusedFrame) {
      focusedFrame = newIndex;
      scrollToFrame(focusedFrame, { focus: true });
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
    const { isStart, isEnd, inRange, badges } = getFrameSelectionState(index, currentSelection());

    item.classList.toggle('is-start', isStart);
    item.classList.toggle('is-end', isEnd);
    item.classList.toggle('is-in-range', inRange);

    // Remove existing badges
    item.querySelectorAll('.frame-grid-badge').forEach((badge) => {
      badge.remove();
    });

    for (const { variant, label } of badges) {
      item.appendChild(
        createElement('span', { className: `frame-grid-badge ${variant}-badge` }, [label]),
      );
    }
  }

  /**
   * Update visual state of grid items (optimized: only changed items)
   */
  function updateVisualState() {
    if (isVirtualized) {
      // The visible window is bounded, so updating every materialized item is
      // cheaper than constructing sets spanning thousands of selected frames.
      materializedIndices.forEach((index) => {
        const item = gridItems[index];
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
        const item = gridItems[index];
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
    if (virtualRenderFrame !== null && virtualRenderFrame >= 0) {
      window.cancelAnimationFrame(virtualRenderFrame);
      virtualRenderFrame = null;
    }
    if (autoFitFrame !== null && autoFitFrame >= 0) {
      window.cancelAnimationFrame(autoFitFrame);
      autoFitFrame = null;
    }
    materializedIndices.forEach((index) => {
      const item = gridItems[index];
      if (item) releaseThumbnail(item);
    });
    materializedIndices.clear();
    // Scene thumbnails are outside gridItems. Release every remaining
    // backing store as well so closing the modal drops canvas memory now,
    // instead of waiting for detached DOM to be garbage-collected.
    backdrop.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    thumbnailCache.release();
    backdrop.remove();
  }

  return { cleanup };
}
