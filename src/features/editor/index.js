/**
 * Editor Feature Entry Point
 * @module features/editor
 */

import { emit } from '../../shared/bus.js';
import {
  getClipPayload,
  getEditorPayload,
  setEditorPayload,
  clearEditorPayload,
  validateClipPayload,
} from '../../shared/app-store.js';
import { qsRequired, createElement, on, createErrorScreen } from '../../shared/utils/dom.js';
import { navigate } from '../../shared/router.js';
import { frameToTimecode } from '../../shared/utils/format.js';
import { throttle } from '../../shared/utils/performance.js';
import {
  createEditorStore,
  createEditorStoreFromClip,
  goToFrame,
  nextFrame,
  previousFrame,
  togglePlayback,
  setPlaybackSpeed,
  updateRange,
  updateCrop,
  clearCrop,
  toggleGrid,
  setSelectedAspectRatio,
  startSceneDetection,
  updateSceneDetectionProgress,
  completeSceneDetection,
  setSceneDetectionError,
} from './state.js';
import { createSceneDetectionManager } from '../scene-detection/index.js';
import { constrainAspectRatio, centerCropAfterConstraint, getSelectedFrames, normalizeSelectionRange, isFrameInRange } from './core.js';
import { renderEditorScreen, updateBaseCanvas, updateOverlayCanvas, updateTimelineHeader, updateScenesPanel, updateCropInfoPanel } from './ui.js';
import { renderTimeline, updateTimelineRange, updatePlayheadPosition } from './timeline.js';

/** @type {ReturnType<typeof createEditorStore> | null} */
let store = null;

/** @type {number | null} */
let playbackIntervalId = null;

/** @type {(() => void) | null} */
let uiCleanup = null;

/** @type {(() => void) | null} */
let timelineCleanup = null;

/** @type {HTMLCanvasElement | null} */
let baseCanvas = null;

/** @type {HTMLCanvasElement | null} */
let overlayCanvas = null;

/** @type {import('../scene-detection/manager.js').SceneDetectionManager | null} */
let sceneDetectionManager = null;

/** @type {(() => void)[]} */
let scenePanelCleanups = [];

/** @type {(() => void)[]} */
let cropInfoPanelCleanups = [];

/** Default FPS for editor */
const DEFAULT_FPS = 30;

/**
 * Initialize editor feature
 */
export function initEditor() {
  const container = qsRequired('#main-content');

  // Register test hooks
  registerTestHooks();

  // Check if returning from Export - restore state from EditorPayload FIRST
  // This takes priority over ClipPayload since Export preserves editor state
  const editorPayload = getEditorPayload();
  const hasValidEditorPayload = editorPayload?.clip?.frames?.length > 0;

  // Get clip payload from capture via app store
  const clipPayload = getClipPayload();

  // Validate payload structure ONLY if not returning from Export
  // When returning from Export, EditorPayload contains all needed data
  if (!hasValidEditorPayload) {
    const validation = validateClipPayload(clipPayload);
    if (!validation.valid) {
      /** @type {(() => void)[]} */
      const cleanups = [];

      const errorScreen = createErrorScreen({
        title: 'Invalid Clip Data',
        message: validation.errors.join(', '),
        actions: [
          {
            label: '\u2190 Back to Capture',
            onClick: () => navigate('/capture'),
            primary: true,
          },
        ],
      }, cleanups);

      const errorState = createElement('section', {
        className: 'screen editor-screen',
        'aria-labelledby': 'editor-title',
      }, [
        createElement('header', { className: 'screen-header' }, [
          createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
        ]),
        errorScreen,
      ]);

      container.innerHTML = '';
      container.appendChild(errorState);

      emit('editor:validation-error', { errors: validation.errors });

      return () => {
        cleanups.forEach(fn => fn());
        cleanup();
      };
    }
  }

  // Determine frames source: prefer EditorPayload when returning from Export
  const frames = hasValidEditorPayload
    ? editorPayload.clip.frames
    : (clipPayload?.frames || []);
  const fps = hasValidEditorPayload
    ? editorPayload.clip.fps
    : (clipPayload?.fps || DEFAULT_FPS);

  if (frames.length === 0) {
    /** @type {(() => void)[]} */
    const cleanups = [];

    const errorScreen = createErrorScreen({
      title: 'No Frames Available',
      message: 'No frames to edit. Please capture some content first.',
      actions: [
        {
          label: '\u2190 Back to Capture',
          onClick: () => navigate('/capture'),
          primary: true,
        },
      ],
    }, cleanups);

    const emptyState = createElement('section', {
      className: 'screen editor-screen',
      'aria-labelledby': 'editor-title',
    }, [
      createElement('header', { className: 'screen-header' }, [
        createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
      ]),
      errorScreen,
    ]);

    container.innerHTML = '';
    container.appendChild(emptyState);

    return () => {
      cleanups.forEach(fn => fn());
      cleanup();
    };
  }

  // Create store - restore from EditorPayload if returning from Export, otherwise create fresh
  if (hasValidEditorPayload) {
    // Restore state from EditorPayload (preserves selection range, crop area)
    store = createEditorStoreFromClip(editorPayload.clip);
    // Clear EditorPayload after consuming to prevent stale frame references on subsequent navigations
    clearEditorPayload();
    emit('editor:restored', { fromExport: true });
  } else {
    // Create fresh store from ClipPayload
    store = createEditorStore(frames, fps);
  }

  // Initial render
  render(container);

  // Start auto-playback if initial state is playing
  if (store.getState().isPlaying) {
    startPlayback();
  }

  // Emit loaded event (thumbnails are now rendered directly from frames)
  emit('editor:loaded', { clip: store?.getState().clip });

  // Subscribe to state changes (must be set up before setting pre-computed scenes)
  store.subscribe(
    throttle((state, prevState) => {
      if (!store || !baseCanvas || !overlayCanvas) return;

      // Update play button icon when playback state changes
      if (state.isPlaying !== prevState.isPlaying) {
        const playBtn = container.querySelector('.btn-play');
        if (playBtn) {
          playBtn.classList.toggle('playing', state.isPlaying);
          playBtn.textContent = state.isPlaying ? '\u23F8' : '\u25B6';
          playBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
        }
      }

      // Update current time display and playhead position
      if (state.currentFrame !== prevState.currentFrame) {
        const currentTimeEl = container.querySelector('.time-display .current');
        if (currentTimeEl) {
          // Calculate position within selection range (clamped)
          const selectionFrameCount = state.selectedRange.end - state.selectedRange.start + 1;
          const currentInSelection = Math.max(
            0,
            Math.min(state.currentFrame - state.selectedRange.start, selectionFrameCount - 1)
          );
          currentTimeEl.textContent = frameToTimecode(currentInSelection, fps);
        }

        // Update playhead position on timeline
        const timelineContainer = container.querySelector('.editor-timeline-container');
        if (timelineContainer && state.clip) {
          updatePlayheadPosition(
            /** @type {HTMLElement} */ (timelineContainer),
            state.currentFrame,
            state.clip.frames.length
          );
        }
      }

      // Update base canvas ONLY when frame changes
      if (state.currentFrame !== prevState.currentFrame &&
          state.clip?.frames[state.currentFrame]) {
        updateBaseCanvas(baseCanvas, state.clip.frames[state.currentFrame]);
      }

      // Update overlay ONLY when crop or grid changes
      // Note: During drag, setupCropInteraction handles overlay updates directly
      if (state.cropArea !== prevState.cropArea ||
          state.showGrid !== prevState.showGrid) {
        const frame = state.clip?.frames[state.currentFrame];
        if (frame) {
          updateOverlayCanvas(
            overlayCanvas,
            state.cropArea,
            frame.width,
            frame.height,
            state.showGrid
          );
        }
      }

      // Update crop info panel when crop changes
      if (state.cropArea !== prevState.cropArea) {
        // Clean up previous crop info panel event listeners
        cropInfoPanelCleanups.forEach((fn) => fn());
        // Update panel and collect new cleanups
        cropInfoPanelCleanups = updateCropInfoPanel(container, state.cropArea, handleCropChange);
      }

      // Update timeline selection
      const timelineContainer = container.querySelector('.editor-timeline-container');
      if (timelineContainer && state.clip) {
        updateTimelineRange(
          /** @type {HTMLElement} */ (timelineContainer),
          state.selectedRange,
          state.clip.frames.length
        );
      }

      // Update timeline header info when selection changes
      if (
        state.selectedRange.start !== prevState.selectedRange.start ||
        state.selectedRange.end !== prevState.selectedRange.end
      ) {
        updateTimelineHeader(container, state.selectedRange, state.currentFrame, fps);
      }

      // Update aspect ratio buttons when selection changes
      if (state.selectedAspectRatio !== prevState.selectedAspectRatio) {
        const aspectBtns = container.querySelectorAll('.aspect-btn');
        aspectBtns.forEach((btn) => {
          const ratio = btn.textContent === 'Free' ? 'free' : btn.textContent;
          btn.classList.toggle('active', ratio === state.selectedAspectRatio);
        });
      }

      // Update grid button when grid state changes
      if (state.showGrid !== prevState.showGrid) {
        const gridBtn = container.querySelector('.property-group .btn-secondary');
        if (gridBtn) {
          gridBtn.classList.toggle('active', state.showGrid);
          gridBtn.textContent = state.showGrid ? 'On' : 'Off';
          gridBtn.setAttribute('aria-pressed', String(state.showGrid));
        }
      }

      // Update scenes panel when scene detection state changes
      if (state.sceneDetectionStatus !== prevState.sceneDetectionStatus ||
          state.sceneDetectionProgress !== prevState.sceneDetectionProgress ||
          state.scenes !== prevState.scenes) {
        // Clean up previous scene panel event listeners
        scenePanelCleanups.forEach((fn) => fn());
        // Update panel and collect new cleanups
        scenePanelCleanups = updateScenesPanel(container, state, {
          onTogglePlay: handleTogglePlay,
          onFrameChange: handleFrameChange,
          onRangeChange: handleRangeChange,
          onCropChange: handleCropChange,
          onToggleGrid: handleToggleGrid,
          onAspectRatioChange: handleAspectRatioChange,
          onSpeedChange: handleSpeedChange,
          onExport: handleExport,
        });
      }
    }, 16) // ~60fps updates
  );

  // Use pre-computed scenes from Capture or fallback to async detection
  // (must be after subscription is set up so scenes panel gets updated)
  if (!hasValidEditorPayload && clipPayload?.sceneDetectionEnabled) {
    if (clipPayload.scenes && clipPayload.scenes.length > 0) {
      // Use pre-computed scenes from Capture (no need to run detection again)
      store.setState((state) => completeSceneDetection(state, clipPayload.scenes));
      emit('editor:scenes-detected', { sceneCount: clipPayload.scenes.length });
      console.log('[Editor] Using pre-computed scenes:', clipPayload.scenes.length, 'scenes');
    } else if (frames.length > 0) {
      // Fallback: run detection if scenes not provided (backward compatibility)
      startSceneDetectionAsync(frames);
    }
  }

  return cleanup;
}

/**
 * Full render of editor screen
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

  const result = renderEditorScreen(container, state, {
    onTogglePlay: handleTogglePlay,
    onFrameChange: handleFrameChange,
    onRangeChange: handleRangeChange,
    onCropChange: handleCropChange,
    onToggleGrid: handleToggleGrid,
    onAspectRatioChange: handleAspectRatioChange,
    onSpeedChange: handleSpeedChange,
    onExport: handleExport,
    getState: () => store?.getState() ?? null,
    getFrame: () => {
      const s = store?.getState();
      return s?.clip?.frames[s.currentFrame] ?? null;
    },
  }, DEFAULT_FPS);

  uiCleanup = result.cleanup;
  baseCanvas = result.baseCanvas;
  overlayCanvas = result.overlayCanvas;

  // Render timeline
  renderTimelineComponent(container);
}

/**
 * Render timeline component
 * @param {HTMLElement} container
 */
function renderTimelineComponent(container) {
  if (!store) return;

  const timelineContainer = container.querySelector('.editor-timeline-container');
  if (!timelineContainer) return;

  if (timelineCleanup) {
    timelineCleanup();
    timelineCleanup = null;
  }

  const state = store.getState();
  if (!state.clip) return;

  timelineCleanup = renderTimeline(
    /** @type {HTMLElement} */ (timelineContainer),
    state.clip,
    state.currentFrame,
    state.selectedRange,
    {
      onRangeChange: handleRangeChange,
    }
  );
}

/**
 * Handle play/pause toggle
 */
function handleTogglePlay() {
  if (!store) return;

  store.setState(togglePlayback);
  const state = store.getState();

  if (state.isPlaying) {
    startPlayback();
  } else {
    stopPlayback();
  }

  emit('editor:playback', { playing: state.isPlaying, speed: state.playbackSpeed });
}

/**
 * Start playback loop
 */
function startPlayback() {
  if (!store) return;

  const state = store.getState();
  const interval = (1000 / DEFAULT_FPS) / state.playbackSpeed;

  playbackIntervalId = window.setInterval(() => {
    if (!store) return;

    const currentState = store.getState();
    if (!currentState.clip) return;

    let nextFrameIndex = currentState.currentFrame + 1;

    // Loop within selected range
    if (nextFrameIndex > currentState.selectedRange.end) {
      nextFrameIndex = currentState.selectedRange.start;
    }

    store.setState((s) => goToFrame(s, nextFrameIndex));
    emit('editor:frame', { index: nextFrameIndex });
  }, interval);
}

/**
 * Stop playback loop
 */
function stopPlayback() {
  if (playbackIntervalId !== null) {
    clearInterval(playbackIntervalId);
    playbackIntervalId = null;
  }
}

/**
 * Handle frame change
 * @param {number} frameIndex
 */
function handleFrameChange(frameIndex) {
  if (!store) return;

  store.setState((state) => goToFrame(state, frameIndex));
  emit('editor:frame', { index: frameIndex });
}

/**
 * Handle range change
 * @param {import('./types.js').FrameRange} range
 */
function handleRangeChange(range) {
  if (!store) return;

  store.setState((state) => updateRange(state, range));
  emit('editor:range', { range });
}

/**
 * Handle crop change
 * @param {import('./types.js').CropArea | null} crop
 */
function handleCropChange(crop) {
  if (!store) return;

  store.setState((state) => (crop ? updateCrop(state, crop) : clearCrop(state)));
  emit('editor:crop', { crop });
}

/**
 * Handle grid toggle
 */
function handleToggleGrid() {
  if (!store) return;

  store.setState(toggleGrid);
}

/**
 * Handle aspect ratio change
 * @param {string} ratio
 */
function handleAspectRatioChange(ratio) {
  if (!store) return;

  // Update selectedAspectRatio and cropArea atomically in single setState
  store.setState((state) => {
    let newState = setSelectedAspectRatio(state, ratio);

    // If cropArea exists, apply constraint and maintain center position
    if (state.cropArea) {
      const constrained = constrainAspectRatio(state.cropArea, ratio);
      const centered = centerCropAfterConstraint(state.cropArea, constrained);
      newState = updateCrop(newState, centered);
    }

    return newState;
  });

  // Emit event after state update completes
  const updatedState = store.getState();
  if (updatedState.cropArea) {
    emit('editor:crop', { crop: updatedState.cropArea });
  }
}

/**
 * Handle speed change
 * @param {number} speed
 */
function handleSpeedChange(speed) {
  if (!store) return;

  store.setState((state) => setPlaybackSpeed(state, speed));

  // Restart playback if playing
  const wasPlaying = store.getState().isPlaying;
  if (wasPlaying) {
    stopPlayback();
    startPlayback();
  }
}

/**
 * Handle export
 *
 * SIMPLIFIED MODEL:
 * - Stores only selection range and crop settings in EditorPayload
 * - Export reads frames directly from clipPayload using selectedRange
 * - No frame cloning or ownership tracking needed
 */
function handleExport() {
  if (!store) return;

  const state = store.getState();
  if (!state.clip) return;

  // Store editor settings (NOT frames) for Export
  // Export will read frames from clipPayload using selectedRange
  setEditorPayload({
    selectedRange: state.selectedRange,
    cropArea: state.cropArea,
    clip: state.clip,  // For returning to Editor with preserved state
    fps: state.clip.fps,
  });

  const selectedCount = state.selectedRange.end - state.selectedRange.start + 1;

  emit('editor:export-ready', {
    frameCount: selectedCount,
    fps: state.clip.fps,
  });
}

// ============================================================
// Scene Detection
// ============================================================

/**
 * Start scene detection asynchronously
 * Does not block the main UI - runs in background
 * @param {import('../capture/types.js').Frame[]} frames
 */
async function startSceneDetectionAsync(frames) {
  if (!store) return;

  // Update state to show detection in progress
  store.setState(startSceneDetection);

  try {
    // Create and initialize manager
    sceneDetectionManager = createSceneDetectionManager();
    await sceneDetectionManager.init();

    // Run detection with progress updates
    const result = await sceneDetectionManager.detect(frames, {
      threshold: 0.3,
      minSceneDuration: 5,
      sampleInterval: 1,
      onProgress: (progress) => {
        if (store) {
          store.setState((state) => updateSceneDetectionProgress(state, progress.percent));
        }
      },
    });

    // Update state with results
    if (store) {
      store.setState((state) => completeSceneDetection(state, result.scenes));
      emit('editor:scenes-detected', {
        sceneCount: result.scenes.length,
        processingTimeMs: result.processingTimeMs,
      });
    }

    console.log('[Editor] Scene detection completed:', result.scenes.length, 'scenes found in', result.processingTimeMs, 'ms');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Detection was cancelled, not an error
      console.log('[Editor] Scene detection cancelled');
    } else {
      const message = error instanceof Error ? error.message : 'Scene detection failed';
      console.error('[Editor] Scene detection error:', message);
      if (store) {
        store.setState((state) => setSceneDetectionError(state, message));
      }
    }
  } finally {
    // Clean up manager after detection
    if (sceneDetectionManager) {
      sceneDetectionManager.dispose();
      sceneDetectionManager = null;
    }
  }
}

/**
 * Cleanup editor feature
 *
 * SIMPLIFIED MODEL:
 * - Does NOT close frames (they live in clipPayload)
 * - Frames are only closed when a new clip is created
 */
function cleanup() {
  stopPlayback();

  // Cancel and dispose scene detection
  if (sceneDetectionManager) {
    sceneDetectionManager.dispose();
    sceneDetectionManager = null;
  }

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  if (timelineCleanup) {
    timelineCleanup();
    timelineCleanup = null;
  }

  // Clean up scene panel event listeners
  scenePanelCleanups.forEach((fn) => fn());
  scenePanelCleanups = [];

  baseCanvas = null;
  overlayCanvas = null;
  store = null;
}

/**
 * Get current editor state
 * @returns {import('./types.js').EditorState | null}
 */
export function getEditorState() {
  return store?.getState() ?? null;
}

// ============================================================
// Test Hooks (only available in Playwright test environment)
// ============================================================

/**
 * Register test hooks for editor feature
 * Called during feature initialization to ensure __TEST_HOOKS__ exists
 */
function registerTestHooks() {
  if (typeof window !== 'undefined' && window.__TEST_HOOKS__) {
    window.__TEST_HOOKS__.setEditorState = (stateOverrides) => {
      if (!store) return;
      store.setState((currentState) => ({
        ...currentState,
        ...stateOverrides,
      }));
    };
  }
}
