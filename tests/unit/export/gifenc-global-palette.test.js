import { describe, expect, it, vi } from 'vitest';

/**
 * The fast preset (paletteInterval 0) must quantize once from the clip-wide
 * sample and map every frame onto that palette (#99 item b).
 */

vi.mock('gifenc', async (importOriginal) => {
  const actual = /** @type {typeof import('gifenc')} */ (await importOriginal());
  return {
    ...actual,
    quantize: vi.fn(actual.quantize),
    applyPalette: vi.fn(actual.applyPalette),
  };
});

import { applyPalette, quantize } from 'gifenc';
import { createGifencEncoder } from '../../../src/features/export/encoders/gifenc-encoder.js';

/**
 * Solid-color RGBA frame
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number]} rgb
 */
function solid(w, h, rgb) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < out.length; p += 4) out.set([...rgb, 255], p);
  return out;
}

const RED = /** @type {[number, number, number]} */ ([255, 0, 0]);
const BLUE = /** @type {[number, number, number]} */ ([0, 0, 255]);

/** @param {Uint8ClampedArray} [paletteSample] */
function initEncoder(paletteSample) {
  const encoder = createGifencEncoder();
  encoder.init({
    width: 4,
    height: 4,
    maxColors: 16,
    frameDelayMs: 100,
    loopCount: 0,
    quantizeFormat: 'rgb444',
    paletteInterval: 0,
    paletteSample,
  });
  return encoder;
}

describe('gifenc global palette (fast preset)', () => {
  it('quantizes the sample once and applies that palette to every frame', () => {
    vi.mocked(quantize).mockClear();
    vi.mocked(applyPalette).mockClear();

    // Sample spans both scenes: red early, blue late
    const sample = new Uint8ClampedArray([...solid(2, 2, RED), ...solid(2, 2, BLUE)]);
    const encoder = initEncoder(sample);

    for (let i = 0; i < 6; i++) {
      encoder.addFrame({ rgba: solid(4, 4, i < 3 ? RED : BLUE), width: 4, height: 4 }, i);
    }
    encoder.finish();

    expect(quantize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(quantize).mock.calls[0][0]).toBe(sample);
    const globalPalette = vi.mocked(quantize).mock.results[0].value;
    expect(applyPalette).toHaveBeenCalledTimes(6);
    for (const call of vi.mocked(applyPalette).mock.calls) {
      expect(call[1]).toBe(globalPalette);
    }
    // The late (blue) scene has an exact palette entry, unlike a frame-0 palette
    expect(globalPalette).toContainEqual(BLUE);
    encoder.dispose();
  });

  it('falls back to a first-frame palette when no sample is given', () => {
    vi.mocked(quantize).mockClear();

    const encoder = initEncoder();
    for (let i = 0; i < 4; i++) {
      encoder.addFrame({ rgba: solid(4, 4, RED), width: 4, height: 4 }, i);
    }

    expect(quantize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(quantize).mock.calls[0][0]).toHaveLength(4 * 4 * 4);
    encoder.dispose();
  });
});
