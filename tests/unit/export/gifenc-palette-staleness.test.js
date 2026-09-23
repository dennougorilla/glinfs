import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Balanced (paletteInterval 10) reuses the palette between scheduled
 * rebuilds, but a scene cut or small new content must rebuild it early
 * instead of drawing it with the previous palette for up to 9 frames (#99).
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
  measurePalette,
  PALETTE_STALENESS,
} from '../../../src/features/export/encoders/gifenc-encoder.js';
import { createPrng } from '../../../src/features/export/pixel-sampling.js';

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
  let sum = 0;
  for (let i = 0; i < index.length; i++) {
    for (let c = 0; c < 3; c++) sum += Math.abs(rgba[i * 4 + c] - palette[index[i]][c]);
  }
  return sum / (index.length * 3);
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
      /** Colors as written to the GIF, i.e. as decoded */
      written: Array.from(index, (i) => palette[i].slice(0, 3).join()),
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

describe('gifenc palette staleness: small new content', () => {
  beforeEach(() => {
    vi.mocked(quantize).mockClear();
    vi.mocked(applyPalette).mockClear();
  });

  const BLACK = /** @type {[number, number, number]} */ ([0, 0, 0]);

  /**
   * Frame 0 black, then `rgb` in the region from frame 1 on: the frame mean
   * barely moves, which is how the mean-only check missed it.
   * @param {(x: number, y: number) => boolean} inRegion
   * @param {[number, number, number]} rgb
   */
  function appearsOnBlack(inRegion, rgb) {
    const withRegion = frame((x, y) => (inRegion(x, y) ? rgb : BLACK));
    const result = encode([solid(BLACK), ...Array.from({ length: 11 }, () => withRegion)], 10);
    const expected = Array.from({ length: W * H }, (_, i) =>
      (inRegion(i % W, Math.floor(i / W)) ? rgb : BLACK).join(),
    );
    return { result, expected };
  }

  it.each([
    ['16x16 gray-48 patch', (x, y) => x < 16 && y < 16, [48, 48, 48]],
    ['8x8 white indicator', (x, y) => x >= 29 && x < 37 && y >= 21 && y < 29, [255, 255, 255]],
    ['12-level gray over a quarter of the frame', (x) => x < 16, [12, 12, 12]],
  ])('draws a %s from the first frame it appears in', (_, inRegion, rgb) => {
    const { result, expected } = appearsOnBlack(
      /** @type {(x: number, y: number) => boolean} */ (inRegion),
      /** @type {[number, number, number]} */ (rgb),
    );

    expect(result.map((r) => r.quantized)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    // Every decoded pixel, not just the frame mean: the region is its own
    // color and the background stays black on every frame it is shown
    for (const { written } of result.slice(1)) expect(written).toEqual(expected);
  });

  it('keeps the schedule on steady noise, whose tail is large but stable', () => {
    const random = createPrng(7);
    const frames = Array.from({ length: 30 }, () =>
      frame(() => [random() * 256, random() * 256, random() * 256]),
    );
    const result = encode(frames, 10);

    expect(result.flatMap((r, i) => (r.quantized ? [i] : []))).toEqual([0, 10, 20]);
  });
});

describe('gifenc palette staleness: constantly changing content', () => {
  beforeEach(() => {
    vi.mocked(quantize).mockClear();
    vi.mocked(applyPalette).mockClear();
  });

  const counts = (/** @type {Uint8ClampedArray[]} */ frames, /** @type {number} */ interval) => {
    vi.mocked(quantize).mockClear();
    vi.mocked(applyPalette).mockClear();
    const result = encode(frames, interval);
    return {
      result,
      quantize: vi.mocked(quantize).mock.calls.length,
      applyPalette: vi.mocked(applyPalette).mock.calls.length,
    };
  };

  it('costs no more quantizes than quality on flashing frames, and few extra maps', () => {
    const frames = Array.from({ length: 30 }, (_, i) => solid(i % 2 ? BLUE : RED));
    const balanced = counts(frames, 10);
    const quality = counts(frames, 1);

    // Every frame still gets its own palette
    for (const { error } of balanced.result) expect(error).toBe(0);
    expect(balanced.quantize).toBe(quality.quantize);
    // Measuring before quantizing maps a stale frame twice. After two
    // stale frames in a row, frames quantize up front (no second map);
    // only the two entry frames (1, 2) and the first frame after each
    // scheduled rebuild (11, 21) pay it. Measuring every frame first would
    // take 57 maps.
    expect(quality.applyPalette).toBe(30);
    expect(balanced.applyPalette).toBe(34);
  });

  it('returns to palette reuse once the content settles', () => {
    const flashes = Array.from({ length: 4 }, (_, i) => solid(i % 2 ? BLUE : RED));
    const frames = [...flashes, ...Array.from({ length: 16 }, () => solid(BLUE))];
    const result = encode(frames, 10);

    // 1-2 stale, 3-9 quantize up front, 10 scheduled; frame 11 fits the
    // palette again, so 11-19 reuse it
    const rebuilt = result.flatMap((r, i) => (r.quantized ? [i] : []));
    expect(rebuilt).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const { error } of result) expect(error).toBe(0);
  });
});

describe('isPaletteStale', () => {
  const paletteFit = (error = 0, tail = 0) => ({ error, tail });

  it('needs both the absolute margin and the ratio for the mean error', () => {
    const { margin, ratio } = PALETTE_STALENESS;
    // Near-exact palette: the margin decides
    expect(isPaletteStale(paletteFit(margin), paletteFit(0))).toBe(false);
    expect(isPaletteStale(paletteFit(margin + 0.1), paletteFit(0))).toBe(true);
    // Coarse palette (few colors): the ratio decides
    expect(isPaletteStale(paletteFit(10 * ratio), paletteFit(10))).toBe(false);
    expect(isPaletteStale(paletteFit(10 * ratio + 0.1), paletteFit(10))).toBe(true);
  });

  it('needs both the absolute sample count and the ratio for the tail', () => {
    const { tailSamples, ratio } = PALETTE_STALENESS;
    // Clean palette frame: a few badly mapped samples are enough
    expect(isPaletteStale(paletteFit(0, tailSamples), paletteFit(0, 0))).toBe(false);
    expect(isPaletteStale(paletteFit(0, tailSamples + 1), paletteFit(0, 0))).toBe(true);
    // Noisy palette frame: the tail must at least double
    expect(isPaletteStale(paletteFit(0, 100 * ratio), paletteFit(0, 100))).toBe(false);
    expect(isPaletteStale(paletteFit(0, 100 * ratio + 1), paletteFit(0, 100))).toBe(true);
  });
});

describe('measurePalette', () => {
  const blackPalette = [[0, 0, 0]];

  it('is the mean per-channel error and the tail count over its samples', () => {
    // 1 row: samples x = 0 and 4
    const rgba = new Uint8ClampedArray(5 * 4);
    rgba.set([5, 10, 15, 255], 0);
    rgba.set([100, 100, 100, 255], 4 * 4);
    rgba.set([255, 255, 255, 255], 2 * 4); // not sampled

    const { error, tail } = measurePalette(rgba, new Uint8Array(5), blackPalette, 5);

    expect(error).toBe((30 + 300) / 6);
    expect(tail).toBe(1); // 300 > tailError; 30 is not
  });

  it('samples every row and column, so any 8x8 element gets 16 samples', () => {
    const width = 640;
    const height = 360;
    const index = new Uint8Array(width * height);
    for (const [x0, y0] of [
      [0, 0],
      [301, 203],
      [632, 352],
    ]) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = y0; y < y0 + 8; y++) {
        for (let x = x0; x < x0 + 8; x++) rgba.set([255, 255, 255, 255], (y * width + x) * 4);
      }
      expect(measurePalette(rgba, index, blackPalette, width).tail).toBe(16);
    }
    // A 1-pixel line in any column or row is sampled too
    for (const column of [0, 1, 2, 3]) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) rgba.set([255, 255, 255, 255], (y * width + column) * 4);
      expect(measurePalette(rgba, index, blackPalette, width).tail).toBe(height / 4);
    }
  });

  it('samples tiny frames', () => {
    const white = (/** @type {number} */ n) => new Uint8ClampedArray(n * 4).fill(255);
    expect(measurePalette(white(1), new Uint8Array(1), blackPalette, 1)).toEqual({
      error: 255,
      tail: 1,
    });
    expect(measurePalette(white(21), new Uint8Array(21), blackPalette, 3).tail).toBe(6);
    expect(measurePalette(new Uint8ClampedArray(0), new Uint8Array(0), blackPalette, 0)).toEqual({
      error: 0,
      tail: 0,
    });
  });
});
