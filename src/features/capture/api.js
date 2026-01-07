/**
 * Capture API - Side Effect Functions
 * @module features/capture/api
 */

/**
 * Generate a unique ID
 * @returns {string}
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Request screen capture permission and start MediaStream
 * @returns {Promise<MediaStream>}
 * @throws {Error} If permission denied or not supported
 */
export async function startScreenCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    const error = new Error('Screen capture not supported');
    error.code = 'NOT_SUPPORTED';
    throw error;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    });
    return stream;
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      const error = new Error('Screen sharing permission denied');
      error.code = 'PERMISSION_DENIED';
      throw error;
    }
    throw err;
  }
}

/**
 * Stop active screen capture
 * @param {MediaStream} stream
 */
export function stopScreenCapture(stream) {
  if (!stream) return;

  const tracks = stream.getTracks();
  for (const track of tracks) {
    track.stop();
  }
}

/**
 * Capture a single frame from video element to ImageData
 * @deprecated Use createFrameProcessor() with VideoFrame API instead
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @returns {import('./types.js').Frame}
 */
export function captureFrame(video, canvas) {
  const width = video.videoWidth;
  const height = video.videoHeight;

  // Ensure canvas matches video dimensions
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get canvas 2D context');
  }

  // Draw video frame to canvas
  ctx.drawImage(video, 0, 0, width, height);

  // Extract pixel data
  const data = ctx.getImageData(0, 0, width, height);

  return {
    id: generateId(),
    data,
    timestamp: performance.now(),
    width,
    height,
  };
}

/**
 * Create a video element for the given stream
 * @param {MediaStream} stream
 * @returns {Promise<HTMLVideoElement>}
 */
export async function createVideoElement(stream) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  // Wait for video to be ready
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => {
      video.play().then(resolve).catch(reject);
    };
    video.onerror = () => reject(new Error('Failed to load video stream'));
  });

  return video;
}

/**
 * Create a hidden canvas for frame capture
 * @returns {HTMLCanvasElement}
 */
export function createCaptureCanvas() {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'none';
  return canvas;
}

/**
 * Create a ReadableStreamDefaultReader for VideoFrame objects
 * Uses MediaStreamTrackProcessor with backpressure control
 * @param {MediaStreamTrack} track - Video track from MediaStream
 * @returns {ReadableStreamDefaultReader<VideoFrame>}
 * @throws {Error} If track is not live or processor creation fails
 */
export function createFrameProcessor(track) {
  // Validate track state
  if (track.readyState !== 'live') {
    throw new Error(`Cannot create frame processor: track state is "${track.readyState}" (expected "live")`);
  }

  // Check for MediaStreamTrackProcessor support
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    throw new Error('MediaStreamTrackProcessor not supported in this browser');
  }

  const processor = new MediaStreamTrackProcessor({
    track,
    maxBufferSize: 30, // Backpressure control: auto-drop old frames when processing lags
  });
  return processor.readable.getReader();
}

/**
 * Create VideoFrame from HTMLVideoElement
 * This works even when the video content hasn't changed (static screen)
 * @param {HTMLVideoElement} video - Video element with active stream
 * @returns {VideoFrame | null} VideoFrame or null if video not ready
 */
export function createVideoFrameFromElement(video) {
  if (!video || video.readyState < 2) {
    return null;
  }

  try {
    // Create VideoFrame directly from video element
    // This works even when screen content is static
    return new VideoFrame(video, {
      timestamp: performance.now() * 1000, // microseconds
    });
  } catch (err) {
    console.error('[Capture] Failed to create VideoFrame from video element:', err);
    return null;
  }
}
