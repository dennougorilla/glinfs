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

/** @type {(() => void) | null} */
let exportCleanup = null;
/** @type {PropertyDescriptor | undefined} */
let createObjectUrlDescriptor;
/** @type {PropertyDescriptor | undefined} */
let revokeObjectUrlDescriptor;

function createFrames(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    timestamp: index * 33.33,
    width: 16,
    height: 12,
  }));
}

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

  it('restores a retained GIF as a completed job on Export revisit (#46)', () => {
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

  it('retains the result across route cleanup and releases its object URL (#46)', () => {
    injectEditorPayload();
    const blob = new Blob(['gif89a'], { type: 'image/gif' });
    setExportResult({ blob, filename: 'saved.gif', completedAt: Date.now() });
    exportCleanup = initExport();

    exportCleanup();
    exportCleanup = null;

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-export');
    expect(getExportResult()?.blob).toBe(blob);
  });

  it('clears the retained result when Adjust & Re-export is chosen (#46)', () => {
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

  it('labels an encoding job with the encoder selected in settings (#46)', () => {
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

  it('updates the play/pause icon, class, title and aria-label immediately (#62)', () => {
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
