/**
 * Capture Feature Entry Point
 * @module features/capture
 */

import {
  clearScreenCaptureState,
  getClipPayload,
  getClipQueueLimit,
  getScreenCaptureState,
  hasActiveScreenCapture,
  isClipQueueFull,
  setClipPayload,
  setScreenCaptureState,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { announce } from '../../shared/live-region.js';
import { loadSettings, updateSetting } from '../../shared/user-settings.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import { CaptureWorkerManager } from '../../workers/capture-worker-manager.js';
import { createVideoElement, startScreenCapture, stopScreenCapture } from './api.js';
// Circular with clip-service (it imports getLiveCaptureContext from here);
// safe because both sides only call the other's hoisted function declarations
// at event time, never during module evaluation.
import {
  announceMemoryBudget,
  buildMemoryBudgetMessage,
  projectClipMemory,
} from './clip-service.js';
import { calculateEffectiveMaxFrames } from './core.js';
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

    // Re-attach the stream-ended listener only if it isn't already attached.
    // cleanup() (below) leaves it attached across navigation, so this only
    // ever fires for saved state that predates that behavior.
    if (captureTrack && !streamEndedCleanup) {
      captureTrack.addEventListener('ended', handleStreamEnded);
      streamEndedCleanup = () => captureTrack.removeEventListener('ended', handleStreamEnded);
    }

    // Adopt any Scene Detection change made elsewhere (the Settings screen)
    // while this capture session was suspended. The restored store predates
    // that change, so without this the toggle would show — and "Create Clip"
    // would act on — a stale value, making the setting look broken whenever a
    // screen was already being shared.
    //
    // Only this flag is re-read: fps and bufferDuration configure the capture
    // worker that is about to be restarted below, so they must keep describing
    // the session that is actually running and take effect on the next one.
    if (store) {
      const persistedSceneDetection = loadSettings().capture.sceneDetection;
      if (store.getState().settings.sceneDetection !== persistedSceneDetection) {
        store.setState((state) =>
          updateSettings(state, { sceneDetection: persistedSceneDetection }),
        );
      }
    }

    // Restart worker capture only if it isn't already running. With
    // capture.backgroundCapture enabled, cleanup() never paused the worker
    // loop in the first place, so state.isCapturing is still true here -
    // calling start() again would be a redundant (if harmless) START message.
    if (workerManager && store && !store.getState().isCapturing) {
      const state = store.getState();
      const bufferLimit = calculateEffectiveMaxFrames(
        state.settings,
        workerManager.getEffectiveFrameDimensions(),
        loadSettings().capture.memoryBudgetMB,
      );
      store.setState((s) => ({ ...s, bufferLimit }));
      workerManager.start(state.settings.fps, bufferLimit.maxFrames);
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

    // Listen for stream end. This listener stays attached across navigation
    // (cleanup() below does not remove it) so a share stopped from the
    // browser UI is caught whether the user is on /capture or elsewhere -
    // see handleStreamEnded's own comment for how it behaves in each case.
    videoTrack.addEventListener('ended', handleStreamEnded);
    streamEndedCleanup = () => videoTrack.removeEventListener('ended', handleStreamEnded);

    // Update state
    store.setState((state) => startCapture(state, stream));

    // Initialize worker manager with video element.
    //
    // The stats callback closes over THIS session's store, not the module
    // variable: cleanup() nulls the module `store` on every navigation while
    // the preserved session (and its store, stashed in screenCaptureState)
    // lives on. With background capture the worker keeps posting stats while
    // the user is on another route — writing them through the module variable
    // silently dropped them all, freezing the PiP's buffer-fullness readout.
    const sessionStore = store;
    const memorySettings = loadSettings().capture;
    workerManager = new CaptureWorkerManager();
    workerManager.init(videoElement, {
      // Downscale at grab time (#96): Retina fullscreen frames are ~24 MB
      // each as raw RGBA; capping the long edge is the difference between a
      // ~10 GB and a ~2 GB ring buffer at default settings.
      maxEdge: memorySettings.captureResolutionLimit,
      onStatsUpdate: (stats) => {
        sessionStore.setState((state) => ({
          ...state,
          stats: {
            frameCount: stats.frameCount,
            duration: stats.frameCount / stats.fps,
            fps: stats.fps,
          },
        }));
      },
    });

    // Start worker capture with the budget-clamped buffer size, computed
    // from the dimensions frames are ACTUALLY captured at (post-limit)
    const fps = store.getState().settings.fps;
    const bufferLimit = calculateEffectiveMaxFrames(
      store.getState().settings,
      workerManager.getEffectiveFrameDimensions(),
      memorySettings.memoryBudgetMB,
    );
    store.setState((state) => ({ ...state, bufferLimit }));
    workerManager.start(fps, bufferLimit.maxFrames);

    // Emitted only after the worker exists: listeners (the header Clip Now
    // button) probe getLiveCaptureContext(), which is null until then
    emit('capture:started', { stream });

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
 * Route-independent handler for the capture track's "ended" event (i.e. the
 * user stopped sharing from the browser's own UI, not from ours).
 *
 * Registered once per capture session (in handleStart) and left attached
 * across navigation - cleanup() never removes it - so this fires whether the
 * user is on /capture or has navigated away:
 * - Mounted (`store` set): defers to handleStop() for the normal UI-aware
 *   teardown (updates the store, re-renders, keeps the buffer available).
 * - Backgrounded (`store` is null, module vars already handed to app-store
 *   by cleanup()): there's no UI to update, so this only releases the
 *   worker/video resources stashed there via clearScreenCaptureState(false).
 */
function handleStreamEnded() {
  if (store) {
    // handleStop() already updates the store, re-renders, and emits
    // 'capture:stopped' - don't duplicate that here.
    handleStop();
  } else {
    // Backgrounded: no UI to update. clearScreenCaptureState delegates the
    // actual teardown (worker termination, video element release) to the
    // cleanup function main.js registers at startup - see
    // registerScreenCaptureCleanup in main.js / cleanupScreenCaptureResources
    // in api.js. `false` = don't stop the stream again, it already ended.
    clearScreenCaptureState(false);
    emit('capture:stopped', {});
  }
  announce('Screen sharing ended');
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
 * Announce a queue-full refusal on every channel the UI listens to.
 * Nothing was destroyed — the store refused before touching any frames.
 */
function announceQueueFull() {
  emit('clip:queue-full', { limit: getClipQueueLimit() });
  announce('Clip queue full — delete a clip or raise the limit in Settings');
}

/**
 * Handle create clip
 *
 * QUEUE MODEL (#95):
 * - Gets ImageBitmaps from worker and converts to VideoFrames
 * - Stores frames in clipPayload (single source of truth); a previous
 *   active clip DEMOTES into the clip queue — setClipPayload never closes
 *   frames while a queue exists (see app-store ownership rules)
 * - A full queue REFUSES the demote, so this checks up front — before
 *   draining the worker's ring buffer for frames that would have nowhere
 *   to go
 * - Scene detection runs in Loading screen (if enabled)
 *
 * @returns {Promise<boolean>} true if a clip payload was stored — the UI
 *   must not navigate to Editor/Loading when no clip was produced
 */
async function handleCreateClip() {
  if (!store || !workerManager) return false;

  // A new active clip demotes the current one into the queue; refuse early
  // while the ring buffer is still intact instead of after draining it
  if (getClipPayload() && isClipQueueFull()) {
    announceQueueFull();
    return false;
  }

  // Same early-refusal for the memory budget (#96): materializing the
  // buffer as VideoFrames must not push held-frame memory past the budget.
  // The user sees the same visible surfaces as a queue-full refusal.
  const projection = projectClipMemory(getLiveCaptureContext());
  if (projection.over) {
    announceMemoryBudget(projection);
    if (store) {
      store.setState((state) => setError(state, buildMemoryBudgetMessage(projection)));
      render(qsRequired('#main-content'));
    }
    return false;
  }

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

  // Store clip payload; the previous active clip (if any) demotes into the
  // clip queue. Scene detection will run in Loading screen if enabled.
  const stored = setClipPayload({
    frames: videoFrames,
    fps: settings.fps,
    capturedAt: Date.now(),
    sceneDetectionEnabled: settings.sceneDetection,
    // scenes not set here - Loading screen will compute them
  });

  if (!stored.ok) {
    // Queue filled between the early check and here (e.g. a Clip Now racing
    // this handler). The refused frames never entered the store, so they are
    // still this function's to release — the store's ownership rules only
    // protect frames it owns.
    for (const frame of videoFrames) {
      try {
        if (!frame.frame.closed) frame.frame.close();
      } catch {
        // Already closed
      }
    }
    announceQueueFull();
    return false;
  }

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
    const { backgroundCapture } = loadSettings().capture;

    if (backgroundCapture) {
      // Leave the worker's frame-grab loop running on any route - only the
      // UI unmounts. isCapturing/isSharing stay true, which is what lets
      // the restore path above skip a redundant workerManager.start().
    } else {
      // Old pause-and-resume behavior: stop the worker capture loop but
      // keep the stream alive.
      if (workerManager) {
        workerManager.stop();
      }

      // Record that the worker loop is paused so isCapturing/isPaused stay
      // truthful for anyone reading the stashed store during navigation
      store.setState(pauseCapture);
    }

    // The stream-ended listener (attached in handleStart) is deliberately
    // left attached here regardless of backgroundCapture: it's what lets a
    // share stopped from the browser UI while navigated away be noticed at
    // all (see handleStreamEnded), whether or not the frame-grab loop
    // itself is still running.

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

/**
 * @typedef {Object} LiveCaptureContext
 * @property {CaptureWorkerManager} workerManager - Worker holding the live ring buffer
 * @property {15|30|60} fps - Capture FPS of the running session
 * @property {boolean} sceneDetection - Scene detection flag for clips made now
 */

/**
 * Resolve the live capture session regardless of where its resources
 * currently live: while /capture is mounted they are module-locals here;
 * on any other route cleanup() has stashed them in app-store. Clip Now
 * (clip-service) works "from anywhere" only because of this dual lookup —
 * hasActiveScreenCapture() alone is false while /capture is mounted.
 *
 * @returns {LiveCaptureContext | null} null when no live capture session exists
 */
export function getLiveCaptureContext() {
  // Mounted on /capture: resources are module-local, app-store has nothing
  if (store && workerManager && captureTrack?.readyState === 'live') {
    const state = store.getState();
    if (state.isSharing) {
      return {
        workerManager,
        fps: state.settings.fps,
        sceneDetection: state.settings.sceneDetection,
        stats: state.stats,
        stream: state.stream,
      };
    }
  }

  // Backgrounded: cleanup() handed everything to app-store
  const saved = getScreenCaptureState();
  if (saved?.workerManager && hasActiveScreenCapture()) {
    const settings = saved.store?.getState()?.settings ?? saved.settings;
    if (settings) {
      return {
        workerManager: saved.workerManager,
        fps: settings.fps,
        sceneDetection: settings.sceneDetection,
        stats: saved.store?.getState()?.stats ?? null,
        stream: saved.stream ?? null,
      };
    }
  }

  return null;
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
