import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Every visit to the Export screen starts a new export session. A GIF encoded
 * on an earlier visit must never come back as this visit's "complete" state:
 * that left the user staring at the previous GIF with no Export button unless
 * they happened to return through "Adjust & Re-export".
 */
describe('Export result is scoped to a single visit', () => {
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

  it('drops the saved result when leaving the screen', () => {
    const frames = createFrames(6);
    injectPayloads(frames, { start: 0, end: 5 });
    exportCleanup = initExport();

    setExportResult({
      blob: new Blob(['gif-a'], { type: 'image/gif' }),
      filename: 'a.gif',
      completedAt: 1,
    });

    exportCleanup();
    exportCleanup = null;

    expect(getExportResult()).toBeNull();
  });

  it('opens on the settings panel even when a result survived, and discards it', () => {
    const frames = createFrames(6);
    const range = { start: 0, end: 5 };

    // Identical inputs to the previous export — the case that used to
    // resurrect the old GIF because every encode input still matched
    setExportResult({
      blob: new Blob(['gif-a'], { type: 'image/gif' }),
      filename: 'a.gif',
      completedAt: 1,
    });

    injectPayloads(frames, range);
    exportCleanup = initExport();

    expect(getExportState()?.job).toBeNull();
    expect(document.querySelector('.export-settings-panel')).not.toBeNull();
    expect(document.querySelector('.export-complete-v2')).toBeNull();
  });

  it('does not restore a result after the selection changed either', () => {
    const frames = createFrames(6);
    injectPayloads(frames, { start: 0, end: 5 });
    exportCleanup = initExport();
    exportCleanup();

    setExportResult({
      blob: new Blob(['gif-a'], { type: 'image/gif' }),
      filename: 'a.gif',
      completedAt: 1,
    });

    // Same clip, narrower selection — must re-encode, not resurrect
    injectPayloads(frames, { start: 1, end: 3 });
    exportCleanup = initExport();

    expect(getExportState()?.job).toBeNull();
  });

  it('a new clip invalidates the previous export result at the store level', () => {
    setExportResult({
      blob: new Blob(['old-clip'], { type: 'image/gif' }),
      filename: 'old.gif',
      completedAt: 1,
    });

    // User goes back to Capture via the header (never pressing Create New
    // GIF) and creates a clip — the old result must not survive
    setClipPayload({ frames: createFrames(3), fps: 30, capturedAt: Date.now() });

    expect(getExportResult()).toBeNull();
  });
});
