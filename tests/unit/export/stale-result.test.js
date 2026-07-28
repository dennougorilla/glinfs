import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeResultFingerprint,
  getExportState,
  initExport,
} from '../../../src/features/export/index.js';
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
  };
});

/** @type {(() => void) | null} */
let exportCleanup = null;

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
 * @param {import('../../../src/features/capture/types.js').Frame[]} frames
 * @param {{ start: number, end: number }} selectedRange
 */
function injectPayloads(frames, selectedRange) {
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

/**
 * Fingerprint matching what initExport computes for the given visit,
 * using the default settings a fresh store loads.
 * @param {{ start: number, end: number }} selectedRange
 */
function fingerprintFor(selectedRange) {
  const frameCount = selectedRange.end - selectedRange.start + 1;
  const settings = getExportState()?.settings;
  if (!settings) throw new Error('export state not initialized');
  return computeResultFingerprint(selectedRange, null, frameCount, 30, settings);
}

describe('Stale export result invalidation (re-review P1)', () => {
  beforeEach(() => {
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = {};
    document.body.innerHTML = '<main id="main-content"></main>';
  });

  afterEach(() => {
    exportCleanup?.();
    exportCleanup = null;
    resetAppStore();
    document.body.innerHTML = '';
    delete window.__TEST_HOOKS__;
    vi.restoreAllMocks();
  });

  it('restores a saved result when the visit matches its fingerprint', () => {
    const frames = createFrames(6);
    const range = { start: 0, end: 5 };
    injectPayloads(frames, range);

    // First mount establishes the settings used for the fingerprint
    exportCleanup = initExport();
    const fingerprint = fingerprintFor(range);
    exportCleanup();

    const blob = new Blob(['gif-a'], { type: 'image/gif' });
    setExportResult({ blob, filename: 'a.gif', completedAt: 1, fingerprint });

    injectPayloads(frames, range);
    exportCleanup = initExport();

    const state = getExportState();
    expect(state?.job?.status).toBe('complete');
    expect(state?.job?.result).toBe(blob);
  });

  it('refuses to restore when the selection changed, and drops the stale result', () => {
    const frames = createFrames(6);
    injectPayloads(frames, { start: 0, end: 5 });
    exportCleanup = initExport();
    const staleFingerprint = fingerprintFor({ start: 0, end: 5 });
    exportCleanup();

    setExportResult({
      blob: new Blob(['gif-a'], { type: 'image/gif' }),
      filename: 'a.gif',
      completedAt: 1,
      fingerprint: staleFingerprint,
    });

    // Same clip, narrower selection — must re-encode, not resurrect
    injectPayloads(frames, { start: 1, end: 3 });
    exportCleanup = initExport();

    const state = getExportState();
    expect(state?.job).toBeNull();
    expect(getExportResult()).toBeNull();
  });

  it('refuses to restore a result saved without a fingerprint', () => {
    const frames = createFrames(4);
    const range = { start: 0, end: 3 };
    setExportResult({
      blob: new Blob(['legacy'], { type: 'image/gif' }),
      filename: 'legacy.gif',
      completedAt: 1,
    });

    injectPayloads(frames, range);
    exportCleanup = initExport();

    expect(getExportState()?.job).toBeNull();
    expect(getExportResult()).toBeNull();
  });

  it('a new clip invalidates the previous export result at the store level', () => {
    setExportResult({
      blob: new Blob(['old-clip'], { type: 'image/gif' }),
      filename: 'old.gif',
      completedAt: 1,
      fingerprint: 'anything',
    });

    // User goes back to Capture via the header (never pressing Create New
    // GIF) and creates a clip — the old result must not survive
    setClipPayload({ frames: createFrames(3), fps: 30, capturedAt: Date.now() });

    expect(getExportResult()).toBeNull();
  });
});
