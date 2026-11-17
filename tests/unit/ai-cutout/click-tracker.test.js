import { describe, expect, it, vi } from 'vitest';
import {
  isScoreDrop,
  joinCandidates,
  refineAnchorPrompt,
  refinePrompt,
  trackClicks,
} from '../../../src/features/ai-cutout/click-tracker.js';

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

  it('a box alone anchors the object: prompted as the box (with any points), then tracked', async () => {
    const box = { frame: 3, x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.8 };
    const { promise, masks, calls } = run({
      picks: [{ frame: 3, x: 0.45, y: 0.5, mode: 'remove' }],
      boxes: [box],
    });
    const result = await promise;
    expect(result).toMatchObject({ tracked: 10, anchors: 1 });
    expect(calls[0]).toMatchObject({
      frame: 3,
      prompt: { points: [{ x: 0.45, y: 0.5, mode: 'remove' }], box: [0.1, 0.2, 0.5, 0.8] },
    });
    expect(masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
  });

  it('answers a box with the whole of what it holds, also on a Part object', async () => {
    const { promise, masks } = run({
      picks: [],
      boxes: [{ frame: 3, x0: 0, y0: 0, x1: 1, y1: 1 }],
      range: { start: 3, end: 3 },
      scope: 'part',
    });
    await promise;
    // Whole: the object (index 2), not the half-frame "part" (index 0)
    expect(masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
  });

  it('joins the answers of two boxes on a frame into one region', async () => {
    const { promise, masks, calls } = run({
      picks: [],
      boxes: [
        { frame: 3, x0: 0, y0: 0, x1: 0.5, y1: 1 },
        { frame: 3, x0: 0.5, y0: 0, x1: 1, y1: 1 },
      ],
      range: { start: 3, end: 3 },
    });
    await promise;
    expect(calls.map((c) => c.prompt.box)).toEqual([
      [0, 0, 0.5, 1],
      [0.5, 0, 1, 1],
    ]);
    expect(masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
  });

  it('joinCandidates: union of masks, max of logits, lowest score', () => {
    const a = {
      data: Uint8Array.of(255, 0, 0),
      width: 3,
      height: 1,
      score: 0.9,
      index: 0,
      lowRes: Float32Array.of(1, -2),
    };
    const b = {
      data: Uint8Array.of(0, 0, 255),
      width: 3,
      height: 1,
      score: 0.7,
      index: 1,
      lowRes: Float32Array.of(-1, 3),
    };
    const joined = joinCandidates([a, b]);
    expect([...joined.data]).toEqual([255, 0, 255]);
    expect([...(joined.lowRes ?? [])]).toEqual([1, 3]);
    expect(joined.score).toBe(0.7);
    expect(joinCandidates([a, { ...b, lowRes: undefined }]).lowRes).toBeNull();
  });

  it("passes the low-res logits of the answer each frame kept as the next frame's mask_input", async () => {
    const segmenter = fakeSegmenter();
    const { promise } = run({
      prompt: async (f, p) => {
        const candidates = await segmenter.prompt(f, p);
        return candidates.map((c) => {
          const lowRes = Float32Array.of(f, c.index);
          return { ...c, lowRes };
        });
      },
    });
    await promise;
    const byFrame = new Map(segmenter.calls.map((c) => [c.frame, c.prompt]));
    expect(byFrame.get(3).maskInput).toBeUndefined();
    // Frame 4 follows 3, frame 2 follows 3 backward, frame 0 follows 1;
    // the answer kept is the object (index 2)
    expect([...byFrame.get(4).maskInput]).toEqual([3, 2]);
    expect([...byFrame.get(2).maskInput]).toEqual([3, 2]);
    expect([...byFrame.get(0).maskInput]).toEqual([1, 2]);
  });

  it("a frame with only remove points reached by a pass gets the previous frame's logits too", async () => {
    const segmenter = fakeSegmenter();
    const { promise } = run({
      picks: [
        { frame: 3, x: 0.3, y: 0.5, mode: 'keep' },
        { frame: 6, x: 0.5, y: 0.65, mode: 'remove' },
      ],
      prompt: async (f, p) =>
        (await segmenter.prompt(f, p)).map((c) => ({ ...c, lowRes: Float32Array.of(f, c.index) })),
    });
    await promise;
    const six = /** @type {{ prompt: any }} */ (segmenter.calls.find((c) => c.frame === 6));
    expect(six.prompt.points.at(-1)).toEqual({ x: 0.5, y: 0.65, mode: 'remove' });
    expect([...six.prompt.maskInput]).toEqual([5, 2]);
  });

  it('Part: the best-scoring smaller answer on the clicked frame', async () => {
    const { promise, masks } = run({ scope: 'part' });
    await promise;
    const top = rect(8, 6, 18, 10);
    expect(masks.get(3)?.data).toEqual(top);
  });

  it("candidate: the user's pick among the clicked frame's answers, small to large (cutout-ux 2)", async () => {
    // Answers on frame 3, small to large: the 1-pixel speck, the top half,
    // the object, the whole frame
    /** @type {any[]} */
    const answered = [];
    const pick = run({ candidate: 3, onAnswers: (frame, c) => answered.push({ frame, c }) });
    await pick.promise;
    expect(pick.masks.get(3)?.data).toEqual(rect(0, 0, W, H));
    // The answers to the clicked frame's own prompt, handed out once
    expect(answered).toHaveLength(1);
    expect(answered[0].frame).toBe(3);
    expect(answered[0].c).toHaveLength(4);
    const object = run({ candidate: 2 });
    await object.promise;
    expect(object.masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
    // The pick replaces Part
    const part = run({ candidate: 2, scope: 'part' });
    await part.promise;
    expect(part.masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
  });

  it('Whole with a stricter wholeMinScoreRatio leaves out an answer that scores lower', async () => {
    // The object (0.88) is within 0.8 of the best (0.9) but not within 0.99
    const { promise, masks } = run({ wholeMinScoreRatio: 0.99 });
    await promise;
    expect(masks.get(3)?.data).toEqual(rect(8, 6, 18, 10));
    const plain = run();
    await plain.promise;
    expect(plain.masks.get(3)?.data).toEqual(rect(8, 6, 18, 14));
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

  it('with minScoreRatio, stops a pass where the score drops while the area holds', async () => {
    // The object leaves at frame 6, but the box prompt keeps answering the
    // same box, with a lower score
    const base = fakeSegmenter();
    const prompt = vi.fn(async (/** @type {number} */ f, /** @type {any} */ p) => {
      const candidates = await base.prompt(f, p);
      return f >= 6 ? candidates.map((c) => ({ ...c, score: c.score * 0.85 })) : candidates;
    });
    const scored = await run({ prompt, minScoreRatio: 0.92 }).promise;
    expect(scored.lost).toEqual([6]);
    expect(scored.tracked).toBe(6);
    // A slow fade trips it too: against the best of the pass, not the last frame
    const fading = vi.fn(async (/** @type {number} */ f, /** @type {any} */ p) => {
      const candidates = await base.prompt(f, p);
      const k = 0.96 ** Math.max(0, f - 4);
      return candidates.map((c) => ({ ...c, score: c.score * k }));
    });
    expect((await run({ prompt: fading, minScoreRatio: 0.93 }).promise).lost).toEqual([6]);
    // Off by default: the same answers track through
    const plain = await run({ prompt }).promise;
    expect(plain.lost).toEqual([]);
    expect(plain.tracked).toBe(10);
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
  it('drops the old masks of the anchors and the frame on screen when a run fails before redoing them', async () => {
    /** @type {Map<number, unknown>} */
    const masks = new Map([
      [2, 'old'],
      [5, 'old'],
      [7, 'old'],
    ]);
    const promise = trackClicks({
      range: { start: 0, end: 9 },
      currentFrame: 5,
      picks: [
        { frame: 2, x: 0.2, y: 0.5, mode: 'keep' },
        { frame: 5, x: 0.4, y: 0.5, mode: 'keep' },
      ],
      prompt: async () => {
        throw new Error('decoder failed');
      },
      keyOf: (f) => `f${f}`,
      store: (f, m) => masks.set(f, m),
      clear: (f) => masks.delete(f),
    });
    await expect(promise).rejects.toThrow('decoder failed');
    expect([...masks.keys()]).toEqual([]);
  });

  it('keeps them when a run with new clicks follows at once (superseded)', async () => {
    const controller = new AbortController();
    /** @type {Map<number, unknown>} */
    const masks = new Map([
      [2, 'old'],
      [5, 'old'],
    ]);
    const promise = trackClicks({
      range: { start: 0, end: 9 },
      currentFrame: 5,
      picks: [{ frame: 2, x: 0.2, y: 0.5, mode: 'keep' }],
      prompt: async () => {
        controller.abort();
        return fakeSegmenter().prompt(2, {});
      },
      keyOf: (f) => `f${f}`,
      store: (f, m) => masks.set(f, m),
      clear: (f) => masks.delete(f),
      superseded: () => true,
      signal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(masks.get(2)).toBe('old');
    expect(masks.get(5)).toBe('old');
  });

  it('refines a frame with only remove points from the mask it has now', async () => {
    const { promise, masks, calls } = run({
      currentFrame: 6,
      picks: [
        { frame: 3, x: 0.3, y: 0.5, mode: 'keep' },
        { frame: 6, x: 0.45, y: 0.65, mode: 'remove' },
      ],
      peek: (f) => (f === 6 ? { data: rect(11, 6, 21, 14), width: W, height: H } : null),
    });
    await promise;
    // The frame on screen first: the box of its mask, a point inside it and the remove point
    expect(calls[0].frame).toBe(6);
    expect(calls[0].prompt.box).toHaveLength(4);
    expect(calls[0].prompt.points.map((/** @type {any} */ p) => p.mode)).toEqual([
      'keep',
      'remove',
    ]);
    expect(calls[0].prompt.points[1]).toEqual({ x: 0.45, y: 0.65, mode: 'remove' });
    // The decoder's most confident answer (the top half), not the one like the old mask
    expect(masks.get(6)?.data).toEqual(rect(11, 6, 21, 10));
    expect(calls.filter((c) => c.frame === 6)).toHaveLength(1);
  });

  it('refines a frame with only remove points from the previous frame when it has no mask yet', async () => {
    const { promise, masks, calls } = run({
      picks: [
        { frame: 3, x: 0.3, y: 0.5, mode: 'keep' },
        { frame: 6, x: 0.5, y: 0.65, mode: 'remove' },
      ],
    });
    const result = await promise;
    expect(result.lost).toEqual([]);
    // Not prompted with the remove point alone: reached by the pass from frame 3
    expect(calls.map((c) => c.frame)).toEqual([3, 4, 5, 6, 7, 8, 9, 2, 1, 0]);
    const six = /** @type {{ prompt: any }} */ (calls.find((c) => c.frame === 6));
    expect(six.prompt.box).toHaveLength(4);
    expect(six.prompt.points.at(-1)).toEqual({ x: 0.5, y: 0.65, mode: 'remove' });
    // Tracking goes on from the refined mask
    expect(masks.get(6)?.data).toEqual(rect(11, 6, 21, 10));
    expect(masks.get(9)?.data).toEqual(rect(14, 6, 24, 10));
  });
});

describe('refinePrompt', () => {
  const base = { data: rect(10, 4, 30, 16), width: W, height: H };

  it('keeps an inside point away from the remove points', () => {
    const prompt = refinePrompt(base, [{ x: 0.3, y: 0.3, mode: 'remove' }]);
    expect(prompt?.points.map((p) => p.mode)).toEqual(['keep', 'remove']);
    expect(prompt?.box).toHaveLength(4);
  });

  it('drops the inside point when a remove point is right there', () => {
    const [inside] = /** @type {any} */ (refinePrompt(base, [])).points;
    const prompt = refinePrompt(base, [{ x: inside.x + 0.01, y: inside.y, mode: 'remove' }]);
    expect(prompt?.points.map((p) => p.mode)).toEqual(['remove']);
  });

  it('is null for an empty mask', () => {
    expect(refinePrompt({ data: new Uint8Array(W * H), width: W, height: H }, [])).toBeNull();
  });
});

describe('isScoreDrop', () => {
  it('is a drop below the ratio of the peak score, never when off or unknown', () => {
    expect(isScoreDrop(1.0, 0.9, 0.93)).toBe(true);
    expect(isScoreDrop(1.0, 0.95, 0.93)).toBe(false);
    expect(isScoreDrop(0.96, 0.5, 0)).toBe(false);
    expect(isScoreDrop(null, 0.5, 0.92)).toBe(false);
    expect(isScoreDrop(0, 0.5, 0.92)).toBe(false);
  });
});

describe('trackClicks with seeds (an earlier answer of the object on an anchor frame)', () => {
  const seedMask = () => ({ data: rect(4, 4, 30, 16), width: W, height: H });
  const seedLogits = Float32Array.from({ length: 16 }, (_, i) => i);

  it("prompts the anchor with the seed's box and points, its own points and the seed's logits; keeps the best-scoring answer", async () => {
    const { promise, masks, calls } = run({
      seedOf: (f) => (f === 3 ? { mask: seedMask(), lowRes: seedLogits } : null),
    });
    await promise;
    const first = calls[0];
    expect(first.frame).toBe(3);
    expect(first.prompt.maskInput).toBe(seedLogits);
    // The seed's grown box (it holds the seed), an inside point of the seed, then the click
    const [x0, y0, x1, y1] = first.prompt.box;
    expect(x0).toBeLessThanOrEqual(4 / W);
    expect(y0).toBeLessThanOrEqual(4 / H);
    expect(x1).toBeGreaterThanOrEqual(30 / W);
    expect(y1).toBeGreaterThanOrEqual(16 / H);
    expect(first.prompt.points.at(-1)).toEqual({ x: 0.3, y: 0.5, mode: 'keep' });
    expect(first.prompt.points[0].mode).toBe('keep');
    // One decode of the anchor, the best-scoring answer (the top half), not the seed
    expect(calls.filter((c) => c.frame === 3)).toHaveLength(1);
    expect(masks.get(3)?.data).toEqual(rect(8, 6, 18, 10));
    expect(masks.get(3)?.data).not.toEqual(seedMask().data);
  });

  it('a frame without a seed is decoded from its own points, as before', async () => {
    const { promise, calls } = run({ seedOf: () => null });
    await promise;
    expect(calls[0].prompt).toEqual({ points: [{ x: 0.3, y: 0.5, mode: 'keep' }], box: null });
  });

  it("seedGuard 'score' keeps the unseeded answer when the seeded one scores lower", async () => {
    /** @param {'off' | 'score'} seedGuard */
    const go = async (seedGuard) => {
      const { prompt } = fakeSegmenter();
      const lower = vi.fn(async (/** @type {number} */ f, /** @type {any} */ p) => {
        const answers = await prompt(f, p);
        // A seeded prompt scores lower than the plain click
        return p.maskInput ? answers.map((a) => ({ ...a, score: a.score * 0.5 })) : answers;
      });
      const { promise, masks } = run({
        prompt: lower,
        seedGuard,
        seedOf: (f) => (f === 3 ? { mask: seedMask(), lowRes: seedLogits } : null),
      });
      await promise;
      return masks.get(3)?.data;
    };
    // off: the seeded answer (the top half, its best score)
    expect(await go('off')).toEqual(rect(8, 6, 18, 10));
    // score: the plain click's Whole answer (the object) scores higher, so it stays
    expect(await go('score')).toEqual(rect(8, 6, 18, 14));
  });

  it("a frame with only remove points and no mask of these prompts starts from its seed's mask (not its logits)", async () => {
    const { promise, calls } = run({
      currentFrame: 6,
      picks: [
        { frame: 3, x: 0.3, y: 0.5, mode: 'keep' },
        { frame: 6, x: 0.45, y: 0.65, mode: 'remove' },
      ],
      peek: () => null,
      seedOf: (f) => (f === 6 ? { mask: seedMask(), lowRes: seedLogits } : null),
    });
    await promise;
    expect(calls[0].frame).toBe(6);
    // The seed's grown box, its inside point, the remove point; no logits (they
    // hold the old answer and pull against the remove point)
    expect(calls[0].prompt.box[0]).toBeLessThanOrEqual(4 / W);
    expect(calls[0].prompt.maskInput).toBeNull();
    expect(calls[0].prompt.points.at(-1)).toEqual({ x: 0.45, y: 0.65, mode: 'remove' });
  });

  it("a new box inside the seed's box is prompted on its own: two different inner boxes give different prompts", async () => {
    /** @param {[number, number, number, number]} inner */
    const go = async (inner) => {
      const box = { frame: 3, x0: inner[0], y0: inner[1], x1: inner[2], y1: inner[3] };
      const { promise, calls, masks } = run({
        boxes: [box],
        seedOf: (f) => (f === 3 ? { mask: seedMask(), lowRes: seedLogits, boxes: [inner] } : null),
      });
      await promise;
      return {
        prompts: calls.filter((c) => c.frame === 3).map((c) => c.prompt),
        mask: masks.get(3),
      };
    };
    // Both inside the seed's box (4..30 x 4..16 of 40 x 20)
    const a = await go([0.2, 0.3, 0.3, 0.5]);
    const b = await go([0.5, 0.4, 0.7, 0.7]);
    // The seeded prompt is the same for both (the seed's box already holds them) ...
    expect(a.prompts[0]).toEqual(b.prompts[0]);
    // ... and each box gets its own prompt: the box, the keep point inside it, no logits
    expect(a.prompts[1]).toEqual({
      points: [{ x: 0.3, y: 0.5, mode: 'keep' }],
      box: [0.2, 0.3, 0.3, 0.5],
    });
    expect(b.prompts[1]).toEqual({ points: [], box: [0.5, 0.4, 0.7, 0.7] });
    expect(a.prompts).not.toEqual(b.prompts);
    // The answer is the seeded one joined with the box's (Whole: the object)
    expect(a.mask?.data).toEqual(rect(8, 6, 18, 14));
  });

  it('a box the seed was made with is not prompted again', async () => {
    const { promise, calls } = run({
      boxes: [{ frame: 3, x0: 0.2, y0: 0.3, x1: 0.3, y1: 0.5 }],
      seedOf: (f) => (f === 3 ? { mask: seedMask(), lowRes: seedLogits, boxes: [] } : null),
    });
    await promise;
    expect(calls.filter((c) => c.frame === 3)).toHaveLength(1);
  });

  it("store gets each answer's low-res logits (for the next run's seeds)", async () => {
    const stored = [];
    const { promise } = run({ store: (f, _mask, lowRes) => stored.push([f, lowRes]) });
    await promise;
    expect(stored).toHaveLength(10);
    // The fake segmenter answers without logits
    expect(stored.every(([, lowRes]) => lowRes === null)).toBe(true);
  });
});

describe('refineAnchorPrompt', () => {
  const seed = { data: rect(4, 4, 12, 12), width: W, height: H };
  it("stretches the seed's box over a keep point outside it and keeps the frame's points last", () => {
    const next = refineAnchorPrompt(seed, {
      points: [{ x: 0.9, y: 0.5, mode: 'keep' }],
      boxes: [],
    });
    expect(next?.box[2]).toBeGreaterThanOrEqual(0.9);
    expect(next?.points.at(-1)).toEqual({ x: 0.9, y: 0.5, mode: 'keep' });
  });
  it("stretches it over the frame's boxes", () => {
    const next = refineAnchorPrompt(seed, { points: [], boxes: [[0.05, 0.05, 0.95, 0.95]] });
    expect(next?.box).toEqual([0.05, 0.05, 0.95, 0.95]);
  });
  it("drops the seed's points right at one of the frame's points", () => {
    const inside = { x: 8 / W, y: 8 / H, mode: /** @type {const} */ ('remove') };
    const next = refineAnchorPrompt(seed, { points: [inside], boxes: [] });
    expect(next?.points.filter((p) => p.mode === 'keep')).toHaveLength(0);
  });
  it('is null for an empty seed', () => {
    expect(
      refineAnchorPrompt(
        { data: new Uint8Array(W * H), width: W, height: H },
        { points: [], boxes: [] },
      ),
    ).toBeNull();
  });
});
