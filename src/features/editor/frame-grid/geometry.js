/**
 * Frame Grid Geometry
 * Pure layout and virtualization math for the frame grid modal. Callers
 * measure the DOM and pass plain numbers in; nothing here touches the DOM.
 * @module features/editor/frame-grid/geometry
 */

export const GRID_GAP = 12;
export const GRID_PADDING = 4;
export const GRID_ASPECT_RATIO = 16 / 9;
export const VIRTUALIZATION_THRESHOLD = 200;
export const VIRTUAL_OVERSCAN_ROWS = 3;

/**
 * @typedef {Object} GridMetrics
 * @property {number} columns - Items per row (at least 1)
 * @property {number} cellWidth - CSS width of one item
 * @property {number} cellHeight - CSS height of one item
 * @property {number} rowStride - Vertical distance between row tops
 * @property {number} rowCount - Number of rows needed for every frame
 * @property {number} totalHeight - Full scrollable height including padding
 */

/**
 * Check whether a clip is large enough to use the virtualized layout.
 * @param {number} frameCount
 * @returns {boolean}
 */
export function shouldVirtualize(frameCount) {
  return frameCount > VIRTUALIZATION_THRESHOLD;
}

/**
 * Calculate optimal thumbnail size to fit all frames in viewport
 * @param {number} frameCount - Total number of frames
 * @param {number} containerWidth - Available width
 * @param {number} containerHeight - Available height
 * @param {number} minThumbnailSize - Quality-preset minimum thumbnail size
 * @param {number} maxThumbnailSize - Quality-preset maximum thumbnail size
 * @returns {number} - Optimal thumbnail width
 */
export function calculateOptimalThumbnailSize(
  frameCount,
  containerWidth,
  containerHeight,
  minThumbnailSize,
  maxThumbnailSize,
) {
  // Binary search for optimal size
  let low = minThumbnailSize;
  let high = maxThumbnailSize;
  // If even the minimum size cannot fit every frame, stay at the minimum.
  // Starting from the default made very large clips silently auto-fit back to
  // a larger and more memory-intensive thumbnail size.
  let optimal = minThumbnailSize;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cols = Math.floor((containerWidth + GRID_GAP) / (mid + GRID_GAP));
    if (cols < 1) {
      high = mid - 1;
      continue;
    }
    const rows = Math.ceil(frameCount / cols);
    const itemHeight = mid / GRID_ASPECT_RATIO;
    const totalHeight = rows * (itemHeight + GRID_GAP) - GRID_GAP;

    if (totalHeight <= containerHeight) {
      optimal = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return Math.max(minThumbnailSize, Math.min(optimal, maxThumbnailSize));
}

/**
 * Compute grid geometry for both CSS-grid and virtualized layouts.
 * @param {number} measuredWidth - Measured grid container width (0 when unknown)
 * @param {number} thumbnailSize - Requested minimum item width from the size slider
 * @param {number} frameCount - Total number of frames
 * @returns {GridMetrics}
 */
export function computeGridMetrics(measuredWidth, thumbnailSize, frameCount) {
  const containerWidth = Math.max(thumbnailSize + GRID_PADDING * 2, measuredWidth);
  const contentWidth = Math.max(1, containerWidth - GRID_PADDING * 2);
  const columns = Math.max(1, Math.floor((contentWidth + GRID_GAP) / (thumbnailSize + GRID_GAP)));
  const cellWidth = Math.max(1, (contentWidth - GRID_GAP * (columns - 1)) / columns);
  const cellHeight = cellWidth / GRID_ASPECT_RATIO;
  const rowStride = cellHeight + GRID_GAP;
  const rowCount = Math.ceil(frameCount / columns);
  const totalHeight =
    GRID_PADDING * 2 + rowCount * cellHeight + Math.max(0, rowCount - 1) * GRID_GAP;

  return { columns, cellWidth, cellHeight, rowStride, rowCount, totalHeight };
}

/**
 * Top offset of the row containing a frame, relative to the grid container.
 * @param {number} index
 * @param {GridMetrics} metrics
 * @returns {number}
 */
export function getItemTop(index, metrics) {
  const row = Math.floor(index / metrics.columns);
  return GRID_PADDING + row * metrics.rowStride;
}

/**
 * Absolute position and size of an item in the virtualized grid.
 * @param {number} index
 * @param {GridMetrics} metrics
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function getVirtualItemRect(index, metrics) {
  const column = index % metrics.columns;
  return {
    left: GRID_PADDING + column * (metrics.cellWidth + GRID_GAP),
    top: getItemTop(index, metrics),
    width: metrics.cellWidth,
    height: metrics.cellHeight,
  };
}

/**
 * Frame index range to materialize for the current scroll position: the
 * visible rows plus an overscan buffer on each side.
 * @param {GridMetrics} metrics
 * @param {number} scrollTop - Scroll offset of the scroll container
 * @param {number} viewportHeight - Visible height of the scroll container
 * @param {number} frameCount - Total number of frames
 * @param {number} [overscanRows]
 * @returns {{ firstIndex: number, lastIndex: number } | null} null when there are no rows
 */
export function computeVirtualWindow(
  metrics,
  scrollTop,
  viewportHeight,
  frameCount,
  overscanRows = VIRTUAL_OVERSCAN_ROWS,
) {
  if (metrics.rowCount === 0) return null;

  const firstVisibleRow = Math.min(
    metrics.rowCount - 1,
    Math.max(0, Math.floor(scrollTop / metrics.rowStride)),
  );
  const lastVisibleRow = Math.min(
    metrics.rowCount - 1,
    Math.max(firstVisibleRow, Math.ceil((scrollTop + viewportHeight) / metrics.rowStride)),
  );
  const firstRow = Math.max(0, firstVisibleRow - overscanRows);
  const lastRow = Math.min(metrics.rowCount - 1, lastVisibleRow + overscanRows);
  const firstIndex = firstRow * metrics.columns;
  const lastIndex = Math.min(frameCount - 1, (lastRow + 1) * metrics.columns - 1);

  return { firstIndex, lastIndex };
}

/**
 * Scroll offset that brings a frame's row into view in the virtualized grid.
 * `center` always recenters; `nearest` scrolls only as far as needed.
 * @param {number} index
 * @param {GridMetrics} metrics
 * @param {number} scrollTop - Current scroll offset
 * @param {number} viewportHeight - Visible height of the scroll container
 * @param {'nearest' | 'center'} block
 * @returns {number | null} New scroll offset, or null when no scroll is needed
 */
export function computeScrollTopForFrame(index, metrics, scrollTop, viewportHeight, block) {
  const itemTop = getItemTop(index, metrics);
  const itemBottom = itemTop + metrics.cellHeight;

  if (block === 'center') {
    return Math.max(0, itemTop - (viewportHeight - metrics.cellHeight) / 2);
  }
  if (itemTop < scrollTop) {
    return itemTop;
  }
  if (itemBottom > scrollTop + viewportHeight) {
    return itemBottom - viewportHeight;
  }
  return null;
}

/**
 * Frame an arrow key moves focus to, clamped to the clip. Up/Down move by one
 * row of `columns` frames.
 * @param {string} key - ArrowLeft / ArrowRight / ArrowUp / ArrowDown
 * @param {number} focusedIndex
 * @param {number} columns - Items per row
 * @param {number} frameCount
 * @returns {number} Target index (unchanged for any other key)
 */
export function getArrowKeyTarget(key, focusedIndex, columns, frameCount) {
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, focusedIndex - 1);
    case 'ArrowRight':
      return Math.min(frameCount - 1, focusedIndex + 1);
    case 'ArrowUp':
      return Math.max(0, focusedIndex - columns);
    case 'ArrowDown':
      return Math.min(frameCount - 1, focusedIndex + columns);
    default:
      return focusedIndex;
  }
}
