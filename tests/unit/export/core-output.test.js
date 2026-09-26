import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateFrameDelay,
  createDefaultSettings,
  estimateMergedRuns,
  getEffectiveEncoderId,
  getScaledDimensions,
  getSpeedLimitInfo,
  normalizeOutputScale,
  normalizeTargetSizeMB,
  OUTPUT_SCALES,
  readGifInfo,
} from '../../../src/features/export/core.js';
import { createGifencEncoder } from '../../../src/features/export/encoders/gifenc-encoder.js';
import { createDefaultEdits, createTextLayer } from '../../../src/shared/edits/model.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

afterEach(() => {
  localStorage.clear();
});

describe('getEffectiveEncoderId with a target size', () => {
  it('forces gifenc while a target size is set, whatever the preference', () => {
    const settings = /** @type {any} */ ({ encoderId: 'gifsicle-wasm' });
    expect(getEffectiveEncoderId(settings, false, true)).toBe('gifenc-js');
    expect(getEffectiveEncoderId(settings, false, false)).toBe('gifsicle-wasm');
    expect(getEffectiveEncoderId(settings, false)).toBe('gifsicle-wasm');
  });
});

describe('output scale', () => {
  it('offers 100, 75, 50, 33 and 25 %', () => {
    expect(OUTPUT_SCALES.map((option) => option.label)).toEqual([
      '100 %',
      '75 %',
      '50 %',
      '33 %',
      '25 %',
    ]);
  });

  it('snaps stored values to an offered scale', () => {
    expect(normalizeOutputScale(0.5)).toBe(0.5);
    expect(normalizeOutputScale(0.34)).toBe(1 / 3);
    expect(normalizeOutputScale(0.7)).toBe(0.75);
    expect(normalizeOutputScale(undefined)).toBe(1);
    expect(normalizeOutputScale('abc')).toBe(1);
    expect(normalizeOutputScale(2)).toBe(1);
    expect(normalizeOutputScale(0)).toBe(1);
  });

  it('scales and rounds each side, never below one pixel', () => {
    expect(getScaledDimensions(640, 480, 1)).toEqual({ width: 640, height: 480 });
    expect(getScaledDimensions(640, 480, 0.5)).toEqual({ width: 320, height: 240 });
    expect(getScaledDimensions(640, 480, 1 / 3)).toEqual({ width: 213, height: 160 });
    expect(getScaledDimensions(3, 1, 0.25)).toEqual({ width: 1, height: 1 });
    expect(getScaledDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });
});

describe('normalizeTargetSizeMB', () => {
  it('keeps positive numbers and turns everything else off', () => {
    expect(normalizeTargetSizeMB(2)).toBe(2);
    expect(normalizeTargetSizeMB('1.5')).toBe(1.5);
    expect(normalizeTargetSizeMB(null)).toBeNull();
    expect(normalizeTargetSizeMB(undefined)).toBeNull();
    expect(normalizeTargetSizeMB('')).toBeNull();
    expect(normalizeTargetSizeMB(0)).toBeNull();
    expect(normalizeTargetSizeMB(-3)).toBeNull();
    expect(normalizeTargetSizeMB('x')).toBeNull();
  });
});

describe('createDefaultSettings output fields', () => {
  it('defaults to full size and no target', () => {
    const settings = createDefaultSettings();
    expect(settings.scale).toBe(1);
    expect(settings.targetSizeMB).toBeNull();
  });

  it('restores the stored scale and target', () => {
    updateSetting('export', 'scale', 0.5);
    updateSetting('export', 'targetSizeMB', 8);
    const settings = createDefaultSettings();
    expect(settings.scale).toBe(0.5);
    expect(settings.targetSizeMB).toBe(8);
  });
});

describe('getSpeedLimitInfo', () => {
  it('is not limited while the delay can express the speed', () => {
    expect(getSpeedLimitInfo(10, 4, 1)).toEqual({
      limited: false,
      effectiveSpeed: 4,
      minDelayCs: 2,
    });
    expect(getSpeedLimitInfo(30, 1, 1).limited).toBe(false);
  });

  it('reports the speed the GIF really plays at when frames hit the 2 cs floor', () => {
    // 60 fps at 2x wants 0.83 cs frames; they last 2 cs: 2 * 0.833 / 2
    const info = getSpeedLimitInfo(60, 2, 1);
    expect(info.limited).toBe(true);
    expect(info.effectiveSpeed).toBeCloseTo(0.8333, 3);
    expect(calculateFrameDelay(60, 2, 1)).toBe(2);
  });

  it('frame skip lengthens each frame and lifts the limit', () => {
    expect(getSpeedLimitInfo(30, 4, 1).limited).toBe(true);
    expect(getSpeedLimitInfo(30, 4, 3).limited).toBe(false);
  });
});

describe('readGifInfo', () => {
  /** A real GIF from the encoder */
  function encode(/** @type {number} */ frames, /** @type {number} */ w, /** @type {number} */ h) {
    const encoder = createGifencEncoder();
    encoder.init({
      width: w,
      height: h,
      maxColors: 16,
      frameDelayMs: 100,
      loopCount: 0,
      quantizeFormat: 'rgb565',
      paletteInterval: 1,
    });
    for (let i = 0; i < frames; i++) {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < rgba.length; p += 4) rgba.set([i * 40, 20, 200, 255], p);
      encoder.addFrame({ rgba, width: w, height: h }, i);
    }
    return encoder.finish();
  }

  it('reads the dimensions and image count of an encoded GIF', () => {
    expect(readGifInfo(encode(3, 7, 5))).toEqual({ width: 7, height: 5, frameCount: 3 });
    expect(readGifInfo(encode(1, 32, 16))).toEqual({ width: 32, height: 16, frameCount: 1 });
  });

  it('returns null for anything that is not a complete GIF', () => {
    const bytes = encode(2, 4, 4);
    expect(readGifInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readGifInfo(new TextEncoder().encode('gif89a but not really'))).toBeNull();
    expect(readGifInfo(bytes.subarray(0, bytes.length - 6))).toBeNull();
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 1] = 0x99;
    expect(readGifInfo(corrupt)).toBeNull();
  });
});

describe('estimateMergedRuns', () => {
  /** @param {(string | undefined)[]} keys */
  const framesWith = (keys) =>
    keys.map((sharedKey, index) => /** @type {any} */ ({ id: `f${index}`, sharedKey }));

  it('counts runs of frames that share pixels', () => {
    const frames = framesWith(['a', 'a', 'a', 'b', undefined, undefined]);
    expect(estimateMergedRuns([0, 1, 2, 3, 4, 5], frames, null)).toEqual({
      count: 4,
      representatives: [0, 3, 4, 5],
      runLengths: [3, 1, 1, 1],
    });
  });

  it('splits a run where a text layer starts or ends', () => {
    const frames = framesWith(['a', 'a', 'a', 'a']);
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ id: 't', text: 'Hi', start: 1, end: 2 }, 4));
    expect(estimateMergedRuns([0, 1, 2, 3], frames, edits).runLengths).toEqual([1, 2, 1]);
  });

  it('works on sparse (frame-skipped) indices', () => {
    const frames = framesWith(['a', 'a', 'a', 'a', 'b', 'b']);
    expect(estimateMergedRuns([0, 2, 4], frames, null).representatives).toEqual([0, 4]);
  });
});
