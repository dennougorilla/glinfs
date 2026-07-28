import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getThumbnailSizesMock = vi.fn();

vi.mock('../../../src/shared/utils/quality-settings.js', () => ({
  getThumbnailSizes: (...args) => getThumbnailSizesMock(...args),
}));

const { renderFrameGridModal } = await import('../../../src/features/editor/frame-grid.js');

const layoutProperties = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'];
const originalLayoutDescriptors = Object.fromEntries(
  layoutProperties.map((property) => [
    property,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, property),
  ]),
);

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

describe('Frame Grid thumbnail size bounds (re-read quality settings per modal open)', () => {
  let cleanup = () => {};

  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
    getThumbnailSizesMock.mockReset();

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
    document.body.innerHTML = '';
  });

  function openModal(frameCount) {
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
    return result;
  }

  it('re-reads thumbnail size bounds from getThumbnailSizes() on every modal open', () => {
    // Regression: DEFAULT/MIN/MAX_THUMBNAIL_SIZE used to be captured once at
    // module-load time, so a quality preference change was ignored until the
    // page was reloaded. renderFrameGridModal must call getThumbnailSizes()
    // fresh each time it runs.
    getThumbnailSizesMock.mockReturnValue({
      timeline: 60,
      gridMax: 160,
      gridDefault: 80,
      gridMin: 40,
    });

    openModal(4);
    let sizeSlider = /** @type {HTMLInputElement} */ (document.querySelector('.grid-size-slider'));
    expect(sizeSlider.min).toBe('40');
    expect(sizeSlider.max).toBe('160');
    // Auto-fit (mocked rAF runs synchronously) picks a size within the
    // preset's [min, max] bounds since the 4 test frames comfortably fit the
    // 800px-wide container.
    expect(Number(sizeSlider.value)).toBeGreaterThanOrEqual(40);
    expect(Number(sizeSlider.value)).toBeLessThanOrEqual(160);
    const firstOpenValue = Number(sizeSlider.value);
    cleanup();

    getThumbnailSizesMock.mockReturnValue({
      timeline: 160,
      gridMax: 400,
      gridDefault: 200,
      gridMin: 100,
    });

    openModal(4);
    sizeSlider = /** @type {HTMLInputElement} */ (document.querySelector('.grid-size-slider'));
    expect(sizeSlider.min).toBe('100');
    expect(sizeSlider.max).toBe('400');
    expect(Number(sizeSlider.value)).toBeGreaterThanOrEqual(100);
    expect(Number(sizeSlider.value)).toBeLessThanOrEqual(400);
    // The second preset's bounds are strictly larger, so the auto-fit value
    // must differ from the first modal open — proving the bounds were
    // re-read rather than reused from a module-load-time snapshot.
    expect(Number(sizeSlider.value)).toBeGreaterThan(firstOpenValue);

    expect(getThumbnailSizesMock).toHaveBeenCalledTimes(2);
  });
});
