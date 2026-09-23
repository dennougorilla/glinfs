import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Global palette sampling for the fast preset (#99 item b): the palette is
 * quantized once from pixels sampled across the whole clip, not frame 0.
 */

const managerFactory = vi.hoisted(() => ({
  /** @type {(() => any) | null} */
  create: null,
}));

vi.mock('../../../src/workers/worker-manager.js', () => ({
  createEncoderManager: () => {
    if (!managerFactory.create) {
      throw new Error('Test did not install a fake manager factory');
    }
    return managerFactory.create();
  },
}));

import { applyPalette, quantize } from 'gifenc';
import { buildPaletteSample, encodeGif } from '../../../src/features/export/api.js';
import {
  computePaletteSampleStep,
  PALETTE_SAMPLE,
  sampledPixelCount,
  sampleFramePixels,
  selectPaletteSampleIndices,
} from '../../../src/features/export/core.js';

/**
 * Frame whose copyTo fills every pixel's red channel with its clip index,
 * so a sample reveals which frames it was taken from.
 * @param {number} index
 * @param {number} [size=8]
 */
function createTaggedFrame(index, size = 8) {
  return {
    id: `frame-${index}`,
    frame: {
      codedWidth: size,
      codedHeight: size,
      copyTo: vi.fn(async (/** @type {Uint8ClampedArray} */ buffer) => {
        for (let p = 0; p < buffer.length; p += 4) {
          buffer[p] = index;
          buffer[p + 3] = 255;
        }
      }),
      close: vi.fn(),
    },
    timestamp: index,
    width: size,
    height: size,
  };
}

/** @param {number} count */
function createFrames(count) {
  return Array.from({ length: count }, (_, i) => createTaggedFrame(i));
}

/**
 * Red values (= source frame indices) present in an RGBA sample
 * @param {Uint8ClampedArray} sample
 */
function sampledFrameIndices(sample) {
  const seen = new Set();
  for (let p = 0; p < sample.length; p += 4) seen.add(sample[p]);
  return [...seen].sort((a, b) => a - b);
}

/**
 * RGBA frame of 4 black rows then 4 white rows, repeated
 * @param {number} w
 * @param {number} h
 */
function stripeFrame(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const pixels = new Uint32Array(rgba.buffer);
  for (let y = 0; y < h; y++) {
    // 0xffffffff = opaque white, 0xff000000 = opaque black (little-endian RGBA)
    pixels.fill(y % 8 < 4 ? 0xff000000 : 0xffffffff, y * w, (y + 1) * w);
  }
  return rgba;
}

/** @param {Uint8ClampedArray} rgba - Square frame to copy out */
function createStripeFrame(rgba) {
  const frame = createTaggedFrame(0, Math.sqrt(rgba.length / 4));
  frame.frame.copyTo = vi.fn(async (/** @type {Uint8ClampedArray} */ buffer) => {
    buffer.set(rgba);
  });
  return frame;
}

describe('selectPaletteSampleIndices', () => {
  it('spreads indices evenly across the whole clip, first and last included', () => {
    expect(selectPaletteSampleIndices(100, 5)).toEqual([0, 25, 50, 74, 99]);
    const idx = selectPaletteSampleIndices(450);
    expect(idx).toHaveLength(PALETTE_SAMPLE.maxFrames);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(449);
    // Evenly spaced: gaps differ by at most one frame (rounding)
    const gaps = idx.slice(1).map((v, i) => v - idx[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('returns strictly ascending unique indices for every clip length', () => {
    for (let total = 1; total <= 200; total++) {
      const idx = selectPaletteSampleIndices(total);
      expect(idx).toHaveLength(Math.min(total, PALETTE_SAMPLE.maxFrames));
      for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
      expect(idx.at(-1)).toBe(total - 1);
    }
  });

  it('handles empty and single-frame clips', () => {
    expect(selectPaletteSampleIndices(0)).toEqual([]);
    expect(selectPaletteSampleIndices(1)).toEqual([0]);
    expect(selectPaletteSampleIndices(10, 1)).toEqual([0]);
  });
});

describe('computePaletteSampleStep', () => {
  const sizes = [
    [1, 1],
    [7, 3],
    [640, 480],
    [1001, 999],
    [1280, 720],
    [1920, 1080],
    [3840, 2160],
  ];

  it('keeps the total sampled pixel count within the budget', () => {
    for (const [w, h] of sizes) {
      for (const frames of [1, 3, PALETTE_SAMPLE.maxFrames]) {
        const step = computePaletteSampleStep(w, h, frames);
        expect(step).toBeGreaterThanOrEqual(1);
        expect(sampledPixelCount(w, h, step) * frames).toBeLessThanOrEqual(
          PALETTE_SAMPLE.maxPixels,
        );
      }
    }
  });

  it('does not waste the budget on large frames (uses at least a quarter)', () => {
    for (const [w, h] of sizes.filter(([w, h]) => w * h * 16 > PALETTE_SAMPLE.maxPixels)) {
      const frames = PALETTE_SAMPLE.maxFrames;
      const step = computePaletteSampleStep(w, h, frames);
      expect(sampledPixelCount(w, h, step) * frames).toBeGreaterThan(PALETTE_SAMPLE.maxPixels / 4);
    }
  });

  it('samples every pixel when the clip already fits the budget', () => {
    expect(computePaletteSampleStep(16, 16, 4)).toBe(1);
  });
});

describe('sampleFramePixels', () => {
  it('takes one in-bounds pixel from each step x step cell, in cell order', () => {
    // 5x3 frame; pixel (x, y) has red = y * 10 + x
    const w = 5;
    const h = 3;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) rgba.set([y * 10 + x, 1, 2, 255], (y * w + x) * 4);
    }
    const out = new Uint8ClampedArray(sampledPixelCount(w, h, 2) * 4 + 4);
    const end = sampleFramePixels(rgba, w, h, 2, out, 4, 7);

    expect(end).toBe(out.length);
    const cells = [];
    for (let p = 4; p < end; p += 4) {
      const red = out[p];
      cells.push([Math.floor((red % 10) / 2), Math.floor(Math.floor(red / 10) / 2)]);
      expect([...out.subarray(p + 1, p + 4)]).toEqual([1, 2, 255]);
    }
    // Row-major over the 3x2 cells, including the partial edge cells
    expect(cells).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it('is deterministic per seed and varies the jitter between seeds', () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) rgba.set([p & 255, p >> 8, 0, 255], p * 4);
    const sample = (/** @type {number} */ seed) => {
      const out = new Uint8ClampedArray(sampledPixelCount(w, h, 8) * 4);
      sampleFramePixels(rgba, w, h, 8, out, 0, seed);
      return out;
    };

    expect(sample(3)).toEqual(sample(3));
    expect(sample(3)).not.toEqual(sample(4));
  });

  it('does not alias with rows repeating at the cell size', () => {
    // 4 black rows then 4 white rows: a fixed step-8 grid only sees black
    const w = 512;
    const h = 512;
    const rgba = stripeFrame(w, h);
    const out = new Uint8ClampedArray(sampledPixelCount(w, h, 8) * 4);
    sampleFramePixels(rgba, w, h, 8, out, 0, 0);

    let white = 0;
    for (let p = 0; p < out.length; p += 4) if (out[p] === 255) white++;
    const share = white / (out.length / 4);
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });
});

describe('buildPaletteSample', () => {
  it('samples frames spread across the whole clip, not just the start', async () => {
    const frames = createFrames(40);
    const sample = await buildPaletteSample(frames, null);

    const expected = selectPaletteSampleIndices(40);
    expect(sampledFrameIndices(sample)).toEqual(expected);
    expect(expected.at(-1)).toBe(39);
    // Only the sampled frames are extracted
    const extracted = frames.filter((f) => f.frame.copyTo.mock.calls.length > 0).length;
    expect(extracted).toBe(expected.length);
  });

  it('stays within the pixel budget for large frames', async () => {
    const frames = Array.from({ length: 30 }, (_, i) => createTaggedFrame(i, 512));
    const sample = await buildPaletteSample(frames, null);

    expect(sample.length / 4).toBeLessThanOrEqual(PALETTE_SAMPLE.maxPixels);
    expect(sample.length / 4).toBeGreaterThan(0);
  });

  it('keeps both colors of a periodic stripe pattern (no aliasing)', async () => {
    // 16 frames of 512x512 give step 8, the stripe period
    const stripes = stripeFrame(512, 512);
    const frames = Array.from({ length: 16 }, () => createStripeFrame(stripes));
    const sample = await buildPaletteSample(frames, null);
    expect(computePaletteSampleStep(512, 512, 16)).toBe(8);

    const palette = quantize(sample, 16, { format: 'rgb444' });
    expect(palette).toContainEqual([0, 0, 0]);
    expect(palette).toContainEqual([255, 255, 255]);
    // The exported frame keeps the stripes instead of coming out solid
    const index = applyPalette(stripes, palette, 'rgb444');
    expect(new Set(index).size).toBe(2);
  });

  it('is reproducible: the same clip gives the same sample', async () => {
    const make = () =>
      Array.from({ length: 20 }, (_, i) => {
        // 128x128 x 16 sample frames exceeds the budget, so cells are jittered
        const frame = createTaggedFrame(i, 128);
        frame.frame.copyTo = vi.fn(async (/** @type {Uint8ClampedArray} */ buffer) => {
          for (let p = 0; p < buffer.length; p += 4) {
            buffer[p] = p >> 2;
            buffer[p + 1] = i;
            buffer[p + 2] = p >> 10;
            buffer[p + 3] = 255;
          }
        });
        return frame;
      });

    const first = await buildPaletteSample(make(), null);
    const second = await buildPaletteSample(make(), null);
    expect(second.length).toBe(first.length);
    // Byte-wise; toEqual's element diff is very slow on a 256KB array
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it('throws AbortError between extractions once aborted', async () => {
    const controller = new AbortController();
    const frames = createFrames(20);
    frames[0].frame.copyTo.mockImplementation(async () => controller.abort());

    await expect(buildPaletteSample(frames, null, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(frames.at(-1)?.frame.copyTo).not.toHaveBeenCalled();
  });
});

describe('encodeGif palette sample wiring', () => {
  /** @type {any[]} */
  let initConfigs;

  beforeEach(() => {
    initConfigs = [];
    managerFactory.create = () => ({
      onProgress: null,
      onError: null,
      async init(/** @type {any} */ config) {
        initConfigs.push(config);
      },
      addFrame(
        /** @type {any} */ _rgba,
        /** @type {number} */ _w,
        /** @type {number} */ _h,
        /** @type {number} */ i,
      ) {
        queueMicrotask(() => this.onProgress?.({ percent: 0, frameIndex: i, totalFrames: 1 }));
      },
      async finish() {
        return new Blob(['gif'], { type: 'image/gif' });
      },
      cancel() {},
      dispose() {},
    });
  });

  /**
   * @param {string} encoderPreset
   * @param {string} [encoderId]
   */
  const encode = (encoderPreset, encoderId = 'gifenc-js') =>
    encodeGif({
      frames: createFrames(24),
      crop: null,
      settings: /** @type {any} */ ({
        quality: 0.8,
        frameSkip: 1,
        playbackSpeed: 1,
        loopCount: 0,
        encoderPreset,
        encoderId,
      }),
      fps: 30,
      onProgress: vi.fn(),
    });

  it('fast passes a clip-wide sample with paletteInterval 0', async () => {
    await encode('fast');

    const [config] = initConfigs;
    expect(config.paletteInterval).toBe(0);
    expect(config.paletteSample).toBeInstanceOf(Uint8ClampedArray);
    expect(sampledFrameIndices(config.paletteSample)).toEqual(selectPaletteSampleIndices(24));
  });

  it.each(['quality', 'balanced'])(
    '%s keeps its per-frame schedule without a sample',
    async (p) => {
      await encode(p);

      expect(initConfigs[0].paletteSample).toBeUndefined();
      expect(initConfigs[0].paletteInterval).toBeGreaterThan(0);
    },
  );

  it('skips the pre-pass for gifsicle, which quantizes internally', async () => {
    await encode('fast', 'gifsicle-wasm');

    expect(initConfigs[0].paletteSample).toBeUndefined();
  });
});
