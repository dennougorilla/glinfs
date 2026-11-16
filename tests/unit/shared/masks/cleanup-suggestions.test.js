import { describe, expect, it } from 'vitest';
import {
  describePlace,
  findCleanupSuggestions,
  MAX_SUGGESTIONS,
} from '../../../../src/shared/masks/cleanup-suggestions.js';

const W = 100;
const H = 60;

/** @typedef {[number, number, number, number]} Rect x, y, w, h */

/**
 * @param {Rect[]} rects - Filled
 * @param {Rect[]} [holes] - Cleared afterwards
 */
function frame(rects, holes = []) {
  const data = new Uint8Array(W * H);
  const fill = (/** @type {Rect} */ [rx, ry, rw, rh], /** @type {number} */ v) => {
    for (let y = ry; y < ry + rh; y++) data.fill(v, y * W + rx, y * W + rx + rw);
  };
  for (const r of rects) fill(r, 1);
  for (const r of holes) fill(r, 0);
  return { data, width: W, height: H };
}

/** The character: a 30x40 block */
const CHARACTER = /** @type {Rect} */ ([10, 10, 30, 40]);

/**
 * @param {ReturnType<typeof frame>[]} frames
 * @param {(f: number) => string} [keyOf]
 */
const suggest = (frames, keyOf) =>
  findCleanupSuggestions({
    frameCount: frames.length,
    getBinary: (f) => frames[f],
    keyOf,
    now: () => 0,
    yieldToMain: async () => {},
  });

describe('findCleanupSuggestions', () => {
  it('suggests nothing for a clean cutout', async () => {
    expect(await suggest(Array.from({ length: 8 }, () => frame([CHARACTER])))).toEqual([]);
  });

  it('counts specks and sets the island area just above the largest', async () => {
    // Two specks (2x2 and 3x3) on every frame
    const frames = Array.from({ length: 6 }, () =>
      frame([CHARACTER, [60, 5, 2, 2], [80, 40, 3, 3]]),
    );
    const [specks] = await suggest(frames);
    expect(specks).toEqual({ kind: 'specks', count: 2, minIslandArea: expect.any(Number) });
    const area = /** @type {any} */ (specks).minIslandArea * W * H;
    expect(area).toBeGreaterThan(9);
    expect(area).toBeLessThan(11);
  });

  it('counts holes inside the character and sets the hole area to the largest', async () => {
    const frames = Array.from({ length: 4 }, () =>
      frame(
        [CHARACTER],
        [
          [20, 20, 2, 2],
          [25, 30, 4, 3],
        ],
      ),
    );
    const [holes] = await suggest(frames);
    expect(holes).toMatchObject({ kind: 'holes', count: 2 });
    expect(/** @type {any} */ (holes).maxHoleArea * W * H).toBeCloseTo(12, 3);
  });

  it('counts what one frame shows: a hole and a speck that move fast count once', async () => {
    // 12 px a frame: too far to link frame to frame
    const frames = Array.from({ length: 4 }, (_, f) =>
      frame([CHARACTER, [50 + 12 * f, 5, 3, 3]], [[12 + 6 * f, 20, 3, 3]]),
    );
    const out = await suggest(frames);
    expect(out).toMatchObject([
      { kind: 'specks', count: 1 },
      { kind: 'holes', count: 1 },
    ]);
  });

  it('suggests removing a flickering blob, with a pick on it on its largest frame', async () => {
    // A 10x10 blob on frames 1, 3 and 6 of 10
    const on = new Set([1, 3, 6]);
    const frames = Array.from({ length: 10 }, (_, f) =>
      frame(on.has(f) ? [CHARACTER, [70, 8, 10, f === 3 ? 12 : 10]] : [CHARACTER]),
    );
    const out = await suggest(frames);
    expect(out).toHaveLength(1);
    const [blob] = /** @type {any[]} */ (out);
    expect(blob).toMatchObject({ kind: 'blob', frames: 3, where: 'top-right' });
    expect(blob.pick.frame).toBe(3);
    expect(blob.pick.x * W).toBeGreaterThanOrEqual(70);
    expect(blob.pick.x * W).toBeLessThan(80);
  });

  it('does not read a held frame as flicker (frames with one key count once)', async () => {
    // A second character, steady, but the clip holds every drawing for 3 frames
    const frames = Array.from({ length: 12 }, () => frame([CHARACTER, [60, 10, 20, 30]]));
    const held = await suggest(frames, (f) => `k${Math.floor(f / 3)}`);
    expect(held).toEqual([]);
  });

  it('points at a short dip in the character and counts its frames', async () => {
    const frames = Array.from({ length: 10 }, (_, f) =>
      frame([f === 4 || f === 5 ? [10, 10, 30, 10] : CHARACTER]),
    );
    expect(await suggest(frames)).toEqual([{ kind: 'shrink', frames: 2, frame: 4 }]);
  });

  it('shows at most four, specks and holes first', async () => {
    const on = new Set([1, 4, 7]);
    const frames = Array.from({ length: 10 }, (_, f) =>
      frame(
        [
          f === 5 ? [10, 10, 30, 10] : CHARACTER,
          [60, 5, 2, 2],
          ...(on.has(f)
            ? [/** @type {Rect} */ ([70, 30, 12, 12]), /** @type {Rect} */ ([50, 45, 10, 10])]
            : []),
        ],
        [[20, 15, 2, 2]],
      ),
    );
    const out = await suggest(frames);
    expect(out.map((s) => s.kind)).toEqual(['specks', 'holes', 'blob', 'blob']);
    expect(out).toHaveLength(MAX_SUGGESTIONS);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      findCleanupSuggestions({
        frameCount: 1,
        getBinary: () => frame([CHARACTER]),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('describePlace', () => {
  it('names thirds of the frame', () => {
    expect(describePlace(0.1, 0.1)).toBe('top-left');
    expect(describePlace(0.5, 0.5)).toBe('center');
    expect(describePlace(0.9, 0.5)).toBe('right');
    expect(describePlace(0.5, 0.9)).toBe('bottom');
  });
});
