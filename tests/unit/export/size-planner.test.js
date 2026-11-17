import { describe, expect, it, vi } from 'vitest';
import { createGifencEncoder } from '../../../src/features/export/encoders/gifenc-encoder.js';
import {
  BYTES_PER_MB,
  buildSizeLadder,
  describeRung,
  ESTIMATE_SAMPLE,
  exportToTargetSize,
  extrapolateFromSample,
  formatFileSize,
  gifFrameSizes,
  planTargetSize,
  SIZE_LADDER,
  selectEstimateSample,
} from '../../../src/features/export/size-planner.js';

/** The user's settings at their most generous */
const FULL = { maxColors: 256, frameSkip: 1, scale: 1 };

/**
 * Fake estimator: bytes proportional to colors, frames and pixels
 * @param {number} bytesAtFull - Estimate of the first rung
 */
function proportional(bytesAtFull) {
  return vi.fn(
    async (/** @type {import('../../../src/features/export/size-planner.js').SizeRung} */ rung) =>
      (bytesAtFull * (rung.maxColors / 256) * rung.scale * rung.scale) / rung.frameSkip,
  );
}

/** A blob of n bytes */
const blobOf = (/** @type {number} */ n) => new Blob([new Uint8Array(n)]);

describe('buildSizeLadder', () => {
  it('walks colors first, then frame skip, then scale', () => {
    expect(buildSizeLadder(FULL)).toEqual([
      { maxColors: 256, frameSkip: 1, scale: 1 },
      { maxColors: 128, frameSkip: 1, scale: 1 },
      { maxColors: 64, frameSkip: 1, scale: 1 },
      { maxColors: 32, frameSkip: 1, scale: 1 },
      { maxColors: 32, frameSkip: 2, scale: 1 },
      { maxColors: 32, frameSkip: 3, scale: 1 },
      { maxColors: 32, frameSkip: 3, scale: 0.75 },
      { maxColors: 32, frameSkip: 3, scale: 0.5 },
      { maxColors: 32, frameSkip: 3, scale: 1 / 3 },
    ]);
    expect(buildSizeLadder(FULL)).toHaveLength(SIZE_LADDER.length);
  });

  it('never goes above the user settings and drops rungs that end up equal', () => {
    // 103 colors, every 2nd frame, 50 %
    const rungs = buildSizeLadder({ maxColors: 103, frameSkip: 2, scale: 0.5 });
    expect(rungs).toEqual([
      { maxColors: 103, frameSkip: 2, scale: 0.5 },
      { maxColors: 64, frameSkip: 2, scale: 0.5 },
      { maxColors: 32, frameSkip: 2, scale: 0.5 },
      { maxColors: 32, frameSkip: 3, scale: 0.5 },
      { maxColors: 32, frameSkip: 3, scale: 1 / 3 },
    ]);
    for (const rung of rungs) {
      expect(rung.maxColors).toBeLessThanOrEqual(103);
      expect(rung.frameSkip).toBeGreaterThanOrEqual(2);
      expect(rung.scale).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps a user frame skip above the ladder', () => {
    const rungs = buildSizeLadder({ maxColors: 32, frameSkip: 5, scale: 0.25 });
    expect(rungs).toEqual([{ maxColors: 32, frameSkip: 5, scale: 0.25 }]);
  });
});

describe('planTargetSize', () => {
  it('picks the first rung whose estimate fits with the safety margin', async () => {
    const rungs = buildSizeLadder(FULL);
    const estimate = proportional(8_000_000);
    // 8 MB, 4 MB, 2 MB, 1 MB: a 2.1 MB target fits 2 MB only with 10 % spare
    // (1.89 MB), so the plan goes one further
    const plan = await planTargetSize({ rungs, targetBytes: 2_100_000, estimate });
    expect(plan).toEqual({
      index: 3,
      fits: true,
      estimates: [8_000_000, 4_000_000, 2_000_000, 1_000_000],
    });
    expect(estimate).toHaveBeenCalledTimes(4);
  });

  it('stops at the first rung when the settings already fit', async () => {
    const estimate = proportional(500_000);
    const plan = await planTargetSize({ rungs: buildSizeLadder(FULL), targetBytes: 1e6, estimate });
    expect(plan.index).toBe(0);
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it('ends on the last rung when nothing fits', async () => {
    const rungs = buildSizeLadder(FULL);
    const plan = await planTargetSize({
      rungs,
      targetBytes: 1,
      estimate: async () => 1_000_000,
    });
    expect(plan).toMatchObject({ index: rungs.length - 1, fits: false });
    expect(plan.estimates).toHaveLength(rungs.length);
  });

  it('reports each step and stops on abort', async () => {
    const controller = new AbortController();
    const onStep = vi.fn();
    const estimate = vi.fn(async () => {
      controller.abort();
      return 10;
    });
    await expect(
      planTargetSize({
        rungs: buildSizeLadder(FULL),
        targetBytes: 1,
        estimate,
        signal: controller.signal,
        onStep,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onStep).toHaveBeenCalledWith({ phase: 'estimate', index: 0, total: 9 });
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty ladder', async () => {
    await expect(
      planTargetSize({ rungs: [], targetBytes: 1, estimate: async () => 0 }),
    ).rejects.toThrow('empty');
  });
});

describe('exportToTargetSize', () => {
  it('encodes the planned rung and keeps it when it fits', async () => {
    const rungs = buildSizeLadder(FULL);
    const encode = vi.fn(async () => blobOf(900));
    const result = await exportToTargetSize({
      rungs,
      targetBytes: 1000,
      estimate: async (rung) => (rung.maxColors <= 64 ? 800 : 5000),
      encode,
    });
    expect(result).toMatchObject({ index: 2, fits: true, attempts: 1, rung: rungs[2] });
    expect(encode).toHaveBeenCalledWith(rungs[2], 1);
  });

  it('steps down one rung per retry, at most twice, when the real GIF is too big', async () => {
    const rungs = buildSizeLadder(FULL);
    const onStep = vi.fn();
    const encode = vi.fn(async () => blobOf(2000));
    const result = await exportToTargetSize({
      rungs,
      targetBytes: 1000,
      estimate: async () => 100,
      encode,
      onStep,
    });
    expect(encode.mock.calls.map(([rung, attempt]) => [rungs.indexOf(rung), attempt])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(result).toMatchObject({ index: 2, fits: false, attempts: 3 });
    expect(onStep).toHaveBeenLastCalledWith({
      phase: 'encode',
      index: 2,
      total: rungs.length,
      attempt: 3,
      previousBytes: 2000,
    });
  });

  it('stops retrying as soon as a retry fits', async () => {
    const rungs = buildSizeLadder(FULL);
    const sizes = [1500, 700];
    const result = await exportToTargetSize({
      rungs,
      targetBytes: 1000,
      estimate: async () => 100,
      encode: async () => blobOf(/** @type {number} */ (sizes.shift())),
    });
    expect(result).toMatchObject({ index: 1, fits: true, attempts: 2 });
    expect(result.blob.size).toBe(700);
  });

  it('never retries past the last rung, and returns that GIF when even it is too big', async () => {
    const rungs = buildSizeLadder(FULL);
    const encode = vi.fn(async () => blobOf(5000));
    const result = await exportToTargetSize({
      rungs,
      targetBytes: 10,
      estimate: async () => 1_000_000,
      encode,
    });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ index: rungs.length - 1, fits: false, attempts: 1 });
    expect(result.blob.size).toBe(5000);
  });

  it('propagates an abort during an encode', async () => {
    const controller = new AbortController();
    await expect(
      exportToTargetSize({
        rungs: buildSizeLadder(FULL),
        targetBytes: 10,
        estimate: async () => 1,
        encode: async () => {
          controller.abort();
          return blobOf(1);
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('selectEstimateSample', () => {
  it('takes runs of consecutive frames from the start to the end of the clip', () => {
    const { positions, schedule, groups } = selectEstimateSample(100, 0, { runs: 4, runLength: 3 });
    expect(positions).toEqual([0, 1, 2, 32, 33, 34, 65, 66, 67, 97, 98, 99]);
    expect(schedule).toEqual(positions);
    // The last frame of each run follows its own previous frame
    expect(groups).toEqual([{ indices: [2, 5, 8, 11], share: 1 }]);
  });

  it('ends half the runs on a scheduled palette rebuild, standing for 1 in N frames', () => {
    const { positions, schedule, groups } = selectEstimateSample(100, 10, {
      runs: 4,
      runLength: 3,
    });
    expect(positions).toEqual([0, 1, 2, 32, 33, 34, 65, 66, 67, 97, 98, 99]);
    // Runs 1 and 3 end on frame indices 20 and 40, runs 0 and 2 between rebuilds
    expect(schedule).toEqual([1, 2, 3, 18, 19, 20, 21, 22, 23, 38, 39, 40]);
    expect(groups).toEqual([
      { indices: [2, 8], share: 0.9 },
      { indices: [5, 11], share: 0.1 },
    ]);
  });

  it('takes every frame of a clip no longer than the sample', () => {
    const size = ESTIMATE_SAMPLE.runs * ESTIMATE_SAMPLE.runLength;
    expect(selectEstimateSample(size, 10).positions).toHaveLength(size);
    expect(selectEstimateSample(3)).toEqual({
      positions: [0, 1, 2],
      schedule: [0, 1, 2],
      groups: [],
    });
    expect(selectEstimateSample(0).positions).toEqual([]);
  });
});

describe('gifFrameSizes / extrapolateFromSample', () => {
  /** A real gifenc GIF of `count` frames, 32x16, each frame different */
  function gif(count) {
    const encoder = createGifencEncoder();
    encoder.init({ width: 32, height: 16, maxColors: 16, frameDelayMs: 100, loopCount: 0 });
    for (let f = 0; f < count; f++) {
      const rgba = new Uint8ClampedArray(32 * 16 * 4);
      for (let i = 0; i < rgba.length; i += 4) rgba.set([(i * (f + 3)) & 255, 60, 90, 255], i);
      encoder.addFrame({ rgba, width: 32, height: 16 }, f);
    }
    return encoder.finish();
  }

  it('splits a GIF into its frames and the fixed overhead', () => {
    const bytes = gif(3);
    const sizes = gifFrameSizes(bytes);
    expect(sizes.frames).toHaveLength(3);
    expect(sizes.frames.every((n) => n > 0)).toBe(true);
    expect(sizes.overhead + sizes.frames.reduce((a, b) => a + b, 0)).toBe(bytes.length);
    // Header, screen descriptor, global table, loop extension, trailer
    expect(sizes.overhead).toBeLessThan(13 + 3 * 256 + 19 + 1 + 1);
  });

  it('counts the first frame once and the measured groups by their share', () => {
    const sizes = { frames: [1000, 900, 100, 800, 120, 700, 2000], overhead: 50 };
    const one = [{ indices: [2, 4], share: 1 }];
    // Measured: frames 2 and 4 (100 and 120 bytes)
    expect(extrapolateFromSample(sizes, one, 31)).toBe(50 + 1000 + 110 * 30);
    expect(extrapolateFromSample(sizes, one, 1)).toBe(1050);
    // 9 in 10 frames like frames 2 and 4, 1 in 10 like frame 6 (a rebuild)
    const split = [
      { indices: [2, 4], share: 0.9 },
      { indices: [6], share: 0.1 },
    ];
    expect(extrapolateFromSample(sizes, split, 11)).toBe(50 + 1000 + (0.9 * 110 + 0.1 * 2000) * 10);
    expect(extrapolateFromSample({ frames: [], overhead: 30 }, one, 10)).toBe(30);
  });

  it('is the sample itself when the sample is the whole GIF', () => {
    expect(extrapolateFromSample({ frames: [300, 100, 200], overhead: 40 }, [], 3)).toBe(640);
  });
});

describe('describeRung', () => {
  it('names the settings a target size used', () => {
    expect(describeRung({ maxColors: 64, frameSkip: 2, scale: 0.75 })).toBe(
      '64 colors · every 2nd frame · 75 %',
    );
    expect(describeRung({ maxColors: 256, frameSkip: 1, scale: 1 })).toBe(
      '256 colors · every frame · 100 %',
    );
    expect(describeRung({ maxColors: 32, frameSkip: 3, scale: 1 / 3 })).toBe(
      '32 colors · every 3rd frame · 33 %',
    );
    expect(describeRung({ maxColors: 32, frameSkip: 5, scale: 0.25 })).toBe(
      '32 colors · every 5th frame · 25 %',
    );
  });
});

describe('decimal file sizes', () => {
  it('uses 1 MB = 1,000,000 bytes, as upload limits do', () => {
    expect(BYTES_PER_MB).toBe(1_000_000);
  });

  it('formats sizes in decimal units', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(999)).toBe('999 B');
    expect(formatFileSize(1_000)).toBe('1.0 KB');
    expect(formatFileSize(950_000)).toBe('950.0 KB');
    expect(formatFileSize(10_000_000)).toBe('10.0 MB');
    expect(formatFileSize(10_200_000)).toBe('10.2 MB');
    expect(formatFileSize(2_500_000_000)).toBe('2.5 GB');
  });
});
