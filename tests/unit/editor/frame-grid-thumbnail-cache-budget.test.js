/**
 * Regression test for issue #76: the frame grid's dedicated ThumbnailCache
 * instance must stay bounded. This substitutes a tiny-capacity cache in
 * place of the real one to make LRU eviction deterministic without
 * rendering an unreasonable number of frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/utils/thumbnail-cache.js', async (importOriginal) => {
  const actual = await importOriginal();
  const boundedCache = new actual.ThumbnailCache(2);
  return {
    ...actual,
    getGridThumbnailCache: () => boundedCache,
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
const { getGridThumbnailCache } = await import('../../../src/shared/utils/thumbnail-cache.js');

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

describe('Frame Grid thumbnail cache budget (issue #76)', () => {
  let cleanup = () => {};

  beforeEach(() => {
    getGridThumbnailCache().clear();
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

  it('never grows the cache past its configured budget and evicts the oldest entries first', () => {
    // Just above VIRTUALIZATION_THRESHOLD (200) — enough to exercise the
    // virtualized path without the runtime cost of thousands of frames.
    const frameCount = 600;
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

    const grid = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-container'));
    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));
    const totalHeight = Number.parseFloat(grid.style.height);
    const cache = getGridThumbnailCache();

    // Row 0's thumbnail is decoded on the initial render (mount does an
    // initial-estimate render plus one auto-fit re-render at the settled
    // size — both are legitimate first renders of row 0, not re-decodes).
    const callsAfterMount = renderCallCountFor('0');
    expect(callsAfterMount).toBeGreaterThan(0);
    expect(cache.size).toBeLessThanOrEqual(2);

    // Scroll in a few steps, each landing on a distinct virtual window, so
    // far more than 2 distinct rows get cached — the bounded cache must
    // never grow past its budget.
    for (let step = 1; step <= 4; step++) {
      body.scrollTop = (totalHeight / 4) * step;
      body.dispatchEvent(new Event('scroll'));
      expect(cache.size).toBeLessThanOrEqual(2);
    }

    // Row 0 was evicted from the cache long ago (LRU budget of 2). Scrolling
    // back to it must be a cache miss, re-triggering a real render.
    body.scrollTop = 0;
    body.dispatchEvent(new Event('scroll'));

    expect(document.querySelector('[data-index="0"] canvas')).not.toBeNull();
    expect(renderCallCountFor('0')).toBeGreaterThan(callsAfterMount);
  });
});
