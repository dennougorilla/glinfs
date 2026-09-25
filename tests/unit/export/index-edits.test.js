import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGif } from '../../../src/features/export/api.js';
import { getExportState, initExport } from '../../../src/features/export/index.js';
import { TRANSPARENT_ENCODER_NOTE } from '../../../src/features/export/ui.js';
import {
  resetAppStore,
  setClipPayload,
  setEditorPayload,
  setExportResult,
} from '../../../src/shared/app-store.js';
import { snapCanvasAlphaToBinary } from '../../../src/shared/edits/compose.js';
import { createDefaultEdits, createTextLayer } from '../../../src/shared/edits/model.js';
import { loadSettings, updateSetting } from '../../../src/shared/user-settings.js';

/**
 * Export screen wiring for edits, transparency and imported clips.
 */

// jsdom has no pixel readback: record the 1-bit alpha snap instead of running it
vi.mock('../../../src/shared/edits/compose.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, snapCanvasAlphaToBinary: vi.fn() };
});

vi.mock('../../../src/features/export/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkEncoderStatus: vi.fn(async () => 'gifenc-js'),
    encodeGif: vi.fn(() => new Promise(() => {})),
  };
});

/** @type {(() => void) | null} */
let exportCleanup = null;

/**
 * @param {{ editorExtras?: Record<string, unknown>, clipExtras?: Record<string, unknown>, clipLevel?: Record<string, unknown>, range?: { start: number, end: number }, count?: number }} [options]
 */
function inject({ editorExtras = {}, clipExtras = {}, clipLevel = {}, range, count = 10 } = {}) {
  const frames = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    timestamp: index,
    width: 16,
    height: 12,
  }));
  const selectedRange = range ?? { start: 0, end: count - 1 };
  setClipPayload(/** @type {any} */ ({ frames, fps: 30, capturedAt: Date.now(), ...clipExtras }));
  setEditorPayload(
    /** @type {any} */ ({
      selectedRange,
      cropArea: null,
      clip: { id: 'c', frames, selectedRange, cropArea: null, createdAt: 0, fps: 30, ...clipLevel },
      fps: 30,
      ...editorExtras,
    }),
  );
}

function clickExport() {
  document.querySelector('.btn-export-main')?.dispatchEvent(new MouseEvent('click'));
}

/** @returns {any} */
function lastEncodeParams() {
  return vi.mocked(encodeGif).mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
  window.__TEST_HOOKS__ = {};
  document.body.innerHTML = '<main id="main-content"></main>';
  vi.mocked(encodeGif).mockClear();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
    return /** @type {CanvasRenderingContext2D} */ (
      /** @type {unknown} */ ({
        canvas: this,
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
      })
    );
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
});

describe('export screen: plain screen captures', () => {
  it('passes no edits, opaque output, the range start and no merging', () => {
    inject({ range: { start: 3, end: 8 } });
    exportCleanup = initExport();
    clickExport();

    expect(lastEncodeParams()).toMatchObject({
      edits: null,
      rangeStart: 3,
      transparent: false,
      mergeIdenticalFrames: false,
    });
    expect(lastEncodeParams().frames).toHaveLength(6);
    expect(document.querySelector('[data-testid="export-transparency-badge"]')).toBeNull();
    expect(document.querySelector('[data-testid="export-transparency-encoder-note"]')).toBeNull();
  });
});

describe('export screen: edits', () => {
  it('normalizes edits from the editor payload against the clip length', () => {
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ id: 't', text: 'Hi', start: 2, end: 999 }, 1000));
    inject({ editorExtras: { edits } });
    exportCleanup = initExport();
    clickExport();

    const passed = lastEncodeParams().edits;
    expect(passed).not.toBe(edits);
    expect(passed.textLayers[0]).toMatchObject({ id: 't', start: 2, end: 9 });
    expect(lastEncodeParams().transparent).toBe(false);
  });

  it('falls back to edits and hasAlpha on the payload clip', () => {
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ text: 'Hi' }, 10));
    inject({ clipLevel: { edits, hasAlpha: true } });
    exportCleanup = initExport();
    clickExport();

    expect(lastEncodeParams().edits.textLayers).toHaveLength(1);
    expect(lastEncodeParams().transparent).toBe(true);
  });
});

describe('export screen: transparency', () => {
  /** Edits with background removal on */
  const keyed = () => {
    const edits = createDefaultEdits();
    edits.background.enabled = true;
    return edits;
  };

  it('forces the JavaScript encoder without overwriting the stored preference', () => {
    updateSetting('export', 'encoderId', 'gifsicle-wasm');
    inject({ editorExtras: { edits: keyed() } });
    exportCleanup = initExport();
    expect(getExportState()?.settings.encoderId).toBe('gifsicle-wasm');

    const wasmCard = document.querySelector('[data-encoder-id="gifsicle-wasm"]');
    const jsCard = document.querySelector('[data-encoder-id="gifenc-js"]');
    expect(wasmCard?.getAttribute('aria-disabled')).toBe('true');
    expect(wasmCard?.classList.contains('export-transparency-encoder-disabled')).toBe(true);
    expect(wasmCard?.textContent).toContain(TRANSPARENT_ENCODER_NOTE);
    expect(jsCard?.classList.contains('selected')).toBe(true);
    // gifenc's own quality settings are shown
    expect(document.querySelector('#dither-check')).not.toBeNull();

    // Clicking the disabled card changes nothing
    const before = getExportState()?.settings.encoderId;
    wasmCard?.dispatchEvent(new MouseEvent('click'));
    expect(getExportState()?.settings.encoderId).toBe(before);

    clickExport();
    expect(lastEncodeParams().transparent).toBe(true);
    expect(getExportState()?.job?.encoder).toBe('gifenc-js');
    expect(loadSettings().export.encoderId).toBe('gifsicle-wasm');
  });

  it('snaps the preview of a transparent export to 1-bit alpha, like the encoder', () => {
    vi.mocked(snapCanvasAlphaToBinary).mockClear();
    inject({ editorExtras: { hasAlpha: true } });
    exportCleanup = initExport();

    expect(snapCanvasAlphaToBinary).toHaveBeenCalled();
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', {
      willReadFrequently: true,
    });
  });

  it('leaves the preview of an opaque export alone', () => {
    vi.mocked(snapCanvasAlphaToBinary).mockClear();
    inject();
    exportCleanup = initExport();

    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', {
      willReadFrequently: false,
    });
    expect(snapCanvasAlphaToBinary).not.toHaveBeenCalled();
  });

  it('shows the transparent background badge for sources with alpha', () => {
    inject({ editorExtras: { hasAlpha: true } });
    exportCleanup = initExport();
    expect(
      document.querySelector('[data-testid="export-transparency-badge"]')?.textContent,
    ).toContain('Transparent background');
  });
});

describe('export screen: imported clips', () => {
  it('merges identical frames only for imported clips', () => {
    inject({ clipExtras: { sourceName: 'loop.gif' } });
    exportCleanup = initExport();
    clickExport();
    expect(lastEncodeParams().mergeIdenticalFrames).toBe(true);
  });
});

describe('getExportResultBase64 test hook', () => {
  it('returns null without a result and base64 of the exported GIF otherwise', async () => {
    inject();
    exportCleanup = initExport();
    expect(await window.__TEST_HOOKS__.getExportResultBase64()).toBeNull();

    setExportResult({
      blob: new Blob([new Uint8Array([71, 73, 70, 56, 57, 97])], { type: 'image/gif' }),
      filename: 'a.gif',
      completedAt: 0,
    });
    expect(await window.__TEST_HOOKS__.getExportResultBase64()).toBe(btoa('GIF89a'));
  });
});
