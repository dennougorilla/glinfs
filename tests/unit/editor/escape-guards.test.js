/**
 * #102 (Escape conflict slice): the editor's document-level Escape clears
 * the crop, but must not act on an Escape an overlay already consumed
 * (defaultPrevented) or one typed into a contenteditable element.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { releaseAllFramesAndReset, setClipPayload } from '../../../src/shared/app-store.js';

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

function pressEscape() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

describe('Editor Escape guards (#102)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="main-content"></div>';
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    setClipPayload({ frames: createTestFrames(10), fps: 30, capturedAt: Date.now() });
    cleanup = /** @type {() => void} */ (initEditor());
    window.__TEST_HOOKS__.setEditorState({ cropArea: CROP });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    releaseAllFramesAndReset();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('clears the crop on a plain Escape', () => {
    pressEscape();
    expect(getEditorState()?.cropArea).toBeNull();
  });

  it('ignores an Escape an overlay already consumed', () => {
    // Mirrors the header popover: capture-phase listener that handles Escape
    const consume = (e) => e.preventDefault();
    document.addEventListener('keydown', consume, true);
    try {
      pressEscape();
    } finally {
      document.removeEventListener('keydown', consume, true);
    }
    expect(getEditorState()?.cropArea).toEqual(CROP);
  });

  it('ignores Escape while a contenteditable element has focus', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom only focuses contenteditable elements that carry a tabindex
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    editable.focus();
    // jsdom does not implement isContentEditable; stub it like a browser
    if (editable.isContentEditable !== true) {
      Object.defineProperty(editable, 'isContentEditable', { value: true });
    }
    expect(document.activeElement).toBe(editable);

    pressEscape();
    expect(getEditorState()?.cropArea).toEqual(CROP);
  });
});
