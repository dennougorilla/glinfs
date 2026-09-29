import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGif } from '../../../src/features/export/api.js';
import {
  getExportState,
  isExportDialogOpen,
  openExportDialog,
} from '../../../src/features/export/index.js';
import {
  getEditorPayload,
  getExportResult,
  resetAppStore,
  setClipPayload,
  setEditorPayload,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { countHotkeys } from '../../../src/shared/hotkeys.js';

vi.mock('../../../src/features/export/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkEncoderStatus: vi.fn(async () => 'gifenc-js'),
    encodeGif: vi.fn(
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Encoding cancelled', 'AbortError')),
            { once: true },
          );
        }),
    ),
  };
});

// Spy on updateProgressUI (keeping its real implementation) so tests can
// assert whether the throttled progress redraw actually fires, without
// depending on DOM structure the settings view doesn't have (it has no
// progress bar, so a stale write there would otherwise be unobservable).
vi.mock('../../../src/features/export/ui.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateProgressUI: vi.fn(actual.updateProgressUI),
  };
});

/** @type {import('../../../src/features/export/index.js').ExportDialogHandle | null} */
let dialog = null;
/** @type {PropertyDescriptor | undefined} */
let createObjectUrlDescriptor;
/** @type {PropertyDescriptor | undefined} */
let revokeObjectUrlDescriptor;

/**
 * @param {number} count
 * @returns {import('../../../src/features/capture/types.js').Frame[]}
 */
function createFrames(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    timestamp: index * 33.33,
    width: 16,
    height: 12,
  }));
}

/**
 * @param {number} count
 */
function injectEditorPayload(count = 4) {
  const frames = createFrames(count);
  const selectedRange = { start: 0, end: count - 1 };
  const clip = {
    id: 'test-clip',
    frames,
    selectedRange,
    cropArea: null,
    createdAt: Date.now(),
    fps: 30,
  };

  setClipPayload({ frames, fps: 30, capturedAt: Date.now() });
  setEditorPayload({ selectedRange, cropArea: null, clip, fps: 30 });
}

/** @param {string} selector */
function $(selector) {
  return /** @type {HTMLElement | null} */ (document.querySelector(selector));
}

function clickExport() {
  $('#export-start')?.dispatchEvent(new MouseEvent('click'));
}

/** @param {string} key @param {Record<string, unknown>} [init] */
function pressKey(key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document).dispatchEvent(event);
  return event;
}

describe('Export dialog', () => {
  beforeEach(() => {
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = {};
    document.body.innerHTML =
      '<div id="app"><button type="button" aria-label="Export as GIF">Export</button><main id="main-content"></main></div>';

    createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:test-export'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
  });

  afterEach(() => {
    dialog?.close();
    dialog = null;
    resetAppStore();
    localStorage.clear();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    if (createObjectUrlDescriptor) {
      Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
    } else {
      delete URL.createObjectURL;
    }
    if (revokeObjectUrlDescriptor) {
      Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
    } else {
      delete URL.revokeObjectURL;
    }
  });

  describe('dialog semantics', () => {
    it('is a modal dialog labelled by its title, which takes focus', () => {
      injectEditorPayload();
      dialog = openExportDialog();

      const element = $('[role="dialog"]');
      expect(element?.getAttribute('aria-modal')).toBe('true');
      const titleId = element?.getAttribute('aria-labelledby');
      expect(titleId && document.getElementById(titleId)?.textContent).toBe('Export GIF');
      expect(document.activeElement?.id).toBe('export-dialog-title');
      // The page underneath leaves the tab order and the a11y tree
      expect($('#app')?.hasAttribute('inert')).toBe(true);
      expect(isExportDialogOpen()).toBe(true);
    });

    it('opening twice keeps a single dialog', () => {
      injectEditorPayload();
      dialog = openExportDialog();
      expect(openExportDialog()).toBe(dialog);
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    });

    it('closes on Escape, returning focus to the opener and the page its keys', () => {
      injectEditorPayload();
      const opener = /** @type {HTMLButtonElement} */ ($('button[aria-label="Export as GIF"]'));
      opener.focus();
      const onClose = vi.fn();
      dialog = openExportDialog({ opener, onClose });
      expect(countHotkeys('modal')).toBe(1);

      const escapeEvent = pressKey('Escape');
      expect(escapeEvent.defaultPrevented).toBe(true);
      expect($('[role="dialog"]')).toBeNull();
      expect(isExportDialogOpen()).toBe(false);
      expect(document.activeElement).toBe(opener);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect($('#app')?.hasAttribute('inert')).toBe(false);
      expect(countHotkeys('modal')).toBe(0);
      dialog = null;
    });

    it('falls back to the editor Export button when opened from <body> (Ctrl/Cmd+E)', () => {
      injectEditorPayload();
      dialog = openExportDialog({ opener: document.body });
      $('#export-dialog-close')?.click();
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Export as GIF');
      dialog = null;
    });

    it('drops the editor payload it was opened for when it closes', () => {
      injectEditorPayload();
      dialog = openExportDialog();
      expect(getEditorPayload()).not.toBeNull();
      dialog.close();
      dialog = null;
      // Left behind, the next editor mount would restore it instead of the
      // clip's own saved state
      expect(getEditorPayload()).toBeNull();
    });

    it('keeps Tab and Shift+Tab inside the dialog', () => {
      injectEditorPayload();
      dialog = openExportDialog();
      const focusable = [
        .../** @type {HTMLElement} */ ($('[role="dialog"]')).querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled])',
        ),
      ];
      const first = /** @type {HTMLElement} */ (focusable[0]);
      const last = /** @type {HTMLElement} */ (focusable.at(-1));
      expect(first.id).toBe('export-dialog-close');
      expect(last.id).toBe('export-start');

      last.focus();
      expect(pressKey('Tab').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      first.focus();
      expect(pressKey('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);

      // From the focused title, Shift+Tab wraps to the end too
      $('#export-dialog-title')?.focus();
      pressKey('Tab', { shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it('while encoding, Close and Escape are disabled and Cancel returns to the settings', async () => {
      injectEditorPayload();
      dialog = openExportDialog();
      clickExport();
      await Promise.resolve();

      expect($('#export-progress')).not.toBeNull();
      expect(/** @type {HTMLButtonElement} */ ($('#export-dialog-close')).disabled).toBe(true);
      expect(document.activeElement?.id).toBe('export-cancel');
      pressKey('Escape');
      expect(isExportDialogOpen()).toBe(true);

      $('#export-cancel')?.click();
      await vi.waitFor(() => expect($('#export-settings')).not.toBeNull());
      expect(getExportState()?.job).toBeNull();
      expect(/** @type {HTMLButtonElement} */ ($('#export-dialog-close')).disabled).toBe(false);
      expect(document.activeElement?.id).toBe('export-start');
    });

    it('closing from the editor aborts a running encode', async () => {
      injectEditorPayload();
      dialog = openExportDialog();
      clickExport();
      await Promise.resolve();
      const signal = /** @type {AbortSignal} */ (vi.mocked(encodeGif).mock.calls.at(-1)?.[1]);
      expect(signal.aborted).toBe(false);

      dialog.close({ restoreFocus: false });
      dialog = null;
      expect(signal.aborted).toBe(true);
      expect($('[role="dialog"]')).toBeNull();
    });
  });

  it('opens a re-opening on the settings instead of the previous GIF', async () => {
    injectEditorPayload();
    const blob = new Blob(['gif89a'], { type: 'image/gif' });
    vi.mocked(encodeGif).mockResolvedValueOnce(blob);

    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => {
      expect($('#export-result')).not.toBeNull();
    });
    expect(document.activeElement?.id).toBe('export-download');

    // Leave via "Back to editing"
    $('#export-back-to-editing')?.click();
    dialog = null;
    expect(isExportDialogOpen()).toBe(false);
    expect(getExportResult()).toBeNull();

    // Same clip, same selection, same settings: nothing distinguishes this
    // opening from the previous one, and it must still be a fresh export
    injectEditorPayload();
    dialog = openExportDialog();

    expect(getExportState()?.job).toBeNull();
    expect($('#export-result')).toBeNull();
    expect($('#export-settings')).not.toBeNull();
    expect($('#export-start')).not.toBeNull();
  });

  it('shows the GIF with its size, dimensions and frame count', async () => {
    injectEditorPayload();
    // A real (tiny) GIF: 2x1, two images
    const bytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
      // image 1
      0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
      // image 2
      0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b,
    ]);
    vi.mocked(encodeGif).mockResolvedValueOnce(new Blob([bytes], { type: 'image/gif' }));
    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());

    expect(/** @type {HTMLImageElement} */ ($('.export-result-img')).getAttribute('src')).toBe(
      'blob:test-export',
    );
    expect($('#export-result-size')?.textContent).toBe(`${bytes.length} B`);
    expect($('#export-result-dimensions')?.textContent).toBe('2×1');
    expect($('#export-result-frames')?.textContent).toBe('2');
    expect($('#export-download')).not.toBeNull();
    expect($('#export-open-tab')).not.toBeNull();
    // jsdom has no ClipboardItem: Copy is not offered
    expect($('#export-copy')).toBeNull();
  });

  it('releases the result object URL and the result when the dialog closes', async () => {
    injectEditorPayload();
    vi.mocked(encodeGif).mockResolvedValueOnce(new Blob(['gif89a'], { type: 'image/gif' }));

    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => {
      expect($('#export-result')).not.toBeNull();
    });

    dialog.close();
    dialog = null;

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-export');
    expect(getExportResult()).toBeNull();
  });

  it('clears the retained result when Export again is chosen', async () => {
    injectEditorPayload();
    const blob = new Blob(['gif89a'], { type: 'image/gif' });
    vi.mocked(encodeGif).mockResolvedValueOnce(blob);

    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => {
      expect($('#export-result')).not.toBeNull();
    });
    expect(getExportResult()?.blob).toBe(blob);

    $('#export-again')?.click();

    expect(getExportResult()).toBeNull();
    expect(getExportState()?.job).toBeNull();
    expect($('#export-settings')).not.toBeNull();
  });

  it('shows an encode failure with Back to settings', async () => {
    injectEditorPayload();
    vi.mocked(encodeGif).mockRejectedValueOnce(new Error('Worker exploded'));
    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => expect($('#export-error')).not.toBeNull());
    expect($('#export-error-message')?.textContent).toBe('Worker exploded');
    expect(document.activeElement?.id).toBe('export-error-back');
    $('#export-error-back')?.click();
    expect($('#export-settings')).not.toBeNull();
    expect(getExportState()?.job).toBeNull();
  });

  it('labels an encoding job with the encoder selected in settings', () => {
    injectEditorPayload();
    dialog = openExportDialog();
    const state = getExportState();
    window.__TEST_HOOKS__.setExportState({
      settings: { ...state?.settings, encoderId: 'gifsicle-wasm' },
    });

    clickExport();

    expect(getExportState()?.job?.encoder).toBe('gifsicle-wasm');
    expect(vi.mocked(encodeGif)).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ encoderId: 'gifsicle-wasm' }),
      }),
      expect.any(AbortSignal),
    );
  });

  it('throttles progress bar redraws but always renders the final 100% frame', async () => {
    injectEditorPayload();

    /** @type {((progress: { percent: number, current: number, total: number }) => void) | null} */
    let capturedOnProgress = null;
    /** @type {(() => void) | null} */
    let resolveEncode = null;
    vi.mocked(encodeGif).mockImplementationOnce((params) => {
      capturedOnProgress = params.onProgress;
      return new Promise((resolve) => {
        resolveEncode = () => resolve(new Blob(['gif89a'], { type: 'image/gif' }));
      });
    });

    dialog = openExportDialog();

    // Drain the mocked checkEncoderStatus().then(...) microtask scheduled
    // during mount before switching to fake timers below
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    // throttle() measures elapsed time from Date.now(); start the clock
    // well past 0 so the throttle's "lastCall = 0" sentinel doesn't make the
    // first progress event look like it's inside the throttle window.
    vi.setSystemTime(1_000_000);
    try {
      clickExport();
      await Promise.resolve();

      const bar = /** @type {HTMLProgressElement} */ ($('#export-progress-bar'));
      expect(capturedOnProgress).not.toBeNull();

      // Starting the job fires one throttled update (progress 0) which
      // consumes the throttle's initial allowance; advance past the window
      vi.advanceTimersByTime(20);

      // First real progress event applies immediately (outside the window)
      capturedOnProgress?.({ percent: 10, current: 1, total: 10 });
      expect(bar.value).toBe(10);

      // A second event inside the throttle window is queued, not drawn
      capturedOnProgress?.({ percent: 50, current: 5, total: 10 });
      expect(bar.value).toBe(10);

      // The final (100%) frame always bypasses the throttle
      capturedOnProgress?.({ percent: 100, current: 10, total: 10 });
      expect(bar.value).toBe(100);
      expect($('#export-progress-frames')?.textContent).toBe('10 / 4 frames');

      resolveEncode?.();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the armed trailing throttle timer when Cancel leaves the encoding state', async () => {
    // Regression: the subscriber only drove throttledUpdateProgressUI while
    // state.job.status === 'encoding'; on any other transition it left an
    // armed trailing timer running, which then called updateProgressUI with
    // the previous job's progress. Assert on the call directly.
    injectEditorPayload();

    const { updateProgressUI } = await import('../../../src/features/export/ui.js');

    /** @type {((progress: { percent: number, current: number, total: number }) => void) | null} */
    let capturedOnProgress = null;
    vi.mocked(encodeGif).mockImplementationOnce((params, signal) => {
      capturedOnProgress = params.onProgress;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Encoding cancelled', 'AbortError')),
          { once: true },
        );
      });
    });

    dialog = openExportDialog();
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      clickExport();
      await Promise.resolve();
      vi.advanceTimersByTime(20);

      // First event applies immediately (outside the throttle window)
      capturedOnProgress?.({ percent: 10, current: 1, total: 10 });
      const callsAfterFirstEvent = vi.mocked(updateProgressUI).mock.calls.length;

      // Second event lands inside the window: it arms a trailing timer
      capturedOnProgress?.({ percent: 55, current: 5, total: 10 });
      expect(vi.mocked(updateProgressUI).mock.calls.length).toBe(callsAfterFirstEvent);

      // Cancel while that trailing timer is still armed
      $('#export-cancel')?.dispatchEvent(new MouseEvent('click'));
      await Promise.resolve();
      await Promise.resolve();

      // Cancel returns to the settings: no job
      expect(getExportState()?.job).toBeNull();
      expect($('#export-settings')).not.toBeNull();

      const callsAfterCancel = vi.mocked(updateProgressUI).mock.calls.length;
      // Past when the trailing timer would have fired with the stale 55%
      vi.advanceTimersByTime(20);
      expect(vi.mocked(updateProgressUI).mock.calls.length).toBe(callsAfterCancel);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('nothing to export', () => {
    it('does not open without clip data, and says why on the bus', () => {
      const errors = vi.fn();
      const off = onBus('export:validation-error', errors);
      dialog = openExportDialog();
      off();
      expect(dialog).toBeNull();
      expect($('[role="dialog"]')).toBeNull();
      expect(errors).toHaveBeenCalledWith({ errors: ['No clip data available'] });
    });

    it('does not open when the selected range yields no frames', () => {
      const frames = createFrames(4);
      setClipPayload({ frames, fps: 30, capturedAt: Date.now() });
      // start > end → frames.slice() is empty
      setEditorPayload({ selectedRange: { start: 3, end: 1 }, cropArea: null, fps: 30 });

      dialog = openExportDialog();
      expect(dialog).toBeNull();
      expect($('[role="dialog"]')).toBeNull();
      // No inline handlers anywhere (the CSP has no 'unsafe-inline')
      expect(document.querySelector('[onclick]')).toBeNull();
    });
  });
});
