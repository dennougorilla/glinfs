/**
 * Histogram-based Scene Detector
 * Detects scene changes by comparing color histograms between frames
 * @module features/scene-detection/algorithms/histogram-detector
 */

import { DEFAULT_DETECTOR_OPTIONS } from '../types.js';

/**
 * @typedef {import('../types.js').SceneDetectorInterface} SceneDetectorInterface
 * @typedef {import('../types.js').DetectorMetadata} DetectorMetadata
 * @typedef {import('../types.js').DetectorOptions} DetectorOptions
 * @typedef {import('../types.js').SceneDetectionResult} SceneDetectionResult
 * @typedef {import('../types.js').Scene} Scene
 * @typedef {import('../types.js').FrameData} FrameData
 */

const HISTOGRAM_BINS = 64;
const HISTOGRAM_SIZE = HISTOGRAM_BINS * 3; // RGB channels

/**
 * Compute color histogram from ImageData
 * Uses 64 bins per channel (R, G, B) for balance between accuracy and performance
 * @param {ImageData} imageData - Raw pixel data
 * @returns {Float32Array} Normalized histogram (192 values: 64 per channel)
 */
export function computeHistogram(imageData) {
  const histogram = new Float32Array(HISTOGRAM_SIZE);
  const data = imageData.data;
  const pixelCount = data.length / 4;

  // Count pixels in each bin
  for (let i = 0; i < data.length; i += 4) {
    const rBin = Math.floor((data[i] / 256) * HISTOGRAM_BINS);
    const gBin = Math.floor((data[i + 1] / 256) * HISTOGRAM_BINS);
    const bBin = Math.floor((data[i + 2] / 256) * HISTOGRAM_BINS);

    histogram[rBin]++;
    histogram[HISTOGRAM_BINS + gBin]++;
    histogram[HISTOGRAM_BINS * 2 + bBin]++;
  }

  // Normalize histogram (divide by pixel count)
  for (let i = 0; i < HISTOGRAM_SIZE; i++) {
    histogram[i] /= pixelCount;
  }

  return histogram;
}

/**
 * Compare two histograms using chi-square distance
 * Lower value = more similar, Higher value = more different
 * @param {Float32Array} hist1 - First histogram
 * @param {Float32Array} hist2 - Second histogram
 * @returns {number} Chi-square distance (0 = identical, higher = more different)
 */
export function compareHistograms(hist1, hist2) {
  let distance = 0;

  for (let i = 0; i < HISTOGRAM_SIZE; i++) {
    const sum = hist1[i] + hist2[i];
    if (sum > 0) {
      const diff = hist1[i] - hist2[i];
      distance += (diff * diff) / sum;
    }
  }

  return distance / 2; // Normalize to 0-1 range approximately
}

/**
 * Build non-overlapping scene ranges from exclusive scene boundaries.
 * Short scenes are merged into the previous range; a short leading range is
 * merged forward because no previous range exists yet.
 *
 * @param {number[]} sceneBreaks - Ordered boundaries including start and exclusive end
 * @param {number} minSceneDuration - Minimum range length in frames
 * @returns {Array<{startFrame: number, endFrame: number}>}
 */
export function buildSceneRanges(sceneBreaks, minSceneDuration) {
  const rawRanges = [];

  for (let i = 0; i < sceneBreaks.length - 1; i++) {
    rawRanges.push({
      startFrame: sceneBreaks[i],
      endFrame: sceneBreaks[i + 1] - 1,
    });
  }

  const ranges = [];
  for (let i = 0; i < rawRanges.length; i++) {
    const range = rawRanges[i];
    const duration = range.endFrame - range.startFrame + 1;

    if (duration >= minSceneDuration) {
      ranges.push(range);
    } else if (ranges.length > 0) {
      ranges[ranges.length - 1].endFrame = range.endFrame;
    } else if (rawRanges[i + 1]) {
      // Preserve a short leading scene by folding it into the next range.
      rawRanges[i + 1].startFrame = range.startFrame;
    }
    // A clip consisting of one short range keeps the existing [] semantics:
    // callers treat that as a single scene with no detected changes.
  }

  return ranges;
}

/**
 * Generate unique scene ID
 * @returns {string}
 */
function generateSceneId() {
  return `scene-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create histogram detector instance
 * @returns {SceneDetectorInterface}
 */
export function createHistogramDetector() {
  /** @type {DetectorMetadata} */
  const metadata = {
    id: 'histogram',
    name: 'Histogram Comparison',
    description: 'Detects scene changes by comparing color distribution histograms between frames',
    supportsWorker: true,
  };

  /**
   * Detect scenes from frame data
   * @param {FrameData[]} frameData - Frames to analyze
   * @param {DetectorOptions} options - Detection options
   * @returns {Promise<SceneDetectionResult>}
   */
  async function detect(frameData, options = DEFAULT_DETECTOR_OPTIONS) {
    const startTime = performance.now();
    const opts = { ...DEFAULT_DETECTOR_OPTIONS, ...options };

    if (frameData.length === 0) {
      return {
        scenes: [],
        totalFrames: 0,
        processingTimeMs: performance.now() - startTime,
        algorithmId: metadata.id,
      };
    }

    /** @type {Scene[]} */
    const scenes = [];
    /** @type {number[]} */
    const sceneBreaks = [0]; // First frame is always a scene start

    // Track previous histogram for comparison
    /** @type {Float32Array | null} */
    let prevHistogram = null;

    // Process frames with sampling
    const framesToProcess = [];
    for (let i = 0; i < frameData.length; i += opts.sampleInterval) {
      framesToProcess.push({ data: frameData[i], originalIndex: i });
    }

    for (let i = 0; i < framesToProcess.length; i++) {
      const { data, originalIndex } = framesToProcess[i];

      // Report progress
      if (opts.onProgress) {
        opts.onProgress({
          percent: Math.round((i / framesToProcess.length) * 100),
          currentFrame: originalIndex,
          totalFrames: frameData.length,
          stage: 'analyzing',
        });
      }

      // Compute histogram from ImageData
      if (!data.imageData) {
        // Skip frames without data
        continue;
      }
      const histogram = computeHistogram(data.imageData);

      // Compare with previous frame
      if (prevHistogram !== null) {
        const distance = compareHistograms(prevHistogram, histogram);

        // Scene change detected if distance exceeds threshold
        if (distance > opts.threshold) {
          sceneBreaks.push(originalIndex);
        }
      }

      prevHistogram = histogram;

      // Yield to event loop periodically to prevent blocking
      if (i % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // Add an exclusive end marker so the final frame remains included.
    sceneBreaks.push(frameData.length);

    const ranges = buildSceneRanges(sceneBreaks, opts.minSceneDuration);
    for (const { startFrame, endFrame } of ranges) {
      const startFrameData = frameData[startFrame];
      const endFrameData = frameData[endFrame];

      scenes.push({
        id: generateSceneId(),
        startFrame,
        endFrame,
        confidence: 1.0, // Histogram detection doesn't provide confidence
        timestamp: startFrameData?.timestamp ?? 0,
        duration: endFrameData ? (endFrameData.timestamp - startFrameData.timestamp) / 1000 : 0,
      });
    }

    // Final progress
    if (opts.onProgress) {
      opts.onProgress({
        percent: 100,
        currentFrame: frameData.length,
        totalFrames: frameData.length,
        stage: 'complete',
      });
    }

    return {
      scenes,
      totalFrames: frameData.length,
      processingTimeMs: performance.now() - startTime,
      algorithmId: metadata.id,
    };
  }

  function dispose() {
    // No resources to clean up for this detector
  }

  return {
    metadata,
    detect,
    dispose,
  };
}
