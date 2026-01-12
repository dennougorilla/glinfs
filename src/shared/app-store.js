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
 */

/**
 * @typedef {Object} EditorPayload
 * @property {import('../features/capture/types.js').Frame[]} frames - Selected frames for export
 * @property {import('../features/editor/types.js').CropArea|null} cropArea - Crop region
 * @property {import('../features/editor/types.js').Clip} clip - Full clip data
 * @property {number} fps - FPS for export timing
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
  // Close old VideoFrames before replacing with new ones
  closePayloadFrames(state.clipPayload);
  state.clipPayload = payload;
  // Clear old editor state since frames are now different
  state.editorPayload = null;
}

/**
 * Clear clip payload (called when editor is done with it)
 */
export function clearClipPayload() {
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

  if (!Array.isArray(p.frames)) {
    errors.push('EditorPayload.frames must be an array');
  } else if (p.frames.length === 0) {
    errors.push('EditorPayload.frames cannot be empty');
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
// Debug / Testing
// ============================================================

/**
 * Reset all state (for testing purposes)
 */
export function resetAppStore() {
  state.clipPayload = null;
  state.editorPayload = null;
  exportResult = null;
}
