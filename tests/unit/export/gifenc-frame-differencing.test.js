import { describe, expect, it } from 'vitest';

/**
 * Frame differencing (opaque exports): pixels unchanged since the previous
 * frame are written as the transparent index over a kept frame (dispose 1).
 * What a viewer shows must equal the non-differenced GIF pixel for pixel,
 * and a frame is only differenced where that is smaller.
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import {
  createGifencEncoder,
  differenceFrame,
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
  it('writes unchanged colors as the transparent index and counts the kept pixels', () => {
    const colors = Int32Array.from([0x000000, 0xffffff, 0xff0000]);
    // Shown before: black, white, white, black; now: black, red, white, white
    const shown = Int32Array.from([0x000000, 0xffffff, 0xffffff, 0x000000]);
    const out = new Uint8Array(4);
    const kept = differenceFrame(Uint8Array.from([0, 2, 1, 1]), colors, shown, 3, out);

    expect(Array.from(out)).toEqual([3, 2, 3, 1]);
    expect(Array.from(shown)).toEqual([0x000000, 0xff0000, 0xffffff, 0xffffff]);
    expect(kept).toBe(2);
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
    const plain = encode(halfSparse, 16);
    const differenced = encode(halfSparse, 16, {
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

    // Only the cut itself, not ~136 frames after it
    expect(whole).toBeLessThanOrEqual(1);
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

/**
 * Bytes of each frame of a GIF (graphic control extension to the end of
 * the image data), as gifenc writes them
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function frameBytes(bytes) {
  const lsd = bytes[10];
  let pos = 13 + (lsd & 0x80 ? 3 * (1 << ((lsd & 7) + 1)) : 0);
  let start = 0;
  /** @type {number[]} */
  const sizes = [];
  const skipBlocks = () => {
    while (bytes[pos] !== 0) pos += bytes[pos] + 1;
    pos++;
  };
  while (pos < bytes.length) {
    const b = bytes[pos++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) start = pos - 2;
      skipBlocks();
    } else if (b === 0x2c) {
      const fields = bytes[pos + 8];
      pos += 9 + (fields & 0x80 ? 3 * (1 << ((fields & 7) + 1)) : 0) + 1;
      skipBlocks();
      sizes.push(pos - start);
    }
  }
  return sizes;
}

/**
 * The bytes each frame takes encoded whole and differenced, computed here
 * from gifenc directly (palette per frame, as paletteInterval 1 does): the
 * oracle the encoder's choice is checked against. `null` where no
 * differenced encoding exists (the first frame, no free palette index).
 * @param {Uint8ClampedArray[]} frames
 * @param {number} width
 * @param {number} height
 * @param {number} maxColors
 */
function oracle(frames, width, height, maxColors) {
  const scratch = GIFEncoder({ auto: false });
  const size = (/** @type {Uint8Array} */ index, /** @type {any} */ opts) => {
    scratch.reset();
    scratch.writeFrame(index, width, height, opts);
    return scratch.bytesView().length;
  };
  const tableSize = (/** @type {number} */ n) => 2 ** Math.max(1, Math.ceil(Math.log2(n)));
  /** @type {Int32Array | null} */
  let previous = null;
  return frames.map((rgba) => {
    const palette = quantize(rgba, maxColors, { format: 'rgb565' });
    const index = applyPalette(rgba, palette, 'rgb565');
    const colors = palette.map(([r, g, b]) => (r << 16) | (g << 8) | b);
    const shows = Int32Array.from(index, (i) => colors[i]);
    const opts = { palette, delay: 100, repeat: 0, dispose: 1 };
    const whole = size(index, opts);
    const before = previous;
    previous = shows;
    if (!before) return { whole, differenced: null };
    const room =
      palette.length < 256 && tableSize(palette.length + 1) === tableSize(palette.length);
    const unused = room ? -1 : findUnusedIndex(index, palette.length);
    const t = unused >= 0 ? unused : palette.length;
    if (t > 255) return { whole, differenced: null };
    const out = Uint8Array.from(index, (v, i) => (shows[i] === before[i] ? t : v));
    const differenced = size(out, {
      palette: unused >= 0 ? palette : [...palette, [0, 0, 0]],
      delay: 100,
      repeat: 0,
      transparent: true,
      transparentIndex: t,
      dispose: 1,
    });
    return { whole, differenced };
  });
}

describe('gifenc frame differencing: the smaller encoding of every frame', () => {
  const W2 = 96;
  const H2 = 64;
  /** @param {number} seed */
  const random = (seed) => rng(seed);
  /** @param {number[]} rgb */
  const fill = (rgb) => {
    const px = new Uint8ClampedArray(W2 * H2 * 4);
    for (let i = 0; i < W2 * H2; i++) px.set([...rgb, 255], i * 4);
    return px;
  };
  /** 1 px scanlines with particles flickering every other frame (review round 3) */
  const scanlineFlicker = () => {
    const r = random(3);
    const bg = new Uint8ClampedArray(W2 * H2 * 4);
    for (let y = 0; y < H2; y++)
      for (let x = 0; x < W2; x++)
        bg.set(y & 1 ? [240, 240, 240, 255] : [20, 20, 20, 255], (y * W2 + x) * 4);
    return Array.from({ length: 24 }, (_, f) => {
      const px = bg.slice();
      if (f % 2)
        for (let i = 0; i < W2 * H2; i++) if (r() < 0.1) px.set([255, 255, 255, 255], i * 4);
      return px;
    });
  };
  /** Ordered-dithered sky with stars blinking in a pattern, then held (review round 3) */
  const starBlink = (/** @type {string} */ pattern, /** @type {number} */ hold) => {
    const r = random(3);
    const bayer = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    const sky = new Uint8ClampedArray(W2 * H2 * 4);
    for (let y = 0; y < H2; y++)
      for (let x = 0; x < W2; x++)
        sky.set(
          (y / H2) * 16 > bayer[y & 3][x & 3] ? [20, 20, 70, 255] : [70, 40, 120, 255],
          (y * W2 + x) * 4,
        );
    const on = sky.slice();
    for (let i = 0; i < W2 * H2 * 0.04; i++)
      on.set([255, 255, 200, 255], ((r() * W2 * H2) | 0) * 4);
    const seq = [...pattern].map((c) => (c === '1' ? on : sky));
    return [...seq, ...Array(hold).fill(seq.at(-1))];
  };
  /** Two frames alternating, or a short flicker over a still frame */
  const alternate = (
    /** @type {Uint8ClampedArray} */ a,
    /** @type {Uint8ClampedArray} */ b,
    period = 1,
  ) => Array.from({ length: 20 }, (_, f) => (Math.floor(f / period) % 2 ? b : a));
  /** Random clips: random palettes, random share and shape of changes */
  const randomClip = (/** @type {number} */ seed) => {
    const r = random(seed);
    const colorCount = [1, 2, 4, 16, 300][Math.floor(r() * 5)];
    const palette = Array.from({ length: colorCount }, () => [
      (r() * 256) | 0,
      (r() * 256) | 0,
      (r() * 256) | 0,
    ]);
    let prev = new Uint8ClampedArray(W2 * H2 * 4);
    for (let i = 0; i < W2 * H2; i++) prev.set([...palette[(r() * colorCount) | 0], 255], i * 4);
    return Array.from({ length: 12 }, () => {
      const cur = prev.slice();
      const share = [0, 0.01, 0.2, 0.7, 1][Math.floor(r() * 5)];
      const x0 = (r() * W2) | 0;
      const bw = Math.max(1, (r() * W2) | 0);
      for (let i = 0; i < W2 * H2; i++) {
        const x = i % W2;
        if ((x >= x0 && x < x0 + bw && r() < share) || r() < share * 0.05) {
          cur.set([...palette[(r() * colorCount) | 0], 255], i * 4);
        }
      }
      prev = cur;
      return cur;
    });
  };

  const cases = [
    ['scanlines with flickering particles', scanlineFlicker(), 64],
    ['stars blinking 1001100110, then held', starBlink('1001100110', 20), 64],
    ['stars on, off, then held off', starBlink('10', 30), 64],
    [
      'black / white third, alternating',
      alternate(
        fill([0, 0, 0]),
        (() => {
          const px = fill([0, 0, 0]);
          for (let i = 0; i < W2 * H2; i++)
            if (i % W2 < W2 / 3) px.set([255, 255, 255, 255], i * 4);
          return px;
        })(),
      ),
      64,
    ],
    [
      'two noise frames alternating',
      alternate(noise(1).slice(0, W2 * H2 * 4), noise(2).slice(0, W2 * H2 * 4)),
      64,
    ],
    ['flicker every 3 frames', alternate(fill([10, 120, 200]), fill([200, 120, 10]), 3), 16],
    [
      'noise then still',
      [
        ...Array.from({ length: 6 }, (_, f) => noise(f + 9).slice(0, W2 * H2 * 4)),
        ...Array(8).fill(fill([30, 60, 90])),
      ],
      64,
    ],
    ...Array.from({ length: 12 }, (_, k) => [
      `random clip ${k + 1}`,
      randomClip(k * 7919 + 11),
      [2, 16, 64, 256][k % 4],
    ]),
  ];

  it.each(cases)('%s', (_label, frames, maxColors) => {
    /** @param {boolean} frameDifferencing */
    const run = (frameDifferencing) => {
      const encoder = createGifencEncoder();
      encoder.init({
        width: W2,
        height: H2,
        maxColors: /** @type {number} */ (maxColors),
        frameDelayMs: 100,
        loopCount: 0,
        quantizeFormat: 'rgb565',
        paletteInterval: 1,
        frameDifferencing,
      });
      for (const [f, rgba] of /** @type {Uint8ClampedArray[]} */ (frames).entries()) {
        encoder.addFrame({ rgba, width: W2, height: H2 }, f);
      }
      return encoder.finish();
    };
    const plain = run(false);
    const differenced = run(true);
    const written = frameBytes(differenced);
    const expected = oracle(
      /** @type {Uint8ClampedArray[]} */ (frames),
      W2,
      H2,
      /** @type {number} */ (maxColors),
    ).map(({ whole, differenced: d }) => (d === null ? whole : Math.min(whole, d)));

    // The first frame's palette is the GIF's global table: compare it with
    // the first frame of the GIF without differencing instead
    expected[0] = frameBytes(plain)[0];
    expect(written).toEqual(expected);
    expect(differenced.length).toBeLessThanOrEqual(plain.length);
    expect(renderGifFrames(differenced)).toEqual(renderGifFrames(plain));
  });
});
