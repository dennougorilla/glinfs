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
      threshold: 0.3,
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
      threshold: 0.3,
      minSceneDuration: 5,
      sampleInterval: 1,
    });

    expect(result.scenes.map(({ startFrame, endFrame }) => ({ startFrame, endFrame }))).toEqual([
      { startFrame: 0, endFrame: 9 },
    ]);
  });
});
