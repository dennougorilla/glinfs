/**
 * Capture API - Side Effect Functions
 * @module features/capture/api
 */

import { getTestConfig, isTestMode } from '../../shared/test-mode.js';

/** Canvas dimensions for the mock stream (kept small - it's only drawn to, never shown) */
const MOCK_STREAM_WIDTH = 640;
const MOCK_STREAM_HEIGHT = 480;

/**
 * Build a canvas.captureStream() MediaStream that draws an animated frame
 * counter, standing in for getDisplayMedia() under test.
 *
 * Lets Playwright drive the entire live capture pipeline (start, background
 * capture, "ended" handling) without a real screen-share permission prompt.
 * The draw loop is stopped as soon as the track is stopped by any caller -
 * handleStop(), stream.getTracks().forEach(t => t.stop()), or the browser -
 * so the canvas/interval never outlives the stream.
 *
 * @returns {MediaStream}
 */
function createMockScreenStream() {
  const canvas = document.createElement('canvas');
  canvas.width = MOCK_STREAM_WIDTH;
  canvas.height = MOCK_STREAM_HEIGHT;
  const ctx = canvas.getContext('2d');

  let frame = 0;
  const drawFrame = () => {
    frame += 1;
    if (!ctx) return;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e94560';
    ctx.font = '48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(frame), canvas.width / 2, canvas.height / 2);
  };
  drawFrame();

  const intervalId = setInterval(drawFrame, 1000 / 30);
  const stream = canvas.captureStream(30);

  // Stop the draw loop the moment the track stops, whoever stops it, so the
  // mock never leaks a live setInterval past the end of its stream.
  const [track] = stream.getVideoTracks();
  const stopDrawing = () => clearInterval(intervalId);
  track?.addEventListener('ended', stopDrawing);
  const originalStop = track?.stop.bind(track);
  if (track && originalStop) {
    track.stop = () => {
      stopDrawing();
      originalStop();
    };
  }

  return stream;
}

/**
 * Request screen capture permission and start MediaStream
 * @returns {Promise<MediaStream>}
 * @throws {Error} If permission denied or not supported
 */
export async function startScreenCapture() {
  if (isTestMode() && getTestConfig().mockStream) {
    return createMockScreenStream();
  }

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

/** How long to wait for stream metadata before giving up */
const VIDEO_READY_TIMEOUT_MS = 10000;

/**
 * Create a video element for the given stream
 *
 * Rejects after a timeout if the stream never becomes ready — otherwise a
 * stream that fires neither loadedmetadata nor error would leave the caller
 * (and the capture UI's "Selecting..." state) hanging forever.
 *
 * @param {MediaStream} stream
 * @param {number} [timeoutMs=VIDEO_READY_TIMEOUT_MS]
 * @returns {Promise<HTMLVideoElement>}
 */
export async function createVideoElement(stream, timeoutMs = VIDEO_READY_TIMEOUT_MS) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  // Wait for video to be ready
  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.srcObject = null;
      reject(new Error(`Video stream not ready after ${timeoutMs}ms`));
    }, timeoutMs);

    video.onloadedmetadata = () => {
      video
        .play()
        .then(() => {
          clearTimeout(timeoutId);
          resolve(undefined);
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
    };
    video.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error('Failed to load video stream'));
    };
  });

  return video;
}

/**
 * Cleanup screen capture resources
 * This function handles all side effects for screen capture cleanup
 * @param {Partial<import('../../shared/app-store.js').ScreenCaptureState>|null} captureState
 * @param {Object} [options]
 * @param {boolean} [options.stopStream=true] - If true, stop the MediaStream
 * @returns {Promise<void>}
 */
export async function cleanupScreenCaptureResources(captureState, options = {}) {
  if (!captureState) return;

  const { stopStream = true } = options;

  // Stop MediaStream tracks
  if (stopStream && captureState.stream) {
    captureState.stream.getTracks().forEach((track) => {
      track.stop();
    });
  }

  // Cleanup worker with proper resource release (fixes memory leak)
  if (captureState.workerManager) {
    await captureState.workerManager.terminateWithCleanup();
  }

  // Cleanup video element
  if (captureState.videoElement) {
    captureState.videoElement.pause();
    captureState.videoElement.srcObject = null;
  }
}
