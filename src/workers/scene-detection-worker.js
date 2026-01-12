/**
 * Scene Detection Worker
 * Runs scene detection algorithms in a separate thread
 * @module workers/scene-detection-worker
 */

// Import algorithm directly (Worker has module support)
import {
  computeHistogram,
  compareHistograms,
} from '../features/scene-detection/algorithms/histogram-detector.js';
import { DEFAULT_DETECTOR_OPTIONS } from '../features/scene-detection/types.js';

/**
 * @typedef {import('../features/scene-detection/types.js').FrameData} FrameData
 * @typedef {import('../features/scene-detection/types.js').DetectorOptions} DetectorOptions
 * @typedef {import('../features/scene-detection/types.js').Scene} Scene
 * @typedef {import('../features/scene-detection/types.js').SceneDetectionResult} SceneDetectionResult
 * @typedef {import('../features/scene-detection/types.js').DetectionProgress} DetectionProgress
 */

/** @type {string} */
let algorithmId = 'histogram';

/** @type {boolean} */
let isCancelled = false;

/**
 * Send message back to main thread
 * @param {'READY' | 'PROGRESS' | 'COMPLETE' | 'ERROR'} type
 * @param {Object} [payload]
 */
function postResult(type, payload) {
  self.postMessage({ type, payload });
}

/**
 * Generate unique scene ID
 * @returns {string}
 */
function generateSceneId() {
  return `scene-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Detect scenes using histogram comparison
 * @param {FrameData[]} frameData
 * @param {DetectorOptions} options
 * @returns {Promise<SceneDetectionResult>}
 */
async function detectScenes(frameData, options) {
  const startTime = performance.now();
  const opts = { ...DEFAULT_DETECTOR_OPTIONS, ...options };

  if (frameData.length === 0) {
    return {
      scenes: [],
      totalFrames: 0,
      processingTimeMs: performance.now() - startTime,
      algorithmId,
    };
  }

  // Build index→FrameData map for O(1) lookups when building scenes
  /** @type {Map<number, FrameData>} */
  const frameByIndex = new Map();
  for (const f of frameData) {
    frameByIndex.set(f.index, f);
  }

  /** @type {number[]} */
  const sceneBreaks = [0]; // First frame is always a scene start

  /** @type {Float32Array | null} */
  let prevHistogram = null;

  // Process frames
  for (let i = 0; i < frameData.length; i++) {
    if (isCancelled) {
      throw new DOMException('Detection cancelled', 'AbortError');
    }

    const data = frameData[i];

    // Report progress (30-90% range, extraction was 0-30%)
    postResult('PROGRESS', {
      percent: 30 + Math.round((i / frameData.length) * 60),
      currentFrame: data.index,
      totalFrames: frameData[frameData.length - 1].index + 1,
      stage: 'analyzing',
    });

    // Compute histogram from ImageData
    let histogram = null;
    if (data.imageData) {
      histogram = computeHistogram(data.imageData);
    }

    // Compare with previous frame
    if (histogram && prevHistogram !== null) {
      const distance = compareHistograms(prevHistogram, histogram);

      // Scene change detected if distance exceeds threshold
      if (distance > opts.threshold) {
        sceneBreaks.push(data.index);
      }
    }

    prevHistogram = histogram;

    // Yield to allow cancellation checks
    if (i % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Build scenes from breaks
  /** @type {Scene[]} */
  const scenes = [];

  // Get the last frame index from frameData
  const lastFrameIndex = frameData[frameData.length - 1].index;
  sceneBreaks.push(lastFrameIndex + 1); // End marker

  for (let i = 0; i < sceneBreaks.length - 1; i++) {
    const startFrame = sceneBreaks[i];
    const endFrame = sceneBreaks[i + 1] - 1;
    const sceneDuration = endFrame - startFrame + 1;

    if (sceneDuration >= opts.minSceneDuration) {
      // Get timestamps from frameData using O(1) Map lookup
      const startData = frameByIndex.get(startFrame);
      const endData = frameByIndex.get(endFrame) || frameData[frameData.length - 1];

      scenes.push({
        id: generateSceneId(),
        startFrame,
        endFrame,
        confidence: 1.0,
        timestamp: startData?.timestamp ?? 0,
        duration: startData && endData
          ? (endData.timestamp - startData.timestamp) / 1000
          : 0,
      });
    } else if (scenes.length > 0) {
      // Merge short scene with previous
      const lastScene = scenes[scenes.length - 1];
      lastScene.endFrame = endFrame;

      const startData = frameByIndex.get(lastScene.startFrame);
      const endData = frameByIndex.get(endFrame) || frameData[frameData.length - 1];
      if (startData && endData) {
        lastScene.duration = (endData.timestamp - startData.timestamp) / 1000;
      }
    }
  }

  // Final progress
  postResult('PROGRESS', {
    percent: 100,
    currentFrame: lastFrameIndex + 1,
    totalFrames: lastFrameIndex + 1,
    stage: 'complete',
  });

  return {
    scenes,
    totalFrames: lastFrameIndex + 1,
    processingTimeMs: performance.now() - startTime,
    algorithmId,
  };
}

/**
 * Handle incoming messages from main thread
 * @param {MessageEvent} event
 */
async function handleMessage(event) {
  const { type, payload } = event.data;

  switch (type) {
    case 'INIT':
      algorithmId = payload?.algorithmId || 'histogram';
      isCancelled = false;
      postResult('READY', { algorithmId });
      break;

    case 'DETECT':
      try {
        isCancelled = false;
        const result = await detectScenes(payload.frameData, payload.options);
        postResult('COMPLETE', result);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Cancelled, don't send error
        } else {
          postResult('ERROR', { message: error.message || 'Detection failed' });
        }
      }
      break;

    case 'CANCEL':
      isCancelled = true;
      break;
  }
}

// Set up message listener
self.addEventListener('message', handleMessage);
