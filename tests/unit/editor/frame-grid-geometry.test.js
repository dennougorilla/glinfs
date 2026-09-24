import { describe, expect, it } from 'vitest';
import {
  calculateOptimalThumbnailSize,
  computeGridMetrics,
  computeScrollTopForFrame,
  computeVirtualWindow,
  GRID_ASPECT_RATIO,
  GRID_GAP,
  getArrowKeyTarget,
  getItemTop,
  getVirtualItemRect,
  shouldVirtualize,
  VIRTUAL_OVERSCAN_ROWS,
  VIRTUALIZATION_THRESHOLD,
} from '../../../src/features/editor/frame-grid/geometry.js';

// 800px wide container, 120px slider value, 250 frames:
// content 792px -> 6 columns of 122px, 68.625px tall, 80.625px row stride.
const metrics = computeGridMetrics(800, 120, 250);

describe('shouldVirtualize', () => {
  it('virtualizes only above the threshold', () => {
    expect(shouldVirtualize(VIRTUALIZATION_THRESHOLD)).toBe(false);
    expect(shouldVirtualize(VIRTUALIZATION_THRESHOLD + 1)).toBe(true);
  });
});

describe('computeGridMetrics', () => {
  it('derives columns, cell size and total height from the measured width', () => {
    expect(metrics).toEqual({
      columns: 6,
      cellWidth: 122,
      cellHeight: 68.625,
      rowStride: 80.625,
      rowCount: 42,
      totalHeight: 8 + 42 * 68.625 + 41 * GRID_GAP,
    });
  });

  it('keeps cells at the 16:9 aspect ratio', () => {
    const m = computeGridMetrics(1000, 160, 10);
    expect(m.cellWidth / m.cellHeight).toBeCloseTo(GRID_ASPECT_RATIO);
  });

  it('falls back to one column of the slider width when the container is unmeasured', () => {
    const m = computeGridMetrics(0, 120, 3);
    expect(m.columns).toBe(1);
    expect(m.cellWidth).toBe(120);
    expect(m.rowCount).toBe(3);
  });

  it('has zero rows and only padding height for an empty clip', () => {
    const m = computeGridMetrics(800, 120, 0);
    expect(m.rowCount).toBe(0);
    expect(m.totalHeight).toBe(8);
  });

  it('adds columns as the slider value shrinks', () => {
    expect(computeGridMetrics(800, 80, 1).columns).toBeGreaterThan(metrics.columns);
    expect(computeGridMetrics(800, 260, 1).columns).toBeLessThan(metrics.columns);
  });
});

describe('getVirtualItemRect / getItemTop', () => {
  it('places an item by row and column inside the padding', () => {
    expect(getVirtualItemRect(0, metrics)).toEqual({
      left: 4,
      top: 4,
      width: 122,
      height: 68.625,
    });
    // index 7 -> row 1, column 1
    expect(getVirtualItemRect(7, metrics)).toEqual({
      left: 4 + 122 + GRID_GAP,
      top: 4 + 80.625,
      width: 122,
      height: 68.625,
    });
  });

  it('shares a top offset across a row', () => {
    expect(getItemTop(6, metrics)).toBe(getItemTop(11, metrics));
    expect(getItemTop(12, metrics)).toBe(getItemTop(6, metrics) + metrics.rowStride);
  });
});

describe('computeVirtualWindow', () => {
  it('materializes the visible rows plus overscan at the top', () => {
    // visible rows 0..7 -> rows 0..10 with overscan
    expect(computeVirtualWindow(metrics, 0, 500, 250)).toEqual({ firstIndex: 0, lastIndex: 65 });
  });

  it('adds overscan on both sides in the middle', () => {
    // visible rows 12..19 -> rows 9..22
    expect(computeVirtualWindow(metrics, 1000, 500, 250)).toEqual({
      firstIndex: 9 * 6,
      lastIndex: 23 * 6 - 1,
    });
  });

  it('clamps to the last frame at the end of the grid', () => {
    expect(computeVirtualWindow(metrics, 3000, 500, 250)).toEqual({
      firstIndex: (37 - VIRTUAL_OVERSCAN_ROWS) * 6,
      lastIndex: 249,
    });
    // Overscrolled past the content still yields a valid window.
    expect(computeVirtualWindow(metrics, 99_999, 500, 250)).toEqual({
      firstIndex: (41 - VIRTUAL_OVERSCAN_ROWS) * 6,
      lastIndex: 249,
    });
  });

  it('honours a custom overscan', () => {
    expect(computeVirtualWindow(metrics, 1000, 500, 250, 0)).toEqual({
      firstIndex: 12 * 6,
      lastIndex: 20 * 6 - 1,
    });
  });

  it('returns null when there are no rows', () => {
    expect(computeVirtualWindow(computeGridMetrics(800, 120, 0), 0, 500, 0)).toBeNull();
  });

  it('always covers every visible frame', () => {
    for (let scrollTop = 0; scrollTop <= metrics.totalHeight; scrollTop += 37) {
      const range = computeVirtualWindow(metrics, scrollTop, 500, 250);
      const firstVisible = Math.floor(scrollTop / metrics.rowStride) * metrics.columns;
      expect(range.firstIndex).toBeGreaterThanOrEqual(0);
      expect(range.lastIndex).toBeLessThanOrEqual(249);
      expect(range.firstIndex).toBeLessThanOrEqual(Math.min(firstVisible, 249));
      expect(range.firstIndex % metrics.columns).toBe(0);
    }
  });
});

describe('computeScrollTopForFrame', () => {
  // index 60 -> row 10: top 810.25, bottom 878.875
  it('centers the row for block "center"', () => {
    expect(computeScrollTopForFrame(60, metrics, 0, 500, 'center')).toBe(
      810.25 - (500 - 68.625) / 2,
    );
  });

  it('never centers above the top of the grid', () => {
    expect(computeScrollTopForFrame(0, metrics, 300, 500, 'center')).toBe(0);
  });

  it('aligns the row bottom when it is below the viewport', () => {
    expect(computeScrollTopForFrame(60, metrics, 0, 500, 'nearest')).toBe(878.875 - 500);
  });

  it('aligns the row top when it is above the viewport', () => {
    expect(computeScrollTopForFrame(60, metrics, 1000, 500, 'nearest')).toBe(810.25);
  });

  it('returns null when the row is already fully visible', () => {
    expect(computeScrollTopForFrame(60, metrics, 600, 500, 'nearest')).toBeNull();
  });
});

describe('calculateOptimalThumbnailSize', () => {
  /** @param {number} size @param {number} count @param {number} w */
  const heightFor = (size, count, w) => {
    const cols = Math.floor((w + GRID_GAP) / (size + GRID_GAP));
    return Math.ceil(count / cols) * (size / GRID_ASPECT_RATIO + GRID_GAP) - GRID_GAP;
  };

  it('picks the largest size that still fits every frame', () => {
    const size = calculateOptimalThumbnailSize(40, 800, 500, 80, 260);
    expect(size).toBeGreaterThan(80);
    expect(size).toBeLessThan(260);
    expect(heightFor(size, 40, 800)).toBeLessThanOrEqual(500);
    expect(heightFor(size + 1, 40, 800)).toBeGreaterThan(500);
  });

  it('caps at the maximum when a few frames fit easily', () => {
    expect(calculateOptimalThumbnailSize(2, 1200, 700, 80, 260)).toBe(260);
  });

  it('stays at the minimum when even the minimum cannot fit every frame', () => {
    expect(calculateOptimalThumbnailSize(5000, 800, 500, 80, 260)).toBe(80);
  });

  it('stays at the minimum when the container is narrower than one item', () => {
    expect(calculateOptimalThumbnailSize(10, 50, 500, 80, 260)).toBe(80);
  });
});

describe('getArrowKeyTarget', () => {
  it('moves one frame left/right and one row up/down', () => {
    expect(getArrowKeyTarget('ArrowLeft', 10, 6, 250)).toBe(9);
    expect(getArrowKeyTarget('ArrowRight', 10, 6, 250)).toBe(11);
    expect(getArrowKeyTarget('ArrowUp', 10, 6, 250)).toBe(4);
    expect(getArrowKeyTarget('ArrowDown', 10, 6, 250)).toBe(16);
  });

  it('clamps to the first and last frame', () => {
    expect(getArrowKeyTarget('ArrowLeft', 0, 6, 250)).toBe(0);
    expect(getArrowKeyTarget('ArrowUp', 3, 6, 250)).toBe(0);
    expect(getArrowKeyTarget('ArrowRight', 249, 6, 250)).toBe(249);
    expect(getArrowKeyTarget('ArrowDown', 246, 6, 250)).toBe(249);
  });

  it('leaves focus unchanged for other keys', () => {
    expect(getArrowKeyTarget('Home', 10, 6, 250)).toBe(10);
  });
});
