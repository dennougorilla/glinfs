/**
 * Scene Detection Worker
 * Runs scene detection algorithms in a separate thread
 * @module workers/scene-detection-worker
 */

// Import scene detection module (Worker has module support)
import { createDetector } from '../features/scene-detection/index.js';
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
 * Detect scenes using the selected algorithm
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

  // Create detector instance for the selected algorithm
  const detector = createDetector(algorithmId);

  // Build frame array with imageData for detection
  const frames = frameData.map(f => ({
    ...f,
    imageData: f.imageData
  }));

  // Add progress callback
  const progressCallback = (currentFrame, totalFrames) => {
    if (!isCancelled) {
      postResult('PROGRESS', {
        percent: 30 + Math.round((currentFrame / totalFrames) * 60),
        currentFrame,
        totalFrames,
        stage: 'analyzing',
      });
    }
  };

  // Add cancellation check callback
  const cancellationCallback = () => isCancelled;

  // Run detection with callbacks
  const detectionResult = await detector.detect(frames, {
    ...opts,
    onProgress: progressCallback,
    checkCancellation: cancellationCallback
  });

  const detectedScenes = Array.isArray(detectionResult)
    ? detectionResult
    : detectionResult?.scenes ?? [];

  // Build index→FrameData map for O(1) lookups when enriching scenes
  /** @type {Map<number, FrameData>} */
  const frameByIndex = new Map();
  for (const f of frameData) {
    frameByIndex.set(f.index, f);
  }

  // Get the last frame index from frameData
  const lastFrameIndex = frameData[frameData.length - 1].index;

  // Enrich scenes with IDs and additional metadata
  /** @type {Scene[]} */
  const scenes = detectedScenes.map(scene => {
    const startData = frameByIndex.get(scene.startFrame);
    const endData = frameByIndex.get(scene.endFrame) || frameData[frameData.length - 1];

    return {
      id: generateSceneId(),
      startFrame: scene.startFrame,
      endFrame: scene.endFrame,
      confidence: scene.confidence || 1.0,
      timestamp: scene.timestamp || startData?.timestamp || 0,
      duration: scene.duration || (startData && endData
        ? (endData.timestamp - startData.timestamp) / 1000
        : 0),
    };
  });

  // Final progress
  postResult('PROGRESS', {
    percent: 100,
    currentFrame: lastFrameIndex + 1,
    totalFrames: lastFrameIndex + 1,
    stage: 'complete',
  });

  return {
    scenes,
    totalFrames: detectionResult?.totalFrames ?? lastFrameIndex + 1,
    processingTimeMs:
      detectionResult?.processingTimeMs ?? performance.now() - startTime,
    algorithmId: detectionResult?.algorithmId ?? algorithmId,
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
