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

import { buildPaletteSample, encodeGif } from '../../../src/features/export/api.js';
import {
  computePaletteSampleStep,
  PALETTE_SAMPLE,
  sampledPixelCount,
  samplePixelGrid,
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

describe('samplePixelGrid', () => {
  it('copies every step-th pixel of every step-th row, in order', () => {
    // 5x3 frame; pixel (x, y) has red = y * 10 + x
    const w = 5;
    const h = 3;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) rgba.set([y * 10 + x, 1, 2, 255], (y * w + x) * 4);
    }
    const out = new Uint8ClampedArray(sampledPixelCount(w, h, 2) * 4 + 4);
    const end = samplePixelGrid(rgba, w, h, 2, out, 4);

    expect(end).toBe(out.length);
    const reds = [];
    for (let p = 4; p < end; p += 4) reds.push(out[p]);
    expect(reds).toEqual([0, 2, 4, 20, 22, 24]);
    expect([...out.subarray(4, 8)]).toEqual([0, 1, 2, 255]);
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
