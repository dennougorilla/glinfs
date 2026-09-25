import { describe, expect, it, vi } from 'vitest';
import { createDefaultAiCutout } from '../../../../src/shared/edits/model.js';
import {
  BUILD_SLICE_MS,
  buildFinalMasks,
  createFinalMaskCache,
  edgeRadiusInMaskPixels,
  getAiParamsKey,
} from '../../../../src/shared/masks/final-masks.js';
import {
  morphMask,
  packedMaskBytes,
  packMask,
  unpackMask,
} from '../../../../src/shared/masks/mask-ops.js';

/** @typedef {[number, number, number, number]} Rect x, y, w, h */

/**
 * Probability mask: 230 inside the rectangles, 10 elsewhere
 * @param {number} width
 * @param {number} height
 * @param {Rect[]} rects
 */
function probOf(width, height, rects) {
  const data = new Uint8Array(width * height).fill(10);
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = ry; y < ry + rh; y++) data.fill(230, y * width + rx, y * width + rx + rw);
  }
  return { data, width, height };
}

/**
 * 0/1 mask with the rectangles set
 * @param {number} width
 * @param {number} height
 * @param {Rect[]} rects
 */
function binaryOf(width, height, rects) {
  const { data } = probOf(width, height, rects);
  return Uint8Array.from(data, (v) => (v > 128 ? 1 : 0));
}

/** @param {Partial<import('../../../../src/shared/edits/model.js').AiCutout>} over */
const aiOf = (over = {}) => ({ ...createDefaultAiCutout(), smoothing: false, ...over });

/** Options that never yield (fast, deterministic unit tests) */
const noYield = { now: () => 0, yieldToMain: async () => {} };

describe('edgeRadiusInMaskPixels', () => {
  it('scales source pixels to mask pixels, keeping the sign and at least one pixel', () => {
    expect(edgeRadiusInMaskPixels(0, 512, 1024)).toBe(0);
    expect(edgeRadiusInMaskPixels(4, 512, 1024)).toBe(2);
    expect(edgeRadiusInMaskPixels(-4, 512, 1024)).toBe(-2);
    expect(edgeRadiusInMaskPixels(1, 256, 1920)).toBe(1);
    expect(edgeRadiusInMaskPixels(-1, 256, 1920)).toBe(-1);
    expect(edgeRadiusInMaskPixels(8, 100, 100)).toBe(8);
    expect(edgeRadiusInMaskPixels(3, 100, 0)).toBe(3);
    expect(edgeRadiusInMaskPixels(Number.NaN, 100, 100)).toBe(0);
  });
});

describe('getAiParamsKey', () => {
  it('changes with every parameter and pick', () => {
    const base = aiOf();
    const keys = new Set([
      getAiParamsKey(base),
      getAiParamsKey({ ...base, threshold: 0.6 }),
      getAiParamsKey({ ...base, smoothing: true }),
      getAiParamsKey({ ...base, edge: -1 }),
      getAiParamsKey({ ...base, picks: [{ frame: 1, x: 0.5, y: 0.5, mode: 'keep' }] }),
      getAiParamsKey({ ...base, picks: [{ frame: 1, x: 0.5, y: 0.5, mode: 'remove' }] }),
    ]);
    expect(keys.size).toBe(6);
    expect(getAiParamsKey(aiOf())).toBe(getAiParamsKey(base));
  });
});

describe('buildFinalMasks', () => {
  const W = 40;
  const H = 20;

  it('thresholds each frame and bit-packs the result', async () => {
    const probs = [probOf(W, H, [[2, 2, 5, 5]]), probOf(W, H, [[10, 3, 6, 4]])];
    const result = await buildFinalMasks({
      frameCount: 2,
      getProb: (f) => probs[f],
      ai: aiOf(),
      ...noYield,
    });
    expect(result.width).toBe(W);
    expect(result.height).toBe(H);
    expect(result.masks[0]).toEqual(packMask(binaryOf(W, H, [[2, 2, 5, 5]]), W, H));
    expect(result.masks[1]).toEqual(packMask(binaryOf(W, H, [[10, 3, 6, 4]]), W, H));
    expect(result.bytes).toBe(2 * packedMaskBytes(W, H));
  });

  it('applies the threshold parameter', async () => {
    const data = new Uint8Array(W * H).fill(100);
    const build = (/** @type {number} */ threshold) =>
      buildFinalMasks({
        frameCount: 1,
        getProb: () => ({ data, width: W, height: H }),
        ai: aiOf({ threshold }),
        ...noYield,
      });
    const low = await build(0.3);
    const high = await build(0.5);
    expect(unpackMask(/** @type {any} */ (low.masks[0])).every((v) => v === 1)).toBe(true);
    expect(unpackMask(/** @type {any} */ (high.masks[0])).every((v) => v === 0)).toBe(true);
  });

  it('smooths a one-frame flicker away when smoothing is on', async () => {
    const empty = probOf(W, H, []);
    const flicker = probOf(W, H, [[5, 5, 5, 5]]);
    const probs = [empty, flicker, empty];
    const build = (/** @type {boolean} */ smoothing) =>
      buildFinalMasks({
        frameCount: 3,
        getProb: (f) => probs[f],
        ai: aiOf({ smoothing }),
        ...noYield,
      });
    const off = await build(false);
    const on = await build(true);
    expect(unpackMask(/** @type {any} */ (off.masks[1])).some(Boolean)).toBe(true);
    expect(unpackMask(/** @type {any} */ (on.masks[1])).some(Boolean)).toBe(false);
  });

  it('grows or shrinks by the edge, converted from source pixels', async () => {
    const rect = /** @type {Rect} */ ([10, 5, 8, 8]);
    const build = (/** @type {number} */ edge) =>
      buildFinalMasks({
        frameCount: 1,
        getProb: () => probOf(W, H, [rect]),
        ai: aiOf({ edge }),
        // Source is twice the mask size: 4 source px = 2 mask px
        sourceWidth: W * 2,
        ...noYield,
      });
    const grown = await build(4);
    const shrunk = await build(-4);
    const binary = binaryOf(W, H, [rect]);
    expect(grown.masks[0]).toEqual(packMask(morphMask(binary, W, H, 2), W, H));
    expect(shrunk.masks[0]).toEqual(packMask(morphMask(binary, W, H, -2), W, H));
    expect(unpackMask(/** @type {any} */ (grown.masks[0])).filter(Boolean)).toHaveLength(12 * 12);
    expect(unpackMask(/** @type {any} */ (shrunk.masks[0])).filter(Boolean)).toHaveLength(4 * 4);
  });

  it('keeps only the picked character on every frame, before and after the pick', async () => {
    /** @param {number} f @returns {Rect} */
    const a = (f) => [2 + 2 * f, 4, 8, 8];
    /** @type {Rect} */
    const b = [28, 4, 8, 8];
    const onProgress = vi.fn();
    const result = await buildFinalMasks({
      frameCount: 6,
      getProb: (f) => probOf(W, H, [a(f), b]),
      ai: aiOf({ picks: [{ frame: 3, x: (a(3)[0] + 4) / W, y: 0.4, mode: 'keep' }] }),
      onProgress,
      ...noYield,
    });
    for (let f = 0; f < 6; f++) {
      expect(result.masks[f], `frame ${f}`).toEqual(packMask(binaryOf(W, H, [a(f)]), W, H));
    }
    // 4 backward steps (frames 3..0) + 6 forward steps
    expect(onProgress).toHaveBeenLastCalledWith({ done: 10, total: 10 });
    expect(onProgress).toHaveBeenCalledTimes(10);
  });

  it('reads each probability mask once, so masks arriving mid-build never mix into it', async () => {
    /** @param {number} f @returns {Rect} */
    const a = (f) => [4 + 2 * f, 6, 6, 6];
    /** @type {Rect} */
    const b = [28, 6, 6, 6];
    const frameCount = 6;
    const ai = aiOf({ picks: [{ frame: 3, x: (a(3)[0] + 3) / W, y: 0.45, mode: 'keep' }] });
    const stable = await buildFinalMasks({
      frameCount,
      getProb: (f) => probOf(W, H, [a(f), b]),
      ai,
      ...noYield,
    });

    // After the build's first reads the store changes: a new character
    // appears top left on every frame (it would take label 1 and shift
    // the labels the backward pass recorded)
    let calls = 0;
    const getProb = vi.fn((f) => {
      calls++;
      const rects = calls > frameCount ? [[0, 0, 2, 2], a(f), b] : [a(f), b];
      return probOf(W, H, /** @type {Rect[]} */ (rects));
    });
    const changing = await buildFinalMasks({ frameCount, getProb, ai, ...noYield });

    expect(getProb).toHaveBeenCalledTimes(frameCount);
    expect(changing.masks).toEqual(stable.masks);
    for (let f = 0; f < frameCount; f++) {
      expect(changing.masks[f], `frame ${f}`).toEqual(packMask(binaryOf(W, H, [a(f)]), W, H));
    }
  });

  it('removes a picked character and leaves unanalyzed frames without a mask', async () => {
    /** @type {Rect} */
    const a = [4, 4, 8, 8];
    /** @type {Rect} */
    const b = [24, 4, 8, 8];
    const result = await buildFinalMasks({
      frameCount: 4,
      getProb: (f) => (f === 2 ? null : probOf(W, H, [a, b])),
      ai: aiOf({ smoothing: true, picks: [{ frame: 0, x: 0.7, y: 0.4, mode: 'remove' }] }),
      ...noYield,
    });
    expect(result.masks[2]).toBeNull();
    for (const f of [0, 1, 3]) {
      expect(result.masks[f], `frame ${f}`).toEqual(packMask(binaryOf(W, H, [a]), W, H));
    }
  });

  it('resamples a frame whose mask has another size to the clip mask size', async () => {
    const small = probOf(W / 2, H / 2, [[0, 0, 10, 5]]);
    const result = await buildFinalMasks({
      frameCount: 2,
      getProb: (f) => (f === 0 ? probOf(W, H, []) : small),
      ai: aiOf({ smoothing: true }),
      ...noYield,
    });
    expect(result.masks[1]?.width).toBe(W);
    // Smoothing averages 230 with frame 0's 10: 120 < 128
    expect(unpackMask(/** @type {any} */ (result.masks[1])).some(Boolean)).toBe(false);

    const unsmoothed = await buildFinalMasks({
      frameCount: 2,
      getProb: (f) => (f === 0 ? probOf(W, H, []) : small),
      ai: aiOf(),
      ...noYield,
    });
    expect(unsmoothed.masks[1]).toEqual(packMask(binaryOf(W, H, [[0, 0, 20, 10]]), W, H));
  });

  it('returns no masks when nothing was analyzed', async () => {
    const result = await buildFinalMasks({
      frameCount: 3,
      getProb: () => null,
      ai: aiOf(),
      ...noYield,
    });
    expect(result).toEqual({ masks: [null, null, null], width: 0, height: 0, bytes: 0 });
  });

  it('keeps a 300-frame 1024x576 clip bit-packed (~22 MB, under 30 MB)', async () => {
    const width = 1024;
    const height = 576;
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 3) data[i] = 255;
    const result = await buildFinalMasks({
      frameCount: 300,
      getProb: () => ({ data, width, height }),
      ai: aiOf(),
      ...noYield,
    });
    expect(result.masks.every((m) => m?.bits.byteLength === (width * height) / 8)).toBe(true);
    expect(result.bytes).toBe(300 * 73728);
    expect(result.bytes).toBeLessThan(30 * 1024 * 1024);
  });

  it('yields to the event loop whenever a slice of work is used up', async () => {
    let clock = 0;
    /** @type {string[]} */
    const events = [];
    await buildFinalMasks({
      frameCount: 10,
      getProb: () => probOf(W, H, [[1, 1, 3, 3]]),
      ai: aiOf(),
      onProgress: ({ done }) => {
        clock += 10; // each frame costs 10 "ms"
        events.push(`frame${done}`);
      },
      sliceMs: 25,
      now: () => clock,
      yieldToMain: async () => {
        events.push('yield');
      },
    });
    const runs = events
      .join(' ')
      .split('yield')
      .map((run) => run.trim().split(/\s+/).filter(Boolean).length);
    expect(events.filter((e) => e === 'yield').length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...runs)).toBeLessThanOrEqual(3);
    expect(BUILD_SLICE_MS).toBeLessThanOrEqual(50);
  });

  it('lets other tasks run between frames with the default yield', async () => {
    let clock = 0;
    let timerFiredAt = -1;
    let done = 0;
    setTimeout(() => {
      timerFiredAt = done;
    }, 0);
    await buildFinalMasks({
      frameCount: 20,
      getProb: () => probOf(W, H, []),
      ai: aiOf(),
      onProgress: (p) => {
        clock += 40;
        done = p.done;
      },
      now: () => clock,
    });
    expect(timerFiredAt).toBeGreaterThan(0);
    expect(timerFiredAt).toBeLessThan(20);
  });

  it('uses scheduler.yield when the platform has it', async () => {
    const yieldFn = vi.fn(async () => {});
    vi.stubGlobal('scheduler', { yield: yieldFn });
    try {
      let clock = 0;
      await buildFinalMasks({
        frameCount: 3,
        getProb: () => probOf(W, H, []),
        ai: aiOf(),
        onProgress: () => {
          clock += 100;
        },
        now: () => clock,
      });
      expect(yieldFn).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops with AbortError when cancelled mid-build or before it starts', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn(({ done }) => {
      if (done === 3) controller.abort();
    });
    const getProb = vi.fn(() => probOf(W, H, [[1, 1, 3, 3]]));
    await expect(
      buildFinalMasks({
        frameCount: 50,
        getProb,
        ai: aiOf(),
        signal: controller.signal,
        onProgress,
        ...noYield,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).toHaveBeenCalledTimes(3);

    getProb.mockClear();
    await expect(
      buildFinalMasks({ frameCount: 5, getProb, ai: aiOf(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getProb).not.toHaveBeenCalled();
  });
});

describe('createFinalMaskCache', () => {
  const W = 16;
  const H = 8;
  const getProb = vi.fn(() => probOf(W, H, [[2, 2, 4, 4]]));
  const base = { frameCount: 3, getProb, ai: aiOf(), storeVersion: 1, ...noYield };

  it('memoizes by store version and params and exposes a MaskSource', async () => {
    const cache = createFinalMaskCache();
    getProb.mockClear();
    const source = await cache.build(base);
    const calls = getProb.mock.calls.length;
    expect(source.getFinalMask(0)).toEqual(packMask(binaryOf(W, H, [[2, 2, 4, 4]]), W, H));
    expect(source.getFinalMask(5)).toBeNull();
    expect(source.getFinalMask(-1)).toBeNull();
    expect(cache.bytes()).toBe(3 * packedMaskBytes(W, H));

    expect(await cache.build({ ...base, ai: aiOf() })).toBe(source);
    expect(getProb.mock.calls.length).toBe(calls);
    expect(cache.peek(base)).toBe(source);

    const newer = await cache.build({ ...base, storeVersion: 2 });
    expect(newer).not.toBe(source);
    expect(newer.version).not.toBe(source.version);
    expect(cache.peek(base)).toBeNull();
    expect(cache.peek({ ...base, storeVersion: 2 })).toBe(newer);

    const otherParams = await cache.build({ ...base, storeVersion: 2, ai: aiOf({ edge: 1 }) });
    expect(otherParams.version).not.toBe(newer.version);

    cache.clear();
    expect(cache.peek({ ...base, storeVersion: 2, ai: aiOf({ edge: 1 }) })).toBeNull();
    expect(cache.bytes()).toBe(0);
  });

  it('never lets a superseded or cancelled build replace the memo', async () => {
    const cache = createFinalMaskCache();
    /** @type {(() => void)[]} */
    const gates = [];
    const slow = {
      ...base,
      storeVersion: 10,
      sliceMs: 0,
      yieldToMain: () => new Promise((resolve) => gates.push(() => resolve(undefined))),
    };
    const first = cache.build(slow);
    // A superseded build is aborted: it rejects instead of resolving stale masks
    const firstSettled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = await cache.build({ ...base, storeVersion: 11 });
    while (gates.length) {
      gates.shift()?.();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await firstSettled;
    expect(cache.peek({ ...base, storeVersion: 11 })).toBe(second);
    expect(cache.peek({ ...base, storeVersion: 10 })).toBeNull();

    const controller = new AbortController();
    controller.abort();
    await expect(
      cache.build({ ...base, storeVersion: 12, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.peek({ ...base, storeVersion: 11 })).toBe(second);
  });
  /**
   * Build options whose yields wait for release(), so a build stays in flight
   * @param {object} over
   */
  function gated(over) {
    /** @type {(() => void)[]} */
    const gates = [];
    const options = {
      ...base,
      sliceMs: 0,
      yieldToMain: () => new Promise((resolve) => gates.push(() => resolve(undefined))),
      ...over,
    };
    const release = async () => {
      while (gates.length) {
        gates.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    return { options, release };
  }

  /**
   * Settle a promise to 'resolved' or the rejection's name (never unhandled)
   * @param {Promise<unknown>} promise
   */
  const outcome = (promise) =>
    promise.then(
      () => 'resolved',
      (error) => error.name,
    );

  it("keys the memo by clip, so a clip of the same shape never gets another clip's masks", async () => {
    const cache = createFinalMaskCache();
    const shape = { frameCount: 2, ai: aiOf(), storeVersion: 5, ...noYield };
    const a = await cache.build({
      ...shape,
      clipId: 'clip-a',
      getProb: () => ({ data: new Uint8Array(W * H).fill(255), width: W, height: H }),
    });
    const b = await cache.build({
      ...shape,
      clipId: 'clip-b',
      getProb: () => ({ data: new Uint8Array(W * H).fill(0), width: W, height: H }),
    });
    expect(b).not.toBe(a);
    expect(Array.from(unpackMask(/** @type {any} */ (a.getFinalMask(0))))).toEqual(
      new Array(W * H).fill(1),
    );
    expect(Array.from(unpackMask(/** @type {any} */ (b.getFinalMask(0))))).toEqual(
      new Array(W * H).fill(0),
    );
    expect(cache.peek({ ...shape, clipId: 'clip-b' })).toBe(b);
    expect(cache.peek({ ...shape, clipId: 'clip-a' })).toBeNull();
  });

  it('aborts a superseded build, which rejects and never outranks the newer one', async () => {
    const cache = createFinalMaskCache();
    const picks = [{ frame: 2, x: 0.25, y: 0.5, mode: /** @type {const} */ ('keep') }];
    const slow = gated({ storeVersion: 20, ai: aiOf({ picks }) });
    const stale = outcome(cache.build(slow.options));
    const fresh = await cache.build({ ...base, storeVersion: 21, ai: aiOf({ threshold: 0.7 }) });
    await slow.release();
    expect(await stale).toBe('AbortError');
    expect(cache.peek({ ...base, storeVersion: 21, ai: aiOf({ threshold: 0.7 }) })).toBe(fresh);
    expect(cache.peek({ ...base, storeVersion: 20, ai: aiOf({ picks }) })).toBeNull();
  });

  it('shares an in-flight build between callers with the same inputs', async () => {
    const cache = createFinalMaskCache();
    const slow = gated({ storeVersion: 30 });
    getProb.mockClear();
    const first = cache.build(slow.options);
    const again = cache.build({ ...slow.options, ai: aiOf() });
    await slow.release();
    const [a, b] = await Promise.all([first, again]);
    expect(b).toBe(a);
    // One build's worth of reads: each frame once
    expect(getProb.mock.calls.length).toBe(base.frameCount);
    expect(cache.peek({ ...base, storeVersion: 30 })).toBe(a);
  });

  it('a caller joining an in-flight build gets its own progress and its own Cancel', async () => {
    const cache = createFinalMaskCache();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const slow = gated({ storeVersion: 32 });
    const first = cache.build({
      ...slow.options,
      signal: firstController.signal,
      onProgress: firstProgress,
    });
    const second = cache.build({
      ...slow.options,
      signal: secondController.signal,
      onProgress: secondProgress,
    });
    const secondOutcome = outcome(second);
    // The first step (before the first gated yield): both callers hear about it
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstProgress).toHaveBeenCalled();
    expect(secondProgress).toHaveBeenCalled();

    // The joined caller cancels: it rejects at once, the first caller's build goes on
    secondController.abort();
    expect(await secondOutcome).toBe('AbortError');
    await slow.release();
    const a = await first;
    expect(cache.peek({ ...base, storeVersion: 32 })).toBe(a);
  });

  it('keeps a shared build running until every joined caller has cancelled', async () => {
    const cache = createFinalMaskCache();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const slow = gated({ storeVersion: 33 });
    const first = outcome(cache.build({ ...slow.options, signal: firstController.signal }));
    const second = cache.build({ ...slow.options, signal: secondController.signal });
    // The first caller (e.g. the preview) goes away: the joined export keeps its build
    firstController.abort();
    expect(await first).toBe('AbortError');
    await slow.release();
    const source = await second;
    expect(cache.peek({ ...base, storeVersion: 33 })).toBe(source);

    // Both cancel: the build stops and nothing is memoized
    const c1 = new AbortController();
    const c2 = new AbortController();
    const again = gated({ storeVersion: 34 });
    const o1 = outcome(cache.build({ ...again.options, signal: c1.signal }));
    const o2 = outcome(cache.build({ ...again.options, signal: c2.signal }));
    c1.abort();
    c2.abort();
    await again.release();
    expect([await o1, await o2]).toEqual(['AbortError', 'AbortError']);
    expect(cache.peek({ ...base, storeVersion: 34 })).toBeNull();
    // A new caller after that starts a fresh build instead of joining the aborted one
    const fresh = await cache.build({ ...base, storeVersion: 34 });
    expect(cache.peek({ ...base, storeVersion: 34 })).toBe(fresh);
  });

  it("clear() and the caller's signal stop an in-flight build", async () => {
    const cache = createFinalMaskCache();
    const cleared = gated({ storeVersion: 40 });
    const clearedOutcome = outcome(cache.build(cleared.options));
    cache.clear();
    await cleared.release();
    expect(await clearedOutcome).toBe('AbortError');
    expect(cache.peek({ ...base, storeVersion: 40 })).toBeNull();

    const controller = new AbortController();
    const cancelled = gated({ storeVersion: 41, signal: controller.signal });
    const cancelledOutcome = outcome(cache.build(cancelled.options));
    controller.abort();
    await cancelled.release();
    expect(await cancelledOutcome).toBe('AbortError');
    expect(cache.peek({ ...base, storeVersion: 41 })).toBeNull();

    // The cache still works afterwards
    const next = await cache.build({ ...base, storeVersion: 42 });
    expect(cache.peek({ ...base, storeVersion: 42 })).toBe(next);
  });
});
