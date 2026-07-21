import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGif } from '../../../src/features/export/api.js';
import { getExportState, initExport } from '../../../src/features/export/index.js';
import {
  getExportResult,
  resetAppStore,
  setClipPayload,
  setEditorPayload,
  setExportResult,
} from '../../../src/shared/app-store.js';

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
// depending on DOM structure that the error/cancelled screen doesn't have
// (it has no .progress-bar-fill, so a stale write there would otherwise be
// unobservable from the DOM alone).
vi.mock('../../../src/features/export/ui.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateProgressUI: vi.fn(actual.updateProgressUI),
  };
});

/** @type {(() => void) | null} */
let exportCleanup = null;
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

describe('Export regressions', () => {
  beforeEach(() => {
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = {};
    document.body.innerHTML = '<main id="main-content"></main>';

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

    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
      return /** @type {CanvasRenderingContext2D} */ ({
        canvas: this,
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
      });
    });
  });

  afterEach(() => {
    exportCleanup?.();
    exportCleanup = null;
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

  it('restores a retained GIF as a completed job on Export revisit', () => {
    injectEditorPayload();
    const blob = new Blob(['gif89a'], { type: 'image/gif' });
    setExportResult({ blob, filename: 'saved.gif', completedAt: Date.now() });

    exportCleanup = initExport();

    expect(getExportState()?.job).toMatchObject({
      status: 'complete',
      progress: 100,
      totalFrames: 4,
      encoder: 'gifenc-js',
      result: blob,
    });
    expect(document.querySelector('.export-complete-v2')).not.toBeNull();
    expect(getExportResult()?.blob).toBe(blob);
  });

  it('retains the result across route cleanup and releases its object URL', () => {
    injectEditorPayload();
    const blob = new Blob(['gif89a'], { type: 'image/gif' });
    setExportResult({ blob, filename: 'saved.gif', completedAt: Date.now() });
    exportCleanup = initExport();

    exportCleanup();
    exportCleanup = null;

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-export');
    expect(getExportResult()?.blob).toBe(blob);
  });

  it('clears the retained result when Adjust & Re-export is chosen', () => {
    injectEditorPayload();
    setExportResult({
      blob: new Blob(['gif89a'], { type: 'image/gif' }),
      filename: 'saved.gif',
      completedAt: Date.now(),
    });
    exportCleanup = initExport();

    const adjustButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Adjust & Re-export'),
    );
    adjustButton?.click();

    expect(getExportResult()).toBeNull();
    expect(getExportState()?.job).toBeNull();
    expect(document.querySelector('.export-settings-panel')).not.toBeNull();
  });

  it('labels an encoding job with the encoder selected in settings', () => {
    injectEditorPayload();
    exportCleanup = initExport();
    const state = getExportState();
    window.__TEST_HOOKS__.setExportState({
      settings: { ...state?.settings, encoderId: 'gifsicle-wasm' },
    });

    document.querySelector('.btn-export-main')?.dispatchEvent(new MouseEvent('click'));

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

    exportCleanup = initExport();

    // Drain the mocked checkEncoderStatus().then(...) microtask scheduled
    // during mount before switching to fake timers below — otherwise it
    // resolves mid-test and its (harmless, unrelated) state update rides
    // along on the throttle timing we're about to assert on.
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    // throttle() measures elapsed time from Date.now(); start the clock
    // well past 0 so the throttle's internal "lastCall = 0" sentinel
    // doesn't make the very first progress event look like it's inside
    // the throttle window.
    vi.setSystemTime(1_000_000);
    try {
      document.querySelector('.btn-export-main')?.dispatchEvent(new MouseEvent('click'));
      await Promise.resolve();

      const fill = /** @type {HTMLElement} */ (document.querySelector('.progress-bar-fill'));
      expect(capturedOnProgress).not.toBeNull();

      // Starting the job itself fires one throttled update (progress 0,
      // against the pre-render DOM) which consumes the throttle's initial
      // "no prior call" allowance. Advance the clock past the throttle
      // window, as real elapsed time would between job start and the
      // first worker PROGRESS message, before asserting on real updates.
      vi.advanceTimersByTime(20);

      // First real progress event applies immediately (outside the window).
      capturedOnProgress?.({ percent: 10, current: 1, total: 10 });
      expect(fill.style.width).toBe('10%');

      // A second event arriving inside the throttle window is queued, not
      // drawn immediately.
      capturedOnProgress?.({ percent: 50, current: 5, total: 10 });
      expect(fill.style.width).toBe('10%');

      // The final (100%) frame always bypasses the throttle so the bar
      // reaches "done" instead of possibly stalling on a queued mid-value.
      capturedOnProgress?.({ percent: 100, current: 10, total: 10 });
      expect(fill.style.width).toBe('100%');

      resolveEncode?.();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the armed trailing throttle timer when leaving the encoding state', async () => {
    // Regression: the subscriber only drove throttledUpdateProgressUI while
    // state.job.status === 'encoding'; on any other transition it left an
    // already-armed trailing timer running. That timer would fire ~16ms
    // later and call updateProgressUI with the *previous* job's progress —
    // a call that's a visual no-op right now only because the error screen
    // happens to lack a .progress-bar-fill element, so DOM assertions alone
    // can't see the bug. Assert on the call directly instead.
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

    exportCleanup = initExport();

    // Drain the mocked checkEncoderStatus().then(...) microtask (see the
    // throttling test above for why this must happen before fake timers).
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      document.querySelector('.btn-export-main')?.dispatchEvent(new MouseEvent('click'));
      await Promise.resolve();

      // Consume the throttle's initial "no prior call" allowance, same as
      // the throttling test above.
      vi.advanceTimersByTime(20);

      // First event applies immediately (outside the throttle window).
      capturedOnProgress?.({ percent: 10, current: 1, total: 10 });
      const callsAfterFirstEvent = vi.mocked(updateProgressUI).mock.calls.length;

      // Second event lands inside the window: throttled, so it does NOT
      // call updateProgressUI yet — it arms a trailing setTimeout instead.
      capturedOnProgress?.({ percent: 55, current: 5, total: 10 });
      expect(vi.mocked(updateProgressUI).mock.calls.length).toBe(callsAfterFirstEvent);

      // Cancel while that trailing timer is still armed.
      const cancelBtn = Array.from(document.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Cancel',
      );
      cancelBtn?.dispatchEvent(new MouseEvent('click'));
      await Promise.resolve();
      await Promise.resolve();

      // cancelEncodingState models a user cancel as job.status 'error' with
      // a specific message (there's no separate 'cancelled' status).
      expect(getExportState()?.job?.status).toBe('error');
      expect(getExportState()?.job?.error).toBe('Encoding cancelled by user');

      const callsAfterCancel = vi.mocked(updateProgressUI).mock.calls.length;

      // Advance past when the trailing timer would have fired with the
      // stale 55% job1 data. With the fix, leaving 'encoding' cancels it,
      // so no further call happens here.
      vi.advanceTimersByTime(20);

      expect(vi.mocked(updateProgressUI).mock.calls.length).toBe(callsAfterCancel);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the play/pause icon, class, title and aria-label immediately', () => {
    injectEditorPayload();
    exportCleanup = initExport();
    const button = /** @type {HTMLButtonElement} */ (
      document.querySelector('.export-preview-play-btn')
    );

    expect(button.getAttribute('aria-label')).toBe('Pause preview');
    button.click();
    expect(getExportState()?.preview.isPlaying).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Play preview');
    expect(button.getAttribute('title')).toBe('Play (Space)');
    expect(button.classList.contains('playing')).toBe(false);
    expect(button.textContent).toBe('\u25B6');

    button.click();
    expect(getExportState()?.preview.isPlaying).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Pause preview');
    expect(button.getAttribute('title')).toBe('Pause (Space)');
    expect(button.classList.contains('playing')).toBe(true);
    expect(button.textContent).toBe('\u23F8');
  });
});
