import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateThumbnailRenderSize,
  renderFrameGridModal,
} from '../../../src/features/editor/frame-grid.js';

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
 * Create lightweight landscape frames without allocating pixel buffers.
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

describe('Frame Grid bounded rendering (issue #47)', () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
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
      });
    });
    let animationFrameId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      animationFrameId += 1;
      return animationFrameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    vi.restoreAllMocks();
    vi.useRealTimers();

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
   * @param {{
   *   initialRange?: import('../../../src/features/editor/types.js').FrameRange,
   *   scenes?: import('../../../src/features/scene-detection/types.js').Scene[],
   *   callbacks?: { onApply: ReturnType<typeof vi.fn>, onCancel: ReturnType<typeof vi.fn> }
   * }} [options]
   */
  function renderModal(frameCount, options = {}) {
    const callbacks = options.callbacks ?? { onApply: vi.fn(), onCancel: vi.fn() };
    const result = renderFrameGridModal({
      container: /** @type {HTMLElement} */ (document.querySelector('#container')),
      frames: /** @type {import('../../../src/features/capture/types.js').Frame[]} */ (
        createFrames(frameCount)
      ),
      initialRange: options.initialRange ?? { start: 0, end: frameCount - 1 },
      scenes: options.scenes ?? [],
      callbacks,
    });
    cleanup = result.cleanup;
    return callbacks;
  }

  it('uses device-pixel-ratio sizing capped by the quality maximum', () => {
    expect(calculateThumbnailRenderSize(120, 2, 400)).toBe(240);
    expect(calculateThumbnailRenderSize(120, 4, 400)).toBe(400);

    renderModal(4);
    const thumbnails = [...document.querySelectorAll('.frame-grid-item canvas')];
    expect(thumbnails).toHaveLength(4);
    thumbnails.forEach((canvas) => {
      expect(canvas.dataset.renderSize).toBe('160');
      expect(canvas.width).toBe(160);
    });
  });

  it('materializes only visible rows and releases canvases when they are evicted', () => {
    renderModal(3600);

    const grid = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-container'));
    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));
    const sizeSlider = /** @type {HTMLInputElement} */ (
      document.querySelector('.grid-size-slider')
    );
    const initialItems = [...grid.querySelectorAll('.frame-grid-item')];
    const firstCanvas = /** @type {HTMLCanvasElement} */ (initialItems[0].querySelector('canvas'));

    expect(grid.classList.contains('is-virtualized')).toBe(true);
    expect(sizeSlider.value).toBe(sizeSlider.min);
    expect(initialItems.length).toBeGreaterThan(0);
    expect(initialItems.length).toBeLessThan(300);
    expect(Number.parseFloat(grid.style.height)).toBeGreaterThan(10_000);
    expect(firstCanvas.width).toBeGreaterThan(0);

    body.scrollTop = Number.parseFloat(grid.style.height) - 500;
    body.dispatchEvent(new Event('scroll'));

    const scrolledItems = [...grid.querySelectorAll('.frame-grid-item')];
    expect(scrolledItems.length).toBeLessThan(300);
    expect(Number.parseInt(scrolledItems[0].dataset.index, 10)).toBeGreaterThan(0);
    expect(firstCanvas.isConnected).toBe(false);
    expect(firstCanvas.width).toBe(0);
    expect(firstCanvas.height).toBe(0);

    const lastItem = grid.querySelector('[data-index="3599"]');
    expect(lastItem).toBeTruthy();
    expect(lastItem.classList.contains('is-end')).toBe(true);
  });

  it('relocates focus to the grid container instead of leaking it to <body> when the focused item is evicted', () => {
    renderModal(3600);

    const grid = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-container'));
    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));
    const modal = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-modal'));

    const focusedItem = /** @type {HTMLElement} */ (document.activeElement);
    expect(focusedItem.dataset.index).toBe('0');
    expect(focusedItem.closest('.frame-grid-container')).toBe(grid);

    // Scroll far enough that the previously-focused item (index 0) is evicted.
    body.scrollTop = Number.parseFloat(grid.style.height) - 500;
    body.dispatchEvent(new Event('scroll'));

    expect(focusedItem.isConnected).toBe(false);
    // Focus must stay inside the modal (on the grid container, a valid
    // programmatic-focus target) rather than falling back to <body>, which
    // would silently escape the modal's Tab-trap.
    expect(document.activeElement).toBe(grid);
    expect(document.activeElement).not.toBe(document.body);
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it('keeps focus and canvas eviction working while keyboard navigation crosses virtual windows', () => {
    renderModal(3600, { initialRange: { start: 1500, end: 1550 } });

    const grid = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-container'));
    const initialFocusedItem = /** @type {HTMLElement} */ (document.activeElement);
    const initialCanvas = /** @type {HTMLCanvasElement} */ (
      initialFocusedItem.querySelector('canvas')
    );
    expect(initialFocusedItem.dataset.index).toBe('1500');

    for (let step = 0; step < 40; step++) {
      const focusedItem = /** @type {HTMLElement} */ (document.activeElement);
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      });
      focusedItem.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement?.isConnected).toBe(true);
      expect(grid.querySelectorAll('.frame-grid-item').length).toBeLessThan(300);
    }

    const finalFocusedItem = /** @type {HTMLElement} */ (document.activeElement);
    expect(Number.parseInt(finalFocusedItem.dataset.index, 10)).toBeGreaterThan(1500);
    expect(finalFocusedItem.closest('.frame-grid-container')).toBe(grid);
    expect(initialCanvas.isConnected).toBe(false);
    expect(initialCanvas.width).toBe(0);
    expect(initialCanvas.height).toBe(0);
  });

  it('materializes a late scene selection without unbounding the 3,600-frame DOM', () => {
    const callbacks = { onApply: vi.fn(), onCancel: vi.fn() };
    renderModal(3600, {
      initialRange: { start: 0, end: 10 },
      scenes: [
        {
          id: 'late-scene',
          startFrame: 3000,
          endFrame: 3020,
          confidence: 0.9,
          timestamp: 100_000,
          duration: 700,
        },
      ],
      callbacks,
    });

    const grid = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-container'));
    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));
    const sceneButton = /** @type {HTMLButtonElement} */ (
      document.querySelector('.frame-grid-scene-btn')
    );
    sceneButton.click();

    expect(body.scrollTop).toBeGreaterThan(0);
    expect(grid.querySelectorAll('.frame-grid-item').length).toBeLessThan(300);
    expect(grid.querySelector('[data-index="3000"]')?.classList.contains('is-start')).toBe(true);
    expect(grid.querySelector('[data-index="3020"]')?.classList.contains('is-end')).toBe(true);
    expect(document.querySelector('.frame-grid-selection-info')?.textContent).toContain(
      'Frame 3001 \u2192 Frame 3021',
    );

    const applyButton = /** @type {HTMLButtonElement} */ (
      document.querySelector('.frame-grid-btn-apply')
    );
    applyButton.click();
    expect(callbacks.onApply).toHaveBeenCalledOnce();
    expect(callbacks.onApply).toHaveBeenCalledWith({ start: 3000, end: 3020 });
  });

  it('releases every canvas and ignores delayed work after cleanup', () => {
    /** @type {FrameRequestCallback[]} */
    const queuedAnimationFrames = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      queuedAnimationFrames.push(callback);
      return queuedAnimationFrames.length;
    });

    const callbacks = { onApply: vi.fn(), onCancel: vi.fn() };
    renderModal(3600, {
      scenes: [
        {
          id: 'scene-thumbnail',
          startFrame: 0,
          endFrame: 10,
          confidence: 1,
          timestamp: 0,
          duration: 367,
        },
      ],
      callbacks,
    });

    const body = /** @type {HTMLElement} */ (document.querySelector('.frame-grid-body'));
    const applyButton = /** @type {HTMLButtonElement} */ (
      document.querySelector('.frame-grid-btn-apply')
    );
    const canvases = /** @type {HTMLCanvasElement[]} */ ([
      ...document.querySelectorAll('.frame-grid-modal canvas'),
    ]);
    expect(canvases.length).toBeGreaterThan(1);

    body.dispatchEvent(new Event('scroll'));
    expect(queuedAnimationFrames.length).toBeGreaterThan(1);

    cleanup();
    queuedAnimationFrames.forEach((callback) => {
      callback(16);
    });

    expect(document.querySelector('.frame-grid-modal')).toBeNull();
    canvases.forEach((canvas) => {
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    });

    applyButton.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it('delegates touch handling while preserving long-press behavior', () => {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    let itemTouchListenerCount = 0;
    const gridTouchEventTypes = [];
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(
      function listener(type, callback, options) {
        if (this instanceof Element && type.startsWith('touch')) {
          if (this.classList.contains('frame-grid-item')) itemTouchListenerCount += 1;
          if (this.classList.contains('frame-grid-container')) gridTouchEventTypes.push(type);
        }
        return originalAddEventListener.call(this, type, callback, options);
      },
    );

    renderModal(200);

    expect(document.querySelectorAll('.frame-grid-item')).toHaveLength(200);
    expect(itemTouchListenerCount).toBe(0);
    expect(gridTouchEventTypes.sort()).toEqual([
      'touchcancel',
      'touchend',
      'touchmove',
      'touchstart',
    ]);

    const [firstItem, secondItem] = document.querySelectorAll('.frame-grid-item');
    firstItem.dispatchEvent(new Event('touchstart', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(firstItem.classList.contains('touch-active')).toBe(true);

    secondItem.dispatchEvent(new Event('touchstart', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(firstItem.classList.contains('touch-active')).toBe(false);
    expect(secondItem.classList.contains('touch-active')).toBe(true);
  });
});
