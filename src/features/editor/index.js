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
import { qsRequired, createElement, on } from '../../shared/utils/dom.js';
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
  setActiveSidebarTab,
} from './state.js';
import { detectScenesAsync } from './scene-detection.js';
import { constrainAspectRatio, getSelectedFrames, normalizeSelectionRange, isFrameInRange } from './core.js';
import { renderEditorScreen, updateBaseCanvas, updateOverlayCanvas, updateTimelineHeader, updateScenePanelUI } from './ui.js';
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
      const backBtn = createElement('button', {
        className: 'btn btn-primary',
        type: 'button',
      }, ['\u2190 Back to Capture']);

      const errorState = createElement('section', {
        className: 'screen editor-screen',
        'aria-labelledby': 'editor-title',
      }, [
        createElement('header', { className: 'screen-header' }, [
          createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
        ]),
        createElement('div', { className: 'editor-empty editor-error' }, [
          createElement('p', {}, ['Invalid clip data: ' + validation.errors.join(', ')]),
          backBtn,
        ]),
      ]);

      container.innerHTML = '';
      container.appendChild(errorState);

      const cleanupBackBtn = on(backBtn, 'click', () => navigate('/capture'));
      emit('editor:validation-error', { errors: validation.errors });

      return () => {
        cleanupBackBtn();
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
    // Build empty state with proper event handlers
    const backBtn = createElement('button', {
      className: 'btn btn-primary',
      type: 'button',
    }, ['\u2190 Back to Capture']);

    const emptyState = createElement('section', {
      className: 'screen editor-screen',
      'aria-labelledby': 'editor-title',
    }, [
      createElement('header', { className: 'screen-header' }, [
        createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
      ]),
      createElement('div', { className: 'editor-empty' }, [
        createElement('p', {}, ['No frames to edit. Please capture some content first.']),
        backBtn,
      ]),
    ]);

    container.innerHTML = '';
    container.appendChild(emptyState);

    // Attach event handler with proper cleanup
    const cleanupBackBtn = on(backBtn, 'click', () => navigate('/capture'));

    return () => {
      cleanupBackBtn();
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

  // Start scene detection in background (only if not already done)
  const initialState = store.getState();
  if (initialState.sceneDetectionStatus === 'idle' && initialState.clip?.frames.length > 0) {
    runSceneDetection(fps);
  }

  // Start auto-playback if initial state is playing
  if (store.getState().isPlaying) {
    startPlayback();
  }

  // Emit loaded event (thumbnails are now rendered directly from frames)
  emit('editor:loaded', { clip: store?.getState().clip });

  // Subscribe to state changes
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

      // Update scene panel when scene detection state changes
      if (state.sceneDetectionStatus !== prevState.sceneDetectionStatus ||
          state.detectedScenes !== prevState.detectedScenes ||
          state.sceneDetectionProgress !== prevState.sceneDetectionProgress) {
        updateScenePanelUI(container, state, {
          onSceneSelect: handleSceneSelect,
        }, fps);
      }
    }, 16) // ~60fps updates
  );

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
    onSidebarTabChange: handleSidebarTabChange,
    onSceneSelect: handleSceneSelect,
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

  const state = store.getState();

  // Always update selectedAspectRatio (independent of cropArea)
  store.setState((s) => setSelectedAspectRatio(s, ratio));

  // If cropArea exists, apply constraint to it
  if (state.cropArea) {
    const constrained = constrainAspectRatio(state.cropArea, ratio);
    store.setState((s) => updateCrop(s, constrained));
    emit('editor:crop', { crop: constrained });
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
 * Handle sidebar tab change
 * @param {import('./types.js').SidebarTab} tab
 */
function handleSidebarTabChange(tab) {
  if (!store) return;
  store.setState((state) => setActiveSidebarTab(state, tab));
}

/**
 * Handle scene selection (from sidebar scene list)
 * @param {import('./types.js').DetectedScene} scene
 */
function handleSceneSelect(scene) {
  if (!store) return;

  // Set range to scene boundaries
  handleRangeChange({
    start: scene.startFrame,
    end: scene.endFrame,
  });

  // Jump playhead to start of scene
  handleFrameChange(scene.startFrame);

  emit('editor:scene-selected', { scene });
}

/**
 * Run scene detection in background
 * @param {number} fps
 */
async function runSceneDetection(fps) {
  if (!store) return;

  const state = store.getState();
  if (!state.clip?.frames.length) return;

  // Mark as detecting
  store.setState(startSceneDetection);

  try {
    const result = await detectScenesAsync(state.clip.frames, {
      threshold: 0.12,
      minSceneFrames: Math.max(3, Math.floor(fps / 5)), // At least 0.2s per scene
      onProgress: (progress) => {
        if (store) {
          store.setState((s) => updateSceneDetectionProgress(s, progress));
        }
      },
    });

    if (store) {
      store.setState((s) => completeSceneDetection(s, result.scenes));
      emit('editor:scenes-detected', { scenes: result.scenes });
    }
  } catch (error) {
    if (store) {
      store.setState(setSceneDetectionError);
    }
    emit('editor:scene-detection-error', { error });
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

/**
 * Cleanup editor feature
 *
 * SIMPLIFIED MODEL:
 * - Does NOT close frames (they live in clipPayload)
 * - Frames are only closed when a new clip is created
 */
function cleanup() {
  stopPlayback();

  if (uiCleanup) {
    uiCleanup();
    uiCleanup = null;
  }

  if (timelineCleanup) {
    timelineCleanup();
    timelineCleanup = null;
  }

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
