import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Balanced (paletteInterval 10) reuses the palette between scheduled
 * rebuilds, but a scene cut must rebuild it early instead of drawing the
 * new scene with the previous scene's colors for up to 9 frames (#99).
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
import {
  createGifencEncoder,
  isPaletteStale,
  PALETTE_STALENESS,
  paletteError,
} from '../../../src/features/export/encoders/gifenc-encoder.js';

const W = 64;
const H = 64;

/**
 * @param {(x: number, y: number) => [number, number, number]} pixel
 * @returns {Uint8ClampedArray}
 */
function frame(pixel) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out.set([...pixel(x, y), 255], (y * W + x) * 4);
  }
  return out;
}

/** @param {[number, number, number]} rgb */
const solid = (rgb) => frame(() => rgb);

/** Mean per-channel error of every pixel against the palette it was mapped with */
function fullFrameError(
  /** @type {Uint8ClampedArray} */ rgba,
  /** @type {Uint8Array} */ index,
  /** @type {number[][]} */ palette,
) {
  const all = Uint32Array.from({ length: W * H }, (_, i) => i);
  return paletteError(rgba, index, palette, all);
}

/**
 * Encode frames and return, per frame, whether it quantized and the error
 * of the palette it was finally written with.
 * @param {Uint8ClampedArray[]} frames
 * @param {number} paletteInterval
 */
function encode(frames, paletteInterval) {
  const encoder = createGifencEncoder();
  encoder.init({
    width: W,
    height: H,
    maxColors: 102,
    frameDelayMs: 33,
    loopCount: 0,
    quantizeFormat: 'rgb565',
    paletteInterval,
  });
  const perFrame = frames.map((rgba, i) => {
    const quantizeCalls = vi.mocked(quantize).mock.calls.length;
    encoder.addFrame({ rgba, width: W, height: H }, i);
    const { calls, results } = vi.mocked(applyPalette).mock;
    const [, palette] = calls.at(-1) ?? [];
    const index = /** @type {Uint8Array} */ (results.at(-1)?.value);
    return {
      quantized: vi.mocked(quantize).mock.calls.length - quantizeCalls,
      error: fullFrameError(rgba, index, /** @type {number[][]} */ (palette)),
    };
  });
  encoder.finish();
  encoder.dispose();
  return perFrame;
}

const RED = /** @type {[number, number, number]} */ ([255, 0, 0]);
const BLUE = /** @type {[number, number, number]} */ ([0, 0, 255]);

describe('gifenc palette staleness (balanced preset)', () => {
  beforeEach(() => {
    vi.mocked(quantize).mockClear();
    vi.mocked(applyPalette).mockClear();
  });

  it('rebuilds the palette on the first frame after a hard cut', () => {
    // Frame 0 red, 1-11 blue: the cut lands between scheduled rebuilds
    const frames = [solid(RED), ...Array.from({ length: 11 }, () => solid(BLUE))];
    const result = encode(frames, 10);

    // Scheduled at 0 and 10, plus the early rebuild at the cut
    expect(result.map((r) => r.quantized)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    // Every frame after the cut, including the 9 before the next scheduled
    // rebuild and the late frames, is drawn with a blue palette
    for (const { error } of result) expect(error).toBe(0);
  });

  it('bounds the post-cut error for a cut into a multi-color scene', () => {
    // Warm gradient, then a cool gradient from frame 3 on
    const warm = frame((x, y) => [200 + (x % 50), 40 + y, 30]);
    const cool = frame((x, y) => [20, 60 + y, 150 + (x % 100)]);
    const frames = [warm, warm, warm, ...Array.from({ length: 12 }, () => cool)];
    const result = encode(frames, 10);

    expect(result[3].quantized).toBe(1);
    for (const { error } of result.slice(3)) expect(error).toBeLessThan(3);
  });

  it('keeps the every-10th-frame schedule on a steady scene', () => {
    // Slowly drifting gradient with a moving highlight
    const frames = Array.from({ length: 30 }, (_, i) =>
      frame((x, y) => {
        const glow = Math.abs(x - i * 2) < 4 && Math.abs(y - 32) < 4 ? 40 : 0;
        return [80 + x + glow, 60 + y + i, 120 + ((x + y) >> 1)];
      }),
    );
    const result = encode(frames, 10);

    const rebuilt = result.flatMap((r, i) => (r.quantized ? [i] : []));
    expect(rebuilt).toEqual([0, 10, 20]);
  });

  it('never adds rebuilds for per-frame (quality) or global (fast) palettes', () => {
    const frames = [solid(RED), solid(BLUE), solid(BLUE), solid(RED)];

    expect(encode(frames, 1).map((r) => r.quantized)).toEqual([1, 1, 1, 1]);
    // interval 0 keeps one palette for the clip (the clip-wide sample in
    // practice); a single-frame rebuild would throw it away
    expect(encode(frames, 0).map((r) => r.quantized)).toEqual([1, 0, 0, 0]);
  });
});

describe('isPaletteStale', () => {
  it('needs both the absolute margin and the ratio to be exceeded', () => {
    const { margin, ratio } = PALETTE_STALENESS;
    // Near-exact palette: the margin decides
    expect(isPaletteStale(margin, 0)).toBe(false);
    expect(isPaletteStale(margin + 0.1, 0)).toBe(true);
    // Coarse palette (few colors): the ratio decides
    expect(isPaletteStale(10 * ratio, 10)).toBe(false);
    expect(isPaletteStale(10 * ratio + 0.1, 10)).toBe(true);
  });
});

describe('paletteError', () => {
  it('is the mean per-channel absolute error at the given pixels', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 100, 100, 100, 255]);
    const palette = [
      [0, 0, 0],
      [100, 100, 130],
    ];
    const index = new Uint8Array([0, 1]);

    expect(paletteError(rgba, index, palette, Uint32Array.of(0))).toBe(20);
    expect(paletteError(rgba, index, palette, Uint32Array.of(1))).toBe(10);
    expect(paletteError(rgba, index, palette, Uint32Array.of(0, 1))).toBe(15);
    expect(paletteError(rgba, index, palette, new Uint32Array(0))).toBe(0);
  });
});
