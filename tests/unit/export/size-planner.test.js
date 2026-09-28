import { describe, expect, it, vi } from 'vitest';
import {
  BYTES_PER_MB,
  buildSizeLadder,
  describeRung,
  exportToTargetSize,
  extrapolateGifSize,
  formatFileSize,
  GIF_FILE_OVERHEAD,
  getLadderFrameSkips,
  planTargetSize,
  SIZE_LADDER,
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

  it('lists the frame skips the ladder uses', () => {
    expect(getLadderFrameSkips(buildSizeLadder(FULL))).toEqual([1, 2, 3]);
    expect(getLadderFrameSkips(buildSizeLadder({ ...FULL, frameSkip: 4 }))).toEqual([4]);
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

describe('extrapolateGifSize', () => {
  it('scales the per-frame bytes of a sample to the whole GIF', () => {
    // 6 sample frames of 1000 bytes each plus the fixed overhead
    const sample = GIF_FILE_OVERHEAD + 6000;
    expect(extrapolateGifSize(sample, 6, 30)).toBe(GIF_FILE_OVERHEAD + 30_000);
    expect(extrapolateGifSize(sample, 6, 6)).toBe(sample);
  });

  it('copes with degenerate samples', () => {
    expect(extrapolateGifSize(500, 0, 10)).toBe(500);
    expect(extrapolateGifSize(10, 1, 10)).toBe(GIF_FILE_OVERHEAD);
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
