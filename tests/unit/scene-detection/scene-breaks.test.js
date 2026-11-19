import { describe, expect, it } from 'vitest';
import {
  computeFrameFeatures,
  scenesFromFeatures,
} from '../../../src/features/scene-detection/algorithms/histogram-detector.js';
import {
  computePerceptualHash,
  findBreaks,
  hashDistance,
  hashFromHex,
  isFlatHash,
  MAX_LAG,
  SCENE_METHODS,
} from '../../../src/features/scene-detection/algorithms/scene-breaks.js';
import { generateClips } from './fixtures/generated-clips.js';

/**
 * Signals from tables: hist[i] is the lag-1 histogram distance into frame i
 * (longer lags: `far`, default 1 = far apart), hash[i] the lag-1 hash
 * distance (longer lags: the lag-1 values in between, added up).
 * @param {number[]} hist
 * @param {number[]} hash
 * @param {(a: number, b: number) => number | undefined} [far]
 */
function signals(hist, hash, far) {
  return {
    length: hist.length,
    histogram: (/** @type {number} */ a, /** @type {number} */ b) =>
      b - a === 1 ? hist[b] : (far?.(a, b) ?? 1),
    hash: (/** @type {number} */ a, /** @type {number} */ b) =>
      Math.min(
        64,
        hash.slice(a + 1, b + 1).reduce((x, y) => x + y, 0),
      ),
  };
}

const quiet = (/** @type {number} */ n) => Array(n).fill(0.01);

/** @param {number} w @param {number} h @param {(x: number, y: number) => number[]} rgb */
function image(w, h, rgb) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

describe('perceptual hash', () => {
  it('follows the scene-lags recipe bit for bit', () => {
    // Checked against a direct Python transcription of the recipe (area
    // weights per pixel, the DCT as a double sum)
    const frame = generateClips(7)[0].frames[3];
    const words = computePerceptualHash(frame);
    const hex = [words[0], words[1]].map((w) => w.toString(16).padStart(8, '0')).join('');
    expect(hex).toBe('5689a9b70ce38b56');
    expect(hashDistance(words, hashFromHex(hex))).toBe(0);
  });

  it('ignores a global brightness step and sees a shape change', () => {
    const [shot, other] = generateClips(7)[0].frames.filter((_, i) => i === 3 || i === 30);
    const brighter = { ...shot, data: shot.data.map((v, i) => (i % 4 === 3 ? v : v * 1.3)) };
    const base = computePerceptualHash(shot);
    expect(hashDistance(base, computePerceptualHash(brighter))).toBeLessThanOrEqual(4);
    expect(hashDistance(base, computePerceptualHash(other))).toBeGreaterThanOrEqual(15);
  });

  it('marks a frame of one colour as flat, and a near-white frame with shapes as not', () => {
    expect(isFlatHash(computePerceptualHash(image(64, 36, () => [10, 200, 30])))).toBe(true);
    const faint = image(64, 36, (x, y) => (x < 20 !== y < 12 ? [250, 250, 250] : [244, 244, 244]));
    expect(isFlatHash(computePerceptualHash(faint))).toBe(false);
    // The hash leaves out row 0 and column 0 of the DCT: a pattern along one
    // axis only has no coefficient in it, so the frame is flat to the hash
    const stripes = image(64, 36, (x) => (x % 16 < 8 ? [200, 200, 200] : [40, 40, 40]));
    expect(isFlatHash(computePerceptualHash(stripes))).toBe(true);
  });

  it('counts differing bits across both words', () => {
    expect(hashDistance(hashFromHex('8000000000000001'), hashFromHex('0000000000000000'))).toBe(2);
    expect(hashDistance(hashFromHex('ffffffffffffffff'), hashFromHex('0000000000000000'))).toBe(64);
  });
});

describe('scene methods on signals', () => {
  it('fixed: a lag-1 histogram distance above 0.3', () => {
    const hist = quiet(10);
    hist[4] = 0.31;
    hist[7] = 0.3;
    expect(findBreaks(signals(hist, Array(10).fill(30)), 'fixed')).toEqual([4]);
  });

  it('adaptive: a flash whose picture comes back is no cut', () => {
    const hist = quiet(12);
    hist[5] = 0.8;
    hist[7] = 0.8;
    // Frame 4 and frame 7 show the same picture
    const far = (/** @type {number} */ a, /** @type {number} */ b) =>
      a === 4 && b === 7 ? 0.01 : 1;
    expect(findBreaks(signals(hist, Array(12).fill(0), far), 'adaptive')).toEqual([]);
    expect(findBreaks(signals(hist, Array(12).fill(0)), 'adaptive')).toEqual([5, 7]);
  });

  it('comeback: drops a candidate when a later frame matches an earlier one', () => {
    const hist = quiet(20);
    hist[8] = 0.5;
    const back = (/** @type {number} */ a, /** @type {number} */ b) =>
      a === 6 && b === 13 ? 0.05 : 1;
    expect(findBreaks(signals(hist, Array(20).fill(0), back), 'comeback')).toEqual([]);
    expect(findBreaks(signals(hist, Array(20).fill(0)), 'comeback')).toEqual([8]);
  });

  it('hash: a hash distance of at least 0.35 x 64 bits', () => {
    const hash = Array(10).fill(4);
    hash[3] = 23;
    hash[6] = 22;
    expect(findBreaks(signals(quiet(10), hash), 'hash')).toEqual([3]);
  });

  it('combined: colours AND shapes change; an exposure step or motion alone is no cut', () => {
    const hist = quiet(30);
    const hash = Array(30).fill(2);
    hist[5] = 0.7; // exposure step: colours only
    hash[12] = 30; // motion: shapes only
    hist[20] = 0.25; // a cut
    hash[20] = 24;
    const near = (/** @type {number} */ a, /** @type {number} */ b) =>
      b - a <= MAX_LAG ? 0.05 : 1;
    expect(findBreaks(signals(hist, hash, near), 'combined')).toEqual([20]);
  });

  it('combined: a fade counts when the frames around it differ in colour and shape', () => {
    const hist = quiet(30);
    const hash = Array(30).fill(4); // each step small, together large
    hist[15] = 0.21;
    const across = (/** @type {number} */ a, /** @type {number} */ b) =>
      a <= 14 && b >= 15 ? 0.9 : 0.05;
    expect(findBreaks(signals(hist, hash, across), 'combined')).toEqual([15]);
    // The same steps with no colour change across them: motion, no cut
    expect(
      findBreaks(
        signals(hist, hash, () => 0.05),
        'combined',
      ),
    ).toEqual([]);
  });

  it('combined: next to a frame of one colour the colours decide', () => {
    const hist = quiet(10);
    hist[5] = 0.5;
    const s = { ...signals(hist, Array(10).fill(0)), flat: (/** @type {number} */ i) => i === 5 };
    expect(findBreaks(s, 'combined')).toEqual([5]);
  });

  it('refuses an unknown method', () => {
    expect(() => findBreaks(signals(quiet(3), [0, 0, 0]), 'nope')).toThrow(/Unknown scene method/);
    expect(Object.keys(SCENE_METHODS)).toEqual([
      'fixed',
      'adaptive',
      'comeback',
      'hash',
      'combined',
    ]);
  });
});

describe('scenesFromFeatures', () => {
  const red = computeFrameFeatures(image(8, 8, () => [255, 0, 0]));
  const blue = computeFrameFeatures(image(8, 8, () => [0, 0, 255]));

  it('maps breaks to clip frames and skips frames without pixels', () => {
    const features = [red, red, null, red, blue, blue, blue];
    const frameIndices = [0, 2, 4, 6, 8, 10, 12];
    expect(
      scenesFromFeatures(features, {
        frameIndices,
        totalFrames: 14,
        minSceneDuration: 1,
        method: 'fixed',
      }),
    ).toEqual([
      { startFrame: 0, endFrame: 7 },
      { startFrame: 8, endFrame: 13 },
    ]);
  });

  it('runs the chosen method (combined finds the cut between flat frames too)', () => {
    const features = [red, red, red, blue, blue, blue];
    const params = { frameIndices: [0, 1, 2, 3, 4, 5], totalFrames: 6, minSceneDuration: 1 };
    for (const method of ['fixed', 'combined', undefined]) {
      expect(scenesFromFeatures(features, { ...params, method }).map((r) => r.startFrame)).toEqual([
        0, 3,
      ]);
    }
    // Shapes alone: two flat frames hash alike
    expect(
      scenesFromFeatures(features, { ...params, method: 'hash' }).map((r) => r.startFrame),
    ).toEqual([0]);
  });
});
