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
  setClipPayload,
  setScreenCaptureState,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { announce } from '../../shared/live-region.js';
import { loadSettings, updateSetting } from '../../shared/user-settings.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import { CaptureWorkerManager } from '../../workers/capture-worker-manager.js';
import { formatImportBusyLabel } from '../import/core.js';
import { importFile, isImporting, reportImportBusy } from '../import/index.js';
import { createVideoElement, startScreenCapture, stopScreenCapture } from './api.js';
// Circular with clip-service (it imports getLiveCaptureContext from here);
// safe because both sides only call the other's hoisted function declarations
// at event time, never during module evaluation.
import {
  announceMemoryBudget,
  buildMemoryBudgetMessage,
  checkClipRoom,
  closeRefusedFrames,
  makeRoomForClip,
  projectClipMemory,
  queueSnapshot,
} from './clip-service.js';
import { calculateEffectiveMaxFrames } from './core.js';
import {
  createCaptureStore,
  pauseCapture,
  resumeCapture,
  setError,
  setImportError,
  startCapture,
  stopCapture,
  updateSettings,
} from './state.js';
import {
  renderCaptureScreen,
  updateBufferStatus,
  updateImportStatus,
  updateSceneDetectionToggle,
} from './ui.js';

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

/** Aborts the file import in progress when the screen unmounts */
/** @type {AbortController | null} */
let importController = null;

/** Busy label of the import in progress ("Opening name…"), survives re-renders */
/** @type {string | null} */
let importBusyLabel = null;

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
    // Update buffer status without full re-render (the limit changes while
    // sharing when the frame size does, B5)
    updateBufferStatus(container, state.stats, state.bufferLimit ?? null);
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
    onChangeSource: handleChangeSource,
    onCreateClip: handleCreateClip,
    onSettingsChange: handleSettingsChange,
    getSettings: () => store?.getState()?.settings ?? null,
    onImportFile: (file) => {
      void handleImportFile(file);
    },
    getImportStatus: () => importBusyLabel,
  });
}

/**
 * Open a GIF / image file (button, file input or drop) as the active clip.
 *
 * features/import owns decoding, refusals and frame cleanup, and navigates
 * to the editor on success. This handler only drives the Capture screen's
 * busy state and shows the refusal inline. Leaving the screen aborts the
 * decode (cleanup()), which closes every frame it created.
 *
 * @param {File} file
 * @returns {Promise<boolean>} true when the clip opened
 */
async function handleImportFile(file) {
  if (!store) return false;
  if (isImporting()) {
    // One import at a time. Refuse here, before this screen's busy state is
    // replaced, and tell the user why (toast + live region)
    reportImportBusy();
    return false;
  }

  const controller = new AbortController();
  importController = controller;
  importBusyLabel = formatImportBusyLabel(file.name);

  const container = qsRequired('#main-content');
  if (store.getState().error) {
    // Drop a stale error (e.g. the previous refused import) before retrying
    store.setState((state) => ({ ...state, error: null }));
    render(container);
  } else {
    updateImportStatus(container, importBusyLabel);
  }

  const result = await importFile(file, {
    signal: controller.signal,
    onProgress: (decoded, total) => {
      if (importController !== controller) return;
      importBusyLabel = formatImportBusyLabel(file.name, decoded, total);
      if (store) updateImportStatus(qsRequired('#main-content'), importBusyLabel);
    },
  });

  if (importController === controller) {
    importController = null;
    importBusyLabel = null;
  }
  // Success navigated to the editor; an abort means the screen is gone
  if (result.ok || !store || result.reason === 'aborted') return result.ok;

  const message = result.message ?? 'Could not open the file';
  // Not setError: a refused import must not mark a running capture stopped
  store.setState((state) => setImportError(state, message));
  render(qsRequired('#main-content'));
  return false;
}

// Note: Frame capture timing is now handled by CaptureWorkerManager
// Worker setInterval is NOT throttled in background tabs

/**
 * Handle start capture
 */
async function handleStart() {
  if (!store) return;

  // The screen this start belongs to. cleanup() nulls the module `store` when
  // the user navigates away (and initCapture creates a new one on return), so
  // after every await below a mismatch means this screen is gone: whatever
  // was acquired for it must be released here, because nothing else holds it
  // and the browser would keep sharing the screen until reload (#168).
  const sessionStore = store;

  // Terminate any previous worker before creating a new one.
  // Without this, re-selecting a screen after "Stop sharing" orphans the old
  // worker together with its full frame buffer (up to maxFrames ImageBitmaps),
  // because dedicated workers are not garbage collected (#40).
  if (workerManager) {
    const previousManager = workerManager;
    await previousManager.terminateWithCleanup();
    // Leaving the screen during this teardown hands the module state to
    // cleanup() and to whatever screen is mounted next: a start there may
    // already own `workerManager`, so this one must not touch it.
    if (store !== sessionStore) return;
    if (workerManager === previousManager) workerManager = null;
  }

  // Clear any existing saved capture state when starting fresh, and wait
  // for the previous session's async teardown (track stop, worker
  // termination) to finish so the new pipeline can't race the old one
  await clearScreenCaptureState();
  if (store !== sessionStore) return;

  /** @type {MediaStream | null} */
  let stream = null;
  /** @type {MediaStreamTrack | null} */
  let videoTrack = null;
  /** @type {HTMLVideoElement | null} */
  let video = null;

  try {
    stream = await startScreenCapture();
    if (store !== sessionStore) {
      stopScreenCapture(stream);
      return;
    }

    // Get video track for event handling
    videoTrack = stream.getVideoTracks()[0];
    captureTrack = videoTrack;

    // Create video element for capture and preview
    video = await createVideoElement(stream);
    if (store !== sessionStore) {
      releaseAbandonedStart(stream, videoTrack, video);
      return;
    }
    videoElement = video;

    // Listen for stream end. This listener stays attached across navigation
    // (cleanup() below does not remove it) so a share stopped from the
    // browser UI is caught whether the user is on /capture or elsewhere -
    // see handleStreamEnded's own comment for how it behaves in each case.
    videoTrack.addEventListener('ended', handleStreamEnded);
    streamEndedCleanup = () => videoTrack.removeEventListener('ended', handleStreamEnded);

    // Update state
    store.setState((state) => startCapture(state, stream));

    // Initialize worker manager with video element
    workerManager = new CaptureWorkerManager();
    startWorkerOn(workerManager, videoElement, sessionStore);

    // Emitted only after the worker exists: listeners (the header Clip Now
    // button) probe getLiveCaptureContext(), which is null until then
    emit('capture:started', { stream });

    // Re-render with video preview
    const container = qsRequired('#main-content');
    render(container);
  } catch (err) {
    if (store !== sessionStore) {
      // The picker was cancelled or the stream failed after the screen was
      // left: release what this start acquired, without touching the module
      // state (it may already belong to a newer screen) or the gone UI
      if (stream) releaseAbandonedStart(stream, videoTrack, video);
      return;
    }

    const message = err instanceof Error ? err.message : 'Failed to start capture';
    store.setState((state) => setError(state, message));
    emit('capture:error', { error: message });

    // Clean up on error
    if (captureTrack) {
      captureTrack.stop();
      captureTrack = null;
    }
    if (stream) {
      stopScreenCapture(stream);
    }
    if (videoElement) {
      videoElement.pause();
      videoElement.srcObject = null;
      videoElement = null;
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
 * Point a worker manager at a video element and start it with the
 * budget-clamped buffer size, computed from the dimensions frames are
 * ACTUALLY captured at (post-limit). Shared by a new share and a change of
 * source, which captures at the new source's size.
 *
 * @param {CaptureWorkerManager} manager
 * @param {HTMLVideoElement} video
 * @param {NonNullable<typeof store>} sessionStore - the store of the screen
 *   this share belongs to
 */
function startWorkerOn(manager, video, sessionStore) {
  const memorySettings = loadSettings().capture;
  manager.init(video, {
    // Downscale at grab time (#96): Retina fullscreen frames are ~24 MB
    // each as raw RGBA; capping the long edge is the difference between a
    // ~10 GB and a ~2 GB ring buffer at default settings.
    maxEdge: memorySettings.captureResolutionLimit,
    // The stats callback closes over THIS session's store, not the module
    // variable: cleanup() nulls the module `store` on every navigation while
    // the preserved session (and its store, stashed in screenCaptureState)
    // lives on. With background capture the worker keeps posting stats while
    // the user is on another route — writing them through the module variable
    // silently dropped them all, freezing the live monitor's buffer-fullness
    // readout.
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
    // A shared window resized (or a size unknown at start): re-clamp the
    // buffer for the new frame size, so it keeps to its share of the
    // memory budget (B5, memory audit)
    onFrameSizeChange: (dims) => {
      const resized = calculateEffectiveMaxFrames(
        sessionStore.getState().settings,
        dims,
        loadSettings().capture.memoryBudgetMB,
      );
      sessionStore.setState((state) => ({ ...state, bufferLimit: resized }));
      manager.resize(resized.maxFrames);
    },
  });

  const bufferLimit = calculateEffectiveMaxFrames(
    sessionStore.getState().settings,
    manager.getEffectiveFrameDimensions(),
    memorySettings.memoryBudgetMB,
  );
  sessionStore.setState((state) => ({ ...state, bufferLimit }));
  manager.start(sessionStore.getState().settings.fps, bufferLimit.maxFrames);
}

/**
 * Change source: pick another screen, window or tab while sharing and move
 * the running capture onto it. A cancelled or failed picker keeps the
 * current share untouched.
 *
 * The buffer is cleared at the switch, so a clip never spans two sources
 * (#203 drops the older run only when the frame size changes; two sources
 * of the same size would otherwise end up in one clip) and the buffer is
 * sized again for the new source's frames.
 *
 * @returns {Promise<boolean>} Whether the source changed
 */
async function handleChangeSource() {
  if (!store || !workerManager || !videoElement || !store.getState().isSharing) return false;
  const sessionStore = store;
  const manager = workerManager;
  const stillCurrent = () =>
    store === sessionStore && workerManager === manager && sessionStore.getState().isSharing;

  /** @type {MediaStream} */
  let stream;
  try {
    stream = await startScreenCapture();
  } catch {
    // Picker cancelled or permission denied: the current share goes on
    return false;
  }
  if (!stillCurrent()) {
    stopScreenCapture(stream);
    return false;
  }

  /** @type {HTMLVideoElement} */
  let video;
  try {
    video = await createVideoElement(stream);
  } catch {
    stopScreenCapture(stream);
    return false;
  }
  if (!stillCurrent()) {
    releaseAbandonedStart(stream, null, video);
    return false;
  }

  const previousStream = sessionStore.getState().stream;
  const previousVideo = videoElement;

  // Move the stream-ended listener to the new track before the old one stops
  if (streamEndedCleanup) streamEndedCleanup();
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', handleStreamEnded);
  streamEndedCleanup = () => track.removeEventListener('ended', handleStreamEnded);
  captureTrack = track;
  videoElement = video;
  sessionStore.setState((state) => ({ ...state, stream }));

  manager.stop();
  manager.clear();
  startWorkerOn(manager, video, sessionStore);

  previousVideo.pause();
  previousVideo.srcObject = null;
  if (previousStream) stopScreenCapture(previousStream);

  emit('capture:started', { stream });
  announce('Source changed');
  render(qsRequired('#main-content'));
  return true;
}

/**
 * Release a stream (and its video element) acquired by a handleStart() whose
 * screen was left while it was awaiting. Only clears the module track if it
 * is still this start's: a newer screen may already own the module state.
 *
 * @param {MediaStream} stream
 * @param {MediaStreamTrack | null} videoTrack
 * @param {HTMLVideoElement | null} video
 */
function releaseAbandonedStart(stream, videoTrack, video) {
  stopScreenCapture(stream);
  if (videoTrack && captureTrack === videoTrack) {
    captureTrack = null;
  }
  if (video) {
    video.pause();
    video.srcObject = null;
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
 * A clip has one frame size: the editor and the export size every frame by
 * the first. Switching the shared source (Chrome's "Share this tab instead",
 * a resized window) changes the size mid-buffer, so only the frames of the
 * newest source (the run since the last size change) make the clip; the
 * older bitmaps are closed with the rest.
 *
 * @param {import('../../workers/capture-worker-manager.js').TransferredFrame[]} imageBitmapFrames
 * @returns {import('./types.js').Frame[]}
 */
export function convertBitmapFramesToVideoFrames(imageBitmapFrames) {
  const videoFrames = [];
  const start = getNewestSourceStart(imageBitmapFrames);
  for (const item of imageBitmapFrames.slice(0, start)) item.bitmap?.close();

  for (const item of imageBitmapFrames.slice(start)) {
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
 * Index of the first frame of the newest source: the trailing run of
 * frames with the size of the last usable one
 * @param {import('../../workers/capture-worker-manager.js').TransferredFrame[]} frames
 * @returns {number}
 */
function getNewestSourceStart(frames) {
  const sized = (/** @type {number} */ i) =>
    frames[i]?.bitmap && frames[i].bitmap.width > 0 && frames[i].bitmap.height > 0;
  let last = frames.length - 1;
  while (last >= 0 && !sized(last)) last--;
  if (last < 0) return 0;
  const { width, height } = frames[last].bitmap;
  let start = last;
  while (start > 0) {
    const previous = frames[start - 1].bitmap;
    if (sized(start - 1) && (previous.width !== width || previous.height !== height)) break;
    start--;
  }
  return start;
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
 *   to go. With the autoRemoveOldClips setting on, the oldest queued clips
 *   are removed instead when that makes room (#186)
 * - Scene detection runs in Loading screen (if enabled)
 *
 * @returns {Promise<boolean>} true if a clip payload was stored — the UI
 *   must not navigate to Editor/Loading when no clip was produced
 */
async function handleCreateClip() {
  if (!store || !workerManager) return false;
  // The screen this Create Clip started on. Leaving /capture while the
  // frames are on the way (cleanup() nulls `store`) must neither throw nor
  // drop them (B4, memory audit)
  const sessionStore = store;

  // A new active clip demotes the current one into the queue, so it needs a
  // queue slot only when there is an active clip. Refuse early while the
  // ring buffer is still intact instead of after draining it; with the
  // autoRemoveOldClips setting on, only when removing the oldest queued
  // clips could not make room either (#186).
  const needSlot = getClipPayload() !== null;
  // The memory budget (#96): materializing the buffer as VideoFrames must
  // not push held-frame memory past the budget. The user sees the same
  // visible surfaces as a queue-full refusal.
  const projection = projectClipMemory(getLiveCaptureContext());
  const room = checkClipRoom({ needSlot, projection });
  if (!room.ok && room.reason === 'queue-full') {
    announceQueueFull();
    return false;
  }
  if (!room.ok) {
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

  const settings = sessionStore.getState().settings;

  if (store !== sessionStore) {
    // The screen was left: keep the snapshot as a queued clip, which does
    // not touch whatever screen is mounted now. Not an active clip, so the
    // caller does not navigate.
    queueSnapshot(videoFrames, { fps: settings.fps, sceneDetection: settings.sceneDetection });
    return false;
  }

  // Remove the oldest queued clips this clip needs room from (setting on).
  // Refused when even removing all of them would not make room for the
  // real snapshot: nothing was removed and the frames are still ours.
  const made = makeRoomForClip({ needSlot: getClipPayload() !== null, frames: videoFrames });
  if (!made.ok) {
    closeRefusedFrames(videoFrames);
    if (made.reason === 'memory-budget' && made.projection) {
      const memoryProjection = made.projection;
      announceMemoryBudget(memoryProjection);
      store.setState((state) => setError(state, buildMemoryBudgetMessage(memoryProjection)));
      render(qsRequired('#main-content'));
    } else {
      announceQueueFull();
    }
    return false;
  }

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
    closeRefusedFrames(videoFrames);
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
  // An import still decoding has nowhere to go once the screen is gone;
  // aborting makes the importer close every frame it created
  if (importController) {
    importController.abort();
    importController = null;
  }
  importBusyLabel = null;

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
