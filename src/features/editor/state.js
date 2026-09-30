/**
 * Editor State Management
 * @module features/editor/state
 */

import {
  areTouchUpsActive,
  createDefaultEdits,
  createTextLayer,
  DEFAULT_TOUCH_UP_RADIUS,
  EDIT_LIMITS,
  normalizeEdits,
  TOUCH_UP_MODES,
} from '../../shared/edits/model.js';
import { removeTouchUpsFromFrame } from '../../shared/edits/touch-ups.js';
import { createStore } from '../../shared/store.js';
import { clamp } from '../../shared/utils/math.js';
import { clampCropArea, createClip, setFrameRange } from './core.js';

/**
 * Initialize editor state with clip
 * @param {import('./types.js').Clip} clip
 * @returns {import('./types.js').EditorState}
 */
export function initEditorState(clip) {
  return {
    clip,
    currentFrame: clip.selectedRange.start,
    selectedRange: clip.selectedRange,
    cropArea: clip.cropArea,
    selectedAspectRatio: clip.cropArea?.aspectRatio ?? 'free',
    isPlaying: true,
    playbackSpeed: 1,
    mode: 'select',
    showGrid: false,
    scenes: [],
    sceneDetectionStatus: 'idle',
    sceneDetectionProgress: 0,
    sceneDetectionError: null,
    edits: clip.edits ?? createDefaultEdits(),
    selectedTextId: null,
    pickingKeyColor: false,
    aiPickTool: null,
    aiCutout: createAiCutoutStatus(),
    brush: createBrushState(),
    sidebarTab: 'frame',
    previewView: 'result',
  };
}

// ============================================================
// Sidebar tabs and preview view (view-only settings)
// ============================================================

/** @type {readonly import('./types.js').SidebarTab[]} */
export const SIDEBAR_TABS = /** @type {const} */ (['frame', 'text', 'background']);

/** @type {readonly import('./types.js').PreviewView[]} */
export const PREVIEW_VIEWS = /** @type {const} */ (['result', 'original', 'mask']);

/**
 * Switch the right sidebar's tab (unknown values are ignored)
 * @param {import('./types.js').EditorState} state
 * @param {unknown} tab
 * @returns {import('./types.js').EditorState}
 */
export function setSidebarTab(state, tab) {
  if (!SIDEBAR_TABS.includes(/** @type {any} */ (tab)) || state.sidebarTab === tab) return state;
  return { ...state, sidebarTab: /** @type {import('./types.js').SidebarTab} */ (tab) };
}

/**
 * Choose what the preview shows while background removal is on (unknown
 * values are ignored). View only: the export never reads it.
 * @param {import('./types.js').EditorState} state
 * @param {unknown} view
 * @returns {import('./types.js').EditorState}
 */
export function setPreviewView(state, view) {
  if (!PREVIEW_VIEWS.includes(/** @type {any} */ (view)) || state.previewView === view) {
    return state;
  }
  return { ...state, previewView: /** @type {import('./types.js').PreviewView} */ (view) };
}

/**
 * The view the preview draws: the chosen one while background removal is
 * on, else the result (Original and Mask mean nothing without a removal)
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').PreviewView}
 */
export function getEffectivePreviewView(state) {
  if (!areTouchUpsActive(state.edits?.background)) return 'result';
  return PREVIEW_VIEWS.includes(state.previewView) ? state.previewView : 'result';
}

/** @type {readonly import('./types.js').BrushScope[]} */
export const BRUSH_SCOPES = /** @type {const} */ (['frame', 'selection']);

/**
 * Mask brush tool of a new editor session: off, erasing, default size,
 * one frame per stroke
 * @returns {import('./types.js').BrushState}
 */
export function createBrushState() {
  return { on: false, mode: 'erase', radius: DEFAULT_TOUCH_UP_RADIUS, scope: 'frame' };
}

/**
 * Initial AI cutout runtime status of an editor session (nothing running,
 * WebGPU not checked yet)
 * @returns {import('./types.js').AiCutoutStatus}
 */
export function createAiCutoutStatus() {
  return {
    phase: 'idle',
    webgpu: null,
    wasmAllowed: false,
    needsWasmChoice: false,
    webgpuModelFailed: false,
    backend: null,
    loadedBytes: 0,
    totalBytes: 0,
    fromCache: false,
    framesDone: 0,
    framesTotal: 0,
    remainingMs: null,
    error: null,
    notice: '',
    building: false,
    maskVersion: 0,
    storeVersion: 0,
  };
}

/**
 * Navigate to specific frame
 * @param {import('./types.js').EditorState} state
 * @param {number} frameIndex
 * @returns {import('./types.js').EditorState}
 */
export function goToFrame(state, frameIndex) {
  if (!state.clip) return state;

  const maxFrame = state.clip.frames.length - 1;
  const clampedIndex = clamp(frameIndex, 0, maxFrame);

  return {
    ...state,
    currentFrame: clampedIndex,
  };
}

/**
 * Go to next frame
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function nextFrame(state) {
  return goToFrame(state, state.currentFrame + 1);
}

/**
 * Go to previous frame
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function previousFrame(state) {
  return goToFrame(state, state.currentFrame - 1);
}

/**
 * Go to first frame
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function goToFirstFrame(state) {
  return goToFrame(state, state.selectedRange.start);
}

/**
 * Go to last frame
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function goToLastFrame(state) {
  return goToFrame(state, state.selectedRange.end);
}

/**
 * Start/stop playback
 * @param {import('./types.js').EditorState} state
 * @param {boolean} playing
 * @returns {import('./types.js').EditorState}
 */
export function setPlaying(state, playing) {
  return {
    ...state,
    isPlaying: playing,
  };
}

/**
 * Toggle playback
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function togglePlayback(state) {
  return setPlaying(state, !state.isPlaying);
}

/**
 * Set playback speed
 * @param {import('./types.js').EditorState} state
 * @param {number} speed
 * @returns {import('./types.js').EditorState}
 */
export function setPlaybackSpeed(state, speed) {
  return {
    ...state,
    playbackSpeed: clamp(speed, 0.25, 4),
  };
}

/**
 * Update frame range selection
 * @param {import('./types.js').EditorState} state
 * @param {import('./types.js').FrameRange} range
 * @returns {import('./types.js').EditorState}
 */
export function updateRange(state, range) {
  if (!state.clip) return state;

  // If currentFrame is outside new range, move to IN point
  const currentFrame =
    state.currentFrame < range.start || state.currentFrame > range.end
      ? range.start
      : state.currentFrame;

  return {
    ...state,
    selectedRange: range,
    currentFrame,
    clip: setFrameRange(state.clip, range),
  };
}

/**
 * Update crop area
 * @param {import('./types.js').EditorState} state
 * @param {import('./types.js').CropArea | null} crop
 * @returns {import('./types.js').EditorState}
 */
export function updateCrop(state, crop) {
  if (!state.clip) return state;

  // Clamp crop to frame bounds if set
  let finalCrop = crop;
  if (crop && state.clip.frames.length > 0) {
    const frame = state.clip.frames[0];
    finalCrop = clampCropArea(crop, frame.width, frame.height);
  }

  return {
    ...state,
    cropArea: finalCrop,
    clip: {
      ...state.clip,
      cropArea: finalCrop,
    },
  };
}

/**
 * Clear crop area
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function clearCrop(state) {
  return updateCrop(state, null);
}

/**
 * Toggle grid visibility
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function toggleGrid(state) {
  return {
    ...state,
    showGrid: !state.showGrid,
  };
}

/**
 * Set selected aspect ratio
 * @param {import('./types.js').EditorState} state
 * @param {import('./types.js').AspectRatio} ratio
 * @returns {import('./types.js').EditorState}
 */
export function setSelectedAspectRatio(state, ratio) {
  return {
    ...state,
    selectedAspectRatio: ratio,
  };
}

/**
 * Set editor mode
 * @param {import('./types.js').EditorState} state
 * @param {import('./types.js').EditorMode} mode
 * @returns {import('./types.js').EditorState}
 */
export function setMode(state, mode) {
  return {
    ...state,
    mode,
  };
}

// ============================================================
// Edits (text layers, background removal)
// ============================================================

/**
 * Frame count of the state's clip (0 without a clip)
 * @param {import('./types.js').EditorState} state
 * @returns {number}
 */
function clipFrameCount(state) {
  return state.clip?.frames.length ?? 0;
}

/**
 * Replace the edits, normalized against the clip, and mirror them into the
 * clip (like cropArea) so the export payload and a return from Export see
 * the same edits. A selection pointing at a removed layer is dropped.
 * @param {import('./types.js').EditorState} state
 * @param {unknown} edits
 * @returns {import('./types.js').EditorState}
 */
export function setEdits(state, edits) {
  if (!state.clip) return state;
  const normalized = normalizeEdits(edits, clipFrameCount(state));
  const selectedTextId = normalized.textLayers.some((layer) => layer.id === state.selectedTextId)
    ? state.selectedTextId
    : null;
  // Touch-ups need background removal: turning it off leaves the brush
  const brush =
    state.brush?.on && !areTouchUpsActive(normalized.background)
      ? { ...state.brush, on: false }
      : state.brush;
  return {
    ...state,
    edits: normalized,
    selectedTextId,
    brush,
    clip: { ...state.clip, edits: normalized },
  };
}

/**
 * Add a text layer spanning the current selection and select it
 * @param {import('./types.js').EditorState} state
 * @param {Partial<import('../../shared/edits/model.js').TextLayer>} [partial]
 * @returns {import('./types.js').EditorState}
 */
export function addTextLayer(state, partial = {}) {
  if (!state.clip) return state;
  const layer = createTextLayer(
    { start: state.selectedRange.start, end: state.selectedRange.end, ...partial },
    clipFrameCount(state),
  );
  const next = setEdits(state, {
    ...state.edits,
    textLayers: [...state.edits.textLayers, layer],
  });
  return { ...next, selectedTextId: layer.id };
}

/**
 * Patch one text layer (values are clamped/validated)
 * @param {import('./types.js').EditorState} state
 * @param {string} id
 * @param {Partial<import('../../shared/edits/model.js').TextLayer>} patch
 * @returns {import('./types.js').EditorState}
 */
export function updateTextLayer(state, id, patch) {
  if (!state.edits.textLayers.some((layer) => layer.id === id)) return state;
  return setEdits(state, {
    ...state.edits,
    textLayers: state.edits.textLayers.map((layer) =>
      layer.id === id ? { ...layer, ...patch, id } : layer,
    ),
  });
}

/**
 * Remove a text layer (deselects it when selected)
 * @param {import('./types.js').EditorState} state
 * @param {string} id
 * @returns {import('./types.js').EditorState}
 */
export function removeTextLayer(state, id) {
  if (!state.edits.textLayers.some((layer) => layer.id === id)) return state;
  return setEdits(state, {
    ...state.edits,
    textLayers: state.edits.textLayers.filter((layer) => layer.id !== id),
  });
}

/**
 * Move a text layer's center (fractions of the output size, clamped 0..1)
 * @param {import('./types.js').EditorState} state
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @returns {import('./types.js').EditorState}
 */
export function moveTextLayer(state, id, x, y) {
  return updateTextLayer(state, id, { x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
}

/**
 * Select a text layer (null, or an unknown id, deselects)
 * @param {import('./types.js').EditorState} state
 * @param {string|null} id
 * @returns {import('./types.js').EditorState}
 */
export function selectTextLayer(state, id) {
  const exists = id !== null && state.edits.textLayers.some((layer) => layer.id === id);
  const selectedTextId = exists ? id : null;
  if (selectedTextId === state.selectedTextId) return state;
  return { ...state, selectedTextId };
}

/**
 * Patch the background removal settings (values are clamped/validated).
 * Setting a color marks it as chosen (see BackgroundRemoval.colorChosen).
 * @param {import('./types.js').EditorState} state
 * @param {Partial<import('../../shared/edits/model.js').BackgroundRemoval>} patch
 * @returns {import('./types.js').EditorState}
 */
export function setBackground(state, patch) {
  const chosen = patch.color !== undefined ? { colorChosen: true } : {};
  return setEdits(state, {
    ...state.edits,
    background: { ...state.edits.background, ...patch, ...chosen },
  });
}

/**
 * Patch the AI cutout parameters (threshold, smoothing, edge, picks). The
 * `ai` object is replaced as a whole by setBackground, so this always
 * spreads the current one.
 * @param {import('./types.js').EditorState} state
 * @param {Partial<import('../../shared/edits/model.js').AiCutout>} patch
 * @returns {import('./types.js').EditorState}
 */
export function setAiParams(state, patch) {
  return setBackground(state, { ai: { ...state.edits.background.ai, ...patch } });
}

/**
 * Add a pick (ignored once EDIT_LIMITS.aiPicks.max picks exist)
 * @param {import('./types.js').EditorState} state
 * @param {import('../../shared/edits/model.js').CutoutPick} pick
 * @returns {import('./types.js').EditorState}
 */
export function addAiPick(state, pick) {
  const { picks } = state.edits.background.ai;
  if (picks.length >= EDIT_LIMITS.aiPicks.max) return state;
  return setAiParams(state, { picks: [...picks, pick] });
}

/**
 * Remove the pick at `index`
 * @param {import('./types.js').EditorState} state
 * @param {number} index
 * @returns {import('./types.js').EditorState}
 */
export function removeAiPick(state, index) {
  const { picks } = state.edits.background.ai;
  if (index < 0 || index >= picks.length) return state;
  return setAiParams(state, { picks: picks.filter((_, i) => i !== index) });
}

/**
 * Remove every pick
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function clearAiPicks(state) {
  if (state.edits.background.ai.picks.length === 0) return state;
  return setAiParams(state, { picks: [] });
}

/**
 * Switch the background removal method. Choosing the AI cutout also turns
 * removal on (that is what the user asked for) and leaves the eyedropper;
 * choosing Color keeps the on/off switch as it was.
 * @param {import('./types.js').EditorState} state
 * @param {import('../../shared/edits/model.js').BackgroundMethod} method
 * @param {string | null} [detectedColor] - Edge color to key when the color
 *   key becomes active without a chosen color
 * @returns {import('./types.js').EditorState}
 */
export function setBackgroundMethod(state, method, detectedColor = null) {
  /** @type {Partial<import('../../shared/edits/model.js').BackgroundRemoval>} */
  const patch = { method };
  if (method === 'ai') {
    patch.enabled = true;
  } else if (detectedColor) {
    patch.color = detectedColor;
  }
  let next = setBackground(state, patch);
  if (method === 'ai') {
    next = setPickingKeyColor(next, false);
  } else {
    next = setAiPickTool(next, null);
  }
  return next;
}

/**
 * Enter/leave an AI pick tool ('keep' / 'remove'); null leaves it. A pick
 * tool and the eyedropper are exclusive.
 * @param {import('./types.js').EditorState} state
 * @param {import('../../shared/edits/model.js').PickMode | null} tool
 * @returns {import('./types.js').EditorState}
 */
export function setAiPickTool(state, tool) {
  if (state.aiPickTool === tool) return state;
  const next = {
    ...state,
    aiPickTool: tool,
    pickingKeyColor: tool ? false : state.pickingKeyColor,
    brush: tool ? brushOff(state.brush) : state.brush,
  };
  // Leaving the tool (a pick that worked, Escape, the toggle) ends the
  // refused pick the notice was about
  return tool ? next : clearPickNotice(next);
}

/** Notice shown when a pick lands on a frame without analysis */
export const PICK_NEEDS_ANALYSIS_NOTICE =
  'This frame is not analyzed yet. Analyze it, then pick again.';

/** Notice shown when a pick lands on background (no character under or near it) */
export const PICK_NO_CHARACTER_NOTICE = 'No character here. Click on a character.';

/**
 * Drop a refused-pick notice (other notices, e.g. an analysis outcome, stay)
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
function clearPickNotice(state) {
  const notice = state.aiCutout?.notice;
  if (notice !== PICK_NEEDS_ANALYSIS_NOTICE && notice !== PICK_NO_CHARACTER_NOTICE) return state;
  return { ...state, aiCutout: { ...state.aiCutout, notice: '' } };
}

/**
 * Patch the AI cutout runtime status (analysis progress, errors, masks)
 * @param {import('./types.js').EditorState} state
 * @param {Partial<import('./types.js').AiCutoutStatus>} patch
 * @returns {import('./types.js').EditorState}
 */
export function updateAiCutoutStatus(state, patch) {
  const current = state.aiCutout ?? createAiCutoutStatus();
  const changed = Object.keys(patch).some(
    (key) =>
      current[/** @type {keyof typeof current} */ (key)] !==
      patch[/** @type {keyof typeof patch} */ (key)],
  );
  if (!changed) return state;
  return { ...state, aiCutout: { ...current, ...patch } };
}

/**
 * Enter/leave eyedropper mode for the background key color
 * @param {import('./types.js').EditorState} state
 * @param {boolean} picking
 * @returns {import('./types.js').EditorState}
 */
export function setPickingKeyColor(state, picking) {
  if (state.pickingKeyColor === picking) return state;
  const next = {
    ...state,
    pickingKeyColor: picking,
    aiPickTool: picking ? null : state.aiPickTool,
    brush: picking ? brushOff(state.brush) : state.brush,
  };
  return picking ? clearPickNotice(next) : next;
}

// ============================================================
// Touch-ups (mask brush)
// ============================================================

/**
 * The brush switched off (the same object when it already is)
 * @param {import('./types.js').BrushState | undefined} brush
 * @returns {import('./types.js').BrushState}
 */
function brushOff(brush) {
  const current = brush ?? createBrushState();
  return current.on ? { ...current, on: false } : current;
}

/**
 * Patch the mask brush tool (mode, size, scope, on/off). Values are
 * validated; the brush only turns on while background removal is on, and
 * turning it on leaves the pick tools and the eyedropper (one preview tool
 * at a time).
 * @param {import('./types.js').EditorState} state
 * @param {Partial<import('./types.js').BrushState>} patch
 * @returns {import('./types.js').EditorState}
 */
export function setBrush(state, patch) {
  const current = state.brush ?? createBrushState();
  const { touchUpRadius } = EDIT_LIMITS;
  const radius =
    typeof patch.radius === 'number' && Number.isFinite(patch.radius)
      ? clamp(patch.radius, touchUpRadius.min, touchUpRadius.max)
      : current.radius;
  /** @type {import('./types.js').BrushState} */
  const next = {
    on:
      typeof patch.on === 'boolean'
        ? patch.on && areTouchUpsActive(state.edits?.background)
        : current.on,
    mode: TOUCH_UP_MODES.includes(/** @type {any} */ (patch.mode))
      ? /** @type {import('../../shared/edits/model.js').TouchUpMode} */ (patch.mode)
      : current.mode,
    radius,
    scope: BRUSH_SCOPES.includes(/** @type {any} */ (patch.scope))
      ? /** @type {import('./types.js').BrushScope} */ (patch.scope)
      : current.scope,
  };
  if (
    next.on === current.on &&
    next.mode === current.mode &&
    next.radius === current.radius &&
    next.scope === current.scope
  ) {
    return state;
  }
  const withBrush = { ...state, brush: next };
  if (!next.on || current.on) return withBrush;
  return clearPickNotice({ ...withBrush, pickingKeyColor: false, aiPickTool: null });
}

/**
 * Whether the frame on screen lies outside the IN..OUT selection
 * @param {import('./types.js').EditorState} state
 * @returns {boolean}
 */
export function isCurrentFrameOutsideSelection(state) {
  const { start, end } = state.selectedRange;
  return state.currentFrame < start || state.currentFrame > end;
}

/**
 * Frame range a new stroke applies to under the brush's scope: the current
 * frame, or the IN..OUT selection. A stroke always covers the frame it is
 * painted on, so with the Selection scope on a frame outside IN..OUT it
 * applies to that frame only (the Touch up section says so) instead of to
 * frames the user cannot see.
 * @param {import('./types.js').EditorState} state
 * @returns {{ start: number, end: number }}
 */
export function getBrushStrokeRange(state) {
  if ((state.brush?.scope ?? 'frame') === 'selection' && !isCurrentFrameOutsideSelection(state)) {
    return { start: state.selectedRange.start, end: state.selectedRange.end };
  }
  return { start: state.currentFrame, end: state.currentFrame };
}

/**
 * Add touch-up strokes in order, as many as fit in EDIT_LIMITS.touchUps.max
 * (unchanged when none fits)
 * @param {import('./types.js').EditorState} state
 * @param {import('../../shared/edits/model.js').TouchUp[]} strokes
 * @returns {import('./types.js').EditorState}
 */
export function addTouchUps(state, strokes) {
  const touchUps = state.edits.touchUps ?? [];
  const room = EDIT_LIMITS.touchUps.max - touchUps.length;
  if (room <= 0 || strokes.length === 0) return state;
  return setEdits(state, { ...state.edits, touchUps: [...touchUps, ...strokes.slice(0, room)] });
}

/**
 * Add a touch-up stroke (ignored once EDIT_LIMITS.touchUps.max exist)
 * @param {import('./types.js').EditorState} state
 * @param {import('../../shared/edits/model.js').TouchUp} stroke
 * @returns {import('./types.js').EditorState}
 */
export function addTouchUp(state, stroke) {
  return addTouchUps(state, [stroke]);
}

/**
 * Remove the most recent stroke
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function undoTouchUp(state) {
  const touchUps = state.edits.touchUps ?? [];
  if (touchUps.length === 0) return state;
  return setEdits(state, { ...state.edits, touchUps: touchUps.slice(0, -1) });
}

/**
 * Whether "Clear on this frame" fits in the stroke limit (splitting a
 * stroke that spans the frame adds one stroke)
 * @param {import('./types.js').EditorState} state
 * @param {number} frameIndex
 * @returns {boolean}
 */
export function canClearTouchUpsOnFrame(state, frameIndex) {
  const touchUps = state.edits.touchUps ?? [];
  return removeTouchUpsFromFrame(touchUps, frameIndex).length <= EDIT_LIMITS.touchUps.max;
}

/**
 * Take one frame out of every stroke's range (see removeTouchUpsFromFrame):
 * only that frame changes. Unchanged when no stroke covers the frame or
 * the split would exceed the stroke limit.
 * @param {import('./types.js').EditorState} state
 * @param {number} frameIndex
 * @returns {import('./types.js').EditorState}
 */
export function clearTouchUpsOnFrame(state, frameIndex) {
  const touchUps = state.edits.touchUps ?? [];
  if (!touchUps.some((s) => s.start <= frameIndex && frameIndex <= s.end)) return state;
  const next = removeTouchUpsFromFrame(touchUps, frameIndex);
  if (next.length > EDIT_LIMITS.touchUps.max) return state;
  return setEdits(state, { ...state.edits, touchUps: next });
}

/**
 * Remove every stroke
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function clearAllTouchUps(state) {
  if ((state.edits.touchUps ?? []).length === 0) return state;
  return setEdits(state, { ...state.edits, touchUps: [] });
}

// ============================================================
// Scene Detection State Management
// ============================================================

/**
 * Start scene detection
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function startSceneDetection(state) {
  return {
    ...state,
    sceneDetectionStatus: 'detecting',
    sceneDetectionProgress: 0,
    sceneDetectionError: null,
    scenes: [],
  };
}

/**
 * Update scene detection progress
 * @param {import('./types.js').EditorState} state
 * @param {number} progress - Progress percentage (0-100)
 * @returns {import('./types.js').EditorState}
 */
export function updateSceneDetectionProgress(state, progress) {
  return {
    ...state,
    sceneDetectionProgress: progress,
  };
}

/**
 * Complete scene detection with results
 * @param {import('./types.js').EditorState} state
 * @param {import('../scene-detection/types.js').Scene[]} scenes
 * @returns {import('./types.js').EditorState}
 */
export function completeSceneDetection(state, scenes) {
  return {
    ...state,
    sceneDetectionStatus: 'completed',
    sceneDetectionProgress: 100,
    scenes,
  };
}

/**
 * Set scene detection error
 * @param {import('./types.js').EditorState} state
 * @param {string} error
 * @returns {import('./types.js').EditorState}
 */
export function setSceneDetectionError(state, error) {
  return {
    ...state,
    sceneDetectionStatus: 'error',
    sceneDetectionError: error,
  };
}

/**
 * Reset scene detection state
 * @param {import('./types.js').EditorState} state
 * @returns {import('./types.js').EditorState}
 */
export function resetSceneDetection(state) {
  return {
    ...state,
    sceneDetectionStatus: 'idle',
    sceneDetectionProgress: 0,
    sceneDetectionError: null,
    scenes: [],
  };
}

// ============================================================
// Store Creation
// ============================================================

/**
 * Create editor store
 * @param {import('../capture/types.js').Frame[]} frames
 * @param {number} [fps] - Source FPS (default: 30)
 * @param {{ hasAlpha?: boolean, edits?: unknown }} [options] - See createClip
 * @returns {ReturnType<typeof createStore<import('./types.js').EditorState>>}
 */
export function createEditorStore(frames, fps, options) {
  const clip = createClip(frames, fps, options);
  return createStore(initEditorState(clip));
}

/**
 * Create editor store from existing clip (for restoring state)
 * @param {import('./types.js').Clip} clip - Existing clip with preserved state
 * @returns {ReturnType<typeof createStore<import('./types.js').EditorState>>}
 */
export function createEditorStoreFromClip(clip) {
  // The clip may come from an older payload (or a test) without edits
  const edits = normalizeEdits(clip.edits, clip.frames.length);
  return createStore(initEditorState({ ...clip, hasAlpha: Boolean(clip.hasAlpha), edits }));
}
