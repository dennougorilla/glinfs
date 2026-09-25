/**
 * Editor session behavior for clip edits: hooks, persistence on unmount,
 * queue promote/demote, export payload, Escape and Delete ordering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  getEditorPayload,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';

/**
 * @param {number} count
 * @param {string} prefix
 */
function createTestFrames(count, prefix = '') {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    data: { data: new Uint8ClampedArray(10 * 10 * 4), width: 10, height: 10 },
    timestamp: i * 33,
    width: 10,
    height: 10,
  }));
}

/** @param {string} key */
function press(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const EDITS = {
  textLayers: [{ id: 't1', text: 'Hello', start: 1, end: 3 }],
  background: { enabled: true, color: '#123456', tolerance: 30, mode: 'global' },
};

describe('Editor edits session', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** @param {Record<string, unknown>} [extra] */
  function mount(extra = {}) {
    setClipPayload({ frames: createTestFrames(6, 'a'), fps: 30, capturedAt: Date.now(), ...extra });
    cleanup = /** @type {() => void} */ (initEditor());
  }

  it('test hooks expose and normalize edits', () => {
    mount({ hasAlpha: true });
    window.__TEST_HOOKS__.setEditorState({
      edits: { ...EDITS, textLayers: [...EDITS.textLayers, 7] },
    });
    const state = window.__TEST_HOOKS__.getEditorState();
    expect(state.edits.textLayers).toHaveLength(1);
    expect(state.edits.textLayers[0]).toMatchObject({ id: 't1', text: 'Hello', start: 1, end: 3 });
    expect(state.edits.background).toMatchObject({ enabled: true, mode: 'global' });
    expect(state.hasAlpha).toBe(true);
    expect(state.selectedTextId).toBeNull();
    expect(state.pickingKeyColor).toBe(false);
    expect(getEditorState()?.clip?.edits).toBe(getEditorState()?.edits);
    // No canvas in jsdom: nothing was read back
    expect(window.__TEST_HOOKS__.getEditorPreviewStats()).toMatchObject({ readbacks: 0 });
  });

  it('restores edits a clip carries in savedEditorState, normalized', () => {
    setClipPayload({
      frames: createTestFrames(4, 'a'),
      fps: 30,
      capturedAt: Date.now(),
      savedEditorState: /** @type {any} */ ({
        selectedRange: { start: 0, end: 3 },
        cropArea: null,
        playbackSpeed: 1,
        currentFrame: 0,
        edits: { textLayers: [{ id: 'x', text: 'Saved', end: 40 }], background: { enabled: true } },
      }),
    });
    cleanup = /** @type {() => void} */ (initEditor());
    const state = getEditorState();
    expect(state?.edits.textLayers[0]).toMatchObject({ id: 'x', text: 'Saved', end: 3 });
    expect(state?.edits.background.enabled).toBe(true);
    // The Text/Background panels show them
    expect(document.querySelector('#text-layer-list')?.textContent).toContain('Saved');
    expect(
      /** @type {HTMLInputElement} */ (document.querySelector('#background-enabled')).checked,
    ).toBe(true);
  });

  it('unmounting stores the session (with edits) on the active clip', () => {
    mount();
    window.__TEST_HOOKS__.setEditorState({
      edits: EDITS,
      selectedRange: { start: 1, end: 4 },
      currentFrame: 2,
    });
    cleanup?.();
    cleanup = null;

    const saved = getClipPayload()?.savedEditorState;
    expect(saved?.selectedRange).toEqual({ start: 1, end: 4 });
    expect(saved?.currentFrame).toBe(2);
    expect(saved?.edits?.textLayers[0].text).toBe('Hello');

    // ...and the next mount restores it
    cleanup = /** @type {() => void} */ (initEditor());
    expect(getEditorState()?.edits.textLayers[0].text).toBe('Hello');
    expect(getEditorState()?.selectedRange).toEqual({ start: 1, end: 4 });
  });

  it('a promote demotes the active clip with its edits and restores them on return', () => {
    mount();
    const idA = /** @type {string} */ (getClipPayload()?.id);
    const { entry } = enqueueClip({
      frames: createTestFrames(5, 'b'),
      fps: 30,
      capturedAt: Date.now(),
    });
    window.__TEST_HOOKS__.setEditorState({ edits: EDITS });

    const clickEntry = (/** @type {string} */ id) =>
      /** @type {HTMLButtonElement} */ (
        document.querySelector(`[data-clip-id="${id}"] button.clip-entry-main`)
      ).click();

    clickEntry(entry.id);
    expect(getClipQueue()[0].savedEditorState?.edits?.textLayers[0].text).toBe('Hello');
    expect(getEditorState()?.edits.textLayers).toEqual([]);

    clickEntry(idA);
    expect(getEditorState()?.edits.textLayers[0].text).toBe('Hello');
    expect(getEditorState()?.edits.background.color).toBe('#123456');
  });

  it('export stores edits and alpha in the editor payload; returning restores them', () => {
    mount({ hasAlpha: true });
    window.__TEST_HOOKS__.setEditorState({ edits: EDITS });
    /** @type {HTMLButtonElement} */ (
      document.querySelector('button[aria-label="Export as GIF"]')
    ).click();

    const payload = getEditorPayload();
    expect(payload?.edits?.textLayers[0].text).toBe('Hello');
    expect(payload?.hasAlpha).toBe(true);
    expect(payload?.clip.edits).toBe(payload?.edits);

    cleanup?.();
    cleanup = /** @type {() => void} */ (initEditor());
    expect(getEditorState()?.edits.textLayers[0].text).toBe('Hello');
    expect(getEditorState()?.clip?.hasAlpha).toBe(true);
  });

  it('adding text selects it and focuses its text field', () => {
    mount();
    /** @type {HTMLButtonElement} */ (document.querySelector('#text-add')).click();
    const state = getEditorState();
    expect(state?.edits.textLayers).toHaveLength(1);
    expect(state?.selectedTextId).toBe(state?.edits.textLayers[0].id);
    expect(document.activeElement?.id).toBe('text-layer-text');
    expect(/** @type {HTMLElement} */ (document.querySelector('#text-layer-editor')).hidden).toBe(
      false,
    );
  });

  it('Escape leaves the eyedropper, then deselects text, then clears the crop', () => {
    mount();
    /** @type {HTMLButtonElement} */ (document.querySelector('#text-add')).click();
    /** @type {HTMLElement} */ (document.activeElement).blur();
    window.__TEST_HOOKS__.setEditorState({
      pickingKeyColor: true,
      cropArea: { x: 0, y: 0, width: 8, height: 8, aspectRatio: 'free' },
    });

    press('Escape');
    expect(getEditorState()?.pickingKeyColor).toBe(false);
    expect(getEditorState()?.selectedTextId).not.toBeNull();

    press('Escape');
    expect(getEditorState()?.selectedTextId).toBeNull();
    expect(getEditorState()?.cropArea).not.toBeNull();

    press('Escape');
    expect(getEditorState()?.cropArea).toBeNull();
  });

  it('Escape in a panel control only leaves the eyedropper', () => {
    mount();
    /** @type {HTMLButtonElement} */ (document.querySelector('#text-add')).click();
    window.__TEST_HOOKS__.setEditorState({ pickingKeyColor: true });
    const textarea = /** @type {HTMLTextAreaElement} */ (
      document.querySelector('#text-layer-text')
    );
    textarea.focus();

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(getEditorState()?.pickingKeyColor).toBe(false);
    // Typing context: the text selection stays
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(getEditorState()?.selectedTextId).not.toBeNull();
  });

  it('Delete removes the selected text layer instead of the clip', () => {
    mount();
    /** @type {HTMLButtonElement} */ (document.querySelector('#text-add')).click();
    /** @type {HTMLElement} */ (document.activeElement).blur();

    press('Delete');
    expect(getEditorState()?.edits.textLayers).toEqual([]);
    expect(getClipPayload()).not.toBeNull();
  });

  it('turning removal on keeps an already chosen key color', () => {
    mount();
    window.__TEST_HOOKS__.setEditorState({ edits: { background: { color: '#abcdef' } } });
    cleanup?.();
    cleanup = /** @type {() => void} */ (initEditor());

    const toggle = /** @type {HTMLInputElement} */ (document.querySelector('#background-enabled'));
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(getEditorState()?.edits.background).toMatchObject({ enabled: true, color: '#abcdef' });
  });
});
