/**
 * Capture Feature Entry Point
 * @module features/capture
 */

import { emit } from '../../shared/bus.js';
import { setClipPayload } from '../../shared/app-store.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import {
  createCaptureStore,
  startCapture,
  stopCapture,
  addFrameToState,
  updateSettings,
  setError,
} from './state.js';
import { getFrames, clearBuffer } from './core.js';
import {
  startScreenCapture,
  stopScreenCapture,
  createVideoElement,
  createFrameProcessor,
} from './api.js';
import { renderCaptureScreen, updateBufferStatus } from './ui.js';

/** @type {ReturnType<typeof createCaptureStore> | null} */
let store = null;

/** @type {AbortController | null} */
let captureAbortController = null;

/** @type {HTMLVideoElement | null} */
let videoElement = null;

/** @type {ReadableStreamDefaultReader<VideoFrame> | null} */
let frameReader = null;

/** @type {(() => void) | null} */
let uiCleanup = null;

/** @type {number} */
let consecutiveFrameErrors = 0;

/** @type {number} */
let errorBatchCount = 0;

/** @type {(() => void) | null} */
let streamEndedCleanup = null;

/** @type {MediaStreamTrack | null} */
let captureTrack = null;

/** Maximum consecutive frame errors before emitting warning */
const MAX_CONSECUTIVE_FRAME_ERRORS = 5;

/**
 * Initialize capture feature
 * @param {Partial<import('./types.js').CaptureSettings>} [settings]
 */
export function initCapture(settings) {
  const container = qsRequired('#main-content');

  // Register test hooks
  registerTestHooks();

  // Create store
  store = createCaptureStore(settings);

  // Initial render
  render(container);

  // Subscribe to state changes
  store.subscribe(
    throttle(() => {
      const state = store.getState();
      // Update buffer status without full re-render
      updateBufferStatus(container, state.stats);
    }, 100)
  );

  return cleanup;
}

/**
 * Full render of capture screen
 * @param {HTMLElement} container
 */
function render(container) {
  if (!store) return;

  // Cleanup previous UI
  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  const state = store.getState();

  uiCleanup = renderCaptureScreen(container, state, {
    onStart: handleStart,
    onStop: handleStop,
    onCreateClip: handleCreateClip,
    onSettingsChange: handleSettingsChange,
  });
}

/**
 * Start VideoFrame capture loop using ReadableStream
 * @param {MediaStreamTrack} track - Video track from MediaStream
 * @param {number} fps - Target frames per second
 * @param {AbortSignal} signal - Abort signal for cleanup
 */
async function startCaptureLoop(track, fps, signal) {
  if (!store) return;

  console.debug('[Capture] Starting capture loop', {
    fps,
    trackId: track.id,
    trackState: track.readyState,
  });

  let reader;
  try {
    reader = createFrameProcessor(track);
  } catch (err) {
    console.error('[Capture] Failed to create frame processor:', err);
    emit('capture:error', {
      error: err instanceof Error ? err.message : 'Failed to initialize capture',
    });
    return;
  }

  frameReader = reader;
  const frameInterval = 1000 / fps;
  let lastFrameTime = 0;
  let totalFramesRead = 0;
  let framesAddedToBuffer = 0;

  try {
    while (!signal.aborted && store.getState().isCapturing) {
      // Wrap reader.read() in try-catch to catch stream errors
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        console.error('[Capture] reader.read() threw:', readErr);
        emit('capture:error', {
          error: 'Frame reader failed: ' + (readErr instanceof Error ? readErr.message : 'Unknown'),
        });
        break;
      }

      const { done, value: videoFrame } = readResult;

      if (done) {
        console.debug('[Capture] Stream ended (done=true)', {
          totalFramesRead,
          framesAddedToBuffer,
        });
        break;
      }

      if (signal.aborted) {
        console.debug('[Capture] Signal aborted');
        videoFrame.close();
        break;
      }

      totalFramesRead++;
      const now = performance.now();

      // Frame rate limiting
      if (now - lastFrameTime >= frameInterval) {
        try {
          // Clone VideoFrame for buffer storage
          const frame = {
            id: crypto.randomUUID(),
            frame: videoFrame.clone(),
            timestamp: videoFrame.timestamp,
            width: videoFrame.codedWidth,
            height: videoFrame.codedHeight,
          };

          store.setState((state) => addFrameToState(state, frame));
          lastFrameTime = now;
          framesAddedToBuffer++;

          // Reset error counter on successful frame
          consecutiveFrameErrors = 0;

          const currentState = store.getState();
          emit('capture:frame', { frame, stats: currentState.stats });
        } catch (err) {
          // Handle GPU memory exhaustion (QuotaExceededError)
          if (
            err instanceof DOMException &&
            (err.name === 'QuotaExceededError' || err.message.includes('resource'))
          ) {
            console.error('[Capture] GPU memory exhaustion:', err);
            emit('capture:resource-error', {
              message: 'GPU memory limit reached. Stopping capture to preserve frames.',
            });
            videoFrame.close();
            break;
          }

          consecutiveFrameErrors++;
          console.error('[Capture] Frame processing error:', err);

          if (consecutiveFrameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
            errorBatchCount++;
            emit('capture:frame-errors', {
              count: consecutiveFrameErrors,
              batchNumber: errorBatchCount,
              message: 'Multiple frame capture failures detected.',
              lastError: err instanceof Error ? err.message : 'Unknown error',
            });
            consecutiveFrameErrors = 0;
          }
        }
      }

      // Always close original VideoFrame to prevent backpressure
      videoFrame.close();
    }
  } finally {
    console.debug('[Capture] Loop cleanup', {
      totalFramesRead,
      framesAddedToBuffer,
      isCapturing: store?.getState()?.isCapturing,
      signalAborted: signal.aborted,
    });
    try {
      reader.releaseLock();
    } catch {
      // Ignore if already released
    }
    frameReader = null;
  }
}

/**
 * Handle start capture
 */
async function handleStart() {
  if (!store) return;

  try {
    const stream = await startScreenCapture();

    // Get original video track
    const originalTrack = stream.getVideoTracks()[0];

    // Use original track directly for MediaStreamTrackProcessor
    // Note: Cloned tracks don't work with MediaStreamTrackProcessor in some browsers
    captureTrack = originalTrack;
    console.log('[Capture] Using original track for processor', {
      trackId: captureTrack.id,
      trackState: captureTrack.readyState,
    });

    // Create video element for stream (needed for preview) - uses original stream
    videoElement = await createVideoElement(stream);

    // Listen for stream end on original track with cleanup tracking
    const handleStreamEnded = () => {
      // Also stop the cloned track when original ends
      if (captureTrack) {
        captureTrack.stop();
      }
      handleStop();
      emit('capture:stopped', {});
    };
    originalTrack.addEventListener('ended', handleStreamEnded);
    streamEndedCleanup = () => originalTrack.removeEventListener('ended', handleStreamEnded);

    // Update state
    store.setState((state) => startCapture(state, stream));
    emit('capture:started', { stream });

    // Start capture loop with abort controller using CLONED track
    captureAbortController = new AbortController();
    const fps = store.getState().settings.fps;

    // Start async capture loop (non-blocking) with cloned track
    startCaptureLoop(captureTrack, fps, captureAbortController.signal).catch((err) => {
      console.error('Capture loop error:', err);
      emit('capture:error', { error: err instanceof Error ? err.message : 'Capture loop failed' });
    });

    // Re-render with video preview
    const container = qsRequired('#main-content');
    render(container);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start capture';
    store.setState((state) => setError(state, message));
    emit('capture:error', { error: message });

    // Clean up cloned track on error
    if (captureTrack) {
      captureTrack.stop();
      captureTrack = null;
    }

    // Re-render to show error
    const container = qsRequired('#main-content');
    render(container);
    throw err;
  }
}

/**
 * Handle stop capture
 * @param {boolean} [preserveBuffer=true] - If true, keep frames in buffer for clip creation
 */
function handleStop(preserveBuffer = true) {
  if (!store) return;

  console.debug('[Capture] Stopping capture');

  // Abort capture loop
  if (captureAbortController) {
    captureAbortController.abort();
    captureAbortController = null;
  }

  // Remove stream event listener before stopping stream
  if (streamEndedCleanup) {
    streamEndedCleanup();
    streamEndedCleanup = null;
  }

  // Stop cloned capture track
  if (captureTrack) {
    captureTrack.stop();
    captureTrack = null;
  }

  // Stop original stream (stops all tracks including original video track)
  const state = store.getState();
  if (state.stream) {
    stopScreenCapture(state.stream);
  }

  // Cleanup elements
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement = null;
  }

  // Update state - optionally clear buffer to release VideoFrame resources
  store.setState((currentState) => {
    const stopped = stopCapture(currentState);
    if (!preserveBuffer) {
      return {
        ...stopped,
        buffer: clearBuffer(stopped.buffer),
      };
    }
    return stopped;
  });
  emit('capture:stopped', {});

  // Re-render
  const container = qsRequired('#main-content');
  render(container);
}

/**
 * Clear all VideoFrame resources from buffer
 * Call this after clip creation or when discarding captured frames
 */
export function clearCaptureBuffer() {
  if (!store) return;

  store.setState((state) => ({
    ...state,
    buffer: clearBuffer(state.buffer),
  }));
}

/**
 * Handle create clip
 */
function handleCreateClip() {
  if (!store) return;

  const state = store.getState();
  const frames = getFrames(state.buffer);

  // Store clip payload for editor via app store
  setClipPayload({
    frames,
    fps: state.settings.fps,
    capturedAt: Date.now(),
  });

  emit('capture:clip-created', {
    frameCount: frames.length,
    fps: state.settings.fps,
  });
}

/**
 * Handle settings change
 * @param {Partial<import('./types.js').CaptureSettings>} newSettings
 */
function handleSettingsChange(newSettings) {
  if (!store) return;

  store.setState((state) => updateSettings(state, newSettings));
  emit('capture:settings', { settings: store.getState().settings });
}

/**
 * Cleanup capture feature
 */
function cleanup() {
  // Stop capture and clear buffer to release all VideoFrame resources
  handleStop(false);

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  consecutiveFrameErrors = 0;
  errorBatchCount = 0;
  store = null;
}

/**
 * Get current capture state (for external access)
 * @returns {import('./types.js').CaptureState | null}
 */
export function getCaptureState() {
  return store?.getState() ?? null;
}

/**
 * Get captured frames
 * @returns {import('./types.js').Frame[]}
 */
export function getCapturedFrames() {
  if (!store) return [];
  return getFrames(store.getState().buffer);
}

// ============================================================
// Test Hooks (only available in Playwright test environment)
// ============================================================

/**
 * Register test hooks for capture feature
 * Called during feature initialization to ensure __TEST_HOOKS__ exists
 */
function registerTestHooks() {
  if (typeof window !== 'undefined' && window.__TEST_HOOKS__) {
    window.__TEST_HOOKS__.setCaptureState = (stateOverrides) => {
      if (!store) return;
      store.setState((currentState) => ({
        ...currentState,
        ...stateOverrides,
      }));
    };
  }
}
