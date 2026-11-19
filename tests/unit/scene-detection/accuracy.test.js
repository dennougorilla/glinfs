import { describe, expect, it } from 'vitest';
import {
  computeFrameFeatures,
  scenesFromFeatures,
} from '../../../src/features/scene-detection/algorithms/histogram-detector.js';
import { generateClips, scoreCuts } from './fixtures/generated-clips.js';

/**
 * Accuracy on generated clips (owner feedback 2026-11-17, item 6): hard
 * cuts, same-palette cuts, fades, white flashes, a fast pan, mouth flaps,
 * anime on 2s/3s, screen recordings, a 9-frame camera flash and exposure
 * steps in one shot. Scored like the scene list the user sees (scenes
 * shorter than 5 frames merged). Bounds are loose: they catch a regression,
 * not a change in the third decimal.
 */

/** @type {Map<number, ReturnType<typeof generateClips>>} */
const clipsBySeed = new Map();
/** @type {Map<number, ReturnType<typeof computeFrameFeatures>[][]>} */
const featuresBySeed = new Map();

/**
 * @param {number} seed
 * @param {string} method
 */
function evaluate(seed, method) {
  if (!clipsBySeed.has(seed)) {
    const clips = generateClips(seed);
    clipsBySeed.set(seed, clips);
    featuresBySeed.set(
      seed,
      clips.map((c) => c.frames.map((f) => computeFrameFeatures(/** @type {any} */ (f)))),
    );
  }
  const clips = /** @type {ReturnType<typeof generateClips>} */ (clipsBySeed.get(seed));
  const features = /** @type {ReturnType<typeof computeFrameFeatures>[][]} */ (
    featuresBySeed.get(seed)
  );
  const totals = { tp: 0, fp: 0, fn: 0 };
  /** @type {Record<string, { tp: number, fp: number, fn: number }>} */
  const byClip = {};
  clips.forEach((clip, k) => {
    const starts = scenesFromFeatures(features[k], {
      frameIndices: clip.frames.map((_, i) => i),
      totalFrames: clip.frames.length,
      minSceneDuration: 5,
      method,
    })
      .map((r) => r.startFrame)
      .filter((s) => s > 0);
    const score = scoreCuts(starts, clip);
    byClip[clip.name] = score;
    totals.tp += score.tp;
    totals.fp += score.fp;
    totals.fn += score.fn;
  });
  return {
    byClip,
    precision: totals.tp / Math.max(1, totals.tp + totals.fp),
    recall: totals.tp / Math.max(1, totals.tp + totals.fn),
  };
}

describe('scene detection accuracy on generated clips', () => {
  it.each([7, 42])('colour and shape beats the fixed and adaptive thresholds (seed %i)', (seed) => {
    const combined = evaluate(seed, 'combined');
    const fixed = evaluate(seed, 'fixed');
    const adaptive = evaluate(seed, 'adaptive');

    // Measured over seeds 7, 11, 23, 42, 99: combined P 0.92 R 1.00,
    // adaptive P 0.73 R 0.97, fixed P 0.62 R 0.86
    expect(combined.precision).toBeGreaterThanOrEqual(0.88);
    expect(combined.recall).toBeGreaterThanOrEqual(0.95);
    expect(combined.precision).toBeGreaterThan(adaptive.precision);
    expect(combined.precision).toBeGreaterThan(fixed.precision);
    expect(combined.recall).toBeGreaterThanOrEqual(adaptive.recall);

    // Flashes and exposure steps keep the shapes: no cut
    for (const name of [
      'white flashes (2 frames), no cut',
      'camera flashes (9 frames), no cut',
      'exposure steps in one shot, no cut',
      'fast pan, no cut',
      'static dialogue, mouth flaps',
    ]) {
      expect(combined.byClip[name].fp, name).toBe(0);
    }
    // ...which both thresholds took for cuts
    expect(fixed.byClip['camera flashes (9 frames), no cut'].fp).toBeGreaterThan(0);
    expect(adaptive.byClip['exposure steps in one shot, no cut'].fp).toBeGreaterThan(0);
    // Same-palette cuts that the fixed threshold misses
    expect(combined.byClip['hard cuts, same palette'].fn).toBe(0);
  });

  it.each([7, 42])(
    'the adaptive threshold keeps PR #208 numbers on its clips (seed %i)',
    (seed) => {
      const adaptive = evaluate(seed, 'adaptive');
      expect(adaptive.byClip['white flashes (2 frames), no cut'].fp).toBe(0);
      expect(adaptive.byClip['fast pan, no cut'].fp).toBe(0);
      expect(evaluate(seed, 'fixed').byClip['white flashes (2 frames), no cut'].fp).toBeGreaterThan(
        0,
      );
    },
  );
});
