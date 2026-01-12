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

/** @type {number} */
let maxFrames = 300;

/** @type {number | null} */
let captureIntervalId = null;

/** @type {number} */
let fps = 30;

/** @type {boolean} */
let isCapturing = false;

/** @type {boolean} */
let pendingRequest = false;

/**
 * Handle messages from main thread
 * @param {MessageEvent} e
 */
self.onmessage = (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'START':
      fps = payload.fps;
      maxFrames = payload.maxFrames;
      startCapture();
      break;

    case 'STOP':
      stopCapture();
      break;

    case 'FRAME_RESPONSE':
      handleFrameResponse(payload.bitmap, payload.timestamp);
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
  pendingRequest = false;

  const interval = 1000 / fps;

  // Request first frame immediately
  pendingRequest = true;
  self.postMessage({ type: 'FRAME_REQUEST', payload: { timestamp: Date.now() } });

  // Start interval for subsequent frames
  captureIntervalId = setInterval(() => {
    if (!isCapturing) return;

    // Backpressure: skip if previous request is still pending
    if (pendingRequest) {
      return;
    }

    pendingRequest = true;
    self.postMessage({ type: 'FRAME_REQUEST', payload: { timestamp: Date.now() } });
  }, interval);
}

/**
 * Stop the capture interval
 */
function stopCapture() {
  isCapturing = false;
  pendingRequest = false;

  if (captureIntervalId !== null) {
    clearInterval(captureIntervalId);
    captureIntervalId = null;
  }
}

/**
 * Handle frame response from main thread
 * @param {ImageBitmap | null} bitmap
 * @param {number} timestamp
 */
function handleFrameResponse(bitmap, timestamp) {
  // Clear pending flag to allow next request
  pendingRequest = false;

  if (!bitmap || !isCapturing) {
    return;
  }

  // Evict oldest frame if buffer is full
  if (frameBuffer.length >= maxFrames) {
    const evicted = frameBuffer.shift();
    if (evicted?.bitmap) {
      evicted.bitmap.close();
    }
  }

  // Add new frame
  frameBuffer.push({
    bitmap,
    timestamp,
    id: crypto.randomUUID(),
  });

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
  // Transfer ownership of all ImageBitmaps to main thread
  const transferables = frameBuffer.map((f) => f.bitmap);

  self.postMessage(
    { type: 'FRAMES_RESPONSE', payload: { frames: frameBuffer } },
    transferables
  );

  // Buffer is now empty (bitmaps transferred)
  frameBuffer = [];
}

/**
 * Clear buffer and release all ImageBitmap resources
 */
function clearBuffer() {
  for (const frame of frameBuffer) {
    frame.bitmap?.close();
  }
  frameBuffer = [];
  pendingRequest = false;
  sendStats();
}
