/**
 * Frame Grid item lifecycle
 * Owns the grid's items and their thumbnails: every item is created up front
 * (with IntersectionObserver lazy thumbnails) for small clips, while large
 * clips materialize only the visible rows plus overscan and evict the rest.
 * @module features/editor/frame-grid/virtualizer
 */

import { on } from '../../../shared/utils/dom.js';
import { getThumbnailSizes } from '../../../shared/utils/quality-settings.js';
import { createGridThumbnailCache } from '../../../shared/utils/thumbnail-cache.js';
import { createThumbnailCanvas } from '../api.js';
import { createGridItem, createThumbnailErrorPlaceholder, releaseThumbnail } from './dom.js';
import {
  computeGridMetrics,
  computeScrollTopForFrame,
  computeVirtualWindow,
  GRID_PADDING,
  getVirtualItemRect,
  shouldVirtualize,
} from './geometry.js';
import { clampFrameIndex } from './selection.js';

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
 * @typedef {Object} FrameGridVirtualizer
 * @property {boolean} isVirtualized - Whether only visible rows are materialized
 * @property {(index: number) => HTMLElement | undefined} getItem - Materialized item, if any
 * @property {(fn: (index: number) => void) => void} forEachMaterialized
 * @property {() => ReturnType<typeof computeGridMetrics>} getGridMetrics
 * @property {() => void} renderVirtualWindow - Sync the virtual window to the scroll position
 * @property {(size: number) => void} setThumbnailSize - Re-layout at a new thumbnail size
 * @property {() => void} updateLayout - Re-layout at the current size (container resized)
 * @property {(index: number, options?: { block?: 'nearest' | 'center', focus?: boolean }) => void} scrollToFrame
 * @property {(index: number) => void} focusInitialFrame - Focus the opening frame after auto-fit
 * @property {() => void} dispose - Stop rendering and release every thumbnail and the cache
 */

/**
 * Create the grid's item/thumbnail manager and populate small clips.
 * @param {Object} params
 * @param {import('../../capture/types.js').Frame[]} params.frames
 * @param {HTMLElement} params.body - Scroll container
 * @param {HTMLElement} params.gridContainer - Item parent
 * @param {import('../types.js').FrameRange} params.initialRange - Rendered eagerly when not virtualized
 * @param {number} params.thumbnailSize - Initial thumbnail size (CSS px)
 * @param {number} params.maxThumbnailSize - Upper bound for thumbnail backing stores
 * @param {() => boolean} params.isMounted - Whether the modal is still in the document
 * @param {(item: HTMLElement, index: number) => void} params.onItemMaterialized - Apply selection state to a new virtual item
 * @param {(item: HTMLElement) => void} params.onItemEvicted - Drop external references before a virtual item is removed
 * @returns {FrameGridVirtualizer}
 */
export function createFrameGridVirtualizer({
  frames,
  body,
  gridContainer,
  initialRange,
  thumbnailSize: initialThumbnailSize,
  maxThumbnailSize,
  isMounted,
  onItemMaterialized,
  onItemEvicted,
}) {
  /** @type {(() => void)[]} */
  const cleanups = [];
  let thumbnailSize = initialThumbnailSize;
  let disposed = false;

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
  // and released in dispose(), so closing the modal frees it (#72).
  const thumbnailCache = createGridThumbnailCache();
  /** @type {number | null} */
  let virtualRenderFrame = null;

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
    const renderSize = calculateThumbnailRenderSize(displayWidth, undefined, maxThumbnailSize);
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
      item.insertBefore(createThumbnailErrorPlaceholder(), item.firstChild);
    }
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
      onItemMaterialized(item, index);
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

    onItemEvicted(item);
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
      if (disposed || !isMounted()) return;
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

  if (isVirtualized) {
    cleanups.push(on(body, 'scroll', scheduleVirtualWindowRender, { passive: true }));
  }

  /**
   * Update grid template columns based on thumbnail size
   */
  function updateLayout() {
    if (isVirtualized) {
      renderVirtualWindow();
    } else {
      gridContainer.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`;
      refreshMaterializedThumbnails();
    }
  }

  /**
   * Re-layout the grid at a new thumbnail size.
   * @param {number} size
   */
  function setThumbnailSize(size) {
    thumbnailSize = size;
    updateLayout();
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
   * Focus the opening frame (materializing its row when virtualized).
   * @param {number} index
   */
  function focusInitialFrame(index) {
    if (isVirtualized) {
      scrollToFrame(index, { focus: true });
    } else {
      gridItems[index]?.focus();
    }
  }

  /** Stop rendering and release every thumbnail and the per-mount cache. */
  function dispose() {
    if (disposed) return;
    disposed = true;

    cleanups.forEach((fn) => {
      fn();
    });
    if (virtualRenderFrame !== null && virtualRenderFrame >= 0) {
      window.cancelAnimationFrame(virtualRenderFrame);
      virtualRenderFrame = null;
    }
    materializedIndices.forEach((index) => {
      const item = gridItems[index];
      if (item) releaseThumbnail(item);
    });
    materializedIndices.clear();
    thumbnailCache.release();
  }

  return {
    isVirtualized,
    getItem: (index) => gridItems[index],
    forEachMaterialized: (fn) => materializedIndices.forEach(fn),
    getGridMetrics,
    renderVirtualWindow,
    setThumbnailSize,
    updateLayout,
    scrollToFrame,
    focusInitialFrame,
    dispose,
  };
}
