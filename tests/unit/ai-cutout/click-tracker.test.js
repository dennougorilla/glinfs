import { describe, expect, it, vi } from 'vitest';
import { trackClicks } from '../../../src/features/ai-cutout/click-tracker.js';

const W = 40;
const H = 20;

/**
 * Mask of a rectangle [x0, x1) × [y0, y1) in a W×H mask
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 */
function rect(x0, y0, x1, y1) {
  const data = new Uint8Array(W * H);
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) data[y * W + x] = 255;
  }
  return data;
}

/**
 * A fake segmenter over a clip where an object (a 10×8 box) moves 1 px per
 * frame to the right; `objectAt(f)` can be overridden per frame. A click
 * answers four masks: the object's top half (part), a sliver, the object,
 * and the whole frame; a box prompt answers the object under the box.
 * @param {{ objectAt?: (f: number) => Uint8Array }} [options]
 */
function fakeSegmenter({ objectAt = (f) => rect(5 + f, 6, 15 + f, 14) } = {}) {
  /** @type {{ frame: number, prompt: any }[]} */
  const calls = [];
  const prompt = vi.fn(async (/** @type {number} */ frame, /** @type {any} */ p) => {
    calls.push({ frame, prompt: p });
    const object = objectAt(frame);
    const top = object.map((v, i) => (Math.floor(i / W) < 10 ? v : 0));
    const cand = (
      /** @type {Uint8Array} */ data,
      /** @type {number} */ score,
      /** @type {number} */ index,
    ) => ({
      data,
      width: W,
      height: H,
      score,
      index,
    });
    return [
      cand(top, 0.9, 0),
      cand(rect(0, 0, 1, 1), 0.5, 1),
      cand(object, 0.88, 2),
      cand(rect(0, 0, W, H), 0.3, 3),
    ];
  });
  return { prompt, calls };
}

/**
 * @param {Partial<Parameters<typeof trackClicks>[0]>} overrides
 */
function run(overrides = {}) {
  /** @type {Map<number, { data: Uint8Array }>} */
  const masks = new Map();
  const cleared = new Set();
  const { prompt, calls } = fakeSegmenter();
  const progress = vi.fn();
  const promise = trackClicks({
    range: { start: 0, end: 9 },
    currentFrame: 3,
    picks: [{ frame: 3, x: 0.3, y: 0.5, mode: 'keep' }],
    prompt,
    keyOf: (f) => `f${f}`,
    store: (f, mask) => masks.set(f, mask),
    clear: (f) => {
      cleared.add(f);
      masks.delete(f);
    },
    onProgress: progress,
    ...overrides,
  });
  return { promise, masks, cleared, calls, prompt, progress };
}

describe('trackClicks', () => {
  it('decodes the clicked frame first, then tracks forward and backward through the selection', async () => {
    const { promise, masks, calls, progress } = run();
    const result = await promise;
    expect(result).toEqual({ tracked: 10, lost: [], anchors: 1 });
    // The clicked frame first, with its click and no box
    expect(calls[0]).toMatchObject({
      frame: 3,
      prompt: { points: [{ x: 0.3, y: 0.5, mode: 'keep' }], box: null },
    });
    expect(calls.map((c) => c.frame)).toEqual([3, 4, 5, 6, 7, 8, 9, 2, 1, 0]);
    // Tracked frames get the previous mask's grown box and an inside point
    expect(calls[1].prompt.box).toHaveLength(4);
    expect(calls[1].prompt.points[0].mode).toBe('keep');
    // Whole: the object (index 2), not the half-frame "part" or the frame
    expect(masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
    // Tracked: the answer overlapping the previous mask most, following the motion
    expect(masks.get(9)?.data).toEqual(rect(14, 6, 24, 14));
    expect(masks.get(0)?.data).toEqual(rect(5, 6, 15, 14));
    expect(progress).toHaveBeenLastCalledWith({ done: 10, total: 10, frame: 0 });
    expect(progress.mock.calls[0][0]).toEqual({ done: 1, total: 10, frame: 3 });
  });

  it('Part: the best-scoring smaller answer on the clicked frame', async () => {
    const { promise, masks } = run({ scope: 'part' });
    await promise;
    const top = rect(8, 6, 18, 10);
    expect(masks.get(3)?.data).toEqual(top);
  });

  it('stops a pass where the mask area jumps and reports that frame as lost', async () => {
    const segmenter = fakeSegmenter({
      // The object suddenly doubles at frame 6 (e.g. it merged with another)
      objectAt: (f) => (f >= 6 ? rect(0, 0, 30, 20) : rect(5 + f, 6, 15 + f, 14)),
    });
    const { promise, masks, cleared } = run({ prompt: segmenter.prompt });
    const result = await promise;
    expect(result.lost).toEqual([6]);
    expect(result.tracked).toBe(6); // 0..5
    expect([...masks.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    // Frames the run did not reach have no stale mask
    for (const f of [6, 7, 8, 9]) expect(cleared.has(f)).toBe(true);
  });

  it('a click on a later frame re-anchors: tracking fills the gap from both sides', async () => {
    const segmenter = fakeSegmenter({
      objectAt: (f) => (f === 5 ? rect(0, 0, 40, 20) : rect(5 + f, 6, 15 + f, 14)),
    });
    const { promise, masks } = run({
      prompt: segmenter.prompt,
      currentFrame: 7,
      picks: [
        { frame: 1, x: 0.2, y: 0.5, mode: 'keep' },
        { frame: 7, x: 0.4, y: 0.5, mode: 'keep' },
      ],
    });
    const result = await promise;
    // Frame 5 (the object is lost there) is reported once; 6 is filled backward from 7
    expect(result.lost).toEqual([5]);
    expect(masks.has(6)).toBe(true);
    expect(masks.has(5)).toBe(false);
    // Both anchors first (the one on screen before the other)
    expect(segmenter.calls.slice(0, 2).map((c) => c.frame)).toEqual([7, 1]);
    expect(result.anchors).toBe(2);
  });

  it('shares one mask between frames with the same pixels (holds)', async () => {
    const { promise, masks, prompt } = run({ keyOf: (f) => (f === 4 ? 'f3' : `f${f}`) });
    await promise;
    expect(masks.get(4)).toBe(masks.get(3));
    expect(prompt.mock.calls.map((c) => c[0])).not.toContain(4);
  });

  it('drops the old masks it redoes, but not the anchors or the frame on screen', async () => {
    const cleared = [];
    const { promise } = run({
      currentFrame: 5,
      clear: (f) => cleared.push(f),
      prompt: async () => {
        // Snapshot at the first prompt: what was cleared before any work
        if (cleared.length && !cleared.includes(-1)) cleared.push(-1);
        return fakeSegmenter().prompt(3, {});
      },
    });
    await promise;
    const before = cleared.slice(0, cleared.indexOf(-1));
    expect(before).toEqual([0, 1, 2, 4, 6, 7, 8, 9]);
  });

  it('does nothing without a click in the selection', async () => {
    const { promise, prompt } = run({ picks: [{ frame: 30, x: 0, y: 0, mode: 'keep' }] });
    await expect(promise).resolves.toEqual({ tracked: 0, lost: [], anchors: 0 });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('stops at an abort, keeping the masks stored so far', async () => {
    const controller = new AbortController();
    const segmenter = fakeSegmenter();
    /** @type {Map<number, unknown>} */
    const masks = new Map();
    const promise = trackClicks({
      range: { start: 0, end: 9 },
      currentFrame: 0,
      picks: [{ frame: 0, x: 0.2, y: 0.5, mode: 'keep' }],
      prompt: async (f, p) => {
        if (f === 3) controller.abort();
        return segmenter.prompt(f, p);
      },
      keyOf: (f) => `f${f}`,
      store: (f, m) => masks.set(f, m),
      clear: () => undefined,
      signal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect([...masks.keys()]).toEqual([0, 1, 2]);
  });
});
