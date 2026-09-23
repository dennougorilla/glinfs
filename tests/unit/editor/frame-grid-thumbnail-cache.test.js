/**
 * Regression tests for issue #76: the virtualized frame grid must route
 * thumbnail rendering through its per-mount ThumbnailCache so a row that
 * scrolls out of view and re-materializes reuses its already-decoded
 * thumbnail instead of paying full decode+draw cost again — and the cache
 * must be released when the modal closes (#72).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every grid cache created by a mount, in creation order. */
const gridCaches = vi.hoisted(() => []);

vi.mock('../../../src/shared/utils/thumbnail-cache.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createGridThumbnailCache: vi.fn(() => {
      const cache = actual.createGridThumbnailCache();
      gridCaches.push(cache);
      return cache;
    }),
  };
});

vi.mock('../../../src/features/editor/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createThumbnailCanvas: vi.fn(actual.createThumbnailCanvas),
  };
});

const { createThumbnailCanvas } = await import('../../../src/features/editor/api.js');
const { renderFrameGridModal } = await import('../../../src/features/editor/frame-grid.js');

/** @returns {import('../../../src/shared/utils/thumbnail-cache.js').ThumbnailCache} */
function latestGridCache() {
  return gridCaches[gridCaches.length - 1];
}

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
    gridCaches.length = 0;
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

  /**
   * Scroll far enough that row 0 is evicted from the virtual window.
   * @returns {HTMLElement}
   */
  function scrollRowZeroOut() {
    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));
    body.scrollTop = 300;
    body.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[data-index="0"]')).toBeNull();
    return body;
  }

  /** @returns {HTMLCanvasElement} */
  function rowZeroCanvas() {
    return /** @type {HTMLCanvasElement} */ (document.querySelector('[data-index="0"] canvas'));
  }

  it('reuses the cached thumbnail instead of re-rendering when an evicted row re-materializes', () => {
    // Just above VIRTUALIZATION_THRESHOLD (200) — enough to exercise the
    // virtualized path without approaching the grid cache's own budget.
    renderModal(600);
    const cache = latestGridCache();

    expect(rowZeroCanvas()).not.toBeNull();
    const renderSize = Number.parseInt(rowZeroCanvas().dataset.renderSize, 10);
    // Mount renders row 0 at the initial estimated size, then again after the
    // auto-fit pass. Only evicted rows are cached, so nothing on screen (and
    // nothing from the pre-auto-fit pass) is held twice.
    const callsAfterMount = renderCallCountFor('0');
    expect(callsAfterMount).toBeGreaterThan(0);
    expect(cache.size).toBe(0);

    // A modest, realistic scroll-back distance.
    const body = scrollRowZeroOut();
    const cached = cache.get('0', renderSize);
    expect(cached).not.toBeNull();
    // The cached copy survives the row's canvas being zeroed on eviction.
    expect(cached.width).toBeGreaterThan(0);
    expect(cached.height).toBeGreaterThan(0);

    // Scroll back — row 0 re-materializes as a brand-new element.
    body.scrollTop = 0;
    body.dispatchEvent(new Event('scroll'));

    const rematerialized = rowZeroCanvas();
    expect(rematerialized).not.toBeNull();
    // The DOM gets a clone, never the cache entry itself.
    expect(rematerialized).not.toBe(cached);
    expect(rematerialized.width).toBe(cached.width);
    // The thumbnail pixels came from the cache, not another decode/draw.
    expect(renderCallCountFor('0')).toBe(callsAfterMount);

    // Evicting the clone again must not zero the cache entry.
    scrollRowZeroOut();
    expect(cache.get('0', renderSize)).toBe(cached);
    expect(cached.width).toBeGreaterThan(0);
  });

  it('releases every cached thumbnail when the modal closes', () => {
    renderModal(600);
    const cache = latestGridCache();
    scrollRowZeroOut();

    const cachedCanvases = [...cache.cache.values()];
    expect(cachedCanvases.length).toBeGreaterThan(0);
    expect(cache.bytes).toBeGreaterThan(0);

    cleanup();

    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    cachedCanvases.forEach((canvas) => {
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    });
  });

  it('gives each mount its own cache, so a reopened grid re-renders', () => {
    renderModal(600);
    scrollRowZeroOut();
    cleanup();
    createThumbnailCanvas.mockClear();

    renderModal(600);
    expect(gridCaches).toHaveLength(2);
    expect(latestGridCache()).not.toBe(gridCaches[0]);
    expect(latestGridCache().size).toBe(0);
    expect(renderCallCountFor('0')).toBeGreaterThan(0);
  });
});
