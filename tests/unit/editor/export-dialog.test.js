/**
 * The editor opens the Export GIF dialog over itself: the payload it hands
 * over (speed included), playback paused while it is open, route hotkeys
 * suspended, focus back on close, and `#/export` as a deep link into it.
 * The editor speed is the GIF speed and starts at the stored default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/export/api.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    checkEncoderStatus: vi.fn(async () => 'gifenc-js'),
    encodeGif: vi.fn(() => new Promise(() => {})),
  };
});

import { getEditorState, initEditor, initExportRoute } from '../../../src/features/editor/index.js';
import { isExportDialogOpen } from '../../../src/features/export/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  getEditorPayload,
  registerClipCodec,
  releaseAllFramesAndReset,
  setClipPayload,
  setEditorPayload,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { countHotkeys } from '../../../src/shared/hotkeys.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

function createTestFrames(count = 10) {
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
  const target = document.activeElement ?? document;
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** @returns {HTMLButtonElement} */
function exportButton() {
  return /** @type {HTMLButtonElement} */ (
    document.querySelector('button[aria-label="Export as GIF"]')
  );
}

describe('Export dialog from the editor', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="app"><main id="main-content"></main></div>';
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    releaseAllFramesAndReset();
    localStorage.clear();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  /** @param {Record<string, unknown>} [extras] */
  function mountEditor(extras = {}) {
    setClipPayload(
      /** @type {any} */ ({
        frames: createTestFrames(),
        fps: 30,
        capturedAt: Date.now(),
        id: 'clip-a',
        ...extras,
      }),
    );
    cleanup = /** @type {() => void} */ (initEditor());
  }

  it('opens from the Export button with the editor state, speed included, and pauses playback', () => {
    mountEditor({ sourceName: 'loop.gif' });
    window.__TEST_HOOKS__.setEditorState({
      selectedRange: { start: 2, end: 7 },
      playbackSpeed: 2,
    });
    expect(getEditorState()?.isPlaying).toBe(true);

    exportButton().click();

    expect(isExportDialogOpen()).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const payload = /** @type {any} */ (getEditorPayload());
    expect(payload).toMatchObject({
      selectedRange: { start: 2, end: 7 },
      playbackSpeed: 2,
      clipId: 'clip-a',
      sourceName: 'loop.gif',
    });
    expect(payload.clip.frames).toBe(getClipPayload()?.frames);
    expect(getEditorState()?.isPlaying).toBe(false);
    expect(document.querySelector('#export-speed')?.textContent).toBe('2×');
    expect(exportButton().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('suspends the route hotkeys while open and resumes playback after closing', () => {
    mountEditor();
    exportButton().focus();
    exportButton().click();
    expect(countHotkeys('modal')).toBe(1);

    // G would toggle the grid and Space the playback underneath
    press({ key: 'g' });
    press({ key: ' ' });
    expect(getEditorState()?.showGrid).toBe(false);
    expect(getEditorState()?.isPlaying).toBe(false);

    press({ key: 'Escape' });
    expect(isExportDialogOpen()).toBe(false);
    expect(document.activeElement).toBe(exportButton());
    expect(getEditorState()?.isPlaying).toBe(true);
    // The payload is gone: the next mount restores the clip's own state
    expect(getEditorPayload()).toBeNull();

    press({ key: 'g' });
    expect(getEditorState()?.showGrid).toBe(true);
  });

  it('keeps playback paused after closing when it was paused before', () => {
    mountEditor();
    window.__TEST_HOOKS__.setEditorState({ isPlaying: false });
    exportButton().click();
    press({ key: 'Escape' });
    expect(getEditorState()?.isPlaying).toBe(false);
  });

  it('opens with Ctrl+E and Cmd+E, once', () => {
    mountEditor();
    const e = press({ key: 'e', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(isExportDialogOpen()).toBe(true);
    press({ key: 'e', metaKey: true });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    press({ key: 'Escape' });
    press({ key: 'e', metaKey: true });
    expect(isExportDialogOpen()).toBe(true);
  });

  it('closes the dialog when the editor unmounts', () => {
    mountEditor();
    exportButton().click();
    cleanup?.();
    cleanup = null;
    expect(isExportDialogOpen()).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(countHotkeys('modal')).toBe(0);
    expect(document.getElementById('app')?.hasAttribute('inert')).toBe(false);
  });

  it('does not restart playback on the editor it is torn down with', () => {
    mountEditor();
    expect(getEditorState()?.isPlaying).toBe(true);
    exportButton().click();
    expect(getEditorState()?.isPlaying).toBe(false);

    // Closing the dialog as part of the teardown must not resume playback
    // (a new animation-frame loop) on the editor going away
    vi.mocked(requestAnimationFrame).mockClear();
    const playing = vi.fn();
    const off = onBus('editor:playback', playing);
    cleanup?.();
    cleanup = null;
    off();

    expect(isExportDialogOpen()).toBe(false);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(playing).not.toHaveBeenCalled();
  });

  describe('speed', () => {
    it('starts a new clip at the stored default speed', () => {
      updateSetting('export', 'playbackSpeed', 1.5);
      mountEditor();
      expect(getEditorState()?.playbackSpeed).toBe(1.5);
    });

    it("keeps a clip's saved speed over the default", () => {
      updateSetting('export', 'playbackSpeed', 1.5);
      mountEditor({
        savedEditorState: {
          selectedRange: { start: 0, end: 9 },
          cropArea: null,
          playbackSpeed: 3,
          currentFrame: 0,
        },
      });
      expect(getEditorState()?.playbackSpeed).toBe(3);
    });

    it('offers 0.25x to 4x, and a stored value outside the list', () => {
      updateSetting('export', 'playbackSpeed', 1.25);
      mountEditor();
      const select = /** @type {HTMLSelectElement} */ (document.getElementById('editor-speed'));
      expect([...select.options].map((option) => option.textContent)).toEqual([
        '0.25×',
        '0.5×',
        '0.75×',
        '1×',
        '1.25×',
        '1.5×',
        '2×',
        '3×',
        '4×',
      ]);
      expect(select.value).toBe('1.25');
    });

    it('restores the speed an editor payload carries', () => {
      const frames = createTestFrames();
      setClipPayload(/** @type {any} */ ({ frames, fps: 30, capturedAt: Date.now() }));
      setEditorPayload(
        /** @type {any} */ ({
          selectedRange: { start: 0, end: 9 },
          cropArea: null,
          clip: { frames, fps: 30, selectedRange: { start: 0, end: 9 }, cropArea: null },
          fps: 30,
          playbackSpeed: 0.5,
        }),
      );
      cleanup = /** @type {() => void} */ (initEditor());
      expect(getEditorState()?.playbackSpeed).toBe(0.5);
    });
  });

  describe('#/export', () => {
    it('opens the editor with the dialog when a clip exists', async () => {
      setClipPayload(/** @type {any} */ ({ frames: createTestFrames(), fps: 30, capturedAt: 0 }));
      const routeCleanup = initExportRoute();
      expect(window.location.hash).toBe('#/editor');
      expect(isExportDialogOpen()).toBe(false);

      routeCleanup('/editor');
      cleanup = /** @type {() => void} */ (initEditor());
      expect(isExportDialogOpen()).toBe(true);
    });

    it('goes to Capture without a clip', () => {
      initExportRoute();
      expect(window.location.hash).toBe('#/capture');
    });

    /**
     * Queue one clip that must be decoded before the editor can show it
     * (the editor then takes its "Opening clip…" path)
     * @param {() => Promise<any>} decode
     */
    async function enqueueCompressedClip(decode) {
      registerClipCodec({
        isCompressionAvailable: () => true,
        encode: async () => ({
          ok: true,
          chunks: [{ type: 'key', timestamp: 0, duration: null, data: new ArrayBuffer(16) }],
          config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 },
          byteLength: 16,
        }),
        decode,
      });
      enqueueClip(
        /** @type {any} */ ({ frames: createTestFrames(2), fps: 10, capturedAt: 0, id: 'clip-q' }),
      );
      await vi.waitFor(() => expect(getClipQueue()[0]?.status).toBe('compressed'));
    }

    it('forgets the request when the editor is left while a clip is still opening', async () => {
      try {
        await enqueueCompressedClip(() => new Promise(() => {}));
        const routeCleanup = initExportRoute();
        routeCleanup('/editor');
        const openingCleanup = /** @type {() => void} */ (initEditor());
        expect(document.querySelector('.editor-clip-opening')).not.toBeNull();
        expect(isExportDialogOpen()).toBe(false);
        // The user goes elsewhere before the clip opened
        openingCleanup();
      } finally {
        registerClipCodec(null);
      }

      // A later, unrelated editor mount does not open the dialog
      mountEditor();
      expect(isExportDialogOpen()).toBe(false);
    });

    it('opens the dialog once a clip that had to be decoded is on screen', async () => {
      const decoded = () =>
        Array.from({ length: 2 }, (_, i) => ({
          codedWidth: 10,
          codedHeight: 10,
          timestamp: i,
          closed: false,
          close: vi.fn(),
          clone() {
            return { ...this };
          },
        }));
      try {
        await enqueueCompressedClip(async () => ({ ok: true, frames: decoded() }));
        const routeCleanup = initExportRoute();
        routeCleanup('/editor');
        cleanup = /** @type {() => void} */ (initEditor());
        expect(isExportDialogOpen()).toBe(false);
        await vi.waitFor(() => expect(isExportDialogOpen()).toBe(true));
      } finally {
        registerClipCodec(null);
      }
    });

    it('forgets the request when the clip cannot be opened', async () => {
      try {
        await enqueueCompressedClip(async () => ({ ok: false, error: 'bad' }));
        const routeCleanup = initExportRoute();
        routeCleanup('/editor');
        const openingCleanup = /** @type {() => void} */ (initEditor());
        await vi.waitFor(() => expect(window.location.hash).toBe('#/capture'));
        openingCleanup();
      } finally {
        registerClipCodec(null);
      }

      mountEditor();
      expect(isExportDialogOpen()).toBe(false);
    });

    it('forgets the request when the editor mount fails', () => {
      setClipPayload(/** @type {any} */ ({ frames: createTestFrames(), fps: 30, capturedAt: 0 }));
      const routeCleanup = initExportRoute();
      routeCleanup('/editor');
      document.body.innerHTML = '';
      expect(() => initEditor()).toThrow();

      document.body.innerHTML = '<div id="app"><main id="main-content"></main></div>';
      mountEditor();
      expect(isExportDialogOpen()).toBe(false);
    });

    it('forgets the request when the next route is not the editor', () => {
      setClipPayload(/** @type {any} */ ({ frames: createTestFrames(), fps: 30, capturedAt: 0 }));
      const routeCleanup = initExportRoute();
      routeCleanup('/settings');
      cleanup = /** @type {() => void} */ (initEditor());
      expect(isExportDialogOpen()).toBe(false);
    });
  });
});
