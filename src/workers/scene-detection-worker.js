/**
 * Scene Detection Worker
 * Runs scene detection algorithms in a separate thread
 * @module workers/scene-detection-worker
 */

// Import algorithm directly (Worker has module support)
import {
  buildSceneRanges,
  compareHistograms,
  computeHistogram,
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

/**
 * Id of the detection run that is allowed to proceed. CANCEL and every new
 * DETECT bump it, so a run cancelled mid-batch stays cancelled even if the
 * next DETECT arrives before its loop observes the cancel (a single boolean
 * would be reset by that DETECT and the stale run would finish, posting its
 * COMPLETE for the new request).
 * @type {number}
 */
let activeRunId = 0;

// Reused OffscreenCanvas for the per-frame pixel readback (issue #99, fix
// 3). The manager sends downscaled ImageBitmaps (produced off-thread via
// createImageBitmap, no sync readback on the main thread) - the
// drawImage + getImageData pair that used to run on the main thread now
// runs here instead, one buffer reused across the whole detection run.
/** @type {OffscreenCanvas | null} */
let readbackCanvas = null;

/** @type {OffscreenCanvasRenderingContext2D | null} */
let readbackCtx = null;

/**
 * Get (creating/resizing as needed) the shared OffscreenCanvas 2D context
 * used to read pixels back from a transferred ImageBitmap.
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvasRenderingContext2D}
 */
function getReadbackContext(width, height) {
  if (!readbackCanvas) {
    readbackCanvas = new OffscreenCanvas(width, height);
    readbackCtx = readbackCanvas.getContext('2d', { willReadFrequently: true });
  } else if (readbackCanvas.width !== width || readbackCanvas.height !== height) {
    readbackCanvas.width = width;
    readbackCanvas.height = height;
  }
  if (!readbackCtx) {
    throw new Error('Failed to get OffscreenCanvas context');
  }
  return readbackCtx;
}

/**
 * Close every not-yet-closed ImageBitmap in `frameData`, exactly once.
 * The reference is nulled after closing so a repeated call is a no-op.
 * @param {FrameData[]} frameData
 */
function closeFrameBitmaps(frameData) {
  for (const data of frameData) {
    data.imageBitmap?.close();
    data.imageBitmap = null;
  }
}

/**
 * Send message back to main thread
 * @param {'READY' | 'PROGRESS' | 'COMPLETE' | 'ERROR'} type
 * @param {Object} [payload]
 * @param {number} [requestId] - The manager's id for the DETECT this replies
 *   to. Echoed so the manager can drop replies from a superseded request that
 *   were already queued before it cancelled.
 */
function postResult(type, payload, requestId) {
  self.postMessage({ type, requestId, payload });
}

/**
 * Throw an AbortError once `runId` is no longer the active run.
 * @param {number} runId
 */
function throwIfStale(runId) {
  if (runId !== activeRunId) {
    throw new DOMException('Detection cancelled', 'AbortError');
  }
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
 * The worker owns every ImageBitmap in `frameData` once it has been
 * transferred here: each is closed right after its readback, and any left
 * unprocessed when the run is cancelled or throws are closed on the way out.
 * @param {FrameData[]} frameData
 * @param {DetectorOptions} options
 * @param {number} runId - This run's id; the run aborts once it is stale
 * @param {number | undefined} requestId - Manager request id echoed on replies
 * @returns {Promise<SceneDetectionResult>}
 */
async function detectScenes(frameData, options, runId, requestId) {
  try {
    return await runDetection(frameData, options, runId, requestId);
  } finally {
    closeFrameBitmaps(frameData);
  }
}

/**
 * @param {FrameData[]} frameData
 * @param {DetectorOptions} options
 * @param {number} runId
 * @param {number | undefined} requestId
 * @returns {Promise<SceneDetectionResult>}
 */
async function runDetection(frameData, options, runId, requestId) {
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
    throwIfStale(runId);

    const data = frameData[i];

    // Report progress (30-90% range, extraction was 0-30%)
    postResult(
      'PROGRESS',
      {
        percent: 30 + Math.round((i / frameData.length) * 60),
        currentFrame: data.index,
        totalFrames: frameData[frameData.length - 1].index + 1,
        stage: 'analyzing',
      },
      requestId,
    );

    // Read the transferred ImageBitmap back into pixels HERE (worker
    // thread), not on main - and compute the histogram from it.
    let histogram = null;
    if (data.imageBitmap) {
      try {
        const ctx = getReadbackContext(data.width, data.height);
        ctx.clearRect(0, 0, data.width, data.height);
        ctx.drawImage(data.imageBitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, data.width, data.height);
        histogram = computeHistogram(imageData);
      } finally {
        data.imageBitmap.close();
        data.imageBitmap = null;
      }
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

  // The last iteration may have yielded (1, 11, 21, ... frames): a CANCEL
  // or new DETECT that landed there must stop this run before it reports
  throwIfStale(runId);

  // Build scenes from breaks
  /** @type {Scene[]} */
  const scenes = [];

  // Get the last frame index from frameData
  const lastFrameIndex = frameData[frameData.length - 1].index;
  sceneBreaks.push(lastFrameIndex + 1); // End marker

  const ranges = buildSceneRanges(sceneBreaks, opts.minSceneDuration);
  for (const { startFrame, endFrame } of ranges) {
    // Get timestamps from frameData using O(1) Map lookup
    const startData = frameByIndex.get(startFrame);
    const endData = frameByIndex.get(endFrame) || frameData[frameData.length - 1];

    scenes.push({
      id: generateSceneId(),
      startFrame,
      endFrame,
      confidence: 1.0,
      timestamp: startData?.timestamp ?? 0,
      duration: startData && endData ? (endData.timestamp - startData.timestamp) / 1000 : 0,
    });
  }

  // Final progress
  postResult(
    'PROGRESS',
    {
      percent: 100,
      currentFrame: lastFrameIndex + 1,
      totalFrames: lastFrameIndex + 1,
      stage: 'complete',
    },
    requestId,
  );

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
      postResult('READY', { algorithmId });
      break;

    case 'DETECT': {
      const runId = ++activeRunId;
      const { requestId } = event.data;
      try {
        const result = await detectScenes(payload.frameData, payload.options, runId, requestId);
        // Superseded while awaiting: its result belongs to no current request
        if (runId === activeRunId) {
          postResult('COMPLETE', result, requestId);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Cancelled, don't send error
        } else if (runId === activeRunId) {
          postResult('ERROR', { message: error.message || 'Detection failed' }, requestId);
        }
      }
      break;
    }

    case 'CANCEL':
      activeRunId++;
      break;
  }
}

// Set up message listener
self.addEventListener('message', handleMessage);
