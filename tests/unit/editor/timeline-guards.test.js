import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClip } from '../../../src/features/editor/core.js';
import {
  renderTimeline,
  updatePlayheadPosition,
  updateTimelineRange,
} from '../../../src/features/editor/timeline.js';

/**
 * Create mock ImageData for testing
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function createMockImageData(width, height) {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

/**
 * Create a mock frame for testing
 * @param {string} id
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(100, 100)),
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

/**
 * Fake a track element's geometry since JSDOM does not perform layout.
 * @param {HTMLElement} track
 */
function mockTrackGeometry(track) {
  track.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 120,
    bottom: 40,
    width: 120,
    height: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

describe('Timeline single-frame division-by-zero guards (issue: totalFrames - 1 === 0)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;
  /** @type {HTMLElement} */
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.innerHTML = '';
  });

  it('renders finite (non-NaN/Infinity) selection and dim positions for a 1-frame clip', () => {
    const clip = createClip([createMockFrame('0')], 30);

    cleanup = renderTimeline(container, clip, 0, clip.selectedRange, {
      onRangeChange: vi.fn(),
    });

    const selectionBox = /** @type {HTMLElement} */ (container.querySelector('.tl-selection'));
    const dimLeft = /** @type {HTMLElement} */ (container.querySelector('.tl-dim--left'));
    const dimRight = /** @type {HTMLElement} */ (container.querySelector('.tl-dim--right'));

    // Exact values: jsdom's CSSOM silently DROPS invalid assignments like
    // 'NaN%', leaving '', so a not-NaN regex would pass even without the
    // divisor guard. With the guard, 0/max(1,0) = 0 everywhere.
    expect(dimLeft.style.width).toBe('0%');
    expect(dimRight.style.left).toBe('0%');
    expect(dimRight.style.width).toBe('100%');
    expect(selectionBox.style.left).toBe('0%');
    expect(selectionBox.style.width).toBe('0%');
  });

  it('produces a finite hover indicator position when hovering a 1-frame clip', () => {
    const clip = createClip([createMockFrame('0')], 30);

    cleanup = renderTimeline(container, clip, 0, clip.selectedRange, {
      onRangeChange: vi.fn(),
    });

    const track = /** @type {HTMLElement} */ (container.querySelector('.tl-track'));
    mockTrackGeometry(track);

    track.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, bubbles: true }));

    const hoverIndicator = /** @type {HTMLElement} */ (container.querySelector('.tl-hover'));
    // Frame 0 of a 1-frame clip must land at exactly 0% (guarded divisor),
    // not '' from a dropped 'NaN%' assignment
    expect(hoverIndicator.style.left).toBe('0%');
  });

  it('updateTimelineRange (exported API) guards totalFrames=1 against NaN/Infinity', () => {
    const clip = createClip([createMockFrame('0')], 30);

    cleanup = renderTimeline(container, clip, 0, clip.selectedRange, {
      onRangeChange: vi.fn(),
    });

    // Calling directly with totalFrames=1 exercises updateSelectionPositions's divisor guard.
    updateTimelineRange(container, { start: 0, end: 0 }, 1);

    const selectionBox = /** @type {HTMLElement} */ (container.querySelector('.tl-selection'));
    const dimLeft = /** @type {HTMLElement} */ (container.querySelector('.tl-dim--left'));
    const dimRight = /** @type {HTMLElement} */ (container.querySelector('.tl-dim--right'));

    expect(dimLeft.style.width).toBe('0%');
    expect(dimRight.style.left).toBe('0%');
    expect(dimRight.style.width).toBe('100%');
    expect(selectionBox.style.left).toBe('0%');
    expect(selectionBox.style.width).toBe('0%');
  });

  it('updatePlayheadPosition (exported API) stays guarded for totalFrames=1', () => {
    const clip = createClip([createMockFrame('0')], 30);

    cleanup = renderTimeline(container, clip, 0, clip.selectedRange, {
      onRangeChange: vi.fn(),
    });

    updatePlayheadPosition(container, 0, 1);

    const playhead = /** @type {HTMLElement} */ (container.querySelector('.tl-playhead'));
    expect(playhead.style.left).toBe('0%');
  });
});
