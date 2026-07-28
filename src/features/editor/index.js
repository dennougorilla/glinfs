/**
 * Editor Feature Entry Point
 * @module features/editor
 */

import {
  clearEditorPayload,
  compressQueuedClip,
  deleteQueuedClip,
  getClipPayload,
  getClipQueue,
  getEditorPayload,
  hasActiveScreenCapture,
  prepareQueuedClipForPromote,
  promoteQueuedClip,
  setEditorPayload,
  validateClipPayload,
} from '../../shared/app-store.js';
import { emit, on as onBus } from '../../shared/bus.js';
import { renderClipEntries } from '../../shared/clip-entries.js';
import { announce } from '../../shared/live-region.js';
import { navigate } from '../../shared/router.js';
import { createElement, createErrorScreen, qsRequired } from '../../shared/utils/dom.js';
import { frameToTimecode } from '../../shared/utils/format.js';
import { throttle } from '../../shared/utils/performance.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';
import { createSceneDetectionManager } from '../scene-detection/index.js';
import {
  centerCropAfterConstraint,
  constrainAspectRatio,
  getClipFps,
  getPlaybackIntervalMs,
  getPositionInSelection,
} from './core.js';
import { initLiveMonitor } from './live-monitor.js';
import {
  clearCrop,
  completeSceneDetection,
  createEditorStore,
  createEditorStoreFromClip,
  goToFrame,
  setPlaybackSpeed,
  setSceneDetectionError,
  setSelectedAspectRatio,
  startSceneDetection,
  toggleGrid,
  togglePlayback,
  updateCrop,
  updateRange,
  updateSceneDetectionProgress,
} from './state.js';
import { renderTimeline, updatePlayheadPosition, updateTimelineRange } from './timeline.js';
import {
  renderEditorScreen,
  showClipsQueueFullBanner,
  updateBaseCanvas,
  updateClipsPanel,
  updateCropInfoPanel,
  updateOverlayCanvas,
  updateScenesPanel,
  updateScenesSelection,
  updateTimelineHeader,
} from './ui.js';

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

/** @type {(ReturnType<typeof throttle>) | null} */
let subscriptionThrottle = null;

/** @type {(() => void) | null} */
let storeUnsubscribe = null;

/** @type {(() => void)[]} */
let scenePanelCleanups = [];

/** @type {(() => void) | null} Live source monitor dock teardown (#100) */
let liveMonitorCleanup = null;

/** @type {(() => void)[]} */
let cropInfoPanelCleanups = [];

/** @type {(() => void)[]} Clip entry listeners from the last clips-panel render */
let clipsPanelCleanups = [];

/** @type {(() => void)[]} Bus unsubscribers for queue events */
let clipsQueueUnsubs = [];

/** @type {number | null} Timer hiding the transient queue-full banner */
let bannerHideTimer = null;

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
  let clipPayload = getClipPayload();

  // Empty mount with clips waiting in the queue (#95): adopt from the queue
  // instead of falling straight into the error screen.
  if (!hasValidEditorPayload && !validateClipPayload(clipPayload).valid) {
    const queue = getClipQueue();
    if (queue.length === 1 && queue[0].status === 'raw') {
      // Exactly one candidate — promoting it guesses nothing away
      promoteQueuedClip(queue[0].id, null);
      clipPayload = getClipPayload();
    } else if (queue.length >= 1) {
      // Multiple candidates — never auto-pick; let the user choose. A single
      // compressed/compressing candidate also lands here (it needs an async
      // decode) but auto-starts its promote so no extra click is needed —
      // the select screen doubles as its progress surface (#92).
      const autoPromoteId = queue.length === 1 ? queue[0].id : null;
      return renderClipSelectScreen(container, autoPromoteId);
    }
    // 0 queued: fall through to the existing invalid-payload screen
  }

  // Validate payload structure ONLY if not returning from Export
  // When returning from Export, EditorPayload contains all needed data
  if (!hasValidEditorPayload) {
    const validation = validateClipPayload(clipPayload);
    if (!validation.valid) {
      /** @type {(() => void)[]} */
      const cleanups = [];

      const errorScreen = createErrorScreen(
        {
          title: 'Invalid Clip Data',
          message: validation.errors.join(', '),
          actions: [
            {
              label: '\u2190 Back to Capture',
              onClick: () => navigate('/capture'),
              primary: true,
            },
          ],
        },
        cleanups,
      );

      const errorState = createElement(
        'section',
        {
          className: 'screen editor-screen',
          'aria-labelledby': 'editor-title',
        },
        [
          createElement('header', { className: 'screen-header' }, [
            createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
          ]),
          errorScreen,
        ],
      );

      container.innerHTML = '';
      container.appendChild(errorState);

      emit('editor:validation-error', { errors: validation.errors });

      return () => {
        cleanups.forEach((fn) => {
          fn();
        });
        cleanup();
      };
    }
  }

  // Determine frames source: prefer EditorPayload when returning from Export
  const frames = hasValidEditorPayload ? editorPayload.clip.frames : clipPayload?.frames || [];
  const fps = hasValidEditorPayload ? editorPayload.clip.fps : clipPayload?.fps || DEFAULT_FPS;

  if (frames.length === 0) {
    /** @type {(() => void)[]} */
    const cleanups = [];

    const errorScreen = createErrorScreen(
      {
        title: 'No Frames Available',
        message: 'No frames to edit. Please capture some content first.',
        actions: [
          {
            label: '\u2190 Back to Capture',
            onClick: () => navigate('/capture'),
            primary: true,
          },
        ],
      },
      cleanups,
    );

    const emptyState = createElement(
      'section',
      {
        className: 'screen editor-screen',
        'aria-labelledby': 'editor-title',
      },
      [
        createElement('header', { className: 'screen-header' }, [
          createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
        ]),
        errorScreen,
      ],
    );

    container.innerHTML = '';
    container.appendChild(emptyState);

    return () => {
      cleanups.forEach((fn) => {
        fn();
      });
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

    // Restore editor state saved when this clip was demoted (#95). Consumed
    // here — a later mount must not clobber newer edits with this snapshot.
    const saved = clipPayload?.savedEditorState;
    if (saved) {
      clipPayload.savedEditorState = null;
      restoreSavedEditorState(saved, frames.length);
    }
  }

  // Initial render
  render(container);

  // Dock the live source monitor into the sidebar slot (#100). Mounted
  // after render so the slot exists; owns its own bus subscriptions and
  // visibility.
  {
    const slot = container.querySelector('[data-live-monitor]');
    if (slot instanceof HTMLElement) {
      liveMonitorCleanup = initLiveMonitor(slot);
    }
  }

  // Keep the Clips section (and memory footer) live: Clip Now, deletes and
  // promotes from the header popover all mutate the queue from outside this
  // feature. The queue-full banner is the visible surface for refusals.
  clipsQueueUnsubs.push(
    onBus('queue:changed', () => refreshClipsPanel(container)),
    onBus('clip:queue-full', () => showQueueFullBanner(container)),
    onBus('clip:memory-budget', (projection) =>
      showQueueFullBanner(
        container,
        projection?.message ?? 'Memory budget reached — raise Memory Budget in Settings',
      ),
    ),
  );

  // Start auto-playback if initial state is playing
  if (store.getState().isPlaying) {
    startPlayback();
  }

  // Emit loaded event (thumbnails are now rendered directly from frames)
  emit('editor:loaded', { clip: store?.getState().clip });

  // Tracks the values each piece of UI last actually rendered, compared
  // against the delivered state instead of prevState: the 16ms throttle
  // keeps only the latest (state, prevState) pair, so a change coalesced
  // with a following tick (e.g. a range drag followed by a playback frame
  // advance within the same window) would be invisible to a prevState diff
  // (#44, #50). Every field is updated only after its DOM update runs, so
  // it always reflects "what's currently on screen", not "what setState
  // last saw".
  const initialState = store.getState();
  const lastRendered = {
    isPlaying: initialState.isPlaying,
    currentFrame: initialState.currentFrame,
    cropArea: initialState.cropArea,
    showGrid: initialState.showGrid,
    selectedAspectRatio: initialState.selectedAspectRatio,
    sceneDetectionStatus: initialState.sceneDetectionStatus,
    sceneDetectionProgress: initialState.sceneDetectionProgress,
    scenes: initialState.scenes,
    selectedRange: initialState.selectedRange,
  };

  // Subscribe to state changes (must be set up before setting pre-computed scenes)
  subscriptionThrottle = throttle((state) => {
    if (!store || !baseCanvas || !overlayCanvas) return;

    // Update play button icon when playback state changes
    if (state.isPlaying !== lastRendered.isPlaying) {
      const playBtn = container.querySelector('.btn-play');
      if (playBtn) {
        playBtn.classList.toggle('playing', state.isPlaying);
        playBtn.textContent = state.isPlaying ? '\u23F8' : '\u25B6';
        playBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
      }
      lastRendered.isPlaying = state.isPlaying;
    }

    // Single lookup reused by every update below that needs the timeline DOM.
    const timelineContainer = container.querySelector('.editor-timeline-container');

    const frameChanged = state.currentFrame !== lastRendered.currentFrame;

    // Update current time display and playhead position
    if (frameChanged) {
      const currentTimeEl = container.querySelector('.time-display .current');
      if (currentTimeEl) {
        // Calculate position within selection range (clamped)
        const currentInSelection = getPositionInSelection(state.currentFrame, state.selectedRange);
        currentTimeEl.textContent = frameToTimecode(currentInSelection, fps);
      }

      // Update playhead position on timeline
      if (timelineContainer && state.clip) {
        updatePlayheadPosition(
          /** @type {HTMLElement} */ (timelineContainer),
          state.currentFrame,
          state.clip.frames.length,
        );
      }
    }

    // Update base canvas ONLY when frame changes
    if (frameChanged && state.clip?.frames[state.currentFrame]) {
      updateBaseCanvas(baseCanvas, state.clip.frames[state.currentFrame]);
    }

    if (frameChanged) {
      lastRendered.currentFrame = state.currentFrame;
    }

    const cropChanged = state.cropArea !== lastRendered.cropArea;
    const gridChanged = state.showGrid !== lastRendered.showGrid;

    // Update overlay ONLY when crop or grid changes
    // Note: During drag, setupCropInteraction handles overlay updates directly
    if (cropChanged || gridChanged) {
      const frame = state.clip?.frames[state.currentFrame];
      if (frame) {
        updateOverlayCanvas(
          overlayCanvas,
          state.cropArea,
          frame.width,
          frame.height,
          state.showGrid,
        );
      }
    }

    // Update crop info panel when crop changes
    if (cropChanged) {
      // Clean up previous crop info panel event listeners
      cropInfoPanelCleanups.forEach((fn) => {
        fn();
      });
      // Update panel and collect new cleanups
      cropInfoPanelCleanups = updateCropInfoPanel(container, state.cropArea, handleCropChange);
      lastRendered.cropArea = state.cropArea;
    }

    // Update timeline selection
    if (timelineContainer && state.clip) {
      updateTimelineRange(
        /** @type {HTMLElement} */ (timelineContainer),
        state.selectedRange,
        state.clip.frames.length,
      );
    }

    const rangeChanged =
      state.selectedRange.start !== lastRendered.selectedRange.start ||
      state.selectedRange.end !== lastRendered.selectedRange.end;

    // Update timeline header info when selection changes
    if (rangeChanged) {
      updateTimelineHeader(container, state.selectedRange, state.currentFrame, fps);
    }

    // Update aspect ratio buttons when selection changes
    if (state.selectedAspectRatio !== lastRendered.selectedAspectRatio) {
      const aspectBtns = container.querySelectorAll('.aspect-btn');
      aspectBtns.forEach((btn) => {
        btn.classList.toggle(
          'active',
          /** @type {HTMLElement} */ (btn).dataset.ratio === state.selectedAspectRatio,
        );
      });
      lastRendered.selectedAspectRatio = state.selectedAspectRatio;
    }

    // Update grid button when grid state changes
    if (gridChanged) {
      const gridBtn = container.querySelector('.btn-grid-toggle');
      if (gridBtn) {
        gridBtn.classList.toggle('active', state.showGrid);
        gridBtn.textContent = state.showGrid ? 'On' : 'Off';
        gridBtn.setAttribute('aria-pressed', String(state.showGrid));
      }
      lastRendered.showGrid = state.showGrid;
    }

    // Full rebuild only when the scene list/status actually changes - a
    // rangeChanged-only tick (e.g. every 16ms during a drag) must NOT tear
    // down and recreate the whole scenes sidebar (issue #99, fix 2).
    const scenesStructureChanged =
      state.sceneDetectionStatus !== lastRendered.sceneDetectionStatus ||
      state.sceneDetectionProgress !== lastRendered.sceneDetectionProgress ||
      state.scenes !== lastRendered.scenes;

    if (scenesStructureChanged) {
      // Clean up previous scene panel event listeners
      scenePanelCleanups.forEach((fn) => {
        fn();
      });
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
      lastRendered.sceneDetectionStatus = state.sceneDetectionStatus;
      lastRendered.sceneDetectionProgress = state.sceneDetectionProgress;
      lastRendered.scenes = state.scenes;
    } else if (rangeChanged) {
      // Cheap path: just flip is-selected on existing cards, no DOM churn.
      updateScenesSelection(container, state);
    }

    // Committed after both the header and the scenes-panel checks above, since
    // both branch on rangeChanged against the same last-rendered snapshot.
    if (rangeChanged) {
      lastRendered.selectedRange = state.selectedRange;
    }
  }, 16); // ~60fps updates
  storeUnsubscribe = store.subscribe(subscriptionThrottle);

  // Use pre-computed scenes from Capture or fallback to async detection
  // (must be after subscription is set up so scenes panel gets updated)
  // Also applies when returning from Export: the EditorPayload does not carry
  // scenes, so re-apply them from the ClipPayload still held in the app store (#43)
  if (clipPayload?.sceneDetectionEnabled) {
    if (Array.isArray(clipPayload.scenes)) {
      // Use pre-computed scenes from Capture. An empty array is a legitimate
      // completed result (no transitions found) — re-running detection for it
      // would flash a detecting state and burn worker time on every return
      // from Export.
      store.setState((state) => completeSceneDetection(state, clipPayload.scenes));
      if (clipPayload.scenes.length > 0) {
        emit('editor:scenes-detected', { sceneCount: clipPayload.scenes.length });
        console.log('[Editor] Using pre-computed scenes:', clipPayload.scenes.length, 'scenes');
      }
    } else if (frames.length > 0) {
      // Fallback: run detection if scenes were never computed
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

  const result = renderEditorScreen(
    container,
    state,
    {
      onTogglePlay: handleTogglePlay,
      onFrameChange: handleFrameChange,
      onRangeChange: handleRangeChange,
      onCropChange: handleCropChange,
      onToggleGrid: handleToggleGrid,
      onAspectRatioChange: handleAspectRatioChange,
      onSpeedChange: handleSpeedChange,
      onExport: handleExport,
      onPromoteClip: handlePromoteClip,
      onDeleteClip: handleDeleteClip,
      getState: () => store?.getState() ?? null,
      getFrame: () => {
        const s = store?.getState();
        return s?.clip?.frames[s.currentFrame] ?? null;
      },
    },
    getClipFps(state.clip),
  );

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
    },
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
  const interval = getPlaybackIntervalMs(getClipFps(state.clip), state.playbackSpeed);

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
    clip: state.clip, // For returning to Editor with preserved state
    fps: state.clip.fps,
  });

  const selectedCount = state.selectedRange.end - state.selectedRange.start + 1;

  emit('editor:export-ready', {
    frameCount: selectedCount,
    fps: state.clip.fps,
  });
}

// ============================================================
// Clip Queue (#95)
// ============================================================

/**
 * Apply the editor state a clip carried through its demote/promote
 * round-trip. Ranges and frame indices are clamped defensively — they came
 * from this same clip, but a stale snapshot must never crash the editor.
 *
 * @param {import('../../shared/app-store.js').SavedEditorState} saved
 * @param {number} frameCount
 */
function restoreSavedEditorState(saved, frameCount) {
  if (!store || frameCount === 0) return;

  store.setState((state) => {
    let newState = state;
    if (saved.selectedRange) {
      const start = Math.max(0, Math.min(saved.selectedRange.start, frameCount - 1));
      const end = Math.max(start, Math.min(saved.selectedRange.end, frameCount - 1));
      newState = updateRange(newState, { start, end });
    }
    if (saved.cropArea) {
      newState = updateCrop(newState, saved.cropArea);
    }
    if (typeof saved.playbackSpeed === 'number') {
      newState = setPlaybackSpeed(newState, saved.playbackSpeed);
    }
    if (typeof saved.currentFrame === 'number') {
      newState = goToFrame(newState, saved.currentFrame);
    }
    return newState;
  });
}

/**
 * Re-render the Clips section after any queue mutation
 * @param {HTMLElement} container
 */
function refreshClipsPanel(container) {
  clipsPanelCleanups.forEach((fn) => {
    fn();
  });
  clipsPanelCleanups = updateClipsPanel(
    container,
    /** @type {import('./ui.js').EditorUIHandlers} */ ({
      onPromoteClip: handlePromoteClip,
      onDeleteClip: handleDeleteClip,
    }),
  );
}

/**
 * Show the transient queue-full banner (refusal surface, amendment 2)
 * @param {HTMLElement} container
 */
function showQueueFullBanner(container, message) {
  if (bannerHideTimer !== null) {
    clearTimeout(bannerHideTimer);
    bannerHideTimer = null;
  }
  const hide = showClipsQueueFullBanner(container, message);
  if (!hide) return;
  bannerHideTimer = window.setTimeout(() => {
    hide();
    bannerHideTimer = null;
  }, 4000);
}

/**
 * Synchronously swap a READY (raw) queued clip with the active clip. The
 * active clip demotes carrying the current selection/crop/speed/position
 * (captured HERE, at swap time — so edits made while a compressed entry was
 * decoding are what get saved), and the editor re-inits against the new
 * active clip. No frames are closed anywhere on this path — see the
 * app-store ownership rules.
 *
 * @param {string} id - Queue entry id
 * @returns {boolean} true if the swap happened
 */
function swapPromotedClip(id) {
  if (!store) return false;

  const state = store.getState();
  const result = promoteQueuedClip(id, {
    selectedRange: state.selectedRange,
    cropArea: state.cropArea,
    playbackSpeed: state.playbackSpeed,
    currentFrame: state.currentFrame,
    scenes: state.scenes,
  });
  if (!result) return false;

  // Internal reinit: full cleanup + re-init restores the promoted clip's
  // saved state via the savedEditorState consume in initEditor.
  cleanup();
  initEditor();
  return true;
}

/**
 * Promote a queued clip into the editor. Raw entries swap synchronously;
 * compressed (or still-compressing) entries decode first (#92) — the entry
 * shows its 'decoding' state via queue:changed, the CURRENT clip stays fully
 * editable until the frames arrive, and a second promote of the same entry
 * is refused by the store while the decode is in flight.
 *
 * @param {string} id - Queue entry id
 * @returns {boolean} true if the promote was started (async) or completed (sync)
 */
function handlePromoteClip(id) {
  if (!store) return false;
  const entry = getClipQueue().find((e) => e.id === id);
  if (!entry) return false;

  if (entry.status === 'raw') {
    return swapPromotedClip(id);
  }
  void promoteWhenDecoded(id);
  return true;
}

/**
 * Async tail of a promote that needs the codec: waits for the entry's frames
 * (encode-in-flight and/or decode), then runs the normal sync swap against
 * whatever editor session is CURRENT by then.
 *
 * @param {string} id - Queue entry id
 * @returns {Promise<boolean>} true if the clip became active
 */
async function promoteWhenDecoded(id) {
  const prep = await prepareQueuedClipForPromote(id);
  if (!prep.ok) {
    // 'decoding' = double-promote, silently ignored (first click wins);
    // 'not-found' = deleted meanwhile — the queue UI already reflects it
    if (prep.reason === 'decode-failed') {
      announce('Could not open clip — decoding failed');
    }
    return false;
  }

  if (store) {
    return swapPromotedClip(id);
  }

  // The editor unmounted while we were decoding. Do not yank the user to a
  // different clip from a background task — hand the (now raw) entry back to
  // the queue and let it re-compress (#92 invariant: only the active clip
  // holds raw frames).
  compressQueuedClip(id);
  return false;
}

/**
 * Delete a queued clip. Confirmation is the inline two-step control on the
 * entry's delete button (#98) - by the time this runs the user has already
 * confirmed; no blocking dialog.
 * @param {string} id
 */
function handleDeleteClip(id) {
  if (deleteQueuedClip(id)) {
    announce('Clip deleted from queue');
  }
}

/**
 * Promote a queued clip from OUTSIDE the editor (header popover in main.js).
 * When the editor is mounted this is a full in-place swap+reinit; when it is
 * not, the clip just becomes the active payload and the caller navigates.
 *
 * Async because compressed entries decode first (#92). For raw entries the
 * promise resolves in the same microtask, so callers can still navigate
 * without a visible delay.
 *
 * @param {string} id - Queue entry id
 * @returns {Promise<boolean>} true if the clip was promoted (or the promote
 *   was completed by a mounted editor)
 */
export async function promoteClipFromQueue(id) {
  if (store) {
    return handlePromoteClip(id);
  }

  const entry = getClipQueue().find((e) => e.id === id);
  if (!entry) return false;

  if (entry.status !== 'raw') {
    const prep = await prepareQueuedClipForPromote(id);
    if (!prep.ok) return false;
    // The editor may have mounted while we decoded — finish the promote as
    // an in-place swap there instead of silently replacing its clip
    if (store) return swapPromotedClip(id);
  }
  return promoteQueuedClip(id, null) !== null;
}

/**
 * "Select a clip to edit" screen: shown when the editor mounts with no
 * active clip but queued clips it cannot instantly adopt — two or more
 * candidates (never guess which one), or a single compressed/compressing
 * one whose decode is async (#92; auto-started via autoPromoteId so the
 * screen is just its progress surface).
 *
 * @param {HTMLElement} container
 * @param {string|null} [autoPromoteId] - Entry to start promoting immediately
 * @returns {() => void} Route cleanup
 */
function renderClipSelectScreen(container, autoPromoteId = null) {
  updateStepIndicator('editor', { isCapturing: hasActiveScreenCapture() });

  /** @type {(() => void)[]} */
  let entryCleanups = [];
  let disposed = false;

  const listHost = createElement('div', { className: 'editor-clip-select-list' });
  const screenEl = createElement(
    'section',
    {
      className: 'screen editor-screen editor-clip-select',
      'aria-labelledby': 'editor-title',
    },
    [
      createElement('header', { className: 'screen-header' }, [
        createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
      ]),
      createElement('p', { className: 'editor-clip-select-hint' }, ['Select a clip to edit']),
      listHost,
    ],
  );

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    entryCleanups.forEach((fn) => {
      fn();
    });
    entryCleanups = [];
    unsubscribe();
  };

  const renderList = () => {
    entryCleanups.forEach((fn) => {
      fn();
    });
    entryCleanups = renderClipEntries(listHost, {
      queue: getClipQueue(),
      // promoteQueuedClip emits 'queue:changed' SYNCHRONOUSLY, which the
      // subscription below turns into the swap to the full editor. Calling
      // initEditor here as well would double-init the feature. Compressed
      // entries go through promoteClipFromQueue (store is null here) whose
      // decode completion triggers the same event.
      onPromote: (id) => {
        void promoteClipFromQueue(id);
      },
      onDelete: handleDeleteClip,
    });
  };

  // The queue can still change under this screen (Clip Now, the header
  // popover). A promote from the popover makes a clip active — swap this
  // screen for the real editor; anything else just re-renders the list.
  const unsubscribe = onBus('queue:changed', () => {
    if (disposed) return;
    if (getClipPayload()) {
      dispose();
      initEditor();
      return;
    }
    renderList();
  });

  container.innerHTML = '';
  container.appendChild(screenEl);
  renderList();

  // Single async candidate (#92): start its promote now; the decode statuses
  // re-render the list above and the final promote swaps in the editor
  if (autoPromoteId) {
    void promoteClipFromQueue(autoPromoteId);
  }

  emit('editor:clip-select', { queueLength: getClipQueue().length });

  return () => {
    dispose();
    cleanup();
  };
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

  // Snapshot this session's store and manager. Every deferred callback
  // below must write through these locals with an isCurrent() guard —
  // reading the module-level bindings after an await would let a stale
  // run (whose editor was already cleaned up) write errors into, or
  // dispose the manager of, a NEWER editor session (#risk: cross-session
  // corruption when navigating away and back during init/detect).
  const sessionStore = store;
  const manager = createSceneDetectionManager();
  sceneDetectionManager = manager;
  const isCurrent = () => store === sessionStore;

  // Update state to show detection in progress
  sessionStore.setState(startSceneDetection);

  try {
    await manager.init();

    // Run detection with progress updates
    const result = await manager.detect(frames, {
      threshold: 0.3,
      minSceneDuration: 5,
      sampleInterval: 1,
      onProgress: (progress) => {
        if (isCurrent()) {
          sessionStore.setState((state) => updateSceneDetectionProgress(state, progress.percent));
        }
      },
    });

    // Update state with results
    if (isCurrent()) {
      sessionStore.setState((state) => completeSceneDetection(state, result.scenes));
      emit('editor:scenes-detected', {
        sceneCount: result.scenes.length,
        processingTimeMs: result.processingTimeMs,
      });
    }

    console.log(
      '[Editor] Scene detection completed:',
      result.scenes.length,
      'scenes found in',
      result.processingTimeMs,
      'ms',
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Detection was cancelled, not an error
      console.log('[Editor] Scene detection cancelled');
    } else {
      const message = error instanceof Error ? error.message : 'Scene detection failed';
      console.error('[Editor] Scene detection error:', message);
      if (isCurrent()) {
        sessionStore.setState((state) => setSceneDetectionError(state, message));
      }
    }
  } finally {
    // Dispose THIS run's manager; only clear the module reference if it
    // still points at it (a newer session may have replaced it)
    manager.dispose();
    if (sceneDetectionManager === manager) {
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

  if (liveMonitorCleanup) {
    liveMonitorCleanup();
    liveMonitorCleanup = null;
  }

  // Cancel any pending throttled subscription update and drop the
  // subscription itself (same pattern as capture's cleanup)
  if (subscriptionThrottle) {
    subscriptionThrottle.cancel();
    subscriptionThrottle = null;
  }
  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }

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
  scenePanelCleanups.forEach((fn) => {
    fn();
  });
  scenePanelCleanups = [];

  // Clean up crop info panel event listeners
  cropInfoPanelCleanups.forEach((fn) => {
    fn();
  });
  cropInfoPanelCleanups = [];

  // Clip queue: drop bus subscriptions, entry listeners and banner timer
  clipsQueueUnsubs.forEach((fn) => {
    fn();
  });
  clipsQueueUnsubs = [];
  clipsPanelCleanups.forEach((fn) => {
    fn();
  });
  clipsPanelCleanups = [];
  if (bannerHideTimer !== null) {
    clearTimeout(bannerHideTimer);
    bannerHideTimer = null;
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
    window.__TEST_HOOKS__.getEditorState = () => {
      const state = store?.getState();
      if (!state) return null;
      // Only serializable scalars — frames/VideoFrames must not cross
      // page.evaluate boundaries
      return {
        selectedRange: state.selectedRange,
        currentFrame: state.currentFrame,
        playbackSpeed: state.playbackSpeed,
        cropArea: state.cropArea,
        frameCount: state.clip?.frames?.length ?? 0,
      };
    };
  }
}
