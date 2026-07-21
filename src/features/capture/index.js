/**
 * Capture Feature Entry Point
 * @module features/capture
 */

import {
  clearScreenCaptureState,
  getScreenCaptureState,
  hasActiveScreenCapture,
  setClipPayload,
  setScreenCaptureState,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { updateSetting } from '../../shared/user-settings.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import { CaptureWorkerManager } from '../../workers/capture-worker-manager.js';
import { createVideoElement, startScreenCapture, stopScreenCapture } from './api.js';
import { calculateMaxFrames } from './core.js';
import {
  createCaptureStore,
  pauseCapture,
  resumeCapture,
  setError,
  startCapture,
  stopCapture,
  updateSettings,
} from './state.js';
import { renderCaptureScreen, updateBufferStatus, updateSceneDetectionToggle } from './ui.js';

/** @type {ReturnType<typeof createCaptureStore> | null} */
let store = null;

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

/** @type {(() => void) | null} */
let storeUnsubscribe = null;

/**
 * Initialize capture feature
 * @param {Partial<import('./types.js').CaptureSettings>} [settings]
 */
export function initCapture(settings) {
  const container = qsRequired('#main-content');

  // Register test hooks
  registerTestHooks();

  // Check if we have a preserved screen capture to restore
  const savedCapture = getScreenCaptureState();
  const canRestore = savedCapture && hasActiveScreenCapture();

  if (canRestore) {
    // Restore from saved capture state
    store = savedCapture.store;
    videoElement = savedCapture.videoElement;
    captureTrack = savedCapture.captureTrack;
    workerManager = savedCapture.workerManager;

    // Re-attach stream ended listener
    if (captureTrack) {
      const handleStreamEnded = () => {
        handleStop();
        clearScreenCaptureState(false); // Stream already ended
        emit('capture:stopped', {});
      };
      captureTrack.addEventListener('ended', handleStreamEnded);
      streamEndedCleanup = () => captureTrack.removeEventListener('ended', handleStreamEnded);
    }

    // Restart worker capture if we have a worker manager
    if (workerManager && store) {
      const state = store.getState();
      const maxFrames = calculateMaxFrames(state.settings);
      workerManager.start(state.settings.fps, maxFrames);
      // Keep the store's flags aligned with the worker loop actually running
      store.setState(resumeCapture);
    }

    emit('capture:restored', { fromNavigation: true });
  } else {
    // Create fresh store (no saved capture or stream ended)
    if (savedCapture) {
      // Clean up invalid saved state
      clearScreenCaptureState();
    }
    store = createCaptureStore(settings);
  }

  // Initial render
  render(container);

  // Subscribe to state changes with cancellable throttle
  throttledUpdate = throttle(() => {
    if (!store) return; // Guard against cleanup race condition
    const state = store.getState();
    // Update buffer status without full re-render
    updateBufferStatus(container, state.stats);
  }, 100);

  storeUnsubscribe = store.subscribe(throttledUpdate);

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

  // Terminate any previous worker before creating a new one.
  // Without this, re-selecting a screen after "Stop sharing" orphans the old
  // worker together with its full frame buffer (up to maxFrames ImageBitmaps),
  // because dedicated workers are not garbage collected (#40).
  if (workerManager) {
    await workerManager.terminateWithCleanup();
    workerManager = null;
  }

  // Clear any existing saved capture state when starting fresh, and wait
  // for the previous session's async teardown (track stop, worker
  // termination) to finish so the new pipeline can't race the old one
  await clearScreenCaptureState();

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
      clearScreenCaptureState(false); // Stream already ended
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
            fps: stats.fps,
          },
        }));
      },
    });

    // Start worker capture
    const fps = store.getState().settings.fps;
    const maxFrames = calculateMaxFrames(store.getState().settings);
    workerManager.start(fps, maxFrames);

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

  // Re-render
  const container = qsRequired('#main-content');
  render(container);
}

/**
 * Convert transferred ImageBitmap frames into VideoFrames for the Editor.
 *
 * Closes every source ImageBitmap regardless of outcome: a VideoFrame copies
 * the pixel data at construction time, so keeping the bitmap alive after a
 * successful conversion only defers release to nondeterministic GC (#40).
 *
 * @param {import('../../workers/capture-worker-manager.js').TransferredFrame[]} imageBitmapFrames
 * @returns {import('./types.js').Frame[]}
 */
export function convertBitmapFramesToVideoFrames(imageBitmapFrames) {
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

    // VideoFrame owns its own copy of the pixel data; release the source
    // bitmap immediately instead of leaving it to GC (success path leak, #40)
    item.bitmap.close();

    // Validate VideoFrame
    if (videoFrame.closed || videoFrame.codedWidth === 0 || videoFrame.codedHeight === 0) {
      videoFrame.close();
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

  return videoFrames;
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
 * @returns {Promise<boolean>} true if a clip payload was stored — the UI
 *   must not navigate to Editor/Loading when no clip was produced
 */
async function handleCreateClip() {
  if (!store || !workerManager) return false;

  // Request frames from worker (transfers ImageBitmap ownership to main thread)
  const imageBitmapFrames = await workerManager.requestFrames();

  if (imageBitmapFrames.length === 0) {
    return false;
  }

  // Convert ImageBitmaps to VideoFrames for Editor
  const videoFrames = convertBitmapFramesToVideoFrames(imageBitmapFrames);

  if (videoFrames.length === 0) {
    return false;
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

  return true;
}

/**
 * Handle settings change
 * @param {Partial<import('./types.js').CaptureSettings>} newSettings
 */
function handleSettingsChange(newSettings) {
  if (!store) return;

  store.setState((state) => updateSettings(state, newSettings));
  emit('capture:settings', { settings: store.getState().settings });

  // Save settings to localStorage
  Object.entries(newSettings).forEach(([key, value]) => {
    if (key !== 'thumbnailQuality') {
      // thumbnailQuality managed separately
      updateSetting('capture', key, value);
    }
  });

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
 * - Preserves screen capture state for restoration on return
 */
function cleanup() {
  // Cancel pending throttled updates before store = null
  if (throttledUpdate) {
    throttledUpdate.cancel();
    throttledUpdate = null;
  }

  // Unsubscribe from store to prevent listener leak
  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }

  // Check if we have an active capture to preserve
  const state = store?.getState();
  const hasActiveCapture = state?.isSharing && state?.stream && captureTrack?.readyState === 'live';

  if (hasActiveCapture) {
    // Preserve screen capture state for restoration
    // Stop the worker capture loop but keep the stream alive
    if (workerManager) {
      workerManager.stop();
    }

    // Record that the worker loop is paused so isCapturing/isPaused stay
    // truthful for anyone reading the stashed store during navigation
    store.setState(pauseCapture);

    // Remove stream ended listener (will be re-attached on restore)
    if (streamEndedCleanup) {
      streamEndedCleanup();
      streamEndedCleanup = null;
    }

    // Store capture state for later restoration
    setScreenCaptureState({
      stream: state.stream,
      videoElement: videoElement,
      captureTrack: captureTrack,
      store: store,
      workerManager: workerManager,
      settings: state.settings,
    });

    // Don't null out these references - they're now owned by app-store
    videoElement = null;
    captureTrack = null;
    workerManager = null;
  } else {
    // No active capture - do full cleanup
    handleStop(false);

    // Terminate worker, letting it close its buffered ImageBitmaps first
    // (bare terminate() skips the CLEAR handshake and leaks them to GC).
    // Fire-and-forget: the router expects cleanup() to be synchronous.
    if (workerManager) {
      const manager = workerManager;
      workerManager = null;
      manager.terminateWithCleanup().catch(() => manager.terminate());
    }
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
