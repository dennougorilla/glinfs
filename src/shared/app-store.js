/**
 * Application Store for Cross-Feature Data Transfer
 * @module shared/app-store
 *
 * Handles data passing between features without using window globals.
 * Each payload type represents data flow between specific features:
 * - ClipPayload: capture -> editor
 * - EditorPayload: editor -> export
 */

/**
 * @typedef {Object} ClipPayload
 * @property {import('../features/capture/types.js').Frame[]} frames - Captured frames
 * @property {15|30|60} fps - Capture FPS setting
 * @property {number} capturedAt - Timestamp when clip was created
 * @property {boolean} [sceneDetectionEnabled] - Whether to run scene detection in editor
 * @property {import('../features/scene-detection/types.js').Scene[]} [scenes] - Pre-computed scenes from capture
 */

/**
 * @typedef {Object} EditorPayload
 * @property {import('../features/editor/types.js').FrameRange} selectedRange - Selected frame range for export
 * @property {import('../features/editor/types.js').CropArea|null} cropArea - Crop region
 * @property {import('../features/editor/types.js').Clip} clip - Full clip data (for state restoration)
 * @property {number} fps - FPS for export timing
 */

/**
 * @typedef {Object} ScreenCaptureState
 * @property {MediaStream} stream - Active screen capture stream
 * @property {HTMLVideoElement} videoElement - Video element for capture
 * @property {MediaStreamTrack} captureTrack - Video track for event handling
 * @property {import('./store.js').Store<import('../features/capture/types.js').CaptureState>} store - Capture store
 * @property {import('../workers/capture-worker-manager.js').CaptureWorkerManager} workerManager - Worker manager
 * @property {import('../features/capture/types.js').CaptureSettings} settings - Capture settings
 */

/**
 * @typedef {Object} AppState
 * @property {ClipPayload|null} clipPayload - Data from capture for editor
 * @property {EditorPayload|null} editorPayload - Data from editor for export
 */

/** @type {AppState} */
const state = {
  clipPayload: null,
  editorPayload: null,
};

/** @type {Partial<ScreenCaptureState>|null} */
let screenCaptureState = null;

/** @type {((state: Partial<ScreenCaptureState>, options: {stopStream: boolean}) => void) | null} */
let screenCaptureCleanupFn = null;

// ============================================================
// Internal: Frame Cleanup
// ============================================================

/**
 * Close all VideoFrames in a ClipPayload
 * Called only when setting a NEW clipPayload (not on navigation)
 * @param {ClipPayload|null} payload
 */
function closePayloadFrames(payload) {
  if (!payload?.frames) return;
  for (const frame of payload.frames) {
    if (frame?.frame && !frame.frame.closed) {
      try {
        frame.frame.close();
      } catch {
        // Ignore errors - frame may already be closed
      }
    }
  }
}

/**
 * Close all VideoFrame resources in an EditorPayload
 * EditorPayload stores frames at payload.clip.frames
 * @param {EditorPayload | null} payload
 */
function closeEditorPayloadFrames(payload) {
  if (!payload?.clip?.frames) return;
  for (const frame of payload.clip.frames) {
    if (frame?.frame && !frame.frame.closed) {
      try {
        frame.frame.close();
      } catch {
        // Ignore errors - frame may already be closed
      }
    }
  }
}

// ============================================================
// ClipPayload (capture -> editor)
// ============================================================

/**
 * Get clip payload from capture feature
 * @returns {ClipPayload|null}
 */
export function getClipPayload() {
  return state.clipPayload;
}

/**
 * Set clip payload from capture feature
 * Closes old frames ONLY when setting new ones (not on navigation)
 * @param {ClipPayload} payload
 */
export function setClipPayload(payload) {
  // Only close old VideoFrames if frames array is different
  // (prevents closing frames when just adding metadata like scenes)
  if (state.clipPayload?.frames !== payload.frames) {
    closePayloadFrames(state.clipPayload);
    // Clear old editor state since frames are now different
    state.editorPayload = null;
  }
  state.clipPayload = payload;
}

/**
 * Clear clip payload
 * @param {boolean} [closeFrames=false] - If true, close all VideoFrames before clearing
 */
export function clearClipPayload(closeFrames = false) {
  if (closeFrames && state.clipPayload) {
    closePayloadFrames(state.clipPayload);
  }
  state.clipPayload = null;
}

// ============================================================
// EditorPayload (editor -> export)
// ============================================================

/**
 * Get editor payload for export feature
 * @returns {EditorPayload|null}
 */
export function getEditorPayload() {
  return state.editorPayload;
}

/**
 * Set editor payload from editor feature
 * @param {EditorPayload} payload
 */
export function setEditorPayload(payload) {
  state.editorPayload = payload;
}

/**
 * Clear editor payload (called when export is done with it)
 */
export function clearEditorPayload() {
  state.editorPayload = null;
}

/**
 * Release all VideoFrame resources and clear all payloads
 * Called when starting a fresh capture session
 */
export function releaseAllFramesAndReset() {
  closePayloadFrames(state.clipPayload);
  closeEditorPayloadFrames(state.editorPayload);
  state.clipPayload = null;
  state.editorPayload = null;
  exportResult = null;
  // Also clear screen capture state for fresh start
  clearScreenCaptureState();
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate clip payload structure
 * @param {unknown} payload
 * @returns {import('./types.js').ValidationResult}
 */
export function validateClipPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('ClipPayload must be an object');
    return { valid: false, errors };
  }

  const p = /** @type {Record<string, unknown>} */ (payload);

  if (!Array.isArray(p.frames)) {
    errors.push('ClipPayload.frames must be an array');
  } else if (p.frames.length === 0) {
    errors.push('ClipPayload.frames cannot be empty');
  }

  if (typeof p.fps !== 'number' || ![15, 30, 60].includes(p.fps)) {
    errors.push('ClipPayload.fps must be 15, 30, or 60');
  }

  if (typeof p.capturedAt !== 'number') {
    errors.push('ClipPayload.capturedAt must be a timestamp');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate editor payload structure
 * @param {unknown} payload
 * @returns {import('./types.js').ValidationResult}
 */
export function validateEditorPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('EditorPayload must be an object');
    return { valid: false, errors };
  }

  const p = /** @type {Record<string, unknown>} */ (payload);

  // Validate selectedRange
  if (!p.selectedRange || typeof p.selectedRange !== 'object') {
    errors.push('EditorPayload.selectedRange must be an object');
  } else {
    const range = /** @type {{ start: unknown, end: unknown }} */ (p.selectedRange);
    if (typeof range.start !== 'number' || typeof range.end !== 'number') {
      errors.push('EditorPayload.selectedRange must have start and end numbers');
    } else if (range.start > range.end) {
      errors.push('EditorPayload.selectedRange.start must not exceed end');
    }
  }

  // Validate clip (required for state restoration)
  if (!p.clip || typeof p.clip !== 'object') {
    errors.push('EditorPayload.clip must be an object');
  }

  if (typeof p.fps !== 'number' || p.fps <= 0) {
    errors.push('EditorPayload.fps must be a positive number');
  }

  // cropArea can be null
  if (p.cropArea !== null && p.cropArea !== undefined) {
    if (typeof p.cropArea !== 'object') {
      errors.push('EditorPayload.cropArea must be an object or null');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// ExportResult (preserved export output)
// ============================================================

/**
 * @typedef {Object} ExportResultPayload
 * @property {Blob} blob - The encoded GIF
 * @property {string} filename - Suggested filename
 * @property {number} completedAt - Timestamp when export completed
 */

/** @type {ExportResultPayload|null} */
let exportResult = null;

/**
 * Get export result for display
 * @returns {ExportResultPayload|null}
 */
export function getExportResult() {
  return exportResult;
}

/**
 * Set export result after encoding completes
 * @param {ExportResultPayload} result
 */
export function setExportResult(result) {
  exportResult = result;
}

/**
 * Clear export result
 */
export function clearExportResult() {
  exportResult = null;
}

// ============================================================
// ScreenCaptureState (persist screen selection across navigation)
// ============================================================

/**
 * Register a cleanup function for screen capture resources
 * Called once at app startup from main.js
 * @param {(state: Partial<ScreenCaptureState>, options: {stopStream: boolean}) => void} fn
 */
export function registerScreenCaptureCleanup(fn) {
  screenCaptureCleanupFn = fn;
}

/**
 * Get stored screen capture state
 * @returns {Partial<ScreenCaptureState>|null}
 */
export function getScreenCaptureState() {
  return screenCaptureState;
}

/**
 * Store screen capture state for persistence across navigation
 * @param {Partial<ScreenCaptureState>} captureState
 */
export function setScreenCaptureState(captureState) {
  screenCaptureState = captureState;
}

/**
 * Clear stored screen capture state
 * Calls registered cleanup function if available (side effects delegated)
 * @param {boolean} [stopStream=true] - If true, stop the MediaStream
 * @returns {Partial<ScreenCaptureState>|null} The cleared state
 */
export function clearScreenCaptureState(stopStream = true) {
  const oldState = screenCaptureState;
  screenCaptureState = null;

  // Delegate side effects to registered cleanup function
  if (oldState && screenCaptureCleanupFn) {
    try {
      // Fire and forget - cleanup is async but we don't await
      // This maintains backward compatibility with sync callers
      screenCaptureCleanupFn(oldState, { stopStream });
    } catch (err) {
      console.error('[app-store] Screen capture cleanup failed:', err);
    }
  }

  return oldState;
}

/**
 * Check if there's an active screen capture that can be restored
 * @returns {boolean}
 */
export function hasActiveScreenCapture() {
  if (!screenCaptureState?.stream) return false;
  const tracks = screenCaptureState.stream.getVideoTracks();
  return tracks.length > 0 && tracks[0].readyState === 'live';
}

// ============================================================
// Debug / Testing
// ============================================================

/**
 * Reset all state (for testing purposes)
 */
export function resetAppStore() {
  state.clipPayload = null;
  state.editorPayload = null;
  exportResult = null;
  clearScreenCaptureState();
}
