/**
 * #102: the editor's shortcuts are route-scope hotkeys on the shared
 * dispatcher — unregistered on unmount, shut out while the frame grid holds
 * the modal scope, and never swallowing browser modifier shortcuts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import {
  getClipPayload,
  releaseAllFramesAndReset,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { countHotkeys } from '../../../src/shared/hotkeys.js';

const CROP = { x: 0, y: 0, width: 8, height: 8, aspectRatio: 'free' };

function createTestFrames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    data: { data: new Uint8ClampedArray(10 * 10 * 4), width: 10, height: 10 },
    timestamp: i * 33.33,
    width: 10,
    height: 10,
  }));
}

/** @param {KeyboardEventInit} init */
function press(init) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e;
}

describe('Editor hotkeys on the shared dispatcher (#102)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="main-content"></div>';
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    setClipPayload({ frames: createTestFrames(10), fps: 30, capturedAt: Date.now() });
    cleanup = /** @type {() => void} */ (initEditor());
    window.__TEST_HOOKS__.setEditorState({ cropArea: CROP, currentFrame: 3 });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    releaseAllFramesAndReset();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('unregisters every route hotkey when the editor unmounts', () => {
    expect(countHotkeys('route')).toBeGreaterThan(0);

    cleanup?.();
    cleanup = null;

    expect(countHotkeys('route')).toBe(0);
  });

  it('does not stack route hotkeys across remounts', () => {
    const perMount = countHotkeys('route');
    cleanup?.();
    cleanup = /** @type {() => void} */ (initEditor());

    expect(countHotkeys('route')).toBe(perMount);
  });

  describe('with the frame grid open (modal scope)', () => {
    beforeEach(() => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
        return /** @type {CanvasRenderingContext2D} */ ({
          canvas: this,
          fillRect: vi.fn(),
          drawImage: vi.fn(),
          putImageData: vi.fn(),
        });
      });
      // jsdom has no scrollIntoView; the grid scrolls its focused frame into view
      HTMLElement.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete (/** @type {any} */ (HTMLElement.prototype).scrollIntoView);
    });

    function openGrid() {
      press({ key: 'f' });
      expect(document.querySelector('.frame-grid-modal')).not.toBeNull();
      expect(countHotkeys('modal')).toBeGreaterThan(0);
      // Keys go to the page body, as when the user clicked outside a control
      /** @type {HTMLElement | null} */ (document.activeElement)?.blur();
    }

    it('keeps route shortcuts off the editor until the grid closes', () => {
      openGrid();

      expect(press({ key: 'ArrowRight' }).defaultPrevented).toBe(true); // grid navigation
      press({ key: 'Home' });
      press({ key: 'g' });
      press({ key: 'Delete' }); // would delete the clip being edited
      expect(getClipPayload()).not.toBeNull();
      expect(document.querySelector('.frame-grid-modal')).not.toBeNull();
      expect(getEditorState()?.currentFrame).toBe(3);
      expect(getEditorState()?.cropArea).toEqual(CROP);

      // The first Escape closes the grid only; the crop survives
      press({ key: 'Escape' });
      expect(document.querySelector('.frame-grid-modal')).toBeNull();
      expect(countHotkeys('modal')).toBe(0);
      expect(getEditorState()?.cropArea).toEqual(CROP);

      press({ key: 'ArrowRight' });
      expect(getEditorState()?.currentFrame).toBe(4);
    });

    it('leaves no grid hotkeys behind when the route changes with the grid open', () => {
      openGrid();

      cleanup?.();
      cleanup = null;

      expect(document.querySelector('.frame-grid-modal')).toBeNull();
      expect(countHotkeys('modal')).toBe(0);
      expect(countHotkeys('route')).toBe(0);
    });
  });

  it('leaves browser modifier shortcuts alone', () => {
    for (const init of [
      { key: 'ArrowRight', metaKey: true },
      { key: 'ArrowLeft', altKey: true }, // browser back
      { key: 'f', metaKey: true }, // find
      { key: 'g', ctrlKey: true }, // find next
      { key: 'Backspace', metaKey: true },
      { key: 'Escape', ctrlKey: true },
    ]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(getEditorState()?.currentFrame).toBe(3);
    expect(getEditorState()?.cropArea).toEqual(CROP);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('still accepts Shift with the plain-key shortcuts', () => {
    press({ key: 'ArrowRight', shiftKey: true });
    expect(getEditorState()?.currentFrame).toBe(4);

    press({ key: 'Escape', shiftKey: true });
    expect(getEditorState()?.cropArea).toBeNull();
  });
});
