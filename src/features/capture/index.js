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
  updateSettings,
  setError,
} from './state.js';
import { calculateMaxFrames } from './core.js';
import {
  startScreenCapture,
  stopScreenCapture,
  createVideoElement,
} from './api.js';
import { renderCaptureScreen, updateBufferStatus, updateSceneDetectionToggle } from './ui.js';
import { CaptureWorkerManager } from '../../workers/capture-worker-manager.js';

/** @type {ReturnType<typeof createCaptureStore> | null} */
let store = null;

/** @type {AbortController | null} */
let captureAbortController = null;

/** @type {HTMLVideoElement | null} */
let videoElement = null;

/** @type {(() => void) | null} */
let uiCleanup = null;

/** @type {(() => void) | null} */
let streamEndedCleanup = null;

/** @type {MediaStreamTrack | null} */
let captureTrack = null;

/** @type {CaptureWorkerManager | null} */
let workerManager = null;

/** @type {ReturnType<typeof throttle> | null} */
let throttledUpdate = null;

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
    getSettings: () => store?.getState()?.settings ?? null,
  });
}

// Note: Frame capture timing is now handled by CaptureWorkerManager
// Worker setInterval is NOT throttled in background tabs

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
      handleStop();
      emit('capture:stopped', {});
    };
    videoTrack.addEventListener('ended', handleStreamEnded);
    streamEndedCleanup = () => videoTrack.removeEventListener('ended', handleStreamEnded);

    // Update state
    store.setState((state) => startCapture(state, stream));
    emit('capture:started', { stream });

    // Initialize worker manager with video element
    workerManager = new CaptureWorkerManager();
    workerManager.init(videoElement, {
      onStatsUpdate: (stats) => {
        if (!store) return;
        store.setState((state) => ({
          ...state,
          stats: {
            frameCount: stats.frameCount,
            duration: stats.frameCount / stats.fps,
            // Estimate memory: ImageBitmap uses ~width*height*4 bytes (RGBA)
            // Assume 1920x1080 average, divide by 10 for GPU-resident estimate
            memoryMB: (stats.frameCount * 1920 * 1080 * 4) / 10 / (1024 * 1024),
            fps: stats.fps,
          },
        }));
      },
    });

    // Start worker capture
    captureAbortController = new AbortController();
    const fps = store.getState().settings.fps;
    const maxFrames = calculateMaxFrames(store.getState().settings);
    workerManager.start(fps, maxFrames);

    console.log('[Capture] Started hybrid worker capture at', fps, 'fps, maxFrames:', maxFrames);

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
    if (workerManager) {
      workerManager.terminate();
      workerManager = null;
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

  // Abort capture
  if (captureAbortController) {
    captureAbortController.abort();
    captureAbortController = null;
  }

  // Stop worker capture (but preserve buffer for clip creation)
  if (workerManager) {
    workerManager.stop();
    if (!preserveBuffer) {
      workerManager.clear();
    }
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

  // Cleanup video element
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement = null;
  }

  // Update state
  store.setState((currentState) => stopCapture(currentState));
  emit('capture:stopped', {});

  console.log('[Capture] Stopped capture, preserveBuffer:', preserveBuffer);

  // Re-render
  const container = qsRequired('#main-content');
  render(container);
}

/**
 * Clear all frame resources from buffer
 * Call this after clip creation or when discarding captured frames
 */
export function clearCaptureBuffer() {
  if (workerManager) {
    workerManager.clear();
  }
  if (store) {
    store.setState((state) => ({
      ...state,
      stats: {
        frameCount: 0,
        duration: 0,
        memoryMB: 0,
        fps: state.stats.fps,
      },
    }));
  }
}

/**
 * Handle create clip
 *
 * SIMPLIFIED MODEL:
 * - Gets ImageBitmaps from worker and converts to VideoFrames
 * - Stores frames in clipPayload (single source of truth)
 * - Old frames are closed automatically by setClipPayload
 * - No ownership tracking needed
 * - Scene detection runs in Loading screen (if enabled)
 *
 * @returns {Promise<void>}
 */
async function handleCreateClip() {
  if (!store || !workerManager) return;

  // Request frames from worker (transfers ImageBitmap ownership to main thread)
  const imageBitmapFrames = await workerManager.requestFrames();

  if (imageBitmapFrames.length === 0) {
    console.warn('[Capture] No frames to create clip');
    return;
  }

  // Convert ImageBitmaps to VideoFrames for Editor
  const videoFrames = [];

  for (const item of imageBitmapFrames) {
    // Validate ImageBitmap
    if (!item.bitmap || item.bitmap.width === 0 || item.bitmap.height === 0) {
      item.bitmap?.close();
      continue;
    }

    let videoFrame;
    try {
      videoFrame = new VideoFrame(item.bitmap, {
        timestamp: item.timestamp * 1000, // Convert ms to microseconds
      });
    } catch {
      item.bitmap.close();
      continue;
    }

    // Validate VideoFrame
    if (videoFrame.closed || videoFrame.codedWidth === 0 || videoFrame.codedHeight === 0) {
      videoFrame.close();
      item.bitmap.close();
      continue;
    }

    videoFrames.push({
      id: item.id,
      frame: videoFrame,
      timestamp: item.timestamp * 1000,
      width: videoFrame.codedWidth,
      height: videoFrame.codedHeight,
    });
  }

  if (videoFrames.length === 0) {
    console.error('[Capture] No valid frames could be created');
    return;
  }

  const settings = store.getState().settings;

  // Store clip payload (old frames closed automatically by setClipPayload)
  // Scene detection will run in Loading screen if sceneDetectionEnabled is true
  setClipPayload({
    frames: videoFrames,
    fps: settings.fps,
    capturedAt: Date.now(),
    sceneDetectionEnabled: settings.sceneDetection,
    // scenes not set here - Loading screen will compute them
  });

  emit('capture:clip-created', {
    frameCount: videoFrames.length,
    fps: settings.fps,
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

  const container = qsRequired('#main-content');

  // Only sceneDetection changed - do targeted update without re-render
  if (newSettings.sceneDetection !== undefined && Object.keys(newSettings).length === 1) {
    updateSceneDetectionToggle(container, store.getState().settings.sceneDetection);
    return;
  }

  // For other settings (fps, bufferDuration), full re-render is required
  render(container);
}

/**
 * Cleanup capture feature
 *
 * SIMPLIFIED MODEL:
 * - Does NOT close frames (they live in clipPayload)
 * - Frames are only closed when a new clip is created
 */
function cleanup() {
  // Cancel pending throttled updates before store = null
  if (throttledUpdate) {
    throttledUpdate.cancel();
    throttledUpdate = null;
  }

  // Stop capture and clear worker buffer
  handleStop(false);

  // Terminate worker
  if (workerManager) {
    workerManager.terminate();
    workerManager = null;
  }

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

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
 * Get captured frames count
 * Note: Frames are stored in worker, use handleCreateClip to get actual frames
 * @returns {number}
 */
export function getCapturedFramesCount() {
  return store?.getState()?.stats?.frameCount ?? 0;
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
