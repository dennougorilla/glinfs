import { GIFEncoder } from 'gifenc';
import { describe, expect, it } from 'vitest';
import {
  createFrameEncoding,
  encodeFrame,
  encodeSmaller,
  STEP_PIXELS,
} from '../../../src/features/export/encoders/gif-frame.js';

/** Deterministic pseudo-random numbers in [0, 1) */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** gifenc's bytes for a frame that is not the first */
function gifencFrame(index, width, height, opts) {
  const enc = GIFEncoder({ auto: false });
  enc.writeFrame(index, width, height, opts);
  return enc.bytesView();
}

/** Byte equality (toEqual on large typed arrays is slow) */
function expectSameBytes(actual, expected) {
  expect(actual.length).toBe(expected.length);
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

/** A palette of n random colors */
function palette(r, n) {
  return Array.from({ length: n }, () => [(r() * 256) | 0, (r() * 256) | 0, (r() * 256) | 0]);
}

/** Indices: `runs` controls how compressible they are (1 = noise) */
function indices(r, width, height, colors, runs) {
  const out = new Uint8Array(width * height);
  let c = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % runs === 0) c = (r() * colors) | 0;
    out[i] = c;
  }
  return out;
}

describe('encodeFrame', () => {
  it('writes the bytes gifenc writes, for any size, palette and options', () => {
    const r = rng(7);
    const encoding = createFrameEncoding();
    const sizes = [
      [1, 1],
      [3, 2],
      [97, 61],
      [640, 360],
    ];
    for (const [width, height] of sizes) {
      for (const colors of [1, 2, 5, 64, 200, 256]) {
        for (const runs of [1, 7, 300]) {
          const pal = palette(r, colors);
          const index = indices(r, width, height, colors, runs);
          const opts = [
            { palette: pal, delay: 33, repeat: 0, dispose: 1 },
            {
              palette: pal,
              delay: 1234,
              dispose: 1,
              transparent: true,
              transparentIndex: colors - 1,
            },
            { palette: pal, delay: 0, transparent: true, transparentIndex: 0 },
            { palette: pal, delay: 50 },
          ];
          for (const o of opts) {
            const ours = encodeFrame(encoding, index, width, height, o);
            expectSameBytes(ours, gifencFrame(index, width, height, o));
          }
        }
      }
    }
  });

  it('gives the same bytes when coded in steps of any size', () => {
    const r = rng(11);
    const index = indices(r, 300, 200, 64, 3);
    const opts = { palette: palette(r, 64), delay: 40, dispose: 1 };
    const expected = gifencFrame(index, 300, 200, opts);
    const encoding = createFrameEncoding();
    for (const step of [1, 13, 4096, STEP_PIXELS]) {
      encoding.start(index, 300, 200, opts);
      let bound = encoding.bound();
      while (!encoding.step(step)) {
        // The bound never decreases and never passes the final size
        expect(encoding.bound()).toBeGreaterThanOrEqual(bound);
        expect(encoding.bound()).toBeLessThanOrEqual(expected.length);
        bound = encoding.bound();
      }
      expectSameBytes(encoding.view(), expected);
      expect(encoding.bound()).toBe(expected.length);
    }
  });
});

describe('encodeSmaller', () => {
  const W = 640;
  const H = 360;

  /** Two started encodings of `a` and `b` */
  function race(a, b) {
    const r = rng(3);
    const pal = palette(r, 64);
    const first = createFrameEncoding();
    const second = createFrameEncoding();
    first.start(a, W, H, { palette: pal, delay: 33, dispose: 1 });
    second.start(b, W, H, {
      palette: pal,
      delay: 33,
      dispose: 1,
      transparent: true,
      transparentIndex: 63,
    });
    return { pal, result: encodeSmaller(first, second), first, second };
  }

  it('returns the smaller, the first on a tie, as encoding both does', () => {
    const r = rng(5);
    const cases = [
      [indices(r, W, H, 64, 1), indices(r, W, H, 64, 500)],
      [indices(r, W, H, 64, 500), indices(r, W, H, 64, 1)],
      [indices(r, W, H, 64, 9), indices(r, W, H, 64, 10)],
    ];
    const same = indices(r, W, H, 64, 4);
    cases.push([same, same]);
    for (const [a, b] of cases) {
      const { pal, result } = race(a, b);
      const whole = gifencFrame(a, W, H, { palette: pal, delay: 33, dispose: 1 });
      const kept = gifencFrame(b, W, H, {
        palette: pal,
        delay: 33,
        dispose: 1,
        transparent: true,
        transparentIndex: 63,
      });
      const expected = kept.length < whole.length ? kept : whole;
      expectSameBytes(result.bytes, expected);
      expect(result.second).toBe(kept.length < whole.length);
    }
  });

  it('stops the larger encoding once it cannot win', () => {
    const r = rng(9);
    // Noise against long runs: the noise passes the runs' final size early
    for (const [a, b, loser] of [
      [indices(r, W, H, 64, 1), indices(r, W, H, 64, 5000), 'first'],
      [indices(r, W, H, 64, 5000), indices(r, W, H, 64, 1), 'second'],
    ]) {
      const run = race(a, b);
      const full = gifencFrame(loser === 'first' ? a : b, W, H, {
        palette: run.pal,
        delay: 33,
        dispose: 1,
        transparent: loser === 'second',
        transparentIndex: 63,
      }).length;
      const winner = run.result.bytes.length;
      expect(run.result.second).toBe(loser === 'first');
      // Dropped within one step of passing the winner, far from its end
      expect(run[loser].bound()).toBeGreaterThanOrEqual(winner);
      expect(run[loser].bound()).toBeLessThan(full / 4);
    }
  });
});
