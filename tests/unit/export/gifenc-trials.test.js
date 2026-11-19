import { describe, expect, it, vi } from 'vitest';

/**
 * Frame differencing with a second worker for the trials: the GIF must be
 * the same bytes as with every trial run in the encoder, the frames written
 * in order, and a failed trial must fail the export.
 */

import {
  createFrameEncoding,
  encodeSmaller,
} from '../../../src/features/export/encoders/gif-frame.js';
import {
  createGifencEncoder,
  TRIALS_AWAY,
} from '../../../src/features/export/encoders/gifenc-encoder.js';

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

/** A textured background with a moving block and some noisy frames */
function frame(f) {
  const r = rng(f * 7919 + 1);
  const px = new Uint8ClampedArray(W * H * 4);
  const noisy = f % 5 === 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const block = x >= f * 4 && x < f * 4 + 16 && y >= 20 && y < 40;
      const n = noisy ? (r() - 0.5) * 80 : 0;
      px[i] = (block ? 230 : 40 + ((x * 7 + y * 3) % 90)) + n;
      px[i + 1] = (block ? 60 : 90 + ((x + y * 5) % 60)) + n;
      px[i + 2] = block ? 90 : 160;
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * A trial runner that runs the trial worker's code in this thread, each job
 * answered when `release` is called (or right away with `auto`)
 */
function fakeRunner({ auto = false, fail = null } = {}) {
  const whole = createFrameEncoding();
  const differenced = createFrameEncoding();
  /** @type {Array<() => void>} */
  const held = [];
  const runner = {
    pending: 0,
    jobs: 0,
    run: vi.fn((job) => {
      runner.pending++;
      runner.jobs++;
      const n = runner.jobs;
      return new Promise((resolve, reject) => {
        const answer = () => {
          runner.pending--;
          if (fail === n) {
            reject(new Error('trial failed'));
            return;
          }
          whole.start(new Uint8Array(job.index), job.width, job.height, job.wholeOptions);
          differenced.start(
            new Uint8Array(job.differenced),
            job.width,
            job.height,
            job.keptOptions,
          );
          resolve({
            bytes: encodeSmaller(whole, differenced).bytes.slice(),
            index: job.index,
            differenced: job.differenced,
          });
        };
        if (auto) queueMicrotask(answer);
        else held.push(answer);
      });
    }),
    release() {
      held.shift()?.();
    },
    get held() {
      return held.length;
    },
    terminate() {},
  };
  return runner;
}

const CONFIG = {
  width: W,
  height: H,
  maxColors: 64,
  frameDelayMs: 100,
  loopCount: 0,
  quantizeFormat: 'rgb565',
  paletteInterval: 1,
  frameDifferencing: true,
};

/** Flush pending promise callbacks */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('gifenc frame differencing on a second worker', () => {
  it('writes the same bytes as with every trial in the encoder', async () => {
    const frames = Array.from({ length: 20 }, (_, f) => frame(f));
    const local = createGifencEncoder();
    local.init(CONFIG);
    for (const [i, px] of frames.entries())
      local.addFrame({ rgba: px.slice(), width: W, height: H }, i);
    const expected = local.finish();

    const runner = fakeRunner({ auto: true });
    const parallel = createGifencEncoder({ trials: runner });
    parallel.init(CONFIG);
    const written = [];
    for (const [i, px] of frames.entries()) {
      written.push(parallel.addFrame({ rgba: px.slice(), width: W, height: H }, i));
      // Frames arrive as separate messages: answered trials come back between them
      if (i % 3 === 0) await settle();
    }
    const bytes = await parallel.finish();

    // Some trials went to the second worker and some frames waited for them
    expect(runner.jobs).toBeGreaterThan(3);
    expect(written.filter(Boolean).length).toBeGreaterThan(runner.jobs);
    expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
  });

  it('sends a trial away only while the second worker has fewer than TRIALS_AWAY', async () => {
    const runner = fakeRunner();
    const encoder = createGifencEncoder({ trials: runner });
    encoder.init(CONFIG);
    for (let f = 0; f < 6; f++) encoder.addFrame({ rgba: frame(f), width: W, height: H }, f);
    // Frame 0 has nothing to try; the rest ran here while one was away
    expect(runner.jobs).toBe(TRIALS_AWAY);
    runner.release();
    await settle();
    encoder.addFrame({ rgba: frame(6), width: W, height: H }, 6);
    expect(runner.jobs).toBe(TRIALS_AWAY + 1);
  });

  it('reuses the index buffers the second worker sends back', async () => {
    const runner = fakeRunner();
    const encoder = createGifencEncoder({ trials: runner });
    encoder.init(CONFIG);
    encoder.addFrame({ rgba: frame(0), width: W, height: H }, 0);
    encoder.addFrame({ rgba: frame(1), width: W, height: H }, 1);
    runner.release();
    await settle();
    encoder.addFrame({ rgba: frame(2), width: W, height: H }, 2);
    const [first, second] = runner.run.mock.calls.map(([job]) => job);
    expect(second.index).toBe(first.index);
    expect(second.differenced).toBe(first.differenced);
  });

  it('writes frames in order: those after a trial away wait for it', async () => {
    const runner = fakeRunner();
    const encoder = createGifencEncoder({ trials: runner });
    encoder.init(CONFIG);
    /** @type {number[]} */
    const order = [];
    for (let f = 0; f < 4; f++) {
      const written = encoder.addFrame({ rgba: frame(f), width: W, height: H }, f);
      if (written) written.then(() => order.push(f));
      else order.push(f);
    }
    await settle();
    // Frame 0 was written; frame 1's trial is away; 2 and 3 wait behind it
    expect(order).toEqual([0]);
    runner.release();
    await settle();
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('fails the frame and finish when a trial fails', async () => {
    const runner = fakeRunner({ auto: true, fail: 1 });
    const encoder = createGifencEncoder({ trials: runner });
    encoder.init(CONFIG);
    const written = [];
    for (let f = 0; f < 4; f++) {
      written.push(encoder.addFrame({ rgba: frame(f), width: W, height: H }, f));
    }
    const failed = written.find(Boolean);
    await expect(failed).rejects.toThrow('trial failed');
    await expect(encoder.finish()).rejects.toThrow('trial failed');
  });

  it('ignores a trial that comes back after dispose', async () => {
    const runner = fakeRunner();
    const encoder = createGifencEncoder({ trials: runner });
    encoder.init(CONFIG);
    for (let f = 0; f < 3; f++) encoder.addFrame({ rgba: frame(f), width: W, height: H }, f);
    encoder.dispose();
    runner.release();
    await settle();

    // A new session on the same encoder is not touched by the late trial
    encoder.init({ ...CONFIG, frameDifferencing: false });
    encoder.addFrame({ rgba: frame(0), width: W, height: H }, 0);
    const bytes = encoder.finish();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.at(-1)).toBe(0x3b);
  });
});
