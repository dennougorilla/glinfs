import { describe, expect, it } from 'vitest';
import {
  buildSceneRanges,
  createHistogramDetector,
} from '../../../src/features/scene-detection/algorithms/histogram-detector.js';

function pixel(r, g, b) {
  return { data: new Uint8ClampedArray([r, g, b, 255]) };
}

function createFrames(count, transitionFrame) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    timestamp: index * 1000,
    imageData: index < transitionFrame ? pixel(255, 0, 0) : pixel(0, 0, 255),
    histogram: null,
  }));
}

describe('buildSceneRanges', () => {
  it('merges a short leading scene forward without dropping frames', () => {
    expect(buildSceneRanges([0, 3, 10], 5)).toEqual([{ startFrame: 0, endFrame: 9 }]);
  });

  it('merges a short trailing scene into the previous scene', () => {
    expect(buildSceneRanges([0, 7, 10], 5)).toEqual([{ startFrame: 0, endFrame: 9 }]);
  });

  it('keeps qualifying adjacent scenes as an exact partition', () => {
    expect(buildSceneRanges([0, 5, 10], 5)).toEqual([
      { startFrame: 0, endFrame: 4 },
      { startFrame: 5, endFrame: 9 },
    ]);
  });
});

describe('histogram detector scene boundaries', () => {
  it('includes the final frame in the final scene', async () => {
    const result = await createHistogramDetector().detect(createFrames(10, 5), {
      minSceneDuration: 5,
      sampleInterval: 1,
    });

    expect(result.scenes.map(({ startFrame, endFrame }) => ({ startFrame, endFrame }))).toEqual([
      { startFrame: 0, endFrame: 4 },
      { startFrame: 5, endFrame: 9 },
    ]);
  });

  it('does not discard a short leading range', async () => {
    const result = await createHistogramDetector().detect(createFrames(10, 3), {
      minSceneDuration: 5,
      sampleInterval: 1,
    });

    expect(result.scenes.map(({ startFrame, endFrame }) => ({ startFrame, endFrame }))).toEqual([
      { startFrame: 0, endFrame: 9 },
    ]);
  });
});

describe('histogram detector review cases (#208)', () => {
  const ranges = (result) =>
    result.scenes.map(({ startFrame, endFrame }) => ({ startFrame, endFrame }));

  /** @param {[number, number, number][]} shots - colour per frame */
  const framesOf = (shots) =>
    shots.map((rgb, index) => ({
      index,
      timestamp: index * 100,
      imageData: rgb ? pixel(...rgb) : null,
      histogram: null,
    }));

  it('measures a flash in clip frames, not sampled positions', async () => {
    const red = /** @type {[number, number, number]} */ ([255, 0, 0]);
    const blue = /** @type {[number, number, number]} */ ([0, 0, 255]);
    const shots = [...Array(9).fill(red), ...Array(9).fill(blue), ...Array(9).fill(red)];
    const expected = [
      { startFrame: 0, endFrame: 8 },
      { startFrame: 9, endFrame: 17 },
      { startFrame: 18, endFrame: 26 },
    ];
    for (const sampleInterval of [1, 3]) {
      const result = await createHistogramDetector().detect(framesOf(shots), {
        minSceneDuration: 5,
        sampleInterval,
      });
      expect(ranges(result), `sampleInterval ${sampleInterval}`).toEqual(expected);
    }
  });

  it('compares across a frame without pixels', async () => {
    const shots = [...Array(10).fill([255, 0, 0]), null, ...Array(10).fill([0, 0, 255])];
    const result = await createHistogramDetector().detect(framesOf(shots), {
      minSceneDuration: 5,
      sampleInterval: 1,
    });
    expect(ranges(result)).toEqual([
      { startFrame: 0, endFrame: 10 },
      { startFrame: 11, endFrame: 20 },
    ]);
  });

  it('still suppresses a short flash when sampled', async () => {
    const red = [255, 0, 0];
    const white = [255, 255, 255];
    // A 2-frame white flash at 30..31 inside a red shot, sampled every 2nd frame
    const shots = Array.from({ length: 60 }, (_, i) => (i === 30 || i === 31 ? white : red));
    const result = await createHistogramDetector().detect(framesOf(shots), {
      minSceneDuration: 5,
      sampleInterval: 2,
    });
    expect(ranges(result)).toEqual([{ startFrame: 0, endFrame: 59 }]);
  });
});
