/**
 * Capture Worker - Timing and Frame Buffer Management
 *
 * This worker handles frame capture timing using setInterval, which is NOT throttled
 * in background tabs (unlike main thread setInterval/requestAnimationFrame).
 *
 * Architecture:
 * - Worker: setInterval for timing, ImageBitmap storage
 * - Main Thread: createImageBitmap(video) for actual frame capture
 *
 * @module workers/capture-worker
 */

/**
 * @typedef {Object} FrameEntry
 * @property {ImageBitmap} bitmap - The captured frame
 * @property {number} timestamp - Capture timestamp (ms)
 * @property {string} id - Unique frame identifier
 */

/** @type {FrameEntry[]} */
let frameBuffer = [];

/** Index of the oldest entry when the buffer has wrapped */
let frameBufferStart = 0;

/** @type {number} */
let maxFrames = 300;

/** @type {number | null} */
let captureIntervalId = null;

/** @type {number} */
let fps = 30;

/** @type {boolean} */
let isCapturing = false;

/**
 * Id of the FRAME_REQUEST whose answer is awaited, or null. Only that
 * request's answer frees the slot: an answer to a request from before a
 * restart (a change of source stops and starts while a grab is in flight)
 * must not let a second grab overlap the current one, or frames could
 * arrive out of order.
 * @type {number | null}
 */
let pendingRequestId = null;

/** Id of the last FRAME_REQUEST sent; never reused while the worker lives */
let lastRequestId = 0;

/**
 * Handle messages from main thread
 * @param {MessageEvent} e
 */
self.onmessage = (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'START':
      fps = payload.fps;
      resizeBuffer(payload.maxFrames);
      startCapture();
      break;

    case 'STOP':
      stopCapture();
      break;

    case 'FRAME_RESPONSE':
      handleFrameResponse(payload.bitmap, payload.timestamp, payload.requestId);
      break;

    case 'GET_FRAMES':
      sendFrames();
      break;

    case 'CLEAR':
      clearBuffer();
      break;

    case 'GET_STATS':
      sendStats();
      break;
  }
};

/**
 * Start the capture interval
 * Worker setInterval is NOT throttled in background tabs!
 */
function startCapture() {
  if (isCapturing) return;
  isCapturing = true;

  const interval = 1000 / fps;

  // Request first frame immediately
  requestFrame();

  // Start interval for subsequent frames
  captureIntervalId = setInterval(() => {
    if (!isCapturing) return;

    // Backpressure: skip if previous request is still pending
    if (pendingRequestId !== null) {
      return;
    }

    requestFrame();
  }, interval);
}

/**
 * Ask the main thread for a frame; its answer must carry the same id
 */
function requestFrame() {
  lastRequestId++;
  pendingRequestId = lastRequestId;
  self.postMessage({
    type: 'FRAME_REQUEST',
    payload: { timestamp: Date.now(), requestId: lastRequestId },
  });
}

/**
 * Stop the capture interval
 */
function stopCapture() {
  isCapturing = false;
  pendingRequestId = null;

  if (captureIntervalId !== null) {
    clearInterval(captureIntervalId);
    captureIntervalId = null;
  }
}

/**
 * Handle frame response from main thread
 * @param {ImageBitmap | null} bitmap
 * @param {number} timestamp
 * @param {number} [requestId] - id of the FRAME_REQUEST this answers
 */
function handleFrameResponse(bitmap, timestamp, requestId) {
  if (requestId !== pendingRequestId) {
    // Answers a request from before a stop, clear or restart: the current
    // request is still pending, so keep its slot and drop this frame
    bitmap?.close();
    return;
  }
  // Allow the next request
  pendingRequestId = null;

  if (!bitmap) {
    return;
  }

  if (!isCapturing) {
    // In-flight frame arrived after STOP: release it instead of leaking (#40)
    bitmap.close();
    return;
  }

  const frame = {
    bitmap,
    timestamp,
    id: crypto.randomUUID(),
  };

  // Evict the oldest frame in O(1). Array.shift() moved every remaining
  // entry on each captured frame once the rolling buffer was full.
  if (frameBuffer.length >= maxFrames) {
    const evicted = frameBuffer[frameBufferStart];
    if (evicted?.bitmap) {
      evicted.bitmap.close();
    }
    frameBuffer[frameBufferStart] = frame;
    frameBufferStart = (frameBufferStart + 1) % maxFrames;
  } else {
    frameBuffer.push(frame);
  }

  // Send stats update
  sendStats();
}

/**
 * Send current stats to main thread
 */
function sendStats() {
  self.postMessage({
    type: 'STATS_UPDATE',
    payload: {
      frameCount: frameBuffer.length,
      maxFrames,
      fps,
    },
  });
}

/**
 * Send all frames to main thread (transfers ownership)
 * After this call, the buffer will be empty
 */
function sendFrames() {
  const orderedFrames = getFramesInCaptureOrder();

  // Transfer ownership of all ImageBitmaps to main thread
  const transferables = orderedFrames.map((f) => f.bitmap);

  self.postMessage({ type: 'FRAMES_RESPONSE', payload: { frames: orderedFrames } }, transferables);

  // Buffer is now empty (bitmaps transferred)
  frameBuffer = [];
  frameBufferStart = 0;
  sendStats();
}

/**
 * Clear buffer and release all ImageBitmap resources
 */
function clearBuffer() {
  for (const frame of frameBuffer) {
    frame.bitmap?.close();
  }
  frameBuffer = [];
  frameBufferStart = 0;
  sendStats();
}

/**
 * Return buffered entries from oldest to newest.
 * @returns {FrameEntry[]}
 */
function getFramesInCaptureOrder() {
  if (frameBufferStart === 0 || frameBuffer.length === 0) {
    return frameBuffer;
  }

  return [...frameBuffer.slice(frameBufferStart), ...frameBuffer.slice(0, frameBufferStart)];
}

/**
 * Apply a new capacity while preserving the newest frames.
 * @param {number} requestedMaxFrames
 */
function resizeBuffer(requestedMaxFrames) {
  const nextMaxFrames = Number.isFinite(requestedMaxFrames)
    ? Math.max(1, Math.floor(requestedMaxFrames))
    : maxFrames;
  const orderedFrames = getFramesInCaptureOrder();

  if (orderedFrames.length > nextMaxFrames) {
    const discardCount = orderedFrames.length - nextMaxFrames;
    for (let i = 0; i < discardCount; i++) {
      orderedFrames[i].bitmap?.close();
    }
    frameBuffer = orderedFrames.slice(discardCount);
  } else if (frameBufferStart !== 0) {
    frameBuffer = orderedFrames;
  }

  frameBufferStart = 0;
  maxFrames = nextMaxFrames;
}
