import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGif } from '../../../src/features/export/api.js';
import { getExportState, openExportDialog } from '../../../src/features/export/index.js';
import {
  TARGET_SIZE_ENCODER_NOTE,
  TRANSPARENT_ENCODER_NOTE,
} from '../../../src/features/export/ui.js';
import {
  resetAppStore,
  setClipPayload,
  setEditorPayload,
  setExportResult,
} from '../../../src/shared/app-store.js';
import { createDefaultEdits, createTextLayer } from '../../../src/shared/edits/model.js';
import { loadSettings, updateSetting } from '../../../src/shared/user-settings.js';
import { GifEncoderManager } from '../../../src/workers/worker-manager.js';

/**
 * Export dialog wiring for edits, transparency, imported clips, the editor
 * speed, the output scale and the target size.
 */

vi.mock('../../../src/features/export/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkEncoderStatus: vi.fn(async () => 'gifenc-js'),
    encodeGif: vi.fn(() => new Promise(() => {})),
  };
});

/** @type {import('../../../src/features/export/index.js').ExportDialogHandle | null} */
let dialog = null;

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

/** @param {string} selector */
function $(selector) {
  return /** @type {HTMLElement | null} */ (document.querySelector(selector));
}

function clickExport() {
  $('#export-start')?.dispatchEvent(new MouseEvent('click'));
}

/** @returns {any} */
function lastEncodeParams() {
  return vi.mocked(encodeGif).mock.calls.at(-1)?.[0];
}

/**
 * Change a control like the user would (value + change event)
 * @param {string} selector
 * @param {string | boolean} value
 */
function change(selector, value) {
  const control = /** @type {HTMLInputElement} */ ($(selector));
  if (typeof value === 'boolean') {
    control.checked = value;
  } else {
    control.value = value;
  }
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
  window.__TEST_HOOKS__ = {};
  document.body.innerHTML = '<div id="app"><main id="main-content"></main></div>';
  vi.mocked(encodeGif).mockReset();
  vi.mocked(encodeGif).mockImplementation(() => new Promise(() => {}));
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
});

describe('export dialog: plain screen captures', () => {
  it('passes no edits, opaque output, the range start and no merging', () => {
    inject({ range: { start: 3, end: 8 } });
    dialog = openExportDialog();
    clickExport();

    expect(lastEncodeParams()).toMatchObject({
      edits: null,
      rangeStart: 3,
      transparent: false,
      mergeIdenticalFrames: false,
      scale: 1,
    });
    expect(lastEncodeParams().frames).toHaveLength(6);
    expect($('[data-testid="export-transparency-badge"]')).toBeNull();
    expect($('[data-testid="export-transparency-encoder-note"]')).toBeNull();
  });

  it('summarizes the output: size, frames and duration at the editor speed', () => {
    inject({ count: 30 });
    dialog = openExportDialog();
    expect($('#export-summary')?.textContent).toBe('16×12 · 30 frames · 1.00s at 1×');
    expect($('#export-estimate')?.textContent).toMatch(/^Estimated size ≈ /);
  });
});

describe('export dialog: edits', () => {
  it('normalizes edits from the editor payload against the clip length', () => {
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ id: 't', text: 'Hi', start: 2, end: 999 }, 1000));
    inject({ editorExtras: { edits } });
    dialog = openExportDialog();
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
    dialog = openExportDialog();
    clickExport();

    expect(lastEncodeParams().edits.textLayers).toHaveLength(1);
    expect(lastEncodeParams().transparent).toBe(true);
  });
});

describe('export dialog: transparency', () => {
  /** Edits with background removal on */
  const keyed = () => {
    const edits = createDefaultEdits();
    edits.background.enabled = true;
    return edits;
  };

  it('forces the JavaScript encoder without overwriting the stored preference', () => {
    updateSetting('export', 'encoderId', 'gifsicle-wasm');
    inject({ editorExtras: { edits: keyed() } });
    dialog = openExportDialog();
    expect(getExportState()?.settings.encoderId).toBe('gifsicle-wasm');

    const wasmCard = $('[data-encoder-id="gifsicle-wasm"]');
    const jsCard = $('[data-encoder-id="gifenc-js"]');
    expect(wasmCard?.getAttribute('aria-disabled')).toBe('true');
    expect(wasmCard?.classList.contains('export-encoder-card--disabled')).toBe(true);
    expect(wasmCard?.textContent).toContain(TRANSPARENT_ENCODER_NOTE);
    expect(/** @type {HTMLInputElement} */ ($('#export-encoder-gifsicle-wasm')).disabled).toBe(
      true,
    );
    expect(jsCard?.classList.contains('export-encoder-card--selected')).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('#export-encoder-gifenc-js')).checked).toBe(true);
    // gifenc's own quality settings are shown
    expect($('#export-dither')).not.toBeNull();

    // Clicking the disabled card changes nothing
    const before = getExportState()?.settings.encoderId;
    wasmCard?.click();
    expect(getExportState()?.settings.encoderId).toBe(before);

    clickExport();
    expect(lastEncodeParams().transparent).toBe(true);
    expect(getExportState()?.job?.encoder).toBe('gifenc-js');
    expect(loadSettings().export.encoderId).toBe('gifsicle-wasm');
  });

  it('shows the transparent background badge for sources with alpha', () => {
    inject({ editorExtras: { hasAlpha: true } });
    dialog = openExportDialog();
    expect($('[data-testid="export-transparency-badge"]')?.textContent).toContain(
      'Transparent background',
    );
  });
});

describe('export dialog: encoder choice', () => {
  it('switching the encoder re-renders its settings and keeps focus on the choice', () => {
    inject();
    dialog = openExportDialog();
    expect($('#export-quality')).not.toBeNull();

    const wasm = /** @type {HTMLInputElement} */ ($('#export-encoder-gifsicle-wasm'));
    wasm.focus();
    change('#export-encoder-gifsicle-wasm', true);

    expect(getExportState()?.settings.encoderId).toBe('gifsicle-wasm');
    expect(loadSettings().export.encoderId).toBe('gifsicle-wasm');
    expect($('#export-quality')).toBeNull();
    expect($('[data-encoder-id="gifsicle-wasm"]')?.classList).toContain(
      'export-encoder-card--selected',
    );
    expect(document.activeElement?.id).toBe('export-encoder-gifsicle-wasm');
  });
});

describe('export dialog: imported clips', () => {
  it('merges identical frames only for imported clips', () => {
    inject({ clipExtras: { sourceName: 'loop.gif' } });
    dialog = openExportDialog();
    clickExport();
    expect(lastEncodeParams().mergeIdenticalFrames).toBe(true);
  });

  it('takes the imported flag from the editor payload when it has one', () => {
    inject({ clipExtras: { sourceName: 'loop.gif' }, editorExtras: { sourceName: null } });
    dialog = openExportDialog();
    clickExport();
    expect(lastEncodeParams().mergeIdenticalFrames).toBe(false);
  });

  it('counts holds (shared pixels) as one GIF frame in the summary', () => {
    // Frames 0-2 and 3-5 are two holds of two decoded frames
    const holdFrames = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      sharedKey: index < 3 ? 'a' : 'b',
      timestamp: index,
      width: 16,
      height: 12,
    }));
    setClipPayload(
      /** @type {any} */ ({ frames: holdFrames, fps: 30, capturedAt: 0, sourceName: 'a.gif' }),
    );
    setEditorPayload(
      /** @type {any} */ ({
        selectedRange: { start: 0, end: 5 },
        cropArea: null,
        clip: { frames: holdFrames, fps: 30 },
        fps: 30,
      }),
    );
    dialog = openExportDialog();
    expect($('#export-summary')?.textContent).toMatch(/· 2 frames ·/);
  });
});

describe('export dialog: the editor speed is the GIF speed', () => {
  it('encodes with the editor payload speed, ignoring and never writing the stored one', () => {
    updateSetting('export', 'playbackSpeed', 0.5);
    inject({ editorExtras: { playbackSpeed: 2 } });
    dialog = openExportDialog();
    expect($('#export-speed')?.textContent).toBe('2×');
    // No speed control in the dialog
    expect(document.querySelector('[role="dialog"] select[id*="speed"]')).toBeNull();

    change('#export-frame-skip', '2');
    clickExport();
    expect(lastEncodeParams().settings).toMatchObject({ playbackSpeed: 2, frameSkip: 2 });
    expect(loadSettings().export.playbackSpeed).toBe(0.5);
  });

  it('falls back to 1x for a payload without a speed', () => {
    updateSetting('export', 'playbackSpeed', 3);
    inject();
    dialog = openExportDialog();
    clickExport();
    expect(lastEncodeParams().settings.playbackSpeed).toBe(1);
  });

  it('says when GIF delays cannot express the speed', () => {
    // 30 fps at 4x wants 0.83 cs frames; GIF frames last at least 2 cs
    inject({ editorExtras: { playbackSpeed: 4 } });
    dialog = openExportDialog();
    const note = /** @type {HTMLElement} */ ($('#export-speed-note'));
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('plays at about 1.67×');

    // Every 3rd frame: 2.5 cs ideal delay, rounds to 3 cs: no longer limited
    change('#export-frame-skip', '3');
    expect(/** @type {HTMLElement} */ ($('#export-speed-note')).hidden).toBe(true);
  });

  it('judges an imported clip by its merged holds, not by its frame slots', () => {
    // 50 fps slots in holds of 5 (one decoded frame each): at 2x a slot
    // would want 1 cs, but each merged GIF frame lasts 5 cs
    const holdFrames = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      sharedKey: `k${Math.floor(index / 5)}`,
      timestamp: index,
      width: 16,
      height: 12,
    }));
    setClipPayload(
      /** @type {any} */ ({ frames: holdFrames, fps: 50, capturedAt: 0, sourceName: 'a.gif' }),
    );
    setEditorPayload(
      /** @type {any} */ ({
        selectedRange: { start: 0, end: 19 },
        cropArea: null,
        clip: { frames: holdFrames, fps: 50 },
        fps: 50,
        playbackSpeed: 2,
      }),
    );
    dialog = openExportDialog();
    expect(/** @type {HTMLElement} */ ($('#export-speed-note')).hidden).toBe(true);
    // 20 slots at 50 fps = 0.4 s, at 2x
    expect($('#export-summary')?.textContent).toBe('16×12 · 4 frames · 0.20s at 2×');
  });

  it('does not show the note at speeds GIF can play', () => {
    inject({ editorExtras: { playbackSpeed: 1.5 } });
    dialog = openExportDialog();
    expect(/** @type {HTMLElement} */ ($('#export-speed-note')).hidden).toBe(true);
  });
});

describe('export dialog: output scale', () => {
  it('passes the scale to the encoder, shows the scaled size and remembers it', () => {
    inject({ count: 4 });
    dialog = openExportDialog();
    const focusBefore = /** @type {HTMLSelectElement} */ ($('#export-scale'));
    focusBefore.focus();
    change('#export-scale', '0.5');

    // Derived text updates in place; the select keeps focus
    expect(document.activeElement).toBe(focusBefore);
    expect($('#export-summary')?.textContent).toMatch(/^8×6 · /);
    expect(loadSettings().export.scale).toBe(0.5);

    clickExport();
    expect(lastEncodeParams().scale).toBe(0.5);
  });

  it('offers 100, 75, 50, 33 and 25 % with the resulting sizes', () => {
    inject();
    dialog = openExportDialog();
    const labels = [.../** @type {HTMLSelectElement} */ ($('#export-scale')).options].map(
      (option) => option.textContent,
    );
    expect(labels).toEqual([
      '100 % (16×12)',
      '75 % (12×9)',
      '50 % (8×6)',
      '33 % (5×4)',
      '25 % (4×3)',
    ]);
  });
});

describe('export dialog: target size', () => {
  it('turning it on forces the JavaScript encoder and says so, without storing that', () => {
    updateSetting('export', 'encoderId', 'gifsicle-wasm');
    inject();
    dialog = openExportDialog();
    expect(/** @type {HTMLInputElement} */ ($('#export-target-mb')).disabled).toBe(true);

    $('#export-target-enabled')?.focus();
    change('#export-target-enabled', true);
    expect(getExportState()?.settings.targetSizeMB).toBeGreaterThan(0);
    expect(/** @type {HTMLInputElement} */ ($('#export-target-mb')).disabled).toBe(false);
    expect($('[data-encoder-id="gifsicle-wasm"]')?.getAttribute('aria-disabled')).toBe('true');
    expect($('[data-testid="export-target-encoder-note"]')?.textContent).toBe(
      TARGET_SIZE_ENCODER_NOTE,
    );
    expect($('#export-target-note')?.textContent).toContain('JavaScript encoder');
    expect(loadSettings().export.encoderId).toBe('gifsicle-wasm');
    expect(document.activeElement?.id).toBe('export-target-enabled');

    change('#export-target-enabled', false);
    expect(getExportState()?.settings.targetSizeMB).toBeNull();
    expect($('[data-encoder-id="gifsicle-wasm"]')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('estimates from a sample, encodes the first rung that fits and reports it', async () => {
    inject({ count: 30 });
    updateSetting('export', 'targetSizeMB', 1);
    // Sample encodes (frameIndices given) are 200 KB per frame at 256
    // colors, halved per color step; the real encode is under the target
    vi.mocked(encodeGif).mockImplementation(async (params) => {
      if (params.frameIndices) {
        const perFrame = (200 * 1024 * (params.maxColors ?? 256)) / 256;
        return new Blob([new Uint8Array(Math.round(perFrame * params.frameIndices.length))]);
      }
      return new Blob([new Uint8Array(900 * 1024)], { type: 'image/gif' });
    });
    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());

    const calls = vi.mocked(encodeGif).mock.calls.map(([params]) => params);
    const samples = calls.filter((params) => params.frameIndices);
    const full = calls.filter((params) => !params.frameIndices);
    // 30 frames at 256 colors ≈ 6 MB, 128 ≈ 3 MB, 64 ≈ 1.5 MB, 32 ≈ 0.75 MB
    expect(samples.map((params) => params.maxColors)).toEqual([103, 64, 32]);
    expect(samples[0].frameIndices).toHaveLength(6);
    expect(samples[0].mergeIdenticalFrames).toBe(false);
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ maxColors: 32, scale: 1 });
    // encodeGif derives the JavaScript encoder from the target in the settings
    expect(full[0].settings.targetSizeMB).toBe(1);
    expect(getExportState()?.job?.encoder).toBe('gifenc-js');
    expect($('#export-result-target')?.textContent).toBe(
      'Fits the 1.0 MB target with 32 colors · every frame · 100 %.',
    );
  });

  it('composes each sample once per frame rate and scale, and runs every encode on one encoder', async () => {
    inject({ count: 30 });
    updateSetting('export', 'targetSizeMB', 1);
    const dispose = vi.spyOn(GifEncoderManager.prototype, 'dispose');
    // Only the 50 % sample fits
    vi.mocked(encodeGif).mockImplementation(async (params) =>
      params.frameIndices
        ? /** @type {any} */ ({ size: params.scale === 0.5 ? 100 : 50_000_000 })
        : new Blob([new Uint8Array(900_000)], { type: 'image/gif' }),
    );
    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());

    const calls = vi.mocked(encodeGif).mock.calls.map(([params]) => params);
    const samples = calls.filter((params) => params.frameIndices);
    const full = calls.filter((params) => !params.frameIndices);
    const key = (/** @type {any} */ p) => `${p.settings.frameSkip}:${p.scale}`;
    // 103 (the quality's cap), 64 and 32 colors at every frame, then fewer
    // frames, then smaller
    expect(samples.map(key)).toEqual(['1:1', '1:1', '1:1', '2:1', '3:1', '3:0.75', '3:0.5']);
    // The rungs that only lower the colors re-quantize the same composed
    // frames; every other frame rate or scale composes its own
    const caches = samples.map((params) => params.frameCache);
    expect(caches.slice(1, 3).every((cache) => cache === caches[0])).toBe(true);
    expect(new Set(caches).size).toBe(5);
    // One encoder worker for the whole export, released at the end
    const encoder = samples[0].encoderManager;
    expect(encoder).toBeInstanceOf(GifEncoderManager);
    expect([...samples, ...full].every((params) => params.encoderManager === encoder)).toBe(true);
    expect(dispose.mock.contexts).toContain(encoder);
    dispose.mockRestore();
  });

  it('steps down a rung when the real GIF is still too big, and says so when nothing fits', async () => {
    inject({ count: 30 });
    updateSetting('export', 'targetSizeMB', 1);
    // Estimates always fit; every real encode is 2 MB
    vi.mocked(encodeGif).mockImplementation(async (params) =>
      params.frameIndices
        ? new Blob([new Uint8Array(100)])
        : new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/gif' }),
    );
    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());

    const full = vi
      .mocked(encodeGif)
      .mock.calls.map(([params]) => params)
      .filter((params) => !params.frameIndices);
    // First rung, then two retries one rung further down each
    expect(full.map((params) => params.maxColors)).toEqual([103, 64, 32]);
    expect($('#export-result-target')?.textContent).toMatch(/^Could not get under 1\.0 MB/);
  });

  it('checks and shows the target in decimal megabytes (1 MB = 1,000,000 bytes)', async () => {
    inject({ count: 30 });
    updateSetting('export', 'targetSizeMB', 10);
    // Estimates fit; every real GIF is 10.2 million bytes: over a 10 MB
    // upload limit, though under 10 MiB
    vi.mocked(encodeGif).mockImplementation(async (params) =>
      params.frameIndices
        ? new Blob([new Uint8Array(100)])
        : new Blob([new Uint8Array(10_200_000)], { type: 'image/gif' }),
    );
    dialog = openExportDialog();
    clickExport();
    await vi.waitFor(() => expect($('#export-result')).not.toBeNull());

    expect($('#export-result-target')?.textContent).toMatch(/^Could not get under 10\.0 MB/);
    expect($('#export-result-size')?.textContent).toContain('10.2 MB');
  });

  it('shows the estimating step while it plans', async () => {
    inject({ count: 30 });
    updateSetting('export', 'targetSizeMB', 2);
    dialog = openExportDialog();
    clickExport();
    await Promise.resolve();
    expect($('#export-progress-step')?.textContent).toBe(
      'Finding settings for 2.0 MB: checking option 1 of 8',
    );
    expect(
      /** @type {HTMLProgressElement} */ ($('#export-progress-bar')).hasAttribute('value'),
    ).toBe(false);
  });
});

describe('getExportResultBase64 test hook', () => {
  it('returns null without a result and base64 of the exported GIF otherwise', async () => {
    inject();
    dialog = openExportDialog();
    expect(await window.__TEST_HOOKS__.getExportResultBase64()).toBeNull();

    setExportResult({
      blob: new Blob([new Uint8Array([71, 73, 70, 56, 57, 97])], { type: 'image/gif' }),
      filename: 'a.gif',
      completedAt: 0,
    });
    expect(await window.__TEST_HOOKS__.getExportResultBase64()).toBe(btoa('GIF89a'));
  });
});
