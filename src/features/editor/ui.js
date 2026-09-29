/**
 * Editor UI Components - Professional Layout
 * @module features/editor/ui
 */

import {
  getClipMemoryEstimateMB,
  getClipPayload,
  getClipQueue,
  getClipQueueLimit,
  hasActiveScreenCapture,
} from '../../shared/app-store.js';
import { getOrderedClipRows, renderClipEntries } from '../../shared/clip-entries.js';
import { registerHotkey } from '../../shared/hotkeys.js';
import { navigate } from '../../shared/router.js';
import { loadSettings } from '../../shared/user-settings.js';
import { createElement } from '../../shared/utils/dom.js';
import { frameToTimecode } from '../../shared/utils/format.js';
import { formatMemory } from '../../shared/utils/memory-monitor.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';
import { getSharedMaskStore } from '../ai-cutout/mask-store.js';
import { renderFrameOnly, renderOverlay } from './api.js';
import { calculateSelectionInfo, getOutputDimensions, getPositionInSelection } from './core.js';
import { updateEditsPanel } from './panels/edits-panel.js';
import { createFrameGridLauncher } from './panels/frame-grid-launcher.js';
import { renderEditorLeftSidebar, renderScenesSidebar } from './panels/left-sidebar.js';
import { renderEditorPreview } from './panels/preview.js';
import { createClearCropButton, renderEditorPropertiesPanel } from './panels/properties.js';
import { renderEditorStatusBar } from './panels/status-bar.js';
import { renderEditorTimelineSection } from './panels/timeline-section.js';
import { renderEditorToolbar } from './panels/toolbar.js';

/**
 * @typedef {Object} EditorUIHandlers
 * @property {() => void} onTogglePlay - Toggle playback
 * @property {(frame: number) => void} onFrameChange - Frame changed
 * @property {(range: import('./types.js').FrameRange) => void} onRangeChange - Range changed
 * @property {(crop: import('./types.js').CropArea | null, options?: { dragging?: boolean }) => void} onCropChange - Crop changed (dragging: a preview drag is still in progress)
 * @property {() => void} [onCropDragEnd] - A crop drag on the preview was released
 * @property {() => void} onToggleGrid - Toggle grid
 * @property {(ratio: string) => void} onAspectRatioChange - Aspect ratio changed
 * @property {(speed: number) => void} onSpeedChange - Speed changed
 * @property {() => void} onExport - Export clicked
 * @property {(id: string) => void} [onPromoteClip] - Queue clip entry clicked (promote to active)
 * @property {(id: string) => void} [onDeleteClip] - Queue clip delete clicked
 * @property {() => void} [onDeleteActiveClip] - Active clip delete clicked (#100 round 4)
 * @property {() => import('./types.js').EditorState} [getState] - Get current state
 * @property {() => import('../capture/types.js').Frame} [getFrame] - Get current frame
 * @property {() => void} [onAddText] - Add a text layer (and select it)
 * @property {(id: string | null) => void} [onSelectText] - Select a text layer (null deselects)
 * @property {(id: string, patch: Partial<import('../../shared/edits/model.js').TextLayer>) => void} [onUpdateText] - Patch a text layer
 * @property {(id: string) => void} [onRemoveText] - Delete a text layer
 * @property {(id: string, x: number, y: number) => void} [onMoveText] - Move a text layer (output fractions)
 * @property {(patch: Partial<import('../../shared/edits/model.js').BackgroundRemoval>) => void} [onSetBackground] - Patch background removal
 * @property {(enabled: boolean) => void} [onToggleBackground] - Turn background removal on/off
 * @property {(picking: boolean) => void} [onSetPickingKeyColor] - Enter/leave eyedropper mode
 * @property {(color: string) => void} [onPickKeyColor] - Eyedropper picked a key color
 * @property {() => void} [onPickTransparentArea] - Eyedropper clicked an already transparent pixel
 * @property {(method: import('../../shared/edits/model.js').BackgroundMethod) => void} [onSetBackgroundMethod] - Color key or AI cutout
 * @property {() => void} [onAiAnalyze] - Analyze the selection (also Retry)
 * @property {() => void} [onAiCancel] - Cancel the running analysis
 * @property {() => void} [onAiAllowWasm] - Explicit "Run without WebGPU" choice
 * @property {(patch: Partial<import('../../shared/edits/model.js').AiCutout>) => void} [onSetAiParams] - Threshold/smoothing/edge
 * @property {(tool: import('../../shared/edits/model.js').PickMode | null, options?: { fromKeyboard?: boolean }) => void} [onSetAiPickTool] - Enter/leave a pick tool (fromKeyboard: move focus to the preview for keyboard picks)
 * @property {(point: { x: number, y: number }) => void} [onAiPick] - Pick at a point (fractions of the source frame)
 * @property {(index: number) => void} [onRemoveAiPick] - Remove a pick
 * @property {() => void} [onClearAiPicks] - Remove every pick
 */

/**
 * Render the editor screen. Thin orchestrator: each panel builds its own DOM
 * and listeners (see ./panels/); this assembles them in layout order, mounts
 * the screen, then populates the post-mount lists and route hotkeys.
 * @param {HTMLElement} container
 * @param {import('./types.js').EditorState} state
 * @param {EditorUIHandlers} handlers
 * @param {number} fps
 * @returns {{ cleanup: () => void, baseCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement }}
 */
export function renderEditorScreen(container, state, handlers, fps) {
  const cleanups = [];

  // Update step indicator
  updateStepIndicator('editor', { isCapturing: hasActiveScreenCapture() });

  const frame = state.clip.frames[state.currentFrame];
  const dimensions = getOutputDimensions(state.cropArea, frame);

  // Main layout
  const screen = createElement('div', { className: 'editor-screen screen' });

  const toolbar = renderEditorToolbar(state, handlers, fps);
  cleanups.push(...toolbar.cleanups);

  // Frame grid modal is shared by the timeline's Open Grid button and the F
  // shortcut; its latch cleanup closes a still-open modal when the editor closes
  const frameGrid = createFrameGridLauncher(state, handlers);
  cleanups.push(frameGrid.cleanup);

  screen.appendChild(toolbar.element);

  // Content area (left sidebar + preview + right sidebar)
  const content = createElement('div', { className: 'editor-content' });

  const leftSidebar = renderEditorLeftSidebar();
  cleanups.push(...leftSidebar.cleanups);
  content.appendChild(leftSidebar.element);

  const preview = renderEditorPreview(state, handlers, frame);
  cleanups.push(...preview.cleanups);
  content.appendChild(preview.element);

  const properties = renderEditorPropertiesPanel(state, handlers);
  cleanups.push(...properties.cleanups);
  content.appendChild(properties.element);
  screen.appendChild(content);

  const timeline = renderEditorTimelineSection(state, fps, frameGrid.open);
  cleanups.push(...timeline.cleanups);
  screen.appendChild(timeline.element);

  screen.appendChild(renderEditorStatusBar(dimensions, state.selectedTextId));

  container.innerHTML = '';
  container.appendChild(screen);

  // Text/Background controls take their values from state (updated in place
  // on later changes by editor/index.js)
  updateEditsPanel(screen, state, fps);

  // Populate scenes sidebar with thumbnails
  cleanups.push(...renderScenesSidebar(leftSidebar.scenesContainer, state, handlers));

  // Populate clips section (active clip + queue). Re-rendered on
  // 'queue:changed' by editor/index.js via updateClipsPanel.
  cleanups.push(...updateClipsPanel(container, handlers));

  // Route-scope keyboard shortcuts. While the frame-grid modal is open it
  // holds modal-scope hotkeys, and the dispatcher skips the route scope
  // entirely — otherwise Escape would close the modal AND clear the crop,
  // Space would select a grid frame AND toggle playback.
  cleanups.push(setupKeyboardShortcuts(handlers, state, { onOpenFrameGrid: frameGrid.open }));

  return {
    cleanup: () =>
      cleanups.forEach((fn) => {
        fn();
      }),
    baseCanvas: preview.baseCanvas,
    overlayCanvas: preview.overlayCanvas,
  };
}

/**
 * Setup keyboard shortcuts (route scope of the app hotkey dispatcher)
 * @param {EditorUIHandlers} handlers
 * @param {import('./types.js').EditorState} state
 * @param {{ onOpenFrameGrid?: () => void }} [options]
 * @returns {() => void} Cleanup function (unregisters every shortcut)
 */
function setupKeyboardShortcuts(handlers, state, options = {}) {
  // Read live state via handlers to avoid stale closures (render runs once)
  const getCurrentState = () => handlers.getState?.() ?? state;

  /**
   * Plain-key shortcut: Shift is ignored (Shift+G, Shift+Arrow behave like
   * the bare key) but Cmd/Ctrl/Alt combos stay with the browser.
   * @param {string} key
   * @param {() => void} action
   */
  const plain = (key, action) =>
    registerHotkey({
      key,
      modifiers: { shift: 'any' },
      scope: 'route',
      handler: (e) => {
        e.preventDefault();
        action();
      },
    });

  /**
   * 1-9 address clips by their LIST POSITION (browser-tab model, #100 r7):
   * plain digit switches, Shift+digit deletes. e.code is used so Shift+1
   * works on every keyboard layout (e.key would be '!' on US).
   * @param {number} position - 1-based
   */
  const clipPosition = (position) =>
    registerHotkey({
      code: `Digit${position}`,
      modifiers: { shift: 'any' },
      scope: 'route',
      handler: (e) => {
        const rows = getOrderedClipRows(getClipPayload(), getClipQueue());
        const row = rows[position - 1];
        if (!row) return false;
        e.preventDefault();
        if (e.shiftKey) {
          if (row.active) {
            handlers.onDeleteActiveClip?.();
          } else {
            handlers.onDeleteClip?.(row.clip.id);
          }
        } else if (!row.active) {
          handlers.onPromoteClip?.(row.clip.id);
        }
      },
    });

  const exportShortcut = (/** @type {{ ctrl?: boolean, meta?: boolean }} */ modifiers) =>
    registerHotkey({
      key: 'e',
      modifiers,
      scope: 'route',
      handler: (e) => {
        e.preventDefault();
        handlers.onExport();
        navigate('/export');
      },
    });

  const deleteSelection = () => {
    const selectedTextId = getCurrentState().selectedTextId;
    if (selectedTextId) {
      handlers.onRemoveText?.(selectedTextId);
    } else {
      handlers.onDeleteActiveClip?.();
    }
  };

  const unsubscribers = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(clipPosition),
    plain(' ', () => handlers.onTogglePlay()),
    plain('ArrowLeft', () => handlers.onFrameChange(getCurrentState().currentFrame - 1)),
    plain('ArrowRight', () => handlers.onFrameChange(getCurrentState().currentFrame + 1)),
    plain('Home', () => handlers.onFrameChange(getCurrentState().selectedRange.start)),
    plain('End', () => handlers.onFrameChange(getCurrentState().selectedRange.end)),
    plain('g', () => handlers.onToggleGrid()),
    // Escape unwinds the innermost editing mode first: a pick tool, the
    // eyedropper, then the text selection, then the crop
    plain('Escape', () => {
      const current = getCurrentState();
      if (current.aiPickTool) {
        handlers.onSetAiPickTool?.(null);
      } else if (current.pickingKeyColor) {
        handlers.onSetPickingKeyColor?.(false);
      } else if (current.selectedTextId) {
        handlers.onSelectText?.(null);
      } else {
        handlers.onCropChange(null);
      }
    }),
    plain('f', () => options.onOpenFrameGrid?.()),
    // Delete the selected text layer, else the clip being edited (undo
    // toast covers safety, #100 r7) — a selected caption is what the user
    // is pointing at, never the whole clip
    plain('Delete', deleteSelection),
    plain('Backspace', deleteSelection),
    exportShortcut({ ctrl: true }),
    exportShortcut({ meta: true }),
    // Escape also leaves a pick tool or the eyedropper while a panel
    // control has focus (their toggles keep focus after a click).
    // Registered last so it is tried before the plain Escape above; it
    // declines everything else, so typing in fields stays shortcut-free.
    registerHotkey({
      key: 'Escape',
      scope: 'route',
      allowInEditable: true,
      handler: (e) => {
        const current = getCurrentState();
        if (current.aiPickTool) {
          e.preventDefault();
          handlers.onSetAiPickTool?.(null);
          return;
        }
        if (!current.pickingKeyColor) return false;
        e.preventDefault();
        handlers.onSetPickingKeyColor?.(false);
      },
    }),
  ];

  return () =>
    unsubscribers.forEach((fn) => {
      fn();
    });
}

/**
 * Update base canvas with new frame only (no overlays)
 * @param {HTMLCanvasElement} canvas
 * @param {import('../capture/types.js').Frame} frame
 */
export function updateBaseCanvas(canvas, frame) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  renderFrameOnly(ctx, frame);
}

/**
 * Update overlay canvas with crop, grid and the selected text layer's bounds
 * @param {HTMLCanvasElement} canvas
 * @param {import('./types.js').CropArea | null} crop
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {boolean} showGrid
 * @param {import('./api.js').SelectedTextOverlay | null} [selectedText]
 */
export function updateOverlayCanvas(
  canvas,
  crop,
  frameWidth,
  frameHeight,
  showGrid,
  selectedText = null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const hasCrop = crop !== null;
  renderOverlay(ctx, crop, frameWidth, frameHeight, {
    showCropOverlay: hasCrop,
    showGrid,
    gridDivisions: 3,
    selectedText,
  });
}

/**
 * Update timeline header info (SEL, IN, OUT) and the toolbar time display
 * Called when selection range or current frame changes
 * @param {HTMLElement} container - The editor screen container
 * @param {import('./types.js').FrameRange} selectedRange - Current selection range
 * @param {number} currentFrame - Current playhead position
 * @param {number} fps - Frames per second
 */
export function updateTimelineHeader(container, selectedRange, currentFrame, fps) {
  const selectionInfo = calculateSelectionInfo(selectedRange, fps);
  const inPoint = frameToTimecode(selectedRange.start, fps);
  const outPoint = frameToTimecode(selectedRange.end, fps);

  // Update IN value
  const inEl = container.querySelector('.timeline-in-value');
  if (inEl) inEl.textContent = inPoint;

  // Update OUT value
  const outEl = container.querySelector('.timeline-out-value');
  if (outEl) outEl.textContent = outPoint;

  // Update SEL value
  const selEl = container.querySelector('.timeline-sel-value');
  if (selEl) selEl.textContent = selectionInfo.formattedDuration;

  // Update SEL frames count
  const selFramesEl = container.querySelector('.timeline-sel-frames');
  if (selFramesEl) selFramesEl.textContent = `(${selectionInfo.formattedFrameCount})`;

  // Recompute the toolbar time display: both the current position within the
  // selection and the selection total change when the range changes (#44)
  const currentTimeEl = container.querySelector('.time-display .current');
  if (currentTimeEl) {
    currentTimeEl.textContent = frameToTimecode(
      getPositionInSelection(currentFrame, selectedRange),
      fps,
    );
  }

  const totalTimeEl = container.querySelector('.time-display .total');
  if (totalTimeEl) {
    totalTimeEl.textContent = frameToTimecode(selectionInfo.frameCount, fps);
  }
}

/**
 * Update scenes sidebar in left panel without full re-render
 * @param {HTMLElement} container - The editor screen container
 * @param {import('./types.js').EditorState} state - Current editor state
 * @param {EditorUIHandlers} handlers - UI handlers
 * @returns {(() => void)[]} Cleanup functions for event listeners
 */
export function updateScenesPanel(container, state, handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Keep the SCENES tab count current (#100 r7)
  const scenesCount = container.querySelector('[data-count="scenes"]');
  if (scenesCount instanceof HTMLElement) {
    const n = state.sceneDetectionStatus === 'completed' ? state.scenes.length : 0;
    scenesCount.textContent = n > 0 ? String(n) : '';
  }

  // Find the scenes container in the left sidebar
  const scenesContainer = container.querySelector('[data-scenes-container]');
  if (!scenesContainer) return cleanups;

  // Re-render the scenes sidebar
  cleanups.push(...renderScenesSidebar(scenesContainer, state, handlers));

  return cleanups;
}

/**
 * Update ONLY the `is-selected` class on already-rendered scene cards, in
 * response to a rangeChanged-only tick (selection/status/scenes list all
 * otherwise unchanged). Does not touch the DOM tree or thumbnails - no
 * innerHTML clear, no createThumbnailCanvas calls. Existing card event
 * listeners (attached by renderScenesSidebar) remain valid since the nodes
 * are untouched (issue #99, fix 2).
 * @param {HTMLElement} container - The editor screen container
 * @param {import('./types.js').EditorState} state - Current editor state
 */
export function updateScenesSelection(container, state) {
  const scenesContainer = container.querySelector('[data-scenes-container]');
  if (!scenesContainer) return;

  const cards = scenesContainer.querySelectorAll('.scene-thumbnail-card');
  cards.forEach((card) => {
    const start = Number(/** @type {HTMLElement} */ (card).dataset.sceneStart);
    const end = Number(/** @type {HTMLElement} */ (card).dataset.sceneEnd);
    const isSelected = state.selectedRange.start === start && state.selectedRange.end === end;
    card.classList.toggle('is-selected', isSelected);
  });
}

/**
 * Render the Clips section (active clip + queue entries + memory footer)
 * in the left sidebar without a full editor re-render.
 *
 * @param {HTMLElement} container - The editor screen container
 * @param {EditorUIHandlers} handlers - UI handlers (onPromoteClip/onDeleteClip)
 * @returns {(() => void)[]} Cleanup functions for event listeners
 */
export function updateClipsPanel(container, handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  const clipsContainer = container.querySelector('[data-clips-container]');
  if (!(clipsContainer instanceof HTMLElement)) return cleanups;

  cleanups.push(
    ...renderClipEntries(clipsContainer, {
      activeClip: getClipPayload(),
      queue: getClipQueue(),
      onPromote: handlers.onPromoteClip,
      onDelete: handlers.onDeleteClip,
      onDeleteActive: handlers.onDeleteActiveClip,
    }),
  );

  // Keep the tab label's count in sync with the list it fronts (#100 r7)
  const clipsCount = container.querySelector('[data-count="clips"]');
  if (clipsCount instanceof HTMLElement) {
    const total = getClipQueue().length + (getClipPayload() ? 1 : 0);
    clipsCount.textContent = total > 0 ? String(total) : '';
  }

  updateClipsMemoryFooter(container);

  return cleanups;
}

/**
 * Memory footer: conservative raw-RGBA estimate for active + queued frames,
 * shown AGAINST the budget so the user sees the wall before hitting it
 * (a bare "~1.2 GB estimated" gave no sense of remaining headroom). The AI
 * cutout's probability masks count too, so this also runs on its own while
 * an analysis adds masks.
 * @param {ParentNode} container - The editor screen container
 */
export function updateClipsMemoryFooter(container) {
  const footer = container.querySelector('[data-clips-footer]');
  if (footer instanceof HTMLElement) {
    const queueLength = getClipQueue().length;
    const limit = getClipQueueLimit();
    const usedMB = getClipMemoryEstimateMB() + getSharedMaskStore().byteLength / (1024 * 1024);
    const budgetMB = loadSettings().capture.memoryBudgetMB;
    footer.textContent = `~${formatMemory(usedMB)} / ${formatMemory(budgetMB)} \u00b7 ${queueLength}/${limit} queued`;
    footer.classList.toggle(
      'clips-sidebar-memory--warning',
      queueLength >= limit || (budgetMB > 0 && usedMB > budgetMB * 0.8),
    );
  }
}

/**
 * Show the transient "queue full" banner in the Clips section header.
 * Returns the hide function so the caller can manage/cancel the timer.
 *
 * @param {HTMLElement} container - The editor screen container
 * @returns {(() => void) | null} Function that hides the banner, or null if no banner slot
 */
export function showClipsQueueFullBanner(container, message) {
  const banner = container.querySelector('.clips-queue-banner');
  if (!(banner instanceof HTMLElement)) return null;

  banner.textContent = message ?? 'Queue full — delete a clip or raise the limit in Settings';
  banner.hidden = false;

  return () => {
    banner.hidden = true;
  };
}

/**
 * Update crop info panel values
 * Clear Crop clicks are handled by a delegated listener registered once in
 * renderEditorPropertiesPanel, so this function never attaches listeners of its own
 * (the returned cleanups array is kept for API compatibility).
 * @param {HTMLElement} container - Editor container
 * @param {import('./types.js').CropArea | null} cropArea - Current crop area
 * @param {(crop: import('./types.js').CropArea | null) => void} _onCropChange - Unused (delegation)
 * @returns {(() => void)[]} Cleanup functions for event listeners
 */
export function updateCropInfoPanel(container, cropArea, _onCropChange) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  const panel = container.querySelector('.crop-info-group');
  if (!panel) return cleanups;

  const values = cropArea
    ? [
        String(Math.round(cropArea.x)),
        String(Math.round(cropArea.y)),
        String(Math.round(cropArea.width)),
        String(Math.round(cropArea.height)),
      ]
    : ['-', '-', '-', '-'];

  const valueEls = panel.querySelectorAll('.crop-info-value');
  valueEls.forEach((el, i) => {
    el.textContent = values[i];
  });

  // Handle Clear Crop button visibility (inside the Crop accordion) and
  // pop the accordion open the moment a crop starts existing — its values
  // must never update invisibly behind a collapsed summary
  const cropGroupEl = container.querySelector('.crop-info-group');
  if (!(cropGroupEl instanceof HTMLElement)) return cleanups;

  const existingClearBtn = cropGroupEl.querySelector('.btn-clear-crop');

  if (cropArea && !existingClearBtn) {
    // Add Clear Crop button (clicks handled via delegation)
    cropGroupEl.appendChild(createClearCropButton());
  } else if (!cropArea && existingClearBtn) {
    // Remove Clear Crop button
    existingClearBtn.remove();
  }

  const cropAccordion = cropGroupEl.closest('details.prop-accordion');
  if (cropArea && cropAccordion instanceof HTMLElement) {
    cropAccordion.setAttribute('open', '');
  }

  return cleanups;
}
