/**
 * Editor State Management
 * @module features/editor/state
 */

import { createStore } from '../../shared/store.js';
import { clamp } from '../../shared/utils/math.js';
import { createClip, setFrameRange, clampCropArea } from './core.js';

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

/**
 * Create editor store
 * @param {import('../capture/types.js').Frame[]} frames
 * @param {number} [fps] - Source FPS (default: 30)
 * @returns {ReturnType<typeof createStore<import('./types.js').EditorState>>}
 */
export function createEditorStore(frames, fps) {
  const clip = createClip(frames, fps);
  return createStore(initEditorState(clip));
}

/**
 * Create editor store from existing clip (for restoring state)
 * @param {import('./types.js').Clip} clip - Existing clip with preserved state
 * @returns {ReturnType<typeof createStore<import('./types.js').EditorState>>}
 */
export function createEditorStoreFromClip(clip) {
  return createStore(initEditorState(clip));
}
