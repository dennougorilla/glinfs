import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Transparent exports (background removal / sources with alpha): gifenc
 * reserves one palette slot for the transparent index, quantizes from opaque
 * pixels only and disposes every frame to the background.
 */

const writes = vi.hoisted(() => /** @type {{ index: Uint8Array, opts: any }[]} */ ([]));

vi.mock('gifenc', async (importOriginal) => {
  const actual = /** @type {typeof import('gifenc')} */ (await importOriginal());
  return {
    ...actual,
    quantize: vi.fn(actual.quantize),
    GIFEncoder: (/** @type {any} */ ...args) => {
      const real = actual.GIFEncoder(...args);
      const writeFrame = real.writeFrame;
      real.writeFrame = (
        /** @type {Uint8Array} */ index,
        /** @type {number} */ w,
        /** @type {number} */ h,
        /** @type {any} */ opts,
      ) => {
        writes.push({ index: Uint8Array.from(index), opts });
        return writeFrame(index, w, h, opts);
      };
      return real;
    },
  };
});

import { quantize } from 'gifenc';
import {
  createGifencEncoder,
  getGifencMetadata,
  measurePalette,
  opaquePixels,
  paletteColorCount,
} from '../../../src/features/export/encoders/gifenc-encoder.js';
import { getGifsicleMetadata } from '../../../src/features/export/encoders/gifsicle-encoder.js';
import { readGifStructure } from './gif-structure.js';

/** @typedef {[number, number, number, number]} RGBA */

/**
 * 4x4 frame: left half `left`, right half `right`
 * @param {RGBA} left
 * @param {RGBA} right
 */
function split(left, right) {
  const out = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) out.set(x < 2 ? left : right, (y * 4 + x) * 4);
  }
  return out;
}

/** @type {RGBA} */
const RED = [255, 0, 0, 255];
/** @type {RGBA} */
const BLUE = [0, 0, 255, 255];
/** @type {RGBA} */
const CLEAR = [0, 0, 0, 0];

/**
 * @param {Partial<import('../../../src/features/export/encoders/types.js').EncoderConfig>} over
 */
function initEncoder(over = {}) {
  const encoder = createGifencEncoder();
  encoder.init({
    width: 4,
    height: 4,
    maxColors: 16,
    frameDelayMs: 100,
    loopCount: 0,
    quantizeFormat: 'rgb565',
    paletteInterval: 1,
    transparent: true,
    ...over,
  });
  return encoder;
}

beforeEach(() => {
  writes.length = 0;
  vi.mocked(quantize).mockClear();
});

describe('capabilities', () => {
  it('reports transparency support per encoder', () => {
    expect(getGifencMetadata().capabilities.supportsTransparency).toBe(true);
    expect(getGifsicleMetadata().capabilities.supportsTransparency).toBe(false);
  });
});

describe('opaquePixels / paletteColorCount', () => {
  it('returns the input itself when every pixel is opaque', () => {
    const rgba = split(RED, BLUE);
    expect(opaquePixels(rgba)).toBe(rgba);
  });

  it('compacts the opaque pixels (alpha >= 128) in order', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 127, 4, 5, 6, 128, 7, 8, 9, 0, 10, 11, 12, 255]);
    expect(Array.from(opaquePixels(rgba))).toEqual([4, 5, 6, 128, 10, 11, 12, 255]);
    expect(opaquePixels(new Uint8ClampedArray([0, 0, 0, 0]))).toHaveLength(0);
  });

  it('reserves one slot, keeping at least 2 colors and at most 255', () => {
    expect(paletteColorCount(256, false)).toBe(256);
    expect(paletteColorCount(256, true)).toBe(255);
    expect(paletteColorCount(16, true)).toBe(15);
    expect(paletteColorCount(2, true)).toBe(2);
  });
});

describe('transparent frames', () => {
  it('quantizes opaque pixels only with maxColors - 1 and maps alpha < 128 to the reserved index', () => {
    const encoder = initEncoder();
    encoder.addFrame({ rgba: split(RED, CLEAR), width: 4, height: 4 }, 0);

    const [call] = vi.mocked(quantize).mock.calls;
    expect(call[0]).toHaveLength(8 * 4);
    expect(call[1]).toBe(15);

    const [{ index, opts }] = writes;
    const palette = vi.mocked(quantize).mock.results[0].value;
    expect(opts).toMatchObject({
      transparent: true,
      transparentIndex: palette.length,
      dispose: 2,
      delay: 100,
      repeat: 0,
    });
    expect(opts.palette).toEqual([...palette, [0, 0, 0]]);
    for (let i = 0; i < 16; i++) {
      if (i % 4 < 2) expect(index[i]).toBeLessThan(palette.length);
      else expect(index[i]).toBe(palette.length);
    }
  });

  it('writes fully opaque frames of a transparent export with dispose 2 too', () => {
    const encoder = initEncoder();
    encoder.addFrame({ rgba: split(RED, BLUE), width: 4, height: 4 }, 0);
    expect(writes[0].opts).toMatchObject({ transparent: true, dispose: 2 });
    // The whole (unfiltered) frame was quantized
    expect(vi.mocked(quantize).mock.calls[0][0]).toHaveLength(16 * 4);
  });

  it('uses a single black entry for a frame without any opaque pixel', () => {
    const encoder = initEncoder();
    encoder.addFrame({ rgba: split(CLEAR, CLEAR), width: 4, height: 4 }, 0);
    expect(quantize).not.toHaveBeenCalled();
    expect(writes[0].opts).toMatchObject({
      palette: [
        [0, 0, 0],
        [0, 0, 0],
      ],
      transparentIndex: 1,
    });
    expect(Array.from(writes[0].index)).toEqual(Array(16).fill(1));
  });

  it('keeps the transparent index inside a 256-entry table', () => {
    const encoder = initEncoder({ maxColors: 256, width: 16, height: 16 });
    const rgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let p = 0; p < 256; p++) rgba.set([p, 255 - p, (p * 7) & 255, p < 200 ? 255 : 0], p * 4);
    encoder.addFrame({ rgba, width: 16, height: 16 }, 0);
    const { opts } = writes[0];
    expect(opts.palette.length).toBeLessThanOrEqual(256);
    expect(opts.transparentIndex).toBe(opts.palette.length - 1);
  });

  it('quantizes the clip-wide sample from its opaque pixels only', () => {
    const sample = new Uint8ClampedArray([...RED, ...CLEAR, ...BLUE, ...CLEAR]);
    const encoder = initEncoder({ paletteInterval: 0, paletteSample: sample });
    expect(vi.mocked(quantize).mock.calls[0][0]).toHaveLength(8);
    expect(vi.mocked(quantize).mock.calls[0][1]).toBe(15);

    encoder.addFrame({ rgba: split(RED, CLEAR), width: 4, height: 4 }, 0);
    // No per-frame rebuild with a clip-wide palette
    expect(quantize).toHaveBeenCalledTimes(1);
  });

  it('falls back to the first frame when the sample has no opaque pixel', () => {
    const encoder = initEncoder({
      paletteInterval: 0,
      paletteSample: new Uint8ClampedArray([...CLEAR, ...CLEAR]),
    });
    expect(quantize).not.toHaveBeenCalled();
    encoder.addFrame({ rgba: split(RED, CLEAR), width: 4, height: 4 }, 0);
    expect(quantize).toHaveBeenCalledTimes(1);
  });

  it('ignores transparent pixels when judging palette staleness', () => {
    // Balanced schedule: frame 1 reuses frame 0's palette unless stale.
    // Its transparent half carries leftover blue RGB (alpha 0) that no
    // palette color matches; counting it would force an early rebuild.
    const encoder = initEncoder({ paletteInterval: 10 });
    encoder.addFrame({ rgba: split(RED, CLEAR), width: 4, height: 4 }, 0);
    encoder.addFrame({ rgba: split(RED, [0, 0, 255, 0]), width: 4, height: 4 }, 1);
    expect(quantize).toHaveBeenCalledTimes(1);
  });

  it('produces GCE blocks with transparency and restore-to-background disposal', () => {
    const encoder = initEncoder();
    encoder.addFrame({ rgba: split(RED, CLEAR), width: 4, height: 4, delayMs: 250 }, 0);
    encoder.addFrame({ rgba: split(BLUE, BLUE), width: 4, height: 4 }, 1);
    const { frames } = readGifStructure(encoder.finish());

    expect(frames).toHaveLength(2);
    for (const [i, frame] of frames.entries()) {
      expect(frame.disposal).toBe(2);
      expect(frame.transparent).toBe(true);
      expect(frame.transparentIndex).toBe(writes[i].opts.transparentIndex);
      expect(frame.transparentIndex).toBeLessThan(frame.colorTableSize);
    }
    expect(frames.map((f) => f.delayCs)).toEqual([25, 10]);
  });
});

describe('opaque (default) exports', () => {
  it('writes exactly the pre-transparency options', () => {
    const encoder = initEncoder({ transparent: false });
    encoder.addFrame({ rgba: split(RED, BLUE), width: 4, height: 4 }, 0);
    expect(Object.keys(writes[0].opts).sort()).toEqual(['delay', 'palette', 'repeat']);
    expect(vi.mocked(quantize).mock.calls[0][1]).toBe(16);

    const { frames } = readGifStructure(encoder.finish());
    expect(frames[0]).toMatchObject({ disposal: 0, transparent: false, delayCs: 10 });
  });

  it('honors a per-frame delay and falls back to frameDelayMs', () => {
    const encoder = initEncoder({ transparent: false });
    encoder.addFrame({ rgba: split(RED, BLUE), width: 4, height: 4, delayMs: 300 }, 0);
    encoder.addFrame({ rgba: split(RED, BLUE), width: 4, height: 4 }, 1);
    expect(writes.map((w) => w.opts.delay)).toEqual([300, 100]);
  });

  it('forgets transparency after dispose + re-init', () => {
    const encoder = initEncoder();
    encoder.dispose();
    encoder.init({ width: 4, height: 4, maxColors: 16, frameDelayMs: 100, loopCount: 0 });
    encoder.addFrame({ rgba: split(RED, CLEAR), width: 4, height: 4 }, 0);
    expect(writes[0].opts.transparent).toBeUndefined();
  });
});

describe('measurePalette skipTransparent', () => {
  it('only measures opaque pixels when asked', () => {
    const rgba = split(RED, [0, 0, 255, 0]);
    const palette = [[255, 0, 0]];
    const index = new Uint8Array(16);
    const all = measurePalette(rgba, index, palette, 4);
    const opaqueOnly = measurePalette(rgba, index, palette, 4, true);
    expect(all.error).toBeGreaterThan(0);
    expect(opaqueOnly).toEqual({ error: 0, tail: 0 });
  });

  it('returns zero error when every sampled pixel is transparent', () => {
    const rgba = split(CLEAR, CLEAR);
    expect(measurePalette(rgba, new Uint8Array(16), [[1, 2, 3]], 4, true)).toEqual({
      error: 0,
      tail: 0,
    });
  });
});
