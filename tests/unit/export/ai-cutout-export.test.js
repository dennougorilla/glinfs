/**
 * Export screen with the AI cutout: frames without masks are analyzed
 * before encoding (segmentation manager faked), the final masks reach
 * encodeGif, and the no-WebGPU choice / errors / cancel show their views.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/ai-cutout/segmentation-manager.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  const fake = { getCapabilities: vi.fn(async () => ({ webgpu: true })), analyzeFrames: vi.fn() };
  return { ...actual, getSegmentationManager: () => fake, __fake: fake };
});

vi.mock('../../../src/shared/edits/compose.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, snapCanvasAlphaToBinary: vi.fn() };
});

vi.mock('../../../src/features/export/api.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    checkEncoderStatus: vi.fn(async () => 'gifenc-js'),
    encodeGif: vi.fn(() => new Promise(() => {})),
  };
});

import { getSharedMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import {
  createAbortError,
  SegmentationError,
  SegmentationErrorCode,
} from '../../../src/features/ai-cutout/protocol.js';
import * as segmentation from '../../../src/features/ai-cutout/segmentation-manager.js';
import { getSharedFinalMaskCache, setWasmAllowed } from '../../../src/features/editor/ai-cutout.js';
import { encodeGif } from '../../../src/features/export/api.js';
import { initExport } from '../../../src/features/export/index.js';
import { describeAiPreparation } from '../../../src/features/export/ui.js';
import { resetAppStore, setClipPayload, setEditorPayload } from '../../../src/shared/app-store.js';

const fake = /** @type {any} */ (segmentation).__fake;
const COUNT = 6;

/** @param {string} key */
function storeMask(key) {
  getSharedMaskStore().set(
    key,
    { data: new Uint8Array(16 * 12).fill(255), width: 16, height: 12 },
    'clip-x',
  );
}

function inject() {
  const frames = Array.from({ length: COUNT }, (_, index) => ({
    id: `x${index}`,
    timestamp: index,
    width: 16,
    height: 12,
  }));
  const selectedRange = { start: 1, end: 4 };
  const edits = { textLayers: [], background: { enabled: true, method: 'ai' } };
  setClipPayload(/** @type {any} */ ({ frames, fps: 30, capturedAt: Date.now(), id: 'clip-x' }));
  setEditorPayload(
    /** @type {any} */ ({
      selectedRange,
      cropArea: null,
      clip: { id: 'c', frames, selectedRange, cropArea: null, createdAt: 0, fps: 30 },
      fps: 30,
      edits,
    }),
  );
}

/** @param {string} selector */
function $(selector) {
  return /** @type {HTMLElement | null} */ (document.querySelector(selector));
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('Export with the AI cutout', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    resetAppStore();
    getSharedMaskStore().clear();
    getSharedFinalMaskCache().clear();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<main id="main-content"></main>';
    vi.mocked(encodeGif).mockClear();
    fake.analyzeFrames.mockReset();
    fake.analyzeFrames.mockImplementation(async (frames, options) => {
      const pending = segmentation.collectPendingFrames(frames, getSharedMaskStore());
      options.onProgress?.({
        phase: 'downloading',
        loadedBytes: 1,
        totalBytes: 2,
        fromCache: false,
        framesDone: 0,
        framesTotal: pending.length,
        backend: null,
        frameMs: null,
      });
      let done = 0;
      for (const { key } of pending) {
        storeMask(key);
        done++;
        options.onProgress?.({
          phase: 'analyzing',
          loadedBytes: 2,
          totalBytes: 2,
          fromCache: false,
          framesDone: done,
          framesTotal: pending.length,
          backend: 'webgpu',
          frameMs: 1,
        });
      }
      return { analyzed: pending.length, skipped: 0, backend: 'webgpu' };
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    getSharedMaskStore().clear();
    setWasmAllowed(false);
    vi.unstubAllGlobals();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
  });

  it('says how many exported frames need the analysis and analyzes only those first', async () => {
    storeMask('x1');
    storeMask('x2');
    inject();
    cleanup = /** @type {() => void} */ (initExport());
    await flush();
    expect($('#export-ai-note')?.hidden).toBe(false);
    expect($('#export-ai-note')?.textContent).toBe(
      '2 of 4 frames are not analyzed yet. Export analyzes them first (they preview without the cutout).',
    );

    $('.btn-export-main')?.click();
    await flush();
    await flush();
    expect(fake.analyzeFrames).toHaveBeenCalledTimes(1);
    const [analyzed, options] = fake.analyzeFrames.mock.calls[0];
    expect(analyzed.map((/** @type {any} */ f) => f.id)).toEqual(['x1', 'x2', 'x3', 'x4']);
    expect(options).toMatchObject({ clipId: 'clip-x', allowWasm: false });

    expect(encodeGif).toHaveBeenCalledTimes(1);
    const params = vi.mocked(encodeGif).mock.calls[0][0];
    expect(params.maskSource).not.toBeNull();
    for (const index of [1, 2, 3, 4]) {
      expect(params.maskSource?.getFinalMask(index)).not.toBeNull();
    }
    expect($('.export-progress')).not.toBeNull();
  });

  it('shows analysis progress with Cancel, and cancel returns to the settings', async () => {
    inject();
    cleanup = /** @type {() => void} */ (initExport());
    await flush();
    /** @type {(() => void) | null} */
    let proceed = null;
    fake.analyzeFrames.mockImplementationOnce(
      (/** @type {any} */ _frames, /** @type {any} */ options) =>
        new Promise((_resolve, reject) => {
          options.onProgress({
            phase: 'analyzing',
            loadedBytes: 2,
            totalBytes: 2,
            fromCache: true,
            framesDone: 1,
            framesTotal: 4,
            backend: 'wasm',
            frameMs: 10,
          });
          proceed = () => undefined;
          options.signal.addEventListener('abort', () => reject(createAbortError()));
        }),
    );
    $('.btn-export-main')?.click();
    await flush();
    expect(proceed).not.toBeNull();
    expect($('#export-ai-prep')).not.toBeNull();
    expect($('#export-ai-progress-text')?.textContent).toMatch(/^Analyzed 1 of 4 frames/);
    expect(/** @type {HTMLProgressElement} */ ($('#export-ai-progress-bar')).value).toBe(0.25);
    expect($('.export-settings-panel')).toBeNull();

    $('#export-ai-cancel')?.click();
    await flush();
    expect($('#export-ai-prep')).toBeNull();
    expect($('.export-settings-panel')).not.toBeNull();
    expect(encodeGif).not.toHaveBeenCalled();
  });

  it('asks for the explicit slow choice without WebGPU, then runs with WASM allowed', async () => {
    inject();
    cleanup = /** @type {() => void} */ (initExport());
    await flush();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.WEBGPU_UNAVAILABLE, 'none'),
    );
    $('.btn-export-main')?.click();
    await flush();
    expect($('#export-ai-prep')?.textContent).toContain('WebGPU is not available');
    expect(encodeGif).not.toHaveBeenCalled();

    // Back to the settings, then Export again and choose the slow path
    $('#export-ai-back')?.click();
    expect($('.export-settings-panel')).not.toBeNull();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.WEBGPU_UNAVAILABLE, 'none'),
    );
    $('.btn-export-main')?.click();
    await flush();
    $('#export-ai-run-wasm')?.click();
    await flush();
    await flush();
    expect(fake.analyzeFrames.mock.calls.at(-1)[1].allowWasm).toBe(true);
    expect(encodeGif).toHaveBeenCalledTimes(1);
  });

  it('shows other failures with Retry', async () => {
    inject();
    cleanup = /** @type {() => void} */ (initExport());
    await flush();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.HASH_MISMATCH, 'bad'),
    );
    $('.btn-export-main')?.click();
    await flush();
    expect($('#export-ai-prep')?.textContent).toContain('could not be prepared');
    expect($('#export-ai-prep [role="alert"]')?.textContent).toContain('damaged');
    $('#export-ai-retry')?.click();
    await flush();
    await flush();
    expect(encodeGif).toHaveBeenCalledTimes(1);
  });

  it('describes the build step', () => {
    expect(describeAiPreparation({ phase: 'building', buildDone: 3, buildTotal: 12 })).toBe(
      'Building the cutout: 25%',
    );
    expect(describeAiPreparation({ phase: 'building' })).toBe('Building the cutout: 0%');
    expect(describeAiPreparation({ phase: 'starting' })).toBe('Preparing…');
  });
});
