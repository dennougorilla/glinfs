/**
 * Export Feature Entry Point
 * @module features/export
 */

import { emit } from '../../shared/bus.js';
import { getEditorPayload, getClipPayload, getExportResult, setExportResult, clearExportResult, releaseAllFramesAndReset } from '../../shared/app-store.js';
import { qsRequired } from '../../shared/utils/dom.js';
import { isVideoFrameValid, syncCanvasSize, renderFramePlaceholder, getDrawableSource } from '../../shared/utils/canvas.js';
import { navigate } from '../../shared/router.js';
import { updateSetting } from '../../shared/user-settings.js';
import {
  createExportStore,
  updateSettings,
  startEncoding,
  updateProgress,
  completeEncoding,
  failEncoding,
  cancelEncodingState,
  resetExport,
  createEncodingJob,
  togglePreviewPlaying,
} from './state.js';
import { applyFrameSkip, generateFilename, getCroppedDimensions } from './core.js';
import { checkEncoderStatus, encodeGif, downloadBlob, openInNewTab } from './api.js';
import { renderExportScreen, updateProgressUI } from './ui.js';

/** @type {ReturnType<typeof createExportStore> | null} */
let store = null;

/** @type {(() => void) | null} */
let uiCleanup = null;

/** @type {import('../capture/types.js').Frame[]} */
let frames = [];

/** @type {import('../editor/types.js').CropArea | null} */
let cropArea = null;

/** @type {{ frameCount: number, width: number, height: number, duration: number, fps: number }} */
let clipInfo = { frameCount: 0, width: 0, height: 0, duration: 0, fps: 30 };

/** @type {AbortController | null} */
let encodingController = null;

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
    // Static error message - safe HTML
    container.innerHTML = '<section class="screen export-screen" aria-labelledby="export-title"><header class="screen-header"><h1 id="export-title" class="screen-title">Export GIF</h1></header><div class="export-empty export-error"><p>No clip data available. Please capture and edit a clip first.</p><button class="btn btn-primary" onclick="location.hash = \'#/editor\'">Back to Editor</button></div></section>';
    emit('export:validation-error', { errors: ['No clip data available'] });
    return cleanup;
  }

  // Get selected frames from clipPayload using range from editorPayload
  const { start, end } = editorPayload.selectedRange;
  frames = clipPayload.frames.slice(start, end + 1);
  cropArea = editorPayload?.cropArea || null;
  const fps = editorPayload?.fps || DEFAULT_FPS;

  if (frames.length === 0) {
    container.innerHTML = `
      <section class="screen export-screen" aria-labelledby="export-title">
        <header class="screen-header">
          <h1 id="export-title" class="screen-title">Export GIF</h1>
        </header>
        <div class="export-empty">
          <p>No frames to export. Please create a clip first.</p>
          <button class="btn btn-primary" onclick="location.hash = '#/capture'">
            Back to Capture
          </button>
        </div>
      </section>
    `;
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
  };

  // Create store
  store = createExportStore();

  // Restore saved export result if available (user returning to Export screen)
  const savedResult = getExportResult();
  if (savedResult) {
    store.setState((s) => completeEncoding(s, savedResult.blob));
  }

  // Check encoder status
  checkEncoderStatus().then((status) => {
    if (store) {
      store.setState((s) => ({ ...s, encoderStatus: status }));
    }
  });

  // Initial render
  render(container);

  // Subscribe to state changes
  store.subscribe(() => {
    if (!store) return;
    const state = store.getState();

    // Update progress UI if encoding
    if (state.job?.status === 'encoding') {
      updateProgressUI(container, state.job);
    }
  });

  // Start playback loop
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

  const { cleanup, canvas } = renderExportScreen(container, state, {
    onSettingsChange: handleSettingsChange,
    onExport: handleExport,
    onCancel: handleCancel,
    onDownload: handleDownload,
    onOpenInTab: handleOpenInTab,
    onBackToEditor: handleBackToEditor,
    onTogglePlay: handleTogglePlay,
    onAdjustSettings: handleAdjustSettings,
    onCreateNew: handleCreateNew,
  }, clipInfo);

  uiCleanup = cleanup;
  previewCanvas = canvas;

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
  const encoderChanging = settings.encoderId !== undefined &&
    settings.encoderId !== store.getState().settings.encoderId;

  store.setState((state) =>
    updateSettings(state, settings, {
      frameCount: clipInfo.frameCount,
      width: clipInfo.width,
      height: clipInfo.height,
    })
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

  // Create encoding job
  const effectiveFrames = applyFrameSkip(frames, state.settings.frameSkip);
  const job = createEncodingJob(effectiveFrames.length, state.encoderStatus === 'gifsicle-wasm' ? 'gifsicle-wasm' : 'gifenc-js');

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
        onProgress: (progress) => {
          if (!store) return;
          store.setState((s) => updateProgress(s, progress));
          emit('export:progress', { percent: progress.percent, frame: progress.current });
        },
      },
      encodingController.signal
    );

    if (!store) return;

    store.setState((s) => completeEncoding(s, result));

    // Save export result for later retrieval (e.g., when returning to Export screen)
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
    const filename = generateFilename();
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
 * Render a frame to the preview canvas with crop applied
 * Uses VideoFrame directly for GPU-accelerated rendering
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../capture/types.js').Frame} frame
 * @param {import('../editor/types.js').CropArea | null} crop
 */
function renderCroppedFrame(ctx, frame, crop) {
  // Handle missing, invalid, or closed frame
  if (!frame?.frame || !isVideoFrameValid(frame.frame)) {
    const canvas = ctx.canvas;
    renderFramePlaceholder(ctx, canvas.width, canvas.height);
    return;
  }

  // Get drawable source (supports both real VideoFrames and mock frames)
  const source = getDrawableSource(frame);
  if (!source) {
    const canvas = ctx.canvas;
    renderFramePlaceholder(ctx, canvas.width, canvas.height);
    return;
  }

  if (crop) {
    // Set canvas size to crop dimensions
    syncCanvasSize(ctx.canvas, crop.width, crop.height);

    // Draw cropped region
    ctx.drawImage(
      source,
      crop.x, crop.y, crop.width, crop.height,
      0, 0, crop.width, crop.height
    );
  } else {
    // No crop - draw full frame
    syncCanvasSize(ctx.canvas, frame.width, frame.height);
    ctx.drawImage(source, 0, 0);
  }
}

/**
 * Start the playback loop
 */
function startPlaybackLoop() {
  if (!store || !previewCanvas || frames.length === 0) return;

  const ctx = previewCanvas.getContext('2d');
  if (!ctx) return;

  // Render first frame immediately
  const state = store.getState();
  const effectiveFrames = applyFrameSkip(frames, state.settings.frameSkip);
  if (effectiveFrames.length > 0) {
    renderCroppedFrame(ctx, effectiveFrames[0], cropArea);
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
      const ctx = previewCanvas.getContext('2d');
      if (ctx) {
        const frame = effectiveFrames[currentFrameIndex % effectiveFrames.length];
        renderCroppedFrame(ctx, frame, cropArea);
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

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  // Cancel any in-progress encoding
  if (encodingController) {
    encodingController.abort();
    encodingController = null;
  }

  frames = [];
  cropArea = null;
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
  }
}
