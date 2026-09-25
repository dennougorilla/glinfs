/**
 * Export Feature Entry Point
 * @module features/export
 */

import {
  clearExportResult,
  getClipPayload,
  getEditorPayload,
  getExportResult,
  releaseAllFramesAndReset,
  setExportResult,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { composeOutputFrame, snapCanvasAlphaToBinary } from '../../shared/edits/compose.js';
import { normalizeEdits, requiresTransparency } from '../../shared/edits/model.js';
import { navigate } from '../../shared/router.js';
import { updateSetting } from '../../shared/user-settings.js';
import { isFrameValid, syncCanvasSize } from '../../shared/utils/canvas.js';
import { createElement, on, qsRequired } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import { createKeyedRegionCache } from '../editor/edits-preview.js';
import { initLiveMonitor } from '../editor/live-monitor.js';
import { checkEncoderStatus, downloadBlob, encodeGif, openInNewTab } from './api.js';
import {
  applyFrameSkip,
  generateFilename,
  getCroppedDimensions,
  getEffectiveEncoderId,
} from './core.js';
import {
  cancelEncodingState,
  completeEncoding,
  createEncodingJob,
  createExportStore,
  failEncoding,
  resetExport,
  startEncoding,
  togglePreviewPlaying,
  updateProgress,
  updateSettings,
} from './state.js';
import { renderExportScreen, updatePreviewPlaybackUI, updateProgressUI } from './ui.js';

/** @type {ReturnType<typeof createExportStore> | null} */
let store = null;

/** @type {(() => void) | null} */
let storeUnsubscribe = null;

/** @type {(() => void) | null} */
let uiCleanup = null;

/** @type {(() => void) | null} Live monitor teardown for the current render (#100 v3) */
let liveMonitorCleanup = null;

/** @type {import('../capture/types.js').Frame[]} */
let frames = [];

/** @type {import('../editor/types.js').CropArea | null} */
let cropArea = null;

/** @type {import('./ui.js').ExportClipInfo & { fps: number }} */
let clipInfo = { frameCount: 0, width: 0, height: 0, duration: 0, fps: 30, transparent: false };

/**
 * Edits to burn in (normalized against the clip), or null for none
 * @type {import('../../shared/edits/model.js').ClipEdits | null}
 */
let edits = null;

/** Absolute clip index of frames[0] (the editor's selected range start) */
let rangeStart = 0;

/**
 * Composed + alpha-snapped preview frames of a transparent export, keyed by
 * absolute frame index (edits and crop are fixed for a mount). Background
 * removal and the 1-bit snap read every frame back on the main thread; the
 * first loop fills this (byte-capped admission, like the editor's keyed
 * cache) and later loops just write the pixels back.
 */
const previewFrameCache = createKeyedRegionCache();

/**
 * Collapse runs of identical frames into one GIF frame. Only imported clips
 * (which expand a source frame's hold into repeated slots) need it; screen
 * captures keep today's frame-for-frame output.
 */
let mergeIdenticalFrames = false;

/** @type {AbortController | null} */
let encodingController = null;

/**
 * Minimum interval between progress-bar DOM updates during encoding.
 * Encode progress events can arrive faster than the display can usefully
 * redraw (worker posts a PROGRESS message per frame); throttling to a
 * single frame budget keeps the main thread from doing needless layout
 * work while still feeling live.
 */
const PROGRESS_UI_THROTTLE_MS = 16;

/**
 * Throttled updateProgressUI, (re)created per mount so its internal timer
 * doesn't outlive the container it renders into. The final 100% update is
 * always applied immediately (bypassing the throttle) so the progress bar
 * never appears to stall short of completion.
 * @type {import('../../shared/utils/performance.js').ThrottledFunction | null}
 */
let throttledUpdateProgressUI = null;

/** @type {number | null} */
let animationFrameId = null;

/** @type {HTMLCanvasElement | null} */
let previewCanvas = null;

/** Current frame index for playback */
let currentFrameIndex = 0;

/** Last frame render time */
let lastFrameTime = 0;

/** Default FPS */
const DEFAULT_FPS = 30;

/**
 * Render the "nothing to export" screen with a real click listener.
 *
 * The document CSP is `script-src 'self' 'wasm-unsafe-eval'` (no
 * 'unsafe-inline'), so an inline `onclick` attribute never runs in the
 * browser — the previous innerHTML markup shipped a dead button. The
 * listener is registered through uiCleanup so leaving the route unhooks it.
 *
 * @param {HTMLElement} container - Route container (#main-content)
 * @param {{ className: string, message: string, buttonLabel: string, route: import('../../shared/router.js').Route }} options
 */
function renderEmptyState(container, { className, message, buttonLabel, route }) {
  const button = createElement('button', { className: 'btn btn-primary', type: 'button' }, [
    buttonLabel,
  ]);
  const screen = createElement(
    'section',
    { className: 'screen export-screen', 'aria-labelledby': 'export-title' },
    [
      createElement('header', { className: 'screen-header' }, [
        createElement('h1', { id: 'export-title', className: 'screen-title' }, ['Export GIF']),
      ]),
      createElement('div', { className }, [createElement('p', {}, [message]), button]),
    ],
  );

  container.innerHTML = '';
  container.appendChild(screen);
  uiCleanup = on(button, 'click', () => navigate(route));
}

/**
 * Initialize export feature
 *
 * SIMPLIFIED MODEL:
 * - Reads frames from clipPayload (single source of truth)
 * - Uses selectedRange from editorPayload to get the right frames
 * - No ownership tracking needed
 */
export function initExport() {
  const container = qsRequired('#main-content');

  // Register test hooks
  registerTestHooks();

  // Get settings from editor and frames from clip
  const editorPayload = getEditorPayload();
  const clipPayload = getClipPayload();

  // Validate we have the required data
  if (!editorPayload?.selectedRange || !clipPayload?.frames?.length) {
    renderEmptyState(container, {
      className: 'export-empty export-error',
      message: 'No clip data available. Please capture and edit a clip first.',
      buttonLabel: 'Back to Editor',
      route: '/editor',
    });
    emit('export:validation-error', { errors: ['No clip data available'] });
    return cleanup;
  }

  // Get selected frames from clipPayload using range from editorPayload
  const { start, end } = editorPayload.selectedRange;
  frames = clipPayload.frames.slice(start, end + 1);
  cropArea = editorPayload?.cropArea || null;
  const fps = editorPayload?.fps || DEFAULT_FPS;
  rangeStart = start;
  // Cached preview frames belong to one clip, crop and set of edits
  previewFrameCache.clear();

  // Edits and alpha travel on the editor payload (or its clip). Both are
  // optional: clips edited before these existed carry neither.
  const rawEdits = editorPayload.edits ?? editorPayload.clip?.edits;
  edits = rawEdits ? normalizeEdits(rawEdits, clipPayload.frames.length) : null;
  const hasAlpha = Boolean(
    editorPayload.hasAlpha ?? editorPayload.clip?.hasAlpha ?? clipPayload.hasAlpha,
  );
  const transparent = requiresTransparency({ edits, hasAlpha });
  mergeIdenticalFrames = Boolean(clipPayload.sourceName);

  if (frames.length === 0) {
    renderEmptyState(container, {
      className: 'export-empty',
      message: 'No frames to export. Please create a clip first.',
      buttonLabel: 'Back to Capture',
      route: '/capture',
    });
    return cleanup;
  }

  // Calculate clip info with actual FPS
  const frame = frames[0];
  const dims = getCroppedDimensions(frame, cropArea);
  clipInfo = {
    frameCount: frames.length,
    width: dims.width,
    height: dims.height,
    duration: frames.length / fps,
    fps,
    transparent,
  };

  // Create store
  //
  // A visit to this screen always starts from the settings + preview state,
  // never from a previously encoded GIF. Returning here — from the Editor,
  // the Settings screen, or anywhere else — means the user wants to export,
  // so the Export button must be reachable without first pressing "Adjust &
  // Re-export". cleanup() drops the previous result on the way out; this is
  // the other half of that contract.
  store = createExportStore();

  // Check encoder status
  checkEncoderStatus().then((status) => {
    if (store) {
      store.setState((s) => ({ ...s, encoderStatus: status }));
    }
  });

  // Initial render
  render(container);

  // Throttled progress redraw for this mount (see PROGRESS_UI_THROTTLE_MS).
  throttledUpdateProgressUI = throttle(updateProgressUI, PROGRESS_UI_THROTTLE_MS);

  // Subscribe to state changes
  storeUnsubscribe = store.subscribe((state, prevState) => {
    if (!store) return;

    // Keep the play/pause button in sync — toggling preview.isPlaying only
    // flips store state, so the UI must be refreshed explicitly (issue #62)
    if (state.preview.isPlaying !== prevState.preview.isPlaying) {
      updatePreviewPlaybackUI(container, state.preview.isPlaying);
    }

    // Update progress UI if encoding. Throttled to avoid redundant DOM
    // writes on every worker PROGRESS message, but the final 100% frame
    // always bypasses the throttle so the bar reliably reaches "done"
    // instead of possibly stalling behind a pending timer.
    if (state.job?.status === 'encoding') {
      if (state.job.progress >= 100) {
        throttledUpdateProgressUI?.cancel();
        updateProgressUI(container, state.job);
      } else {
        throttledUpdateProgressUI?.(container, state.job);
      }
    } else if (prevState.job?.status === 'encoding') {
      // Left the encoding state (e.g. cancel). Cancel any armed trailing
      // timer so it doesn't fire ~ms later and paint the previous job's
      // progress over whatever the next job renders (issue: stale progress
      // flash after cancel + immediate re-export).
      throttledUpdateProgressUI?.cancel();
    }
  });

  // Ensure the playback loop is running even when the preview starts
  // paused — handleTogglePlay only flips state; the loop itself renders
  // (or idles) based on preview.isPlaying. startPlaybackLoop is idempotent,
  // so this cannot double-start a loop render() already began.
  startPlaybackLoop();

  return cleanup;
}

/**
 * Full render of export screen
 * @param {HTMLElement} container
 */
function render(container) {
  if (!store) return;

  // Stop playback before re-render
  stopPlaybackLoop();

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  const state = store.getState();

  const { cleanup, canvas } = renderExportScreen(
    container,
    state,
    {
      onSettingsChange: handleSettingsChange,
      onExport: handleExport,
      onCancel: handleCancel,
      onDownload: handleDownload,
      onOpenInTab: handleOpenInTab,
      onBackToEditor: handleBackToEditor,
      onTogglePlay: handleTogglePlay,
      onAdjustSettings: handleAdjustSettings,
      onCreateNew: handleCreateNew,
    },
    clipInfo,
  );

  uiCleanup = cleanup;
  previewCanvas = canvas;

  // (Re)mount the live monitor into this render's slot — renderExportScreen
  // rebuilds the panel, so the previous mount's DOM is gone
  if (liveMonitorCleanup) {
    liveMonitorCleanup();
    liveMonitorCleanup = null;
  }
  {
    const slot = container.querySelector('[data-live-monitor]');
    if (slot instanceof HTMLElement) {
      liveMonitorCleanup = initLiveMonitor(slot);
    }
  }

  // Restart playback if we have a canvas and state says we should be playing
  if (previewCanvas && state.preview.isPlaying) {
    startPlaybackLoop();
  }
}

/**
 * Handle settings change
 * @param {Partial<import('./types.js').ExportSettings>} settings
 */
function handleSettingsChange(settings) {
  if (!store) return;

  // Check if encoder is changing (requires full re-render)
  const encoderChanging =
    settings.encoderId !== undefined && settings.encoderId !== store.getState().settings.encoderId;

  store.setState((state) =>
    updateSettings(state, settings, {
      frameCount: clipInfo.frameCount,
      width: clipInfo.width,
      height: clipInfo.height,
    }),
  );

  emit('export:settings', { settings: store.getState().settings });

  // Save settings to localStorage
  Object.entries(settings).forEach(([key, value]) => {
    updateSetting('export', key, value);
  });

  // Reset frame index when settings change
  currentFrameIndex = 0;
  lastFrameTime = 0;

  // Re-render UI when encoder changes (shows different settings panel)
  if (encoderChanging) {
    render(qsRequired('#main-content'));
  }
}

/**
 * Handle export button click
 */
async function handleExport() {
  if (!store || frames.length === 0) return;

  const state = store.getState();

  // Create encoding job (transparent exports always run on gifenc)
  const effectiveFrames = applyFrameSkip(frames, state.settings.frameSkip);
  const job = createEncodingJob(
    effectiveFrames.length,
    getEffectiveEncoderId(state.settings, clipInfo.transparent),
  );

  // Create AbortController for cancellation support
  encodingController = new AbortController();

  store.setState((s) => startEncoding(s, job));
  emit('export:started', { job });

  // Re-render to show progress
  render(qsRequired('#main-content'));

  try {
    const result = await encodeGif(
      {
        frames,
        crop: cropArea,
        settings: state.settings,
        fps: clipInfo.fps,
        edits,
        rangeStart,
        transparent: clipInfo.transparent === true,
        mergeIdenticalFrames,
        onProgress: (progress) => {
          if (!store) return;
          store.setState((s) => updateProgress(s, progress));
          emit('export:progress', { percent: progress.percent, frame: progress.current });
        },
      },
      encodingController.signal,
    );

    if (!store) return;

    store.setState((s) => completeEncoding(s, result));

    // Record the result for this visit. The filename is generated once here
    // so repeated downloads of the same GIF keep the same name; the record
    // lives only as long as this mount (see cleanup).
    setExportResult({
      blob: result,
      filename: generateFilename(),
      completedAt: Date.now(),
    });

    emit('export:complete', { blob: result, size: result.size });

    // Re-render to show complete state
    render(qsRequired('#main-content'));
  } catch (error) {
    if (!store) return;

    // Handle cancellation specifically
    if (error instanceof DOMException && error.name === 'AbortError') {
      store.setState(cancelEncodingState);
      emit('export:cancelled', {});
    } else {
      const message = error instanceof Error ? error.message : 'Encoding failed';
      store.setState((s) => failEncoding(s, message));
      emit('export:error', { error: message });
    }

    // Re-render to show error/cancelled state
    render(qsRequired('#main-content'));
  } finally {
    encodingController = null;
  }
}

/**
 * Handle cancel button click
 */
function handleCancel() {
  if (!store) return;

  // Abort the encoding operation if in progress
  if (encodingController) {
    encodingController.abort();
    // State update and emit will be handled in handleExport's catch block
  }
}

/**
 * Handle download button click
 */
function handleDownload() {
  if (!store) return;

  const state = store.getState();
  if (state.job?.result) {
    // Prefer the filename recorded when the export completed so repeated
    // downloads (or downloads after returning to this screen) match it
    const filename = getExportResult()?.filename ?? generateFilename();
    downloadBlob(state.job.result, filename);
  }
}

/**
 * Handle open in tab button click
 */
function handleOpenInTab() {
  if (!store) return;

  const state = store.getState();
  if (state.job?.result) {
    openInNewTab(state.job.result);
  }
}

/**
 * Handle back to editor button click
 *
 * SIMPLIFIED MODEL:
 * - Just navigate back (frames live in clipPayload)
 * - No ownership tracking needed
 */
function handleBackToEditor() {
  if (!store) return;

  store.setState(resetExport);
  navigate('/editor');
}

/**
 * Handle adjust settings button click (after export complete)
 * Resets to preview state so user can change settings and re-export
 */
function handleAdjustSettings() {
  if (!store) return;

  // Reset job state to show settings again
  store.setState(resetExport);

  // Clear saved export result so it doesn't auto-restore
  clearExportResult();

  // Re-render to show settings panel
  render(qsRequired('#main-content'));

  // Start playback loop for preview
  startPlaybackLoop();
}

/**
 * Handle "Create New GIF" button click
 * Releases all VideoFrame resources and navigates to Capture
 */
function handleCreateNew() {
  if (!store) return;

  // Reset export state
  store.setState(resetExport);

  // Release all VideoFrame resources and clear all payloads
  releaseAllFramesAndReset();

  emit('export:new-session', {});

  // Navigate to capture for fresh start
  navigate('/capture');
}

// ============================================================
// Canvas Preview Playback
// ============================================================

/**
 * Absolute clip index of the k-th frame the export plays/encodes
 * (after frame skip): text frame ranges are evaluated against it.
 * @param {number} k - Index into applyFrameSkip(frames, frameSkip)
 * @param {number} frameSkip
 * @returns {number}
 */
function absoluteFrameIndex(k, frameSkip) {
  return rangeStart + k * Math.max(1, frameSkip);
}

/**
 * The preview canvas context. Reading it back every frame (background
 * removal, 1-bit alpha snapping) is fast only when the FIRST getContext call
 * asks for willReadFrequently, so every caller goes through here.
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasRenderingContext2D | null}
 */
function getPreviewContext(canvas) {
  return canvas.getContext('2d', {
    willReadFrequently: edits?.background?.enabled === true || clipInfo.transparent === true,
  });
}

/**
 * Draw one preview frame through the encoder's compositor. A transparent
 * export is then snapped to GIF's 1-bit alpha, the same threshold the
 * encoder applies, so partial alpha (a text box's opacity, soft edges of an
 * imported PNG) previews exactly as it will be exported. That readback is
 * paid once per frame: later loops draw from previewFrameCache.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../capture/types.js').Frame} frame
 * @param {number} frameIndex - Absolute clip frame index
 */
function renderPreviewFrame(ctx, frame, frameIndex) {
  if (!clipInfo.transparent) {
    // Opaque exports never read back: nothing to cache
    composeOutputFrame(ctx, frame, cropArea, edits, frameIndex);
    return;
  }
  const cached = previewFrameCache.get(frameIndex);
  if (cached) {
    syncCanvasSize(ctx.canvas, cached.width, cached.height);
    ctx.putImageData(cached, 0, 0);
    return;
  }
  composeOutputFrame(ctx, frame, cropArea, edits, frameIndex);
  const snapped = snapCanvasAlphaToBinary(ctx);
  // A closed frame drew the placeholder: never keep that
  if (snapped && isFrameValid(frame)) {
    previewFrameCache.set(frameIndex, snapped);
  }
}

/**
 * Start the playback loop
 *
 * Idempotent: a second call while a loop is running is a no-op. Two
 * concurrent rAF chains would race on currentFrameIndex/lastFrameTime and
 * only the last-registered chain would remain cancellable.
 */
function startPlaybackLoop() {
  if (animationFrameId !== null) return;
  if (!store || !previewCanvas || frames.length === 0) return;

  const ctx = getPreviewContext(previewCanvas);
  if (!ctx) return;

  // Render first frame immediately. The preview goes through the same
  // compositor as the encoder, so it shows exactly what will be exported.
  const state = store.getState();
  const effectiveFrames = applyFrameSkip(frames, state.settings.frameSkip);
  if (effectiveFrames.length > 0) {
    renderPreviewFrame(ctx, effectiveFrames[0], absoluteFrameIndex(0, state.settings.frameSkip));
  }

  function animate(timestamp) {
    if (!store || !previewCanvas) {
      animationFrameId = null;
      return;
    }

    const state = store.getState();

    // Only animate if playing
    if (!state.preview.isPlaying) {
      animationFrameId = requestAnimationFrame(animate);
      return;
    }

    const effectiveFrames = applyFrameSkip(frames, state.settings.frameSkip);
    if (effectiveFrames.length === 0) {
      animationFrameId = requestAnimationFrame(animate);
      return;
    }

    // Calculate frame delay based on settings
    const baseDelay = 1000 / clipInfo.fps;
    const frameDelay = (baseDelay * state.settings.frameSkip) / state.settings.playbackSpeed;

    if (timestamp - lastFrameTime >= frameDelay) {
      const ctx = getPreviewContext(previewCanvas);
      if (ctx) {
        const k = currentFrameIndex % effectiveFrames.length;
        renderPreviewFrame(
          ctx,
          effectiveFrames[k],
          absoluteFrameIndex(k, state.settings.frameSkip),
        );
        currentFrameIndex = (currentFrameIndex + 1) % effectiveFrames.length;
        lastFrameTime = timestamp;
      }
    }

    animationFrameId = requestAnimationFrame(animate);
  }

  animationFrameId = requestAnimationFrame(animate);
}

/**
 * Stop the playback loop
 */
function stopPlaybackLoop() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * Handle play/pause toggle
 */
function handleTogglePlay() {
  if (!store) return;
  store.setState(togglePreviewPlaying);
  emit('preview:toggle', { isPlaying: store.getState().preview.isPlaying });
}

/**
 * Cleanup export feature
 *
 * SIMPLIFIED MODEL:
 * - Does NOT close frames (they live in clipPayload)
 * - Frames are only closed when a new clip is created
 */
function cleanup() {
  // Stop playback loop
  stopPlaybackLoop();

  if (liveMonitorCleanup) {
    liveMonitorCleanup();
    liveMonitorCleanup = null;
  }

  // Leaving the screen ends this export session. Dropping the result here is
  // what guarantees the next visit opens on the settings panel instead of a
  // previous GIF still sitting in the "complete" state — the reported case of
  // an old GIF surviving unless the user happened to return via "Adjust &
  // Re-export" (the only path that used to clear it).
  clearExportResult();

  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  if (throttledUpdateProgressUI) {
    throttledUpdateProgressUI.cancel();
    throttledUpdateProgressUI = null;
  }

  // Cancel any in-progress encoding
  if (encodingController) {
    encodingController.abort();
    encodingController = null;
  }

  frames = [];
  cropArea = null;
  edits = null;
  previewFrameCache.clear();
  rangeStart = 0;
  mergeIdenticalFrames = false;
  store = null;
  previewCanvas = null;
  currentFrameIndex = 0;
  lastFrameTime = 0;
}

/**
 * Get current export state
 * @returns {import('./types.js').ExportState | null}
 */
export function getExportState() {
  return store?.getState() ?? null;
}

// ============================================================
// Test Hooks (only available in Playwright test environment)
// ============================================================

/**
 * Register test hooks for export feature
 * Called during feature initialization to ensure __TEST_HOOKS__ exists
 */
function registerTestHooks() {
  if (typeof window !== 'undefined' && window.__TEST_HOOKS__) {
    window.__TEST_HOOKS__.setExportState = (stateOverrides) => {
      if (!store) return;
      store.setState((currentState) => ({
        ...currentState,
        ...stateOverrides,
      }));
    };

    // Lets E2E decode the real exported GIF (e.g. with ImageDecoder)
    window.__TEST_HOOKS__.getExportResultBase64 = async () => {
      const blob = getExportResult()?.blob ?? store?.getState().job?.result ?? null;
      return blob ? blobToBase64(blob) : null;
    };
  }
}

/**
 * Base64 of a blob's bytes (no data: prefix). Uses FileReader, which
 * handles multi-MB GIFs without the argument-count limit of
 * String.fromCharCode(...bytes).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read export result'));
    reader.readAsDataURL(blob);
  });
}
