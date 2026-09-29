/**
 * Export dialog with the AI cutout: frames without masks are analyzed
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
import { getExportState, openExportDialog } from '../../../src/features/export/index.js';
import { describeAiPreparation } from '../../../src/features/export/ui.js';
import { resetAppStore, setClipPayload, setEditorPayload } from '../../../src/shared/app-store.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

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

/** @param {{ count?: number, range?: { start: number, end: number } }} [options] */
function inject({ count = COUNT, range = { start: 1, end: 4 } } = {}) {
  const frames = Array.from({ length: count }, (_, index) => ({
    id: `x${index}`,
    timestamp: index,
    width: 16,
    height: 12,
  }));
  const selectedRange = range;
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
  /** @type {import('../../../src/features/export/index.js').ExportDialogHandle | null} */
  let dialog = null;

  beforeEach(() => {
    resetAppStore();
    getSharedMaskStore().clear();
    getSharedFinalMaskCache().clear();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="app"><main id="main-content"></main></div>';
    vi.mocked(encodeGif).mockClear();
    fake.analyzeFrames.mockReset();
    fake.analyzeFrames.mockImplementation(async (frames, options) => {
      const pending = segmentation.collectPendingFrames(
        frames,
        getSharedMaskStore(),
        options.modelId,
      );
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
    dialog?.close();
    dialog = null;
    resetAppStore();
    getSharedMaskStore().clear();
    setWasmAllowed(false);
    vi.unstubAllGlobals();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
  });

  it('says how many exported frames need the analysis and analyzes only those first', async () => {
    storeMask('anime:x1');
    storeMask('anime:x2');
    inject();
    dialog = openExportDialog();
    await flush();
    expect($('#export-ai-note')?.hidden).toBe(false);
    expect($('#export-ai-note')?.textContent).toBe(
      '2 of 4 frames are not analyzed yet. Export analyzes them first (the editor previews them without the cutout).',
    );

    $('#export-start')?.click();
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
    expect($('#export-progress')).not.toBeNull();
  });

  it('shows analysis progress with Cancel, and cancel returns to the settings', async () => {
    inject();
    dialog = openExportDialog();
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
    $('#export-start')?.click();
    await flush();
    expect(proceed).not.toBeNull();
    expect($('#export-ai-prep')).not.toBeNull();
    expect($('#export-ai-progress-text')?.textContent).toMatch(/^Analyzed 1 of 4 frames/);
    expect(/** @type {HTMLProgressElement} */ ($('#export-ai-progress-bar')).value).toBe(0.25);
    expect($('#export-settings')).toBeNull();

    $('#export-ai-cancel')?.click();
    await flush();
    expect($('#export-ai-prep')).toBeNull();
    expect($('#export-settings')).not.toBeNull();
    expect(encodeGif).not.toHaveBeenCalled();
  });

  it('asks for the explicit slow choice without WebGPU, then runs with WASM allowed', async () => {
    inject();
    dialog = openExportDialog();
    await flush();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.WEBGPU_UNAVAILABLE, 'none'),
    );
    $('#export-start')?.click();
    await flush();
    expect($('#export-ai-prep')?.textContent).toContain('WebGPU is not available');
    expect(encodeGif).not.toHaveBeenCalled();

    // Back to the settings, then Export again and choose the slow path
    $('#export-ai-back')?.click();
    expect($('#export-settings')).not.toBeNull();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.WEBGPU_UNAVAILABLE, 'none'),
    );
    $('#export-start')?.click();
    await flush();
    $('#export-ai-run-wasm')?.click();
    await flush();
    await flush();
    expect(fake.analyzeFrames.mock.calls.at(-1)[1].allowWasm).toBe(true);
    expect(encodeGif).toHaveBeenCalledTimes(1);
  });

  it('names the model when it could not run on WebGPU (the browser has WebGPU)', async () => {
    inject();
    dialog = openExportDialog();
    await flush();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.WEBGPU_MODEL_FAILED, 'shader limits'),
    );
    $('#export-start')?.click();
    await flush();
    const text = $('#export-ai-prep')?.textContent ?? '';
    expect(text).toContain('The Anime model could not run on WebGPU');
    expect(text).not.toContain('WebGPU is not available');
    expect($('#export-ai-run-wasm')).not.toBeNull();
    expect(encodeGif).not.toHaveBeenCalled();
  });

  it('shows other failures with Retry', async () => {
    inject();
    dialog = openExportDialog();
    await flush();
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.HASH_MISMATCH, 'bad'),
    );
    $('#export-start')?.click();
    await flush();
    expect($('#export-ai-prep')?.textContent).toContain('could not be prepared');
    expect($('#export-ai-prep [role="alert"]')?.textContent).toContain('damaged');
    $('#export-ai-retry')?.click();
    await flush();
    await flush();
    expect(encodeGif).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cancelled', () => $('#export-ai-cancel')?.click()],
    ['failed', null],
  ])(
    'keeps the frames analyzed before the analysis was %s (the editor rebuilds from them)',
    async (_label, stop) => {
      inject();
      dialog = openExportDialog();
      await flush();
      /** @type {((error: unknown) => void) | null} */
      let fail = null;
      fake.analyzeFrames.mockImplementationOnce(
        (/** @type {any} */ _frames, /** @type {any} */ options) =>
          new Promise((_resolve, reject) => {
            // Half of the exported frames finish before the stop
            storeMask('anime:x1');
            storeMask('anime:x2');
            fail = reject;
            options.signal.addEventListener('abort', () => reject(createAbortError()));
          }),
      );
      $('#export-start')?.click();
      await flush();

      if (stop) {
        stop();
      } else {
        /** @type {any} */ (fail)(new SegmentationError(SegmentationErrorCode.WORKER_CRASHED, 'x'));
        await flush();
        expect($('#export-ai-prep')?.textContent).toContain('could not be prepared');
        // A failed preparation is not running: the dialog can be closed
        expect(/** @type {HTMLButtonElement} */ ($('#export-dialog-close')).disabled).toBe(false);
        $('#export-ai-back')?.click();
      }
      await flush();
      expect($('#export-settings')).not.toBeNull();
      expect(getSharedMaskStore().has('anime:x1')).toBe(true);
      expect(getSharedMaskStore().has('anime:x2')).toBe(true);
      expect(getSharedMaskStore().has('anime:x3')).toBe(false);
      expect(encodeGif).not.toHaveBeenCalled();
      // The note counts what is still missing
      expect($('#export-ai-note')?.textContent).toMatch(/^2 of 4 frames/);
    },
  );

  it('disables Close and Escape while the analysis runs', async () => {
    inject();
    dialog = openExportDialog();
    await flush();
    fake.analyzeFrames.mockImplementationOnce(
      (/** @type {any} */ _frames, /** @type {any} */ options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(createAbortError()));
        }),
    );
    $('#export-start')?.click();
    await flush();
    expect($('#export-ai-prep')).not.toBeNull();
    expect(/** @type {HTMLButtonElement} */ ($('#export-dialog-close')).disabled).toBe(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect($('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement?.id).toBe('export-ai-cancel');
  });

  /**
   * encodeGif answers: sample encodes (frameIndices given) at `sampleBytes`
   * for their frame skip, full encodes small enough for any target
   * @param {Record<number, number>} sampleBytes
   */
  function encodeBySkip(sampleBytes) {
    vi.mocked(encodeGif).mockImplementation(async (params) =>
      params.frameIndices
        ? /** @type {any} */ ({ size: sampleBytes[params.settings.frameSkip] ?? 100 })
        : new Blob([new Uint8Array(10)], { type: 'image/gif' }),
    );
  }

  it('with a target size, analyzes the samples it estimates and only the rung it encodes', async () => {
    // Range 0..9, frame skip 2 chosen: the ladder could also try skip 3,
    // whose frames (3, 9) skip 2 never touches
    updateSetting('export', 'frameSkip', 2);
    updateSetting('export', 'targetSizeMB', 5);
    inject({ count: 10, range: { start: 0, end: 9 } });
    encodeBySkip({});
    dialog = openExportDialog();
    await flush();
    // The note counts the frames of the settings (the ladder's first rung)
    expect($('#export-ai-note')?.textContent).toMatch(/^5 of 5 frames/);

    $('#export-start')?.click();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());
    // The first rung fits: its sample is every frame it exports, so the
    // encode needs no more analysis, and 3 and 9 are never analyzed
    expect(fake.analyzeFrames).toHaveBeenCalledTimes(1);
    const [analyzed] = fake.analyzeFrames.mock.calls[0];
    expect(analyzed.map((/** @type {any} */ f) => f.id)).toEqual(['x0', 'x2', 'x4', 'x6', 'x8']);
    expect(getSharedMaskStore().has('x3')).toBe(false);
    expect(getSharedMaskStore().has('x9')).toBe(false);
  });

  it('with a target size, prepares a later rung when the ladder gets to it', async () => {
    updateSetting('export', 'frameSkip', 2);
    updateSetting('export', 'targetSizeMB', 5);
    inject({ count: 10, range: { start: 0, end: 9 } });
    // Every skip-2 rung is estimated over the target; skip 3 fits
    encodeBySkip({ 2: 50_000_000 });
    dialog = openExportDialog();
    await flush();

    $('#export-start')?.click();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());
    const analyzed = fake.analyzeFrames.mock.calls.map((/** @type {any} */ [frames]) =>
      frames.map((/** @type {any} */ f) => f.id),
    );
    expect(analyzed).toEqual([
      ['x0', 'x2', 'x4', 'x6', 'x8'],
      ['x0', 'x3', 'x6', 'x9'],
    ]);
    const full = vi
      .mocked(encodeGif)
      .mock.calls.map(([params]) => params)
      .filter((params) => !params.frameIndices);
    expect(full).toHaveLength(1);
    expect(full[0].settings.frameSkip).toBe(3);
    for (const index of [0, 3, 6, 9]) {
      expect(full[0].maskSource?.getFinalMask(index)).not.toBeNull();
    }
  });

  it('with a target size, a failed analysis mid-way shows the AI error, and Back the settings', async () => {
    updateSetting('export', 'frameSkip', 2);
    updateSetting('export', 'targetSizeMB', 5);
    inject({ count: 10, range: { start: 0, end: 9 } });
    encodeBySkip({ 2: 50_000_000 });
    const analyze = fake.analyzeFrames.getMockImplementation();
    fake.analyzeFrames.mockImplementationOnce(analyze);
    fake.analyzeFrames.mockRejectedValueOnce(
      new SegmentationError(SegmentationErrorCode.HASH_MISMATCH, 'bad'),
    );
    dialog = openExportDialog();
    await flush();

    $('#export-start')?.click();
    await vi.waitFor(() =>
      expect($('#export-ai-prep')?.textContent).toContain('could not be prepared'),
    );
    expect(getExportState()?.job).toBeNull();
    $('#export-ai-back')?.click();
    expect($('#export-settings')).not.toBeNull();
  });

  it('describes the build step', () => {
    expect(describeAiPreparation({ phase: 'building', buildDone: 3, buildTotal: 12 })).toBe(
      'Building the cutout: 25%',
    );
    expect(describeAiPreparation({ phase: 'building' })).toBe('Building the cutout: 0%');
    expect(describeAiPreparation({ phase: 'starting' })).toBe('Preparing…');
  });
});
