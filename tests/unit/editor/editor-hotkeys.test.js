/**
 * #102: the editor's shortcuts are route-scope hotkeys on the shared
 * dispatcher — unregistered on unmount, yielded to the frame-grid modal,
 * and never swallowing browser modifier shortcuts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { releaseAllFramesAndReset, setClipPayload } from '../../../src/shared/app-store.js';
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

  it('yields to an open aria-modal (the frame grid owns its keys)', () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    expect(press({ key: 'ArrowRight' }).defaultPrevented).toBe(false);
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(false);
    expect(getEditorState()?.currentFrame).toBe(3);
    expect(getEditorState()?.cropArea).toEqual(CROP);

    modal.remove();
    press({ key: 'ArrowRight' });
    expect(getEditorState()?.currentFrame).toBe(4);
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
