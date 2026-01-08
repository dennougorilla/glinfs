/**
 * Capture Feature Entry Point
 * @module features/capture
 */

import { emit } from '../../shared/bus.js';
import {
  setClipPayload,
  getClipPayload,
  clearClipPayload,
  getEditorPayload,
  clearEditorPayload,
  clearExportResult,
} from '../../shared/app-store.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import {
  createCaptureStore,
  initCaptureState,
  startCapture,
  stopCapture,
  pauseCapture as pauseCaptureState,
  resumeCapture as resumeCaptureState,
  addFrameToState,
  updateSettings,
  setError,
} from './state.js';
import { getFrames, clearBuffer, closeAllFrames } from './core.js';
import { register, acquire, release, releaseAll } from '../../shared/videoframe-pool.js';
import {
  startScreenCapture,
  stopScreenCapture,
  createVideoElement,
  createVideoFrameFromElement,
} from './api.js';
import { renderCaptureScreen, updateBufferStatus } from './ui.js';

/** @type {ReturnType<typeof createCaptureStore> | null} */
let store = null;

/** @type {AbortController | null} */
let captureAbortController = null;

/** @type {HTMLVideoElement | null} */
let videoElement = null;

/** @type {number | null} */
let captureIntervalId = null;

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

/** @type {ReturnType<typeof throttle> | null} */
let throttledUpdate = null;

/** Maximum consecutive frame errors before emitting warning */
const MAX_CONSECUTIVE_FRAME_ERRORS = 5;

/** @type {import('./types.js').CaptureState | null} */
let pausedCaptureState = null;

/** @type {boolean} */
let isPausedForEditor = false;

/**
 * Initialize capture feature
 * @param {Partial<import('./types.js').CaptureSettings>} [settings]
 */
export function initCapture(settings) {
  const container = qsRequired('#main-content');

  // Register test hooks
  registerTestHooks();

  // Check if we're resuming from a paused state (returning from Editor)
  if (isPausedForEditor && pausedCaptureState) {
    // Resume from paused state
    store = createCaptureStore(pausedCaptureState.settings);
    // Restore the paused state
    store.setState(() => pausedCaptureState);

    // Initial render (will show paused state with existing buffer)
    render(container);

    // Subscribe to state changes
    throttledUpdate = throttle(() => {
      if (!store) return;
      const state = store.getState();
      updateBufferStatus(container, state.stats);
    }, 100);
    store.subscribe(throttledUpdate);

    // Resume capture loop if we have video element
    if (videoElement && store.getState().stream) {
      const fps = store.getState().settings.fps;
      captureAbortController = new AbortController();
      store.setState((state) => resumeCaptureState(state));
      startCaptureLoop(videoElement, fps, captureAbortController.signal);
      emit('capture:resumed', {});

      // Re-render to show capturing state
      render(container);
    }

    // Clear paused state
    isPausedForEditor = false;
    pausedCaptureState = null;

    return cleanup;
  }

  // Normal initialization (fresh start)
  store = createCaptureStore(settings);

  // Initial render
  render(container);

  // Subscribe to state changes with cancellable throttle
  throttledUpdate = throttle(() => {
    if (!store) return; // Guard against cleanup race condition
    const state = store.getState();
    // Update buffer status without full re-render
    updateBufferStatus(container, state.stats);
  }, 100);

  store.subscribe(throttledUpdate);

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
 * Start VideoFrame capture loop using setInterval
 * Creates VideoFrames from video element at specified FPS
 * Works reliably even with static screen content
 * @param {HTMLVideoElement} video - Video element with active stream
 * @param {number} fps - Target frames per second
 * @param {AbortSignal} signal - Abort signal for cleanup
 */
function startCaptureLoop(video, fps, signal) {
  if (!store) return;

  const frameInterval = 1000 / fps;
  let framesAddedToBuffer = 0;

  // Capture function called by setInterval
  const captureFrame = () => {
    if (!store || signal.aborted || !store.getState().isCapturing) {
      stopCaptureInterval();
      return;
    }

    const videoFrame = createVideoFrameFromElement(video);
    if (!videoFrame) {
      return;
    }

    try {
      const frameId = crypto.randomUUID();
      const frame = {
        id: frameId,
        frame: videoFrame,
        timestamp: videoFrame.timestamp,
        width: videoFrame.codedWidth,
        height: videoFrame.codedHeight,
      };

      // Register frame in pool with 'capture' as owner
      register(frameId, videoFrame, 'capture');

      // Release evicted frame before adding new one (if buffer is full)
      // This must happen before addFrameToState since core.js is now pure
      const currentState = store.getState();
      if (currentState.buffer.size >= currentState.buffer.maxFrames) {
        const evictedFrame = currentState.buffer.frames[currentState.buffer.head];
        if (evictedFrame) {
          release(evictedFrame.id, 'capture');
        }
      }

      store.setState((state) => addFrameToState(state, frame));
      framesAddedToBuffer++;

      // Reset error counter on successful frame
      consecutiveFrameErrors = 0;

      const updatedState = store.getState();
      emit('capture:frame', { frame, stats: updatedState.stats });
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
        stopCaptureInterval();
        return;
      }

      consecutiveFrameErrors++;
      console.error('[Capture] Frame processing error:', err);
      videoFrame.close();

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
  };

  // Helper to stop interval
  const stopCaptureInterval = () => {
    if (captureIntervalId !== null) {
      clearInterval(captureIntervalId);
      captureIntervalId = null;
    }
  };

  // Listen for abort signal
  signal.addEventListener('abort', stopCaptureInterval);

  // Start capture interval
  captureIntervalId = setInterval(captureFrame, frameInterval);

  // Capture first frame immediately
  captureFrame();
}

/**
 * Handle start capture
 */
async function handleStart() {
  if (!store) return;

  try {
    const stream = await startScreenCapture();

    // Get video track for event handling
    const videoTrack = stream.getVideoTracks()[0];
    captureTrack = videoTrack;

    // Create video element for capture and preview
    videoElement = await createVideoElement(stream);

    // Listen for stream end
    const handleStreamEnded = () => {
      // If paused for editor, clean up paused state since stream is gone
      if (isPausedForEditor) {
        // Release all capture-owned frames to prevent memory leak
        releaseAll('capture');
        pausedCaptureState = null;
        isPausedForEditor = false;
        if (videoElement) {
          videoElement.pause();
          videoElement.srcObject = null;
          videoElement = null;
        }
        captureTrack = null;
        streamEndedCleanup = null;
        emit('capture:stopped', {});
        return;
      }

      handleStop();
      emit('capture:stopped', {});
    };
    videoTrack.addEventListener('ended', handleStreamEnded);
    streamEndedCleanup = () => videoTrack.removeEventListener('ended', handleStreamEnded);

    // Update state
    store.setState((state) => startCapture(state, stream));
    emit('capture:started', { stream });

    // Start capture loop with abort controller using video element
    captureAbortController = new AbortController();
    const fps = store.getState().settings.fps;

    // Start capture loop (uses setInterval internally)
    startCaptureLoop(videoElement, fps, captureAbortController.signal);

    // Re-render with video preview
    const container = qsRequired('#main-content');
    render(container);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start capture';
    store.setState((state) => setError(state, message));
    emit('capture:error', { error: message });

    // Clean up on error
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

  // Stop capture interval
  if (captureIntervalId !== null) {
    clearInterval(captureIntervalId);
    captureIntervalId = null;
  }

  // Abort capture loop (triggers cleanup via signal)
  if (captureAbortController) {
    captureAbortController.abort();
    captureAbortController = null;
  }

  // Remove stream event listener before stopping stream
  if (streamEndedCleanup) {
    streamEndedCleanup();
    streamEndedCleanup = null;
  }

  // Stop capture track
  if (captureTrack) {
    captureTrack.stop();
    captureTrack = null;
  }

  // Stop stream (stops all tracks)
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
  // Release frames via pool BEFORE clearing buffer (since clearBuffer is now pure)
  if (!preserveBuffer) {
    releaseAll('capture');
  }
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
 *
 * OWNERSHIP MODEL (VideoFramePool):
 * - Adds 'editor' as owner to frames via acquire() - NO cloning needed
 * - Capture retains 'capture' ownership (frames stay in buffer)
 * - Editor releases ownership on cleanup via releaseAll('editor')
 * - Frames are only closed when all owners have released
 *
 * @see tests/unit/shared/videoframe-ownership.test.js for ownership contract
 */
function handleCreateClip() {
  if (!store) return;

  // Clear old payloads before creating new clip
  // Release 'editor' ownership for old payload frames (if any)
  const oldClipPayload = getClipPayload();
  if (oldClipPayload?.frames?.length) {
    releaseAll('editor');
    clearClipPayload();
  }

  const oldEditorPayload = getEditorPayload();
  if (oldEditorPayload?.frames?.length) {
    releaseAll('export');
    clearEditorPayload();
  }

  clearExportResult();

  const state = store.getState();
  const frames = getFrames(state.buffer);

  // Add 'editor' as owner to each frame - NO cloning needed
  // Frames now have owners: ['capture', 'editor']
  frames.forEach((frame) => {
    acquire(frame.id, 'editor');
  });

  // Store clip payload for editor via app store
  // Pass the same frame references (not clones)
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

  // If fps or bufferDuration changed, release current frames before clearing buffer
  // This is needed because updateSettings calls clearBuffer which is now a pure function
  if (newSettings.fps !== undefined || newSettings.bufferDuration !== undefined) {
    releaseAll('capture');
  }

  store.setState((state) => updateSettings(state, newSettings));
  emit('capture:settings', { settings: store.getState().settings });
}

/**
 * Pause capture (preserves stream and buffer for resume)
 * Called when navigating to Editor to allow resuming on return
 */
function handlePause() {
  if (!store) return;

  // Stop capture interval
  if (captureIntervalId !== null) {
    clearInterval(captureIntervalId);
    captureIntervalId = null;
  }

  // Abort capture loop
  if (captureAbortController) {
    captureAbortController.abort();
    captureAbortController = null;
  }

  // Update state to paused (keep stream and buffer)
  store.setState((state) => pauseCaptureState(state));

  // Store state for resume
  pausedCaptureState = store.getState();
  isPausedForEditor = true;

  emit('capture:paused', {});
}

/**
 * Cleanup capture feature
 * @param {import('../../shared/router.js').Route} [targetRoute] - Route we're navigating to
 */
function cleanup(targetRoute) {
  // If navigating to Editor, pause instead of full cleanup
  if (targetRoute === '/editor' && store?.getState()?.isCapturing) {
    handlePause();

    // Cleanup UI only (keep capture resources)
    if (throttledUpdate) {
      throttledUpdate.cancel();
      throttledUpdate = null;
    }

    if (uiCleanup) {
      uiCleanup();
      uiCleanup = null;
    }

    consecutiveFrameErrors = 0;
    errorBatchCount = 0;
    store = null;
    return;
  }

  // Full cleanup for other routes or when not capturing
  // Cancel pending throttled updates before store = null
  if (throttledUpdate) {
    throttledUpdate.cancel();
    throttledUpdate = null;
  }

  // Stop capture and clear buffer to release all VideoFrame resources
  handleStop(false);

  // Clear paused state on full cleanup
  pausedCaptureState = null;
  isPausedForEditor = false;

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
