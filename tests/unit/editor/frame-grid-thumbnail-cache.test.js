/**
 * Regression tests for issue #76: the virtualized frame grid must route
 * thumbnail rendering through its dedicated ThumbnailCache instance so a
 * row that scrolls out of view and re-materializes reuses its
 * already-decoded thumbnail instead of paying full decode+draw cost again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/editor/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createThumbnailCanvas: vi.fn(actual.createThumbnailCanvas),
  };
});

const { createThumbnailCanvas } = await import('../../../src/features/editor/api.js');
const { renderFrameGridModal } = await import('../../../src/features/editor/frame-grid.js');
const { getGridThumbnailCache, resetThumbnailCache } = await import(
  '../../../src/shared/utils/thumbnail-cache.js'
);

const layoutProperties = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'];
const originalLayoutDescriptors = Object.fromEntries(
  layoutProperties.map((property) => [
    property,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, property),
  ]),
);
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

/**
 * @param {number} count
 */
function createFrames(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    frame: null,
    timestamp: index * 33_333,
    width: 16,
    height: 9,
  }));
}

/**
 * @param {string} frameId
 */
function renderCallCountFor(frameId) {
  return createThumbnailCanvas.mock.calls.filter((call) => call[0]?.id === frameId).length;
}

describe('Frame Grid thumbnail caching (issue #76)', () => {
  let cleanup = () => {};

  beforeEach(() => {
    resetThumbnailCache();
    createThumbnailCanvas.mockClear();
    document.body.innerHTML = '<div id="container"></div>';

    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.classList?.contains('frame-grid-container') ? 800 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return this.classList?.contains('frame-grid-container') ? 800 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('frame-grid-body') ? 500 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('frame-grid-body') ? 500 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const inlineWidth = Number.parseFloat(this.style?.width || '');
      const width = this.classList?.contains('frame-grid-item')
        ? inlineWidth || 80
        : this.classList?.contains('frame-grid-container')
          ? 800
          : 0;
      const height = width / (16 / 9);
      return /** @type {DOMRect} */ ({
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function context() {
      return /** @type {CanvasRenderingContext2D} */ ({
        canvas: this,
        fillRect: vi.fn(),
        drawImage: vi.fn(),
      });
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    vi.restoreAllMocks();

    layoutProperties.forEach((property) => {
      const descriptor = originalLayoutDescriptors[property];
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, property, descriptor);
      } else {
        delete HTMLElement.prototype[property];
      }
    });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
        writable: true,
      });
    } else {
      delete HTMLElement.prototype.scrollIntoView;
    }
    if (originalDevicePixelRatio) {
      Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatio);
    }
    document.body.innerHTML = '';
    resetThumbnailCache();
  });

  /**
   * @param {number} frameCount
   */
  function renderModal(frameCount) {
    const result = renderFrameGridModal({
      container: /** @type {HTMLElement} */ (document.querySelector('#container')),
      frames: /** @type {import('../../../src/features/capture/types.js').Frame[]} */ (
        createFrames(frameCount)
      ),
      initialRange: { start: 0, end: frameCount - 1 },
      scenes: [],
      callbacks: { onApply: vi.fn(), onCancel: vi.fn() },
    });
    cleanup = result.cleanup;
  }

  it('reuses the cached thumbnail instead of re-rendering when an evicted row re-materializes', () => {
    // Just above VIRTUALIZATION_THRESHOLD (200) — enough to exercise the
    // virtualized path without approaching the grid cache's own budget.
    renderModal(600);

    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));

    expect(document.querySelector('[data-index="0"] canvas')).not.toBeNull();
    // Mount renders row 0 once at the initial estimated size, then once more
    // after the auto-fit pass settles on the final grid density — both are
    // legitimate first renders (distinct cache keys), not a caching bug.
    const callsAfterMount = renderCallCountFor('0');
    expect(callsAfterMount).toBeGreaterThan(0);

    // Scroll just far enough that row 0's virtual window slides past it and
    // it gets evicted from the DOM — a modest, realistic scroll-back
    // distance, not a teleport across the whole 3,600-frame grid (which
    // would replace the entire materialized window and legitimately blow
    // through the shared cache's LRU budget in one jump).
    body.scrollTop = 300;
    body.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[data-index="0"]')).toBeNull();

    // Scroll back — row 0 re-materializes as a brand-new element.
    body.scrollTop = 0;
    body.dispatchEvent(new Event('scroll'));

    const rematerialized = document.querySelector('[data-index="0"] canvas');
    expect(rematerialized).not.toBeNull();
    // The thumbnail pixels came from the cache, not another decode/draw.
    expect(renderCallCountFor('0')).toBe(callsAfterMount);
  });

  it('clears cached thumbnails on resetThumbnailCache so subsequent renders re-decode', () => {
    renderModal(10);

    const canvas = /** @type {HTMLCanvasElement} */ (
      document.querySelector('[data-index="0"] canvas')
    );
    expect(canvas).not.toBeNull();
    const renderSize = Number.parseInt(canvas.dataset.renderSize, 10);
    expect(renderCallCountFor('0')).toBeGreaterThan(0);
    expect(getGridThumbnailCache().has('0', renderSize)).toBe(true);

    resetThumbnailCache();
    expect(getGridThumbnailCache().has('0', renderSize)).toBe(false);

    cleanup();
    createThumbnailCanvas.mockClear();

    renderModal(10);
    // Cache was reset, so this mount is a fresh, uncached render again.
    expect(renderCallCountFor('0')).toBeGreaterThan(0);
    const secondCanvas = /** @type {HTMLCanvasElement} */ (
      document.querySelector('[data-index="0"] canvas')
    );
    const secondRenderSize = Number.parseInt(secondCanvas.dataset.renderSize, 10);
    expect(getGridThumbnailCache().has('0', secondRenderSize)).toBe(true);
  });
});
