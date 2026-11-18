import { describe, expect, it } from 'vitest';
import {
  buildSceneRanges,
  computeHistogram,
  findSceneBreaks,
} from '../../../src/features/scene-detection/algorithms/histogram-detector.js';
import { generateClips, scoreCuts } from './fixtures/generated-clips.js';

/**
 * Accuracy on generated clips (owner feedback 2026-11-17, item 6): hard
 * cuts, same-palette cuts, fades, white flashes, a fast pan, mouth flaps,
 * anime on 2s/3s and screen recordings. The adaptive detector against the
 * old fixed 0.3 threshold, scored like the scene list the user sees (scenes
 * shorter than 5 frames merged). Bounds are loose: they catch a regression,
 * not a change in the third decimal.
 */

const MIN_SCENE = 5;

/**
 * @param {number} seed
 * @param {{ fixedThreshold?: number }} options
 */
function evaluate(seed, options) {
  const totals = { tp: 0, fp: 0, fn: 0 };
  /** @type {Record<string, { tp: number, fp: number, fn: number }>} */
  const byClip = {};
  for (const clip of generateClips(seed)) {
    const histograms = clip.frames.map((f) => computeHistogram(/** @type {any} */ (f)));
    const breaks = findSceneBreaks(histograms, options);
    const starts = buildSceneRanges([0, ...breaks, clip.frames.length], MIN_SCENE)
      .map((r) => r.startFrame)
      .filter((s) => s > 0);
    const score = scoreCuts(starts, clip);
    byClip[clip.name] = score;
    totals.tp += score.tp;
    totals.fp += score.fp;
    totals.fn += score.fn;
  }
  return {
    byClip,
    precision: totals.tp / Math.max(1, totals.tp + totals.fp),
    recall: totals.tp / Math.max(1, totals.tp + totals.fn),
  };
}

describe('scene detection accuracy on generated clips', () => {
  it.each([7, 42])(
    'the adaptive threshold finds the cuts and ignores flashes (seed %i)',
    (seed) => {
      const adaptive = evaluate(seed, {});
      const fixed = evaluate(seed, { fixedThreshold: 0.3 });

      // Measured: adaptive P 0.94 / R 0.94-1.00; fixed P 0.79 / R 0.88
      expect(adaptive.precision).toBeGreaterThanOrEqual(0.88);
      expect(adaptive.recall).toBeGreaterThanOrEqual(0.88);
      expect(adaptive.precision).toBeGreaterThan(fixed.precision);
      expect(adaptive.recall).toBeGreaterThanOrEqual(fixed.recall);

      // White flashes are no cuts; the fixed threshold took them for cuts
      expect(adaptive.byClip['white flashes (2 frames), no cut'].fp).toBe(0);
      expect(fixed.byClip['white flashes (2 frames), no cut'].fp).toBeGreaterThan(0);
      // No cut in a pan or a talking shot
      expect(adaptive.byClip['fast pan, no cut'].fp).toBe(0);
      expect(adaptive.byClip['static dialogue, mouth flaps'].fp).toBe(0);
    },
  );

  it('finds a hard cut and a flash-free single shot in the smallest clip', () => {
    const red = new Float32Array(192);
    red[63] = 1;
    red[64] = 1;
    red[128] = 1;
    const blue = new Float32Array(192);
    blue[0] = 1;
    blue[64] = 1;
    blue[191] = 1;
    expect(findSceneBreaks([red, red, red, blue, blue, blue])).toEqual([3]);
    // A missing histogram starts nothing and breaks no chain
    expect(findSceneBreaks([red, null, red])).toEqual([]);
    expect(findSceneBreaks([])).toEqual([]);
  });
});
