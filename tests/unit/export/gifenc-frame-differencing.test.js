import { describe, expect, it } from 'vitest';

/**
 * Frame differencing (opaque exports): pixels unchanged since the previous
 * frame are written as the transparent index over a kept frame (dispose 1).
 * What a viewer shows must equal the non-differenced GIF pixel for pixel,
 * and a frame is only differenced where that is smaller.
 */

import {
  createGifencEncoder,
  differenceFrame,
  FRAME_DIFFERENCING,
  findUnusedIndex,
} from '../../../src/features/export/encoders/gifenc-encoder.js';
import { readGifStructure, renderGifFrames } from './gif-structure.js';

const W = 96;
const H = 64;

/** Deterministic pseudo-random numbers in [0, 1) */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** Static textured background with a block moving across it */
function movingBlock(f) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inBlock = x >= 4 + f * 3 && x < 20 + f * 3 && y >= 20 && y < 40;
      px[i] = inBlock ? 220 : 40 + ((x * 7 + y * 3) % 90);
      px[i + 1] = inBlock ? 60 : 90 + ((x + y * 5) % 60);
      px[i + 2] = inBlock ? 90 : 160;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Noise everywhere, new in every frame (video-like) */
function noise(f) {
  const r = rng(f * 7919 + 1);
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i += 4) {
    const base = 120 + ((i >> 2) % 40);
    px[i] = base + (r() - 0.5) * 60;
    px[i + 1] = base + (r() - 0.5) * 60;
    px[i + 2] = 200 + (r() - 0.5) * 40;
    px[i + 3] = 255;
  }
  return px;
}

/** Sparse noise over half the frame: between the limits, so frames are tried both ways */
function halfSparse(f) {
  const r = rng(f * 104729 + 3);
  const px = movingBlock(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W / 2; x++) {
      if (r() < 0.3) px[(y * W + x) * 4] = 255 * r();
    }
  }
  return px;
}

/** Many colors: each frame quantizes to a full 256-color palette */
function manyColors(f) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const moving = x >= f * 4 && x < f * 4 + 12;
      px[i] = moving ? 255 : (x * 8) & 255;
      px[i + 1] = moving ? 255 : (y * 16) & 255;
      px[i + 2] = moving ? 255 : ((x + y) * 4) & 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * @param {(f: number) => Uint8ClampedArray} generate
 * @param {number} frames
 * @param {Partial<import('../../../src/features/export/encoders/types.js').EncoderConfig>} [config]
 */
function encode(generate, frames, config = {}) {
  const encoder = createGifencEncoder();
  encoder.init({
    width: W,
    height: H,
    maxColors: 64,
    frameDelayMs: 100,
    loopCount: 0,
    quantizeFormat: 'rgb565',
    paletteInterval: 1,
    ...config,
  });
  for (let f = 0; f < frames; f++) encoder.addFrame({ rgba: generate(f), width: W, height: H }, f);
  return encoder.finish();
}

describe('differenceFrame', () => {
  it('writes unchanged colors as the transparent index and counts transitions', () => {
    const colors = Int32Array.from([0x000000, 0xffffff, 0xff0000]);
    // Shown before: black, white, white, black; now: black, red, white, white
    const shown = Int32Array.from([0x000000, 0xffffff, 0xffffff, 0x000000]);
    const out = new Uint8Array(4);
    const stats = differenceFrame(Uint8Array.from([0, 2, 1, 1]), colors, shown, 3, out);

    expect(Array.from(out)).toEqual([3, 2, 3, 1]);
    expect(Array.from(shown)).toEqual([0x000000, 0xff0000, 0xffffff, 0xffffff]);
    // kept | changed | kept | changed: 4 runs, starting from "changed"
    expect(stats).toEqual({ transitions: 4 / 4, kept: 2 / 4 });
  });

  it('compares colors, not indices, so a new palette keeps matching pixels', () => {
    const shown = Int32Array.from([0x123456, 0x123456]);
    const out = new Uint8Array(2);
    // Index 1 of the new palette is the color shown before
    differenceFrame(Uint8Array.from([1, 0]), Int32Array.from([0x000000, 0x123456]), shown, 2, out);
    expect(Array.from(out)).toEqual([2, 0]);
  });
});

describe('findUnusedIndex', () => {
  it('returns the first palette index the frame does not use, else -1', () => {
    expect(findUnusedIndex(Uint8Array.from([0, 1, 3, 3]), 4)).toBe(2);
    expect(findUnusedIndex(Uint8Array.from([0, 1, 2, 3]), 4)).toBe(-1);
  });
});

describe('gifenc frame differencing', () => {
  it.each([
    ['a moving block on a static background', movingBlock, {}],
    ['noise in every frame', noise, {}],
    ['sparse noise over half the frame', halfSparse, {}],
    ['a full 256-color palette', manyColors, { maxColors: 256 }],
    ['a reused palette (balanced schedule)', movingBlock, { paletteInterval: 10 }],
  ])('shows exactly the frames of the non-differenced GIF: %s', (_label, generate, config) => {
    const plain = encode(generate, 12, config);
    const differenced = encode(generate, 12, { ...config, frameDifferencing: true });

    const a = renderGifFrames(plain);
    const b = renderGifFrames(differenced);
    expect(b).toHaveLength(12);
    for (let f = 0; f < a.length; f++) {
      expect(b[f], `frame ${f}`).toEqual(a[f]);
    }
  });

  it('is much smaller where most pixels stay the same', () => {
    const plain = encode(movingBlock, 12);
    const differenced = encode(movingBlock, 12, { frameDifferencing: true });

    expect(differenced.length).toBeLessThan(plain.length * 0.7);
    const { frames } = readGifStructure(differenced);
    expect(frames.every((f) => f.disposal === 1)).toBe(true);
    expect(frames.slice(1).every((f) => f.transparent)).toBe(true);
  });

  it('never grows the GIF where pixels change everywhere', () => {
    const plain = encode(noise, 12);
    const differenced = encode(noise, 12, { frameDifferencing: true });

    expect(differenced.length).toBeLessThanOrEqual(plain.length);
  });

  it('keeps the smaller encoding of each tried frame', () => {
    const plain = encode(halfSparse, 2 * FRAME_DIFFERENCING.trialEvery);
    const differenced = encode(halfSparse, 2 * FRAME_DIFFERENCING.trialEvery, {
      frameDifferencing: true,
    });

    expect(differenced.length).toBeLessThanOrEqual(plain.length);
  });

  it.each([
    ['every frame', 1],
    ['the balanced schedule', 10],
  ])('never grows flat colors with few transitions (review case, palette %s)', (_l, interval) => {
    // 20 frames at 480x240: solid black, then black with a white left third
    const width = 480;
    const height = 240;
    /** @param {number} f */
    const flat = (f) => {
      const px = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const white = f % 2 === 1 && i % width < width / 3;
        px.fill(white ? 255 : 0, i * 4, i * 4 + 3);
        px[i * 4 + 3] = 255;
      }
      return px;
    };
    /** @param {boolean} frameDifferencing */
    const run = (frameDifferencing) => {
      const encoder = createGifencEncoder();
      encoder.init({
        width,
        height,
        maxColors: 64,
        frameDelayMs: 100,
        loopCount: 0,
        quantizeFormat: 'rgb565',
        paletteInterval: interval,
        frameDifferencing,
      });
      for (let f = 0; f < 20; f++) encoder.addFrame({ rgba: flat(f), width, height }, f);
      return encoder.finish();
    };
    const plain = run(false);
    const differenced = run(true);
    process.stderr.write(
      `[flat ${interval}] plain ${plain.length} B, differenced ${differenced.length} B\n`,
    );

    expect(differenced.length).toBeLessThanOrEqual(plain.length);
    const a = renderGifFrames(plain);
    const b = renderGifFrames(differenced);
    expect(b).toHaveLength(a.length);
    // Count mismatches in a loop: a deep equal of 20 large frames is slow
    const differing = a.reduce((n, frame, f) => {
      let d = 0;
      for (let i = 0; i < frame.length; i++) if (frame[i] !== b[f][i]) d++;
      return n + d;
    }, 0);
    expect(differing).toBe(0);
  });

  it('differences a static stretch again soon after video-like frames (review case)', () => {
    // 12 noisy frames, then 150 frames of a static background with a moving block
    const width = 160;
    const height = 90;
    const r = rng(5);
    /** @param {number} f */
    const video = (f) => {
      const px = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const n = (r() - 0.5) * 20;
          px[i] = ((x + f * 3) % 256) + n;
          px[i + 1] = ((y * 2 + f) % 256) + n;
          px[i + 2] = ((x + y + f * 5) % 256) + n;
          px[i + 3] = 255;
        }
      }
      return px;
    };
    /** @param {number} f */
    const still = (f) => {
      const px = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const block = Math.abs(x - 20 - (f % 60) * 4) < 10 && Math.abs(y - 50) < 10;
          px.set(block ? [255, 0, 0, 255] : [(x >> 5) * 30, (y >> 5) * 40, 200, 255], i);
        }
      }
      return px;
    };
    const frames = [
      ...Array.from({ length: 12 }, (_, f) => video(f)),
      ...Array.from({ length: 150 }, (_, f) => still(f)),
    ];
    /** @param {boolean} frameDifferencing */
    const run = (frameDifferencing) => {
      const encoder = createGifencEncoder();
      encoder.init({
        width,
        height,
        maxColors: 64,
        frameDelayMs: 100,
        loopCount: 0,
        quantizeFormat: 'rgb565',
        paletteInterval: 1,
        frameDifferencing,
      });
      for (const [f, rgba] of frames.entries()) encoder.addFrame({ rgba, width, height }, f);
      return encoder.finish();
    };
    const plain = run(false);
    const differenced = run(true);
    const whole = readGifStructure(differenced)
      .frames.slice(12)
      .filter((f) => !f.transparent).length;
    process.stderr.write(
      `[noise12+static150] plain ${plain.length} B, differenced ${differenced.length} B, ${whole} of 150 static frames whole\n`,
    );

    // Within about two trial periods of the cut, not ~136 frames later
    expect(whole).toBeLessThanOrEqual(2 * FRAME_DIFFERENCING.trialEvery);
  });

  it('is off for transparent exports, which clear pixels with dispose 2', () => {
    /** @param {number} f */
    const cutout = (f) => {
      const px = movingBlock(f);
      for (let i = 0; i < px.length; i += 4) if (px[i] !== 220) px[i + 3] = 0;
      return px;
    };
    const without = encode(cutout, 6, { transparent: true });
    const withFlag = encode(cutout, 6, { transparent: true, frameDifferencing: true });

    expect(withFlag).toEqual(without);
    expect(readGifStructure(withFlag).frames.every((f) => f.disposal === 2)).toBe(true);
  });
});
