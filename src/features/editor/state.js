/**
 * Editor State Management
 * @module features/editor/state
 */

import { createDefaultEdits, createTextLayer, normalizeEdits } from '../../shared/edits/model.js';
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
  return {
    ...state,
    edits: normalized,
    selectedTextId,
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
 * Enter/leave eyedropper mode for the background key color
 * @param {import('./types.js').EditorState} state
 * @param {boolean} picking
 * @returns {import('./types.js').EditorState}
 */
export function setPickingKeyColor(state, picking) {
  if (state.pickingKeyColor === picking) return state;
  return { ...state, pickingKeyColor: picking };
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
