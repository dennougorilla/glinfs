import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFrameGridModal } from '../../../src/features/editor/frame-grid.js';
import { countHotkeys } from '../../../src/shared/hotkeys.js';

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
        drawImage: vi.fn(),
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
    // Every grid key is a modal-scope dispatcher hotkey released on cleanup
    expect(countHotkeys('modal')).toBe(0);
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
    const callbacks = { onApply: vi.fn(), onCancel: vi.fn() };
    const result = renderFrameGridModal({
      container: /** @type {HTMLElement} */ (document.querySelector('#container')),
      frames: /** @type {import('../../../src/features/capture/types.js').Frame[]} */ (
        createFrames(4)
      ),
      initialRange: { start: 0, end: 3 },
      callbacks,
    });
    cleanup = result.cleanup;
    return callbacks;
  }

  /**
   * @param {KeyboardEventInit} init
   * @param {EventTarget} [target] - Defaults to the focused element
   */
  function press(init, target = document.activeElement ?? document) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  /** @returns {HTMLElement} */
  const focusedItem = () => /** @type {HTMLElement} */ (document.activeElement);

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
  describe('on the shared hotkey dispatcher (#102)', () => {
    it('registers its keys in the modal scope only while open', () => {
      renderModal();
      expect(countHotkeys('modal')).toBeGreaterThan(0);

      cleanup();
      cleanup = () => {};
      expect(countHotkeys('modal')).toBe(0);
    });

    it.each([
      ['isComposing', { isComposing: true }],
      ['keyCode 229', { keyCode: 229 }],
    ])('ignores Escape during IME composition (%s)', (_label, init) => {
      const { onCancel } = renderModal();

      const event = press({ key: 'Escape', ...init });

      expect(event.defaultPrevented).toBe(false);
      expect(onCancel).not.toHaveBeenCalled();
      expect(document.querySelector('.frame-grid-modal')).not.toBeNull();

      // The same key outside composition still closes the grid
      expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('ignores Enter/Arrow keystrokes that belong to an IME composition', () => {
      const { onCancel } = renderModal();
      const item = focusedItem();
      expect(item.classList.contains('frame-grid-item')).toBe(true);

      expect(press({ key: 'ArrowRight', isComposing: true }).defaultPrevented).toBe(false);
      expect(press({ key: 'Enter', keyCode: 229 }).defaultPrevented).toBe(false);

      expect(document.activeElement).toBe(item);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it.each([
      [{ key: 'f', metaKey: true }], // find (macOS)
      [{ key: 'f', ctrlKey: true }], // find
      [{ key: 'ArrowRight', metaKey: true }],
      [{ key: 'ArrowLeft', altKey: true }], // browser back
      [{ key: 'Enter', ctrlKey: true }],
      [{ key: 'Escape', metaKey: true }],
    ])('leaves the browser shortcut %o alone', (init) => {
      const { onApply, onCancel } = renderModal();
      const item = focusedItem();

      expect(press(init).defaultPrevented).toBe(false);

      expect(document.activeElement).toBe(item);
      expect(onApply).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('keeps Shift with the grid keys (Shift+Arrow moves, Shift+Escape closes)', () => {
      const { onCancel } = renderModal();
      const item = focusedItem();

      expect(press({ key: 'ArrowRight', shiftKey: true }).defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(item);
      expect(focusedItem().dataset.index).toBe(String(Number(item.dataset.index) + 1));

      press({ key: 'Escape', shiftKey: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
