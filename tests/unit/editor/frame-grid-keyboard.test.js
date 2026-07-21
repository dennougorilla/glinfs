import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFrameGridModal } from '../../../src/features/editor/frame-grid.js';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

/**
 * Create lightweight frames for the modal. Thumbnail rendering is stubbed in
 * the test because jsdom does not implement CanvasRenderingContext2D.
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

describe('Frame Grid keyboard handling (issue #42)', () => {
  let cleanup = () => {};

  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
      return /** @type {CanvasRenderingContext2D} */ ({
        canvas: this,
        fillRect: vi.fn(),
      });
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
        writable: true,
      });
    } else {
      delete HTMLElement.prototype.scrollIntoView;
    }
    document.body.innerHTML = '';
  });

  function renderModal() {
    const result = renderFrameGridModal({
      container: /** @type {HTMLElement} */ (document.querySelector('#container')),
      frames: /** @type {import('../../../src/features/capture/types.js').Frame[]} */ (
        createFrames(4)
      ),
      initialRange: { start: 0, end: 3 },
      callbacks: {
        onApply: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    cleanup = result.cleanup;
  }

  it.each([
    ['button', '.frame-grid-btn-apply', 'Enter'],
    ['button', '.frame-grid-btn-cancel', ' '],
    ['input', '.grid-size-slider', 'ArrowRight'],
  ])('leaves %s keyboard behavior to the focused control', (_type, selector, key) => {
    renderModal();
    const control = /** @type {HTMLElement} */ (document.querySelector(selector));
    control.focus();

    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    control.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(control);
  });

  it.each([
    ['select', 'ArrowDown'],
    ['textarea', ' '],
  ])('does not intercept keys from a focused %s', (tagName, key) => {
    renderModal();
    const control = document.createElement(tagName);
    document.querySelector('.frame-grid-modal')?.appendChild(control);
    control.focus();

    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    control.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(control);
  });

  it('still closes the modal on Escape when focus is inside an interactive control', () => {
    const onCancel = vi.fn();
    const result = renderFrameGridModal({
      container: /** @type {HTMLElement} */ (document.querySelector('#container')),
      frames: /** @type {import('../../../src/features/capture/types.js').Frame[]} */ (
        createFrames(4)
      ),
      initialRange: { start: 0, end: 3 },
      callbacks: {
        onApply: vi.fn(),
        onCancel,
      },
    });
    cleanup = result.cleanup;

    const slider = /** @type {HTMLElement} */ (document.querySelector('.grid-size-slider'));
    slider.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    slider.dispatchEvent(event);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
