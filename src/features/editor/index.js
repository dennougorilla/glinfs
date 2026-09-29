/**
 * Editor Feature Entry Point
 * @module features/editor
 */

import {
  clearEditorPayload,
  compressQueuedClip,
  deleteActiveClip,
  deleteQueuedClip,
  getClipPayload,
  getClipQueue,
  getEditorPayload,
  hasActiveScreenCapture,
  hasPendingDeletion,
  prepareQueuedClipForPromote,
  promoteQueuedClip,
  setEditorPayload,
  toSavedEditorState,
  undoDelete,
  validateClipPayload,
} from '../../shared/app-store.js';
import { emit, on as onBus } from '../../shared/bus.js';
import {
  createLayerId,
  EDIT_LIMITS,
  isAiCutoutActive,
  isColorKeyActive,
  normalizeEdits,
  requiresTransparency,
} from '../../shared/edits/model.js';
import {
  extendStrokePath,
  getStrokePathPoints,
  startStrokePath,
} from '../../shared/edits/touch-ups.js';
import { announce } from '../../shared/live-region.js';
import { navigate, redirect } from '../../shared/router.js';
import { showToast } from '../../shared/toast.js';
import { loadSettings } from '../../shared/user-settings.js';
import { createElement, createErrorScreen, qsRequired } from '../../shared/utils/dom.js';
import { frameToTimecode } from '../../shared/utils/format.js';
import { throttle } from '../../shared/utils/performance.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';
import { getSharedMaskStore } from '../ai-cutout/mask-store.js';
import { getModelEntry } from '../ai-cutout/model-registry.js';
import { getSegmentationManager } from '../ai-cutout/segmentation-manager.js';
import { openExportDialog } from '../export/index.js';
import { createSceneDetectionManager } from '../scene-detection/index.js';
import {
  getAiModelId,
  getSharedFinalMaskCache,
  isFrameAnalyzed,
  pickFindsCharacter,
} from './ai-cutout.js';
import { createAiCutoutSession } from './ai-cutout-session.js';
import {
  centerCropAfterConstraint,
  constrainAspectRatio,
  getClipFps,
  getPlaybackFrame,
  getPositionInSelection,
} from './core.js';
import {
  createEditorFrameRenderer,
  detectOutputEdgeColor,
  getSelectedTextOverlay,
  previewDependsOnCrop,
} from './edits-preview.js';
import { initLiveMonitor } from './live-monitor.js';
import { updateEditsPanel } from './panels/edits-panel.js';
import { isBrushActive, setOverlayPickMode, updatePreviewViewSwitch } from './panels/preview.js';
import { updateSidebarTabs } from './panels/properties.js';
import { updateDeleteHint } from './panels/status-bar.js';
import { TOUCH_UP_NEEDS_REMOVAL, updateTouchUpSection } from './panels/touch-up-panel.js';
import {
  addAiPick,
  addTextLayer,
  addTouchUps,
  canClearTouchUpsOnFrame,
  clearAiPicks,
  clearAllTouchUps,
  clearCrop,
  clearTouchUpsOnFrame,
  completeSceneDetection,
  createEditorStore,
  createEditorStoreFromClip,
  getBrushStrokeRange,
  getEffectivePreviewView,
  goToFrame,
  moveTextLayer,
  PICK_NEEDS_ANALYSIS_NOTICE,
  PICK_NO_CHARACTER_NOTICE,
  removeAiPick,
  removeTextLayer,
  selectTextLayer,
  setAiParams,
  setAiPickTool,
  setBackground,
  setBackgroundMethod,
  setBrush,
  setEdits,
  setPickingKeyColor,
  setPlaybackSpeed,
  setPlaying,
  setPreviewView,
  setSceneDetectionError,
  setSelectedAspectRatio,
  setSidebarTab,
  startSceneDetection,
  toggleGrid,
  togglePlayback,
  undoTouchUp,
  updateAiCutoutStatus,
  updateCrop,
  updateRange,
  updateSceneDetectionProgress,
  updateTextLayer,
} from './state.js';
import { renderTimeline, updatePlayheadPosition, updateTimelineRange } from './timeline.js';
import {
  renderEditorScreen,
  showClipsQueueFullBanner,
  updateClipsMemoryFooter,
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
let playbackFrameId = null;

/**
 * Playback clock anchor: frames are derived from elapsed time since `time`,
 * re-anchored whenever the playhead, range, speed or FPS changes outside the loop
 * @type {{ frame: number, time: number, speed: number, fps: number, rangeStart: number, rangeEnd: number, lastFrame: number } | null}
 */
let playbackAnchor = null;

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

/**
 * Preview renderer of this editor session (owns the keyed-region cache)
 * @type {ReturnType<typeof createEditorFrameRenderer> | null}
 */
let previewRenderer = null;

/**
 * A crop drag on the preview is in progress: the preview skips background
 * removal until the drag is released (re-keying the moving region on every
 * pointer move would read back and flood-fill it per tick)
 */
let cropDragging = false;

/**
 * AI cutout session of this editor mount (analysis + final masks)
 * @type {ReturnType<typeof createAiCutoutSession> | null}
 */
let aiSession = null;

/** @type {(() => void) | null} Unsubscribes the AI session's edits watcher */
let aiEditsUnsubscribe = null;

/**
 * The deleted active clip this editor keeps on screen while the successor
 * decodes (see handleDeleteActiveClip)
 * @type {{ id: string, frames: import('../capture/types.js').Frame[] } | null}
 */
let deletedClipOnScreen = null;

/**
 * The Export GIF dialog open over this editor, or null
 * @type {import('../export/index.js').ExportDialogHandle | null}
 */
let exportDialog = null;

/**
 * `#/export` asked for the editor with the Export dialog open: the next
 * editor mount takes the request (see initExportRoute) and opens the dialog
 * once it shows the clip
 */
let pendingExportDialog = false;

/** @typedef {import('../../shared/edits/model.js').TouchUp} TouchUp */

/**
 * The mask brush gesture in progress (pointer down until released): its
 * strokes preview live (drawPreview adds them to the edits) and are added
 * to the edits together when the pointer is released; Escape drops them.
 * A stroke is one path, so the pointer leaving the preview ends the current
 * one (`pieces`) and coming back starts another with the same settings.
 * `live` is the stroke being painted as the renderer sees it (a new object
 * whenever its path changes).
 * @type {{
 *   settings: Omit<TouchUp, 'id' | 'points'>,
 *   width: number,
 *   height: number,
 *   pieces: TouchUp[],
 *   path: import('../../shared/edits/touch-ups.js').StrokePath | null,
 *   live: TouchUp | null,
 * } | null}
 */
let brushGesture = null;

/** @type {number | null} requestAnimationFrame of the live stroke preview */
let brushDrawFrameId = null;

/**
 * The right sidebar's last chosen tab: kept for the whole page session, so
 * switching clips (a new editor state) reopens the same tab
 * @type {import('./types.js').SidebarTab}
 */
let lastSidebarTab = 'frame';

/** Default FPS for editor */
const DEFAULT_FPS = 30;

/**
 * The default speed of a new clip: the user setting `export.playbackSpeed`
 * (kept only for this since the editor speed became the GIF speed)
 * @returns {number}
 */
function getDefaultClipSpeed() {
  try {
    const speed = Number(loadSettings().export.playbackSpeed);
    return Number.isFinite(speed) && speed > 0 ? speed : 1;
  } catch {
    return 1;
  }
}

// Probability masks belong to clips. When a clip's frames are released for
// good (its deletion's Undo window ended, or a fresh session drained
// everything) its masks go too; a full reset also stops the model worker.
// Subscribed at module scope: the Undo timer can fire on any screen.
onBus('clips:released', (/** @type {{ ids?: string[], reset?: boolean }} */ detail) => {
  const maskStore = getSharedMaskStore();
  if (detail?.reset) {
    getSegmentationManager().dispose();
    maskStore.clear();
    getSharedFinalMaskCache().clear();
    return;
  }
  for (const id of detail?.ids ?? []) {
    // Frames of the clip still in the worker must not store masks afterwards
    getSegmentationManager().forgetClip(id);
    maskStore.deleteClip(id);
    // Its memoized final masks (~22 MB for 300 frames) and a build for it
    getSharedFinalMaskCache().forgetClip(id);
  }
});

/**
 * Mask store group of the clip being edited: the active clip payload's
 * stable id (it survives demote/promote), when this editor shows it
 * @returns {string | undefined}
 */
function getActiveClipId() {
  const state = store?.getState();
  if (!state?.clip) return undefined;
  const payload = getClipPayload();
  if (payload && payload.frames === state.clip.frames) return payload.id;
  // The active clip was deleted and stays on screen while its successor
  // decodes: an analysis now still belongs to that clip (so its masks go
  // when the deletion is final), not to the default group nothing releases
  if (deletedClipOnScreen && deletedClipOnScreen.frames === state.clip.frames) {
    return deletedClipOnScreen.id;
  }
  return undefined;
}

/**
 * Initialize editor feature
 */
export function initEditor() {
  // A `#/export` request is for this mount only: taken first, so a mount
  // that fails, shows an error or is left while a clip opens can't leave it
  // armed for a later, unrelated mount
  const openExportDialogOnMount = pendingExportDialog;
  pendingExportDialog = false;

  const container = qsRequired('#main-content');

  // Register test hooks
  registerTestHooks();

  // Check if returning from Export - restore state from EditorPayload FIRST
  // This takes priority over ClipPayload since Export preserves editor state
  const editorPayload = getEditorPayload();
  const hasValidEditorPayload = editorPayload?.clip?.frames?.length > 0;

  // Get clip payload from capture via app store
  let clipPayload = getClipPayload();

  // Empty mount with clips waiting in the queue: ALWAYS adopt the newest
  // one automatically (#100 round 5 — the select screen read as a dark
  // broken state and forced a pointless choice; the queue is ordered
  // newest-first, which is what the user just made and wants to see).
  if (!hasValidEditorPayload && !validateClipPayload(clipPayload).valid) {
    const queue = getClipQueue();
    if (queue.length >= 1 && queue[0].status === 'raw') {
      promoteQueuedClip(queue[0].id, null);
      clipPayload = getClipPayload();
    } else if (queue.length >= 1) {
      // Newest entry needs the codec (compressed / still compressing):
      // show a lightweight opening state while it decodes, then re-init
      return renderClipOpeningScreen(container, queue[0].id, openExportDialogOnMount);
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
    // Restore state from EditorPayload (preserves selection range, crop area,
    // edits)
    store = createEditorStoreFromClip({
      ...editorPayload.clip,
      edits: editorPayload.edits ?? editorPayload.clip.edits,
      hasAlpha: editorPayload.hasAlpha ?? editorPayload.clip.hasAlpha ?? clipPayload?.hasAlpha,
    });
    const payloadSpeed = editorPayload.playbackSpeed;
    store.setState((state) =>
      setPlaybackSpeed(
        state,
        typeof payloadSpeed === 'number' && payloadSpeed > 0 ? payloadSpeed : getDefaultClipSpeed(),
      ),
    );
    // Clear EditorPayload after consuming to prevent stale frame references on subsequent navigations
    clearEditorPayload();
    emit('editor:restored', { fromExport: true });
  } else {
    // Create fresh store from ClipPayload. A new clip starts at the default
    // speed; a clip's saved speed (below) wins.
    store = createEditorStore(frames, fps, { hasAlpha: clipPayload?.hasAlpha });
    store.setState((state) => setPlaybackSpeed(state, getDefaultClipSpeed()));

    // Restore editor state saved when this clip was demoted (#95). Consumed
    // here — a later mount must not clobber newer edits with this snapshot.
    const saved = clipPayload?.savedEditorState;
    if (saved) {
      clipPayload.savedEditorState = null;
      restoreSavedEditorState(saved, frames.length);
    }
  }

  // The sidebar reopens on the tab chosen last in this page session
  store.setState((state) => setSidebarTab(state, lastSidebarTab));

  previewRenderer = createEditorFrameRenderer();
  cropDragging = false;

  startAiCutoutSession();

  // Initial render
  render(container);

  // Draw the current frame SYNCHRONOUSLY before the browser can paint —
  // the canvas otherwise stays black until the first (throttled)
  // subscription tick, which reads as a dark flash on every mount/reinit
  // (promote, active-delete succession) (#100 round 6).
  drawPreview(store.getState());
  drawOverlay(store.getState());

  // Dock the live source monitor into the sidebar slot (#100). Mounted
  // after render so the slot exists; owns its own bus subscriptions and
  // visibility.
  {
    const slot = container.querySelector('[data-live-monitor]');
    const previewHost = container.querySelector('.editor-preview-wrapper');
    if (slot instanceof HTMLElement) {
      liveMonitorCleanup = initLiveMonitor(
        slot,
        previewHost instanceof HTMLElement ? previewHost : null,
      );
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
    edits: initialState.edits,
    selectedTextId: initialState.selectedTextId,
    pickingKeyColor: initialState.pickingKeyColor,
    aiPickTool: initialState.aiPickTool,
    aiCutout: initialState.aiCutout,
    brush: initialState.brush,
    sidebarTab: initialState.sidebarTab,
    previewView: initialState.previewView,
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

    const cropChanged = state.cropArea !== lastRendered.cropArea;
    const gridChanged = state.showGrid !== lastRendered.showGrid;
    const editsChanged = state.edits !== lastRendered.edits;
    const textSelectionChanged = state.selectedTextId !== lastRendered.selectedTextId;
    const pickingChanged = state.pickingKeyColor !== lastRendered.pickingKeyColor;
    const pickToolChanged = state.aiPickTool !== lastRendered.aiPickTool;
    const aiChanged = state.aiCutout !== lastRendered.aiCutout;
    const brushChanged = state.brush !== lastRendered.brush;
    const masksChanged = state.aiCutout.maskVersion !== lastRendered.aiCutout.maskVersion;
    const tabChanged = state.sidebarTab !== lastRendered.sidebarTab;
    const viewChanged = state.previewView !== lastRendered.previewView;
    const editsUseCrop = previewDependsOnCrop(state.edits, state.clip?.hasAlpha);
    // The analysis coverage shown in the panel depends on the selection
    const selectionChanged =
      state.selectedRange.start !== lastRendered.selectedRange.start ||
      state.selectedRange.end !== lastRendered.selectedRange.end;
    // The Touch up section counts the strokes on the current frame and says
    // when the frame lies outside the selection: only that section follows
    // the playhead (not the whole panel on every played frame)
    const touchUpSectionStale =
      (frameChanged || selectionChanged) && (state.edits.touchUps.length > 0 || state.brush.on);

    // Update base canvas ONLY when the composed frame changes
    if (
      frameChanged ||
      editsChanged ||
      masksChanged ||
      viewChanged ||
      (cropChanged && editsUseCrop)
    ) {
      drawPreview(state);
    }
    // Sidebar tab, the Background tab's badge, the Touch up mode swap and
    // the preview's view switch
    if (tabChanged || brushChanged || editsChanged || aiChanged) {
      updateSidebarTabs(container, state);
      lastRendered.sidebarTab = state.sidebarTab;
    }
    if (viewChanged || editsChanged) {
      updatePreviewViewSwitch(container, state);
      lastRendered.previewView = state.previewView;
    }
    if (frameChanged || editsChanged || aiChanged) {
      updateAiPreviewNote(container, state);
    }

    if (frameChanged) {
      lastRendered.currentFrame = state.currentFrame;
    }

    // Update overlay ONLY when crop, grid or the selected text box changes
    // (a frame change can move the selected layer in/out of its range).
    // Note: During drag, setupCropInteraction handles overlay updates directly
    if (
      cropChanged ||
      gridChanged ||
      editsChanged ||
      textSelectionChanged ||
      (frameChanged && state.selectedTextId !== null)
    ) {
      drawOverlay(state);
    }

    if (
      editsChanged ||
      textSelectionChanged ||
      pickingChanged ||
      pickToolChanged ||
      aiChanged ||
      brushChanged ||
      (selectionChanged && state.edits.background.method === 'ai')
    ) {
      updateEditsPanel(container, state, fps);
      if (textSelectionChanged) {
        updateDeleteHint(container, state.selectedTextId);
      }
      if (pickingChanged) {
        container
          .querySelector('.editor-canvas-container')
          ?.classList.toggle('editor-bg-picking', state.pickingKeyColor);
      }
      if (pickToolChanged) {
        container
          .querySelector('.editor-canvas-container')
          ?.classList.toggle('editor-ai-picking', state.aiPickTool !== null);
        updateOverlayPickMode(container, state.aiPickTool, lastRendered.aiPickTool);
      }
      if (brushChanged || editsChanged) {
        container
          .querySelector('.editor-canvas-container')
          ?.classList.toggle('editor-brush-painting', isBrushActive(state));
      }
      lastRendered.edits = state.edits;
      lastRendered.selectedTextId = state.selectedTextId;
      lastRendered.pickingKeyColor = state.pickingKeyColor;
      lastRendered.aiPickTool = state.aiPickTool;
      lastRendered.aiCutout = state.aiCutout;
      lastRendered.brush = state.brush;
    } else if (touchUpSectionStale) {
      updateTouchUpSection(container, state);
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

  // `#/export` deep link: the editor with the Export dialog open
  if (openExportDialogOnMount) {
    handleExport();
  }

  return cleanup;
}

/**
 * Route handler of `#/export`, which is no longer a screen: with a clip to
 * edit (the active one, an editor payload, or a queued one the editor
 * adopts) it opens the editor with the Export dialog open; otherwise it
 * goes to Capture. Redirects replace the history entry, so Back never lands
 * on `#/export` again.
 * @returns {(nextRoute: import('../../shared/router.js').Route) => void}
 */
export function initExportRoute() {
  const hasClip =
    (getEditorPayload()?.clip?.frames?.length ?? 0) > 0 ||
    validateClipPayload(getClipPayload()).valid ||
    getClipQueue().length > 0;
  if (hasClip) {
    pendingExportDialog = true;
    redirect('/editor');
  } else {
    redirect('/capture');
  }
  return (nextRoute) => {
    // Went somewhere else before the editor mounted: forget the request
    if (nextRoute !== '/editor') pendingExportDialog = false;
  };
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
      onCropDragEnd: handleCropDragEnd,
      onToggleGrid: handleToggleGrid,
      onAspectRatioChange: handleAspectRatioChange,
      onSpeedChange: handleSpeedChange,
      onExport: handleExport,
      onPromoteClip: handlePromoteClip,
      onDeleteClip: handleDeleteClip,
      onDeleteActiveClip: handleDeleteActiveClip,
      onAddText: handleAddText,
      onSelectText: handleSelectText,
      onUpdateText: handleUpdateText,
      onRemoveText: handleRemoveText,
      onMoveText: handleMoveText,
      onSetBackground: handleSetBackground,
      onToggleBackground: handleToggleBackground,
      onSetPickingKeyColor: handleSetPickingKeyColor,
      onPickKeyColor: handlePickKeyColor,
      onPickTransparentArea: handlePickTransparentArea,
      onSetBackgroundMethod: handleSetBackgroundMethod,
      onAiAnalyze: handleAiAnalyze,
      onAiCancel: handleAiCancel,
      onAiAllowWasm: handleAiAllowWasm,
      onSetAiParams: handleSetAiParams,
      onSetAiModel: handleSetAiModel,
      onSetAiPickTool: handleSetAiPickTool,
      onAiPick: handleAiPick,
      onRemoveAiPick: handleRemoveAiPick,
      onClearAiPicks: handleClearAiPicks,
      onSetBrush: handleSetBrush,
      onBrushStrokeStart: handleBrushStrokeStart,
      onBrushStrokeMove: handleBrushStrokeMove,
      onBrushStrokeEnd: handleBrushStrokeEnd,
      onBrushStrokeCancel: handleBrushStrokeCancel,
      onUndoTouchUp: handleUndoTouchUp,
      onClearTouchUpsOnFrame: handleClearTouchUpsOnFrame,
      onClearAllTouchUps: handleClearAllTouchUps,
      onSelectSidebarTab: handleSelectSidebarTab,
      onSetPreviewView: handleSetPreviewView,
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
 * Draw the current frame with its edits onto the base canvas
 * @param {import('./types.js').EditorState} state
 */
function drawPreview(state) {
  const frame = state.clip?.frames[state.currentFrame];
  if (!baseCanvas || !previewRenderer || !frame) return;
  const ctx = baseCanvas.getContext('2d');
  if (!ctx) return;
  // The strokes being painted preview live on top of the stored ones
  const painting = getBrushGestureStrokes();
  const edits =
    painting.length > 0
      ? { ...state.edits, touchUps: [...state.edits.touchUps, ...painting] }
      : state.edits;
  previewRenderer.render(ctx, frame, state.cropArea, edits, state.currentFrame, {
    skipKey: cropDragging,
    transparent: requiresTransparency({ edits: state.edits, hasAlpha: state.clip?.hasAlpha }),
    maskSource: isAiCutoutActive(state.edits.background) ? (aiSession?.maskSource ?? null) : null,
    view: getEffectivePreviewView(state),
  });
}

/**
 * The small status note on the preview: with the AI cutout on, a frame
 * without a mask previews unkeyed and says why
 * @param {ParentNode} container
 * @param {import('./types.js').EditorState} state
 */
function updateAiPreviewNote(container, state) {
  const note = container.querySelector('#ai-preview-note');
  if (!(note instanceof HTMLElement)) return;
  let text = '';
  if (isAiCutoutActive(state.edits.background)) {
    const frame = state.clip?.frames[state.currentFrame];
    if (!isFrameAnalyzed(frame, { modelId: getAiModelId(state.edits.background.ai) })) {
      text = 'Not analyzed yet';
    } else if (!aiSession?.maskSource?.getFinalMask(state.currentFrame)) {
      text = 'Updating the cutout\u2026';
    }
  }
  if (note.textContent !== text) note.textContent = text;
  note.hidden = text === '';
}

/**
 * Draw the overlay: crop, grid and the selected text layer's bounds
 * @param {import('./types.js').EditorState} state
 */
function drawOverlay(state) {
  const frame = state.clip?.frames[state.currentFrame];
  if (!overlayCanvas || !frame) return;
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;
  updateOverlayCanvas(
    overlayCanvas,
    state.cropArea,
    frame.width,
    frame.height,
    state.showGrid,
    getSelectedTextOverlay(ctx, state, frame),
  );
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
 * Anchor the playback clock at the current state
 * @param {import('./types.js').EditorState} state
 * @param {number} time - performance.now()-based timestamp
 */
function anchorPlayback(state, time) {
  playbackAnchor = {
    frame: state.currentFrame,
    time,
    speed: state.playbackSpeed,
    fps: getClipFps(state.clip),
    rangeStart: state.selectedRange.start,
    rangeEnd: state.selectedRange.end,
    lastFrame: state.currentFrame,
  };
}

/**
 * Start playback loop
 *
 * Driven by requestAnimationFrame and elapsed wall-clock time rather than a
 * per-tick frame step, so late ticks catch up instead of slowing playback.
 */
function startPlayback() {
  if (!store || playbackFrameId !== null) return;

  anchorPlayback(store.getState(), performance.now());

  /** @param {number} timestamp */
  const tick = (timestamp) => {
    if (!store || !playbackAnchor) {
      playbackFrameId = null;
      return;
    }

    const state = store.getState();
    if (state.clip) {
      // Seek, range edit, speed or FPS change since the last tick: restart
      // the clock from wherever the playhead is now
      const fps = getClipFps(state.clip);
      if (
        state.currentFrame !== playbackAnchor.lastFrame ||
        state.playbackSpeed !== playbackAnchor.speed ||
        fps !== playbackAnchor.fps ||
        state.selectedRange.start !== playbackAnchor.rangeStart ||
        state.selectedRange.end !== playbackAnchor.rangeEnd
      ) {
        anchorPlayback(state, timestamp);
      }

      const nextFrameIndex = getPlaybackFrame({
        anchorFrame: playbackAnchor.frame,
        elapsedMs: timestamp - playbackAnchor.time,
        fps,
        playbackSpeed: state.playbackSpeed,
        range: state.selectedRange,
      });

      if (nextFrameIndex !== state.currentFrame) {
        store.setState((s) => goToFrame(s, nextFrameIndex));
        playbackAnchor.lastFrame = store.getState().currentFrame;
        emit('editor:frame', { index: nextFrameIndex });
      }
    }

    playbackFrameId = window.requestAnimationFrame(tick);
  };

  playbackFrameId = window.requestAnimationFrame(tick);
}

/**
 * Stop playback loop
 */
function stopPlayback() {
  if (playbackFrameId !== null) {
    window.cancelAnimationFrame(playbackFrameId);
    playbackFrameId = null;
  }
  playbackAnchor = null;
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
 * @param {{ dragging?: boolean }} [options] - dragging: a preview drag is
 *   still moving the crop (background removal waits for its release)
 */
function handleCropChange(crop, options) {
  if (!store) return;
  cropDragging = options?.dragging === true;

  store.setState((state) => (crop ? updateCrop(state, crop) : clearCrop(state)));
  emit('editor:crop', { crop });
}

/**
 * A crop drag on the preview was released: key the final region once. The
 * flag is not store state, so nothing else would redraw the preview.
 */
function handleCropDragEnd() {
  if (!store || !cropDragging) return;
  cropDragging = false;
  drawPreview(store.getState());
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
 * Open the Export GIF dialog over the editor (Export button, Ctrl/Cmd+E,
 * `#/export`).
 *
 * SIMPLIFIED MODEL:
 * - The editor payload carries what defines the GIF's content — range,
 *   crop, edits and the playback speed (the editor speed IS the GIF speed);
 *   the dialog reads frames from its clip (the frames on screen)
 * - No frame cloning or ownership tracking needed; the dialog clears the
 *   payload when it closes
 * - Playback pauses while the dialog is open and resumes afterwards if it
 *   was playing
 */
function handleExport() {
  if (!store || exportDialog) return;

  const state = store.getState();
  if (!state.clip) return;

  const activePayload = getClipPayload();
  const showsActiveClip = activePayload?.frames === state.clip.frames;
  setEditorPayload({
    selectedRange: state.selectedRange,
    cropArea: state.cropArea,
    clip: state.clip,
    fps: state.clip.fps,
    edits: state.edits,
    hasAlpha: state.clip.hasAlpha === true,
    playbackSpeed: state.playbackSpeed,
    clipId: getActiveClipId(),
    sourceName: showsActiveClip ? (activePayload?.sourceName ?? null) : null,
  });

  const sessionStore = store;
  const wasPlaying = state.isPlaying;
  if (wasPlaying) {
    stopPlayback();
    store.setState((s) => setPlaying(s, false));
  }

  const opener = document.activeElement;
  exportDialog = openExportDialog({
    opener,
    onClose: () => {
      // The editor's teardown drops the handle before closing the dialog:
      // playback must not restart on the editor going away
      if (!exportDialog) return;
      exportDialog = null;
      if (wasPlaying && store === sessionStore && !sessionStore.getState().isPlaying) {
        sessionStore.setState((s) => setPlaying(s, true));
        startPlayback();
      }
    },
  });
  if (!exportDialog) {
    // Nothing to export (empty selection): leave the editor as it was
    clearEditorPayload();
    if (wasPlaying) {
      store.setState((s) => setPlaying(s, true));
      startPlayback();
    }
    return;
  }

  const selectedCount = state.selectedRange.end - state.selectedRange.start + 1;
  emit('editor:export-ready', {
    frameCount: selectedCount,
    fps: state.clip.fps,
  });
}

// ============================================================
// Edits (text layers, background removal)
// ============================================================

/**
 * Apply the Text/Background panels immediately (the store subscription is
 * throttled; a newly added layer's controls must exist before focusing them)
 */
function syncEditsPanelNow() {
  if (!store) return;
  const container = document.querySelector('#main-content');
  if (container) {
    const state = store.getState();
    updateEditsPanel(container, state, getClipFps(state.clip));
  }
}

/** Add a text layer over the current selection, select it and focus its text */
function handleAddText() {
  if (!store) return;
  store.setState((state) => addTextLayer(state));
  syncEditsPanelNow();
  const input = document.getElementById('text-layer-text');
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    input.select();
  }
  emit('editor:text', { action: 'add' });
}

/**
 * Select a text layer (null deselects). Selecting one (e.g. on the preview)
 * shows the Text tab, where its settings are.
 * @param {string | null} id
 */
function handleSelectText(id) {
  if (!store) return;
  store.setState((state) => selectTextLayer(state, id));
  if (id !== null && !store.getState().brush.on) handleSelectSidebarTab('text');
}

/**
 * @param {string} id
 * @param {Partial<import('../../shared/edits/model.js').TextLayer>} patch
 */
function handleUpdateText(id, patch) {
  if (!store) return;
  store.setState((state) => updateTextLayer(state, id, patch));
}

/**
 * Delete a text layer (the Delete key or the list's × button), with an Undo
 * toast like a clip deletion: the layer and its styling/timing come back at
 * the same position in the stack.
 * @param {string} id
 */
function handleRemoveText(id) {
  if (!store) return;
  const before = store.getState();
  const index = before.edits.textLayers.findIndex((layer) => layer.id === id);
  if (index === -1) return;
  const layer = before.edits.textLayers[index];
  const clipFrames = before.clip?.frames;

  store.setState((state) => removeTextLayer(state, id));
  // Move keyboard focus off the removed item now, not a throttle tick later
  syncEditsPanelNow();
  announce('Text layer deleted');
  if (hasPendingDeletion()) {
    // The toast's action slot holds a clip deletion's Undo, and a new action
    // toast would replace it: never make a deleted clip unrecoverable
    showToast('Text layer deleted');
    return;
  }
  showToast('Text layer deleted', {
    actionLabel: 'Undo',
    onAction: () => restoreTextLayer(layer, index, clipFrames),
  });
}

/**
 * Undo a text layer deletion: re-insert it at its old stack position and
 * select it. A no-op once the editor shows another clip (or none).
 * @param {import('../../shared/edits/model.js').TextLayer} layer
 * @param {number} index
 * @param {unknown} clipFrames - Frames of the clip the layer belonged to
 */
function restoreTextLayer(layer, index, clipFrames) {
  if (!store) return;
  const state = store.getState();
  if (!state.clip || state.clip.frames !== clipFrames) return;
  if (state.edits.textLayers.some((l) => l.id === layer.id)) return;
  const textLayers = [...state.edits.textLayers];
  textLayers.splice(Math.min(index, textLayers.length), 0, layer);
  store.setState((s) => selectTextLayer(setEdits(s, { ...s.edits, textLayers }), layer.id));
  announce('Text layer restored');
}

/**
 * @param {string} id
 * @param {number} x - Center X as a fraction of the output width
 * @param {number} y - Center Y as a fraction of the output height
 */
function handleMoveText(id, x, y) {
  if (!store) return;
  store.setState((state) => moveTextLayer(state, id, x, y));
}

/** @param {Partial<import('../../shared/edits/model.js').BackgroundRemoval>} patch */
function handleSetBackground(patch) {
  if (!store) return;
  store.setState((state) => setBackground(state, patch));
}

/**
 * Turn background removal on/off. Turning it on before any key color was
 * chosen keys out the most common opaque border color of the current
 * output. A border that is already transparent has no such color: the
 * current key color stays and the user is pointed at the eyedropper.
 * @param {boolean} enabled
 */
function handleToggleBackground(enabled) {
  if (!store) return;
  /** @type {Partial<import('../../shared/edits/model.js').BackgroundRemoval>} */
  const patch = { enabled };
  const state = store.getState();
  // Only the color key needs a key color: turning on the AI cutout never
  // picks one
  const colorKeyTurnsOn = isColorKeyActive({ ...state.edits.background, enabled });
  if (colorKeyTurnsOn && !state.edits.background.colorChosen) {
    const frame = state.clip?.frames[state.currentFrame];
    const detected = frame ? detectOutputEdgeColor(frame, state.cropArea) : null;
    if (detected) {
      patch.color = detected;
    } else if (state.clip?.hasAlpha) {
      announce('The edges are already transparent. Pick the color to remove from the preview.');
    }
  }
  store.setState((state) => setBackground(state, patch));
}

/**
 * Switch between the color key and the AI cutout. Switching to Color with
 * removal on and no chosen key color detects the edge color, like turning
 * the color key on does.
 * @param {import('../../shared/edits/model.js').BackgroundMethod} method
 */
function handleSetBackgroundMethod(method) {
  if (!store) return;
  const state = store.getState();
  const background = state.edits.background;
  if (background.method === method) return;
  let detected = null;
  if (method === 'color' && background.enabled && !background.colorChosen) {
    const frame = state.clip?.frames[state.currentFrame];
    detected = frame ? detectOutputEdgeColor(frame, state.cropArea) : null;
  }
  store.setState((s) => setBackgroundMethod(s, method, detected));
  if (method === 'ai') {
    void aiSession?.checkCapabilities();
    announce('AI cutout selected');
  } else if (aiSession?.analyzing) {
    // The AI section (with the progress and Cancel) is hidden now: an
    // analysis must not go on unseen. Finished frames are kept.
    aiSession.cancel();
    announce('Color key selected. The analysis was stopped; finished frames are kept.');
  } else {
    announce('Color key selected');
  }
}

/**
 * Frames of the current selection (what "Analyze selection" analyzes)
 * @returns {import('../capture/types.js').Frame[]}
 */
function getSelectionFrames() {
  const state = store?.getState();
  if (!state?.clip) return [];
  return state.clip.frames.slice(state.selectedRange.start, state.selectedRange.end + 1);
}

/** Analyze the selection's frames that have no mask yet (also Retry) */
function handleAiAnalyze() {
  if (!store || !aiSession) return;
  void aiSession.analyze(getSelectionFrames());
}

/** Cancel the running analysis; finished masks are kept */
function handleAiCancel() {
  aiSession?.cancel();
}

/** The explicit "Run without WebGPU (very slow)" choice: run the analysis */
function handleAiAllowWasm() {
  if (!store || !aiSession) return;
  void aiSession.allowWasmAndAnalyze(getSelectionFrames());
}

/** @param {Partial<import('../../shared/edits/model.js').AiCutout>} patch */
function handleSetAiParams(patch) {
  if (!store) return;
  store.setState((state) => setAiParams(state, patch));
}

/**
 * Choose the AI model. Each model keeps its own masks, so the section now
 * shows that model's analysis (switching back reuses the earlier masks);
 * threshold, smoothing, edge and picks stay as they are. Not while an
 * analysis runs (the choice is disabled then): it analyzes with the model
 * it started with.
 * @param {import('../../shared/edits/model.js').AiModel} modelId
 */
function handleSetAiModel(modelId) {
  if (!store) return;
  const state = store.getState();
  if (getAiModelId(state.edits.background.ai) === modelId || aiSession?.analyzing) return;
  store.setState((s) => {
    const next = setAiParams(s, { model: modelId });
    // The last analysis' outcome (and a model's failure on WebGPU)
    // belonged to the other model
    return updateAiCutoutStatus(next, {
      notice: '',
      error: null,
      needsWasmChoice: false,
      webgpuModelFailed: false,
      phase: s.aiCutout.phase === 'error' ? 'idle' : s.aiCutout.phase,
    });
  });
  announce(`${getModelEntry(modelId).label} model selected`);
}

/**
 * @param {import('../../shared/edits/model.js').PickMode | null} tool
 * @param {{ fromKeyboard?: boolean }} [options] - fromKeyboard: the toggle
 *   was switched with the keyboard, so the keyboard pick target (the
 *   preview) takes focus
 */
function handleSetAiPickTool(tool, options = {}) {
  if (!store) return;
  store.setState((state) => setAiPickTool(state, tool));
  if (tool && options.fromKeyboard && overlayCanvas) {
    setOverlayPickMode(overlayCanvas, true);
    overlayCanvas.focus();
  } else if (tool) {
    announce(`Click a character in the preview to ${tool === 'keep' ? 'keep' : 'remove'} it`);
  }
}

/**
 * Follow the pick tool on the preview overlay: focusable (keyboard picks)
 * while a tool is on. When the tool ends while the overlay has focus (a
 * pick was placed, or Escape), focus goes back to the tool's toggle
 * instead of staying on a control that is no longer focusable.
 * @param {ParentNode} container
 * @param {import('../../shared/edits/model.js').PickMode | null} tool
 * @param {import('../../shared/edits/model.js').PickMode | null} previousTool
 */
function updateOverlayPickMode(container, tool, previousTool) {
  if (!overlayCanvas) return;
  const hadFocus = document.activeElement === overlayCanvas;
  setOverlayPickMode(overlayCanvas, tool !== null);
  if (tool === null && hadFocus && previousTool) {
    const toggle = container.querySelector(`#ai-pick-${previousTool}`);
    if (toggle instanceof HTMLElement) toggle.focus();
  }
}

/**
 * The pick tool clicked the preview: add a pick on the current frame and
 * leave the tool. Picks need the frame's analysis (the character under the
 * click is found in its mask).
 * @param {{ x: number, y: number }} point - Fractions of the SOURCE frame
 */
function handleAiPick(point) {
  if (!store) return;
  const state = store.getState();
  const mode = state.aiPickTool;
  if (!mode) return;
  const frame = state.clip?.frames[state.currentFrame];
  if (!isFrameAnalyzed(frame, { modelId: getAiModelId(state.edits.background.ai) })) {
    const message = PICK_NEEDS_ANALYSIS_NOTICE;
    announce(message);
    store.setState((s) => updateAiCutoutStatus(s, { notice: message }));
    return;
  }
  if (state.edits.background.ai.picks.length >= EDIT_LIMITS.aiPicks.max) {
    announce(`The limit of ${EDIT_LIMITS.aiPicks.max} picks is reached`);
    return;
  }
  // A pick on background would be ignored by the build (a Keep pick there
  // would otherwise leave nothing): refuse it and keep the tool on
  const frames = /** @type {import('../capture/types.js').Frame[]} */ (state.clip?.frames);
  const ai = state.edits.background.ai;
  if (!pickFindsCharacter({ frames, ai, frameIndex: state.currentFrame, point })) {
    const message = PICK_NO_CHARACTER_NOTICE;
    announce(message);
    store.setState((s) => updateAiCutoutStatus(s, { notice: message }));
    return;
  }
  store.setState((s) =>
    setAiPickTool(addAiPick(s, { frame: s.currentFrame, x: point.x, y: point.y, mode }), null),
  );
  announce(`${mode === 'keep' ? 'Keep' : 'Remove'} pick added. It is followed through the clip.`);
}

/** @param {number} index */
function handleRemoveAiPick(index) {
  if (!store) return;
  store.setState((state) => removeAiPick(state, index));
  announce('Pick removed');
}

/** Remove every pick */
function handleClearAiPicks() {
  if (!store) return;
  store.setState(clearAiPicks);
  announce('Picks cleared');
}

/**
 * Start this mount's AI cutout session: status goes to the editor store
 * (new final masks bump aiCutout.maskVersion, which redraws the preview)
 * and background edits rebuild the masks. Every callback checks that this
 * session's store is still the current one (a promote re-inits the editor
 * synchronously).
 */
function startAiCutoutSession() {
  if (!store) return;
  const sessionStore = store;
  const isCurrent = () => store === sessionStore;
  const maskStore = getSharedMaskStore();
  const session = createAiCutoutSession({
    getState: () => (isCurrent() ? sessionStore.getState() : null),
    setStatus: (patch) => {
      if (isCurrent()) sessionStore.setState((s) => updateAiCutoutStatus(s, patch));
    },
    onMasksChanged: () => {
      const container = document.querySelector('#main-content');
      if (isCurrent() && container) updateClipsMemoryFooter(container);
    },
    getClipId: getActiveClipId,
    manager: getSegmentationManager(),
    maskStore,
  });
  aiSession = session;

  const clipId = getActiveClipId();
  // Only the masks of the clip's model: the other model's set may be evicted first
  if (clipId !== undefined) {
    maskStore.touchClip(clipId, getAiModelId(sessionStore.getState().edits.background.ai));
  }

  // Any change of the background settings (method, on/off, parameters,
  // picks) may need other final masks. Unthrottled, so a build in flight
  // for old parameters is aborted right away.
  aiEditsUnsubscribe = sessionStore.subscribe((state, prevState) => {
    if (state.edits.background !== prevState.edits.background) {
      session.requestBuild();
    }
  });

  // Masks from an earlier visit are memoized: the first draw is keyed
  session.requestBuild();
  if (sessionStore.getState().edits.background.method === 'ai') {
    void session.checkCapabilities();
  }
}

// ============================================================
// Touch-ups (mask brush)
// ============================================================

/**
 * Mask brush tool: on/off, mode, size, scope
 * @param {Partial<import('./types.js').BrushState>} patch
 */
function handleSetBrush(patch) {
  if (!store) return;
  const before = store.getState();
  store.setState((state) => setBrush(state, patch));
  const after = store.getState();
  if (patch.on === true && !after.brush.on) {
    announce(TOUCH_UP_NEEDS_REMOVAL);
  } else if (after.brush.on && !before.brush.on) {
    announce(
      `Brush on. Paint on the preview to ${after.brush.mode === 'erase' ? 'erase' : 'restore'}. Press Escape to stop.`,
    );
  } else if (!after.brush.on && before.brush.on) {
    announce('Brush off');
  }
}

/** Draw the live stroke preview on the next animation frame (coalesced) */
function scheduleBrushDraw() {
  if (brushDrawFrameId !== null) return;
  brushDrawFrameId = window.requestAnimationFrame(() => {
    brushDrawFrameId = null;
    if (store) drawPreview(store.getState());
  });
}

/**
 * Strokes of the brush gesture in progress, as they will be added
 * @returns {TouchUp[]}
 */
function getBrushGestureStrokes() {
  const gesture = brushGesture;
  if (!gesture) return [];
  if (!gesture.path) return gesture.pieces;
  gesture.live ??= {
    id: 'live',
    ...gesture.settings,
    points: getStrokePathPoints(gesture.path),
  };
  return [...gesture.pieces, gesture.live];
}

/** Strokes the edits can still take, minus the gesture's finished ones */
function brushStrokeRoom() {
  const stored = store?.getState().edits.touchUps.length ?? 0;
  return EDIT_LIMITS.touchUps.max - stored - (brushGesture?.pieces.length ?? 0);
}

/** Announce that the stroke limit stops the brush */
function announceStrokeLimit() {
  announce(
    `The limit of ${EDIT_LIMITS.touchUps.max} strokes is reached. Undo or clear strokes to paint more.`,
  );
}

/**
 * The gesture's current stroke ends (the pointer left the preview, or was
 * released): it joins the finished pieces
 */
function finishBrushPiece() {
  const gesture = brushGesture;
  if (!gesture?.path) return;
  gesture.pieces.push({
    id: createLayerId(),
    ...gesture.settings,
    points: getStrokePathPoints(gesture.path),
  });
  gesture.path = null;
  gesture.live = null;
}

/** Stop the scheduled live stroke preview */
function cancelBrushDraw() {
  if (brushDrawFrameId !== null) {
    window.cancelAnimationFrame(brushDrawFrameId);
    brushDrawFrameId = null;
  }
}

/**
 * A brush gesture starts on the preview: playback pauses (a stroke belongs
 * to the frame on screen) and its strokes take the brush's settings and
 * the frame range of its scope now
 * @param {{ x: number, y: number } | null} point - Fractions of the SOURCE
 *   frame; null when the pointer went down off the frame (the stroke starts
 *   where it enters)
 */
function handleBrushStrokeStart(point) {
  if (!store) return;
  brushGesture = null;
  const state = store.getState();
  const frame = state.clip?.frames[state.currentFrame];
  if (!isBrushActive(state) || !frame) return;
  if (state.edits.touchUps.length >= EDIT_LIMITS.touchUps.max) {
    announceStrokeLimit();
    return;
  }
  if (state.isPlaying) {
    stopPlayback();
    store.setState((s) => setPlaying(s, false));
  }
  const current = store.getState();
  const { mode, radius } = current.brush;
  brushGesture = {
    settings: { mode, radius, ...getBrushStrokeRange(current) },
    width: frame.width,
    height: frame.height,
    pieces: [],
    path: point ? startStrokePath(point, radius, frame.width, frame.height) : null,
    live: null,
  };
  if (point) scheduleBrushDraw();
}

/**
 * More of the gesture (coalesced pointer events, already limited to the
 * frame by clipStrokeMove): points extend the current stroke, thinned out
 * as they arrive; null ends it (the pointer left the preview) and the next
 * point starts a new one
 * @param {({ x: number, y: number } | null)[]} points - Fractions of the SOURCE frame
 */
function handleBrushStrokeMove(points) {
  const gesture = brushGesture;
  if (!gesture) return;
  let changed = false;
  for (const point of points) {
    if (point === null) {
      finishBrushPiece();
    } else if (gesture.path) {
      if (extendStrokePath(gesture.path, point)) {
        gesture.live = null;
        changed = true;
      }
    } else if (brushStrokeRoom() > 0) {
      gesture.path = startStrokePath(point, gesture.settings.radius, gesture.width, gesture.height);
      gesture.live = null;
      changed = true;
    }
  }
  if (changed) scheduleBrushDraw();
}

/** The gesture ends (pointer released): add its strokes to the edits */
function handleBrushStrokeEnd() {
  finishBrushPiece();
  const gesture = brushGesture;
  brushGesture = null;
  cancelBrushDraw();
  if (!store || !gesture || gesture.pieces.length === 0) return;
  const before = store.getState();
  store.setState((state) => addTouchUps(state, gesture.pieces));
  const after = store.getState();
  if (after.edits.touchUps.length - before.edits.touchUps.length < gesture.pieces.length) {
    // Not all added (the limit was reached meanwhile): drop the live preview
    if (after === before) drawPreview(before);
    announceStrokeLimit();
  }
}

/**
 * Escape during a gesture: its strokes are dropped, nothing is added (the
 * pointer stays down but paints nothing more until it is released)
 * @returns {boolean} Whether a gesture was cancelled
 */
function handleBrushStrokeCancel() {
  if (!brushGesture) return false;
  brushGesture = null;
  cancelBrushDraw();
  if (store) drawPreview(store.getState());
  announce('Stroke cancelled');
  return true;
}

/** Remove the most recent stroke */
function handleUndoTouchUp() {
  if (!store) return;
  const before = store.getState();
  store.setState(undoTouchUp);
  if (store.getState() !== before) announce('Last stroke undone');
}

/**
 * Take the current frame out of every stroke: only this frame changes (a
 * stroke over the selection keeps its other frames)
 */
function handleClearTouchUpsOnFrame() {
  if (!store) return;
  const state = store.getState();
  if (!canClearTouchUpsOnFrame(state, state.currentFrame)) {
    announce(
      `Clearing this frame would split strokes past the limit of ${EDIT_LIMITS.touchUps.max}. Undo or clear some strokes first.`,
    );
    return;
  }
  store.setState((s) => clearTouchUpsOnFrame(s, s.currentFrame));
  if (store.getState() !== state) announce('Touch-ups cleared on this frame');
}

/** Remove every stroke, with an Undo toast */
function handleClearAllTouchUps() {
  if (!store) return;
  const before = store.getState();
  const removed = before.edits.touchUps;
  if (removed.length === 0) return;
  const clipFrames = before.clip?.frames;
  store.setState(clearAllTouchUps);
  announce('All touch-ups cleared');
  if (hasPendingDeletion()) {
    // Never replace a clip deletion's Undo (see handleRemoveText)
    showToast('All touch-ups cleared');
    return;
  }
  showToast('All touch-ups cleared', {
    actionLabel: 'Undo',
    onAction: () => {
      const state = store?.getState();
      if (!store || !state?.clip || state.clip.frames !== clipFrames) return;
      if (state.edits.touchUps.length > 0) return;
      store.setState((s) => setEdits(s, { ...s.edits, touchUps: removed }));
      announce('Touch-ups restored');
    },
  });
}

// ============================================================
// Sidebar tabs and preview view
// ============================================================

/**
 * A sidebar tab was chosen. Leaving the Background tab ends its preview
 * tools (eyedropper, pick tool): their controls are no longer on screen.
 * @param {import('./types.js').SidebarTab} tab
 */
function handleSelectSidebarTab(tab) {
  if (!store) return;
  store.setState((state) => setSidebarTab(state, tab));
  const state = store.getState();
  lastSidebarTab = state.sidebarTab;
  if (state.sidebarTab === 'background') return;
  if (state.aiPickTool) handleSetAiPickTool(null);
  if (state.pickingKeyColor) handleSetPickingKeyColor(false);
}

/**
 * Result / Original / Mask view of the preview (view only)
 * @param {import('./types.js').PreviewView} view
 */
function handleSetPreviewView(view) {
  if (!store) return;
  store.setState((state) => setPreviewView(state, view));
}

/** @param {boolean} picking */
function handleSetPickingKeyColor(picking) {
  if (!store) return;
  store.setState((state) => setPickingKeyColor(state, picking));
  if (picking) {
    announce('Click the background in the preview to pick its color');
  }
}

/**
 * The eyedropper picked a key color: use it, enable removal, leave the mode
 * @param {string} color - '#rrggbb'
 */
function handlePickKeyColor(color) {
  if (!store) return;
  store.setState((state) =>
    setPickingKeyColor(setBackground(state, { color, enabled: true }), false),
  );
  announce(`Background color ${color} removed`);
}

/**
 * The eyedropper hit a pixel that is already transparent: there is no color
 * to remove there, so nothing changes and the mode stays on for another try
 */
function handlePickTransparentArea() {
  announce('That area is already transparent. Click a colored area to remove it.');
}

/**
 * Store the session's state on the active clip payload when it is still the
 * clip being edited, so leaving the editor (Capture, Settings, Export,
 * opening another file — which demotes the clip with it) keeps the work
 */
function saveEditorStateToClip() {
  const state = store?.getState();
  const clipPayload = getClipPayload();
  if (!state?.clip || !clipPayload || clipPayload.frames !== state.clip.frames) return;
  clipPayload.savedEditorState = toSavedEditorState(state);
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
    if (saved.edits) {
      newState = setEdits(newState, normalizeEdits(saved.edits, frameCount));
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
      onDeleteActiveClip: handleDeleteActiveClip,
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
    ...toSavedEditorState(state),
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
 * Delete a queued clip. Deletion is a single click on the entry's delete
 * button, followed by a 5s Undo toast (#98) - no blocking confirmation
 * dialog.
 * @param {string} id
 */
function handleDeleteClip(id) {
  if (deleteQueuedClip(id)) {
    announce('Clip deleted from queue');
    showToast('Clip deleted', { actionLabel: 'Undo', onAction: handleUndoDelete });
  }
}

/** Restore the most recent deletion (toast action, #100 r5) */
function handleUndoDelete() {
  if (undoDelete()) {
    announce('Clip restored');
  }
}

/**
 * Delete the ACTIVE clip (single click in the entry UI, followed by an Undo
 * toast, #98 / #100 round 4) and hand the editor to the succession logic: a
 * full reinit re-runs
 * initEditor's empty-mount path — one raw queued clip auto-promotes, several
 * show the select screen, none redirects to Capture.
 */
function handleDeleteActiveClip() {
  const successor = getClipQueue()[0] ?? null;
  const successorNeedsDecode = successor !== null && successor.status !== 'raw';

  // Undo restores the clip from its payload: carry the edits with it
  saveEditorStateToClip();
  const shownId = getActiveClipId();
  const shownFrames = store?.getState().clip?.frames;
  if (!deleteActiveClip()) return;
  showToast('Clip deleted', { actionLabel: 'Undo', onAction: handleUndoDelete });

  if (!successor) {
    // Nothing left to edit — leaving to Capture is the natural next step;
    // re-initing here would land on the "Invalid Clip Data" ERROR screen
    // for what was a perfectly deliberate action (#100 round 5)
    cleanup();
    announce('Last clip deleted');
    navigate('/capture');
    return;
  }

  announce('Clip deleted');
  if (successorNeedsDecode) {
    // Keep the current editor ON SCREEN while the compressed successor
    // decodes (#100 round 6) — the deleted clip's frames live in the undo
    // hold, so the canvas stays valid; tearing down to an "Opening clip…"
    // screen here is exactly the dark flash the user reported. The entry
    // shows its 'decoding' state in the panel; promoteWhenDecoded swaps in
    // the new clip the moment its frames arrive.
    deletedClipOnScreen =
      shownId !== undefined && shownFrames ? { id: shownId, frames: shownFrames } : null;
    void promoteWhenDecoded(successor.id);
    return;
  }
  cleanup();
  initEditor();
}

/**
 * Delete the ACTIVE clip from OUTSIDE the editor (header popover in
 * main.js). When the editor is mounted this routes through its own handler
 * so the succession reinit runs; otherwise the store-level delete suffices
 * (whatever screen is up doesn't render the active clip's frames).
 * @returns {boolean} true if a clip was deleted
 */
export function deleteActiveClipFromAnywhere() {
  if (store) {
    handleDeleteActiveClip();
    return true;
  }
  const deleted = deleteActiveClip();
  if (deleted) announce('Clip deleted');
  return deleted;
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
 * Minimal "opening" surface while the newest queued clip decodes (#92):
 * spinner + label, swapped for the real editor the moment the clip becomes
 * active. Replaces the select screen (#100 round 5) — adoption is automatic,
 * so the only state worth showing is "working on it".
 *
 * @param {HTMLElement} container
 * @param {string} entryId - Queue entry being opened
 * @param {boolean} [openExportDialogOnMount=false] - A `#/export` request
 *   taken by this mount: handed on to the editor that replaces this screen,
 *   and dropped when the clip cannot be opened or the screen is left
 * @returns {() => void} Route cleanup
 */
function renderClipOpeningScreen(container, entryId, openExportDialogOnMount = false) {
  updateStepIndicator('editor', { isCapturing: hasActiveScreenCapture() });
  let disposed = false;

  container.innerHTML = '';
  container.appendChild(
    createElement(
      'section',
      { className: 'screen editor-screen editor-clip-opening', 'aria-labelledby': 'editor-title' },
      [
        createElement('header', { className: 'screen-header' }, [
          createElement('h1', { id: 'editor-title', className: 'screen-title' }, ['Clip Editor']),
        ]),
        createElement('div', { className: 'editor-clip-opening-body', role: 'status' }, [
          createElement('span', { className: 'clip-entry-status-spinner', 'aria-hidden': 'true' }),
          'Opening clip\u2026',
        ]),
      ],
    ),
  );

  const unsubscribe = onBus('queue:changed', () => {
    if (disposed) return;
    if (getClipPayload()) {
      disposed = true;
      unsubscribe();
      pendingExportDialog = openExportDialogOnMount;
      initEditor();
    }
  });

  void promoteClipFromQueue(entryId).then((ok) => {
    if (disposed) return;
    if (!ok && !getClipPayload()) {
      // Decode failed and nothing became active — don't strand the user on
      // a spinner; Capture is the only sensible place left
      disposed = true;
      unsubscribe();
      announce('Could not open clip');
      navigate('/capture');
    }
  });

  return () => {
    disposed = true;
    unsubscribe();
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
  // The Export dialog lives over this editor: close it first (aborting a
  // running export) so nothing of it outlives the mount
  if (exportDialog) {
    const dialog = exportDialog;
    exportDialog = null;
    dialog.close({ restoreFocus: false });
  }
  stopPlayback();
  deletedClipOnScreen = null;
  brushGesture = null;
  cancelBrushDraw();

  // Before anything is torn down: keep this session's work on the clip
  saveEditorStateToClip();

  // Stop this mount's analysis and mask build (finished masks stay in the
  // mask store; the model worker stays up for the export or a later mount)
  if (aiEditsUnsubscribe) {
    aiEditsUnsubscribe();
    aiEditsUnsubscribe = null;
  }
  if (aiSession) {
    aiSession.dispose();
    aiSession = null;
  }
  if (previewRenderer) {
    previewRenderer.clear();
    previewRenderer = null;
  }

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
      const { edits, ...rest } = stateOverrides ?? {};
      store.setState((currentState) => {
        const merged = { ...currentState, ...rest };
        // Edits are normalized and mirrored into the clip like real edits
        return edits === undefined ? merged : setEdits(merged, edits);
      });
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
        edits: state.edits,
        selectedTextId: state.selectedTextId,
        pickingKeyColor: state.pickingKeyColor,
        hasAlpha: state.clip?.hasAlpha === true,
        aiPickTool: state.aiPickTool,
        aiCutout: state.aiCutout,
        brush: state.brush,
        sidebarTab: state.sidebarTab,
        previewView: state.previewView,
      };
    };
    // Keyed-background cache counters: readbacks must not grow on text-only edits
    window.__TEST_HOOKS__.getEditorPreviewStats = () => previewRenderer?.stats() ?? null;
  }
}
