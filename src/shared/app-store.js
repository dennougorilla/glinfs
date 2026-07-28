/**
 * Application Store for Cross-Feature Data Transfer
 * @module shared/app-store
 *
 * Handles data passing between features without using window globals.
 * Each payload type represents data flow between specific features:
 * - ClipPayload: capture -> editor (the ACTIVE clip)
 * - ClipQueueEntry: clips waiting in the bounded clip queue
 * - EditorPayload: editor -> export
 *
 * ============================================================
 * FRAME OWNERSHIP RULES (#95) — read before touching any of this
 * ============================================================
 * VideoFrames pin GPU/CPU memory until close()d, and drawing a closed frame
 * silently renders black. Every frame in this store therefore has exactly one
 * owner at a time — the active clipPayload or one clipQueue entry — and moves
 * between them without ever being copied or closed in transit:
 *
 * - Frames are closed ONLY on:
 *   1. explicit queue-entry delete (deleteQueuedClip),
 *   2. releaseAllFramesAndReset (which also drains the queue).
 *   They are NEVER closed on promoteQueuedClip / demote / setClipPayload
 *   while a queue exists — those operations only MOVE ownership.
 * - The ACTIVE clip is structurally never evictable: it lives in
 *   clipPayload, not in the queue, so no queue-limit logic can reach it.
 * - Queue full => enqueue (and the demote inside setClipPayload) is REFUSED
 *   with a { ok: false, reason: 'queue-full' } result the UI must surface.
 *   Nothing is destroyed on refusal.
 * - Every queue mutation emits 'queue:changed' on the bus.
 */

import { emit } from './bus.js';
import { loadSettings } from './user-settings.js';
import { createFrameThumbnailDataUrl } from './utils/canvas.js';
import { estimateFramesMemoryMB } from './utils/memory-monitor.js';
import { resetThumbnailCache } from './utils/thumbnail-cache.js';

/**
 * @typedef {Object} SavedEditorState
 * Editor state captured when a clip is demoted, restored when it is promoted
 * back. Kept small on purpose: only what the user would notice losing.
 * @property {import('../features/editor/types.js').FrameRange} selectedRange
 * @property {import('../features/editor/types.js').CropArea|null} cropArea
 * @property {number} playbackSpeed
 * @property {number} currentFrame
 */

/**
 * @typedef {Object} ClipPayload
 * @property {import('../features/capture/types.js').Frame[]} frames - Captured frames
 * @property {15|30|60} fps - Capture FPS setting
 * @property {number} capturedAt - Timestamp when clip was created
 * @property {boolean} [sceneDetectionEnabled] - Whether to run scene detection in editor
 * @property {import('../features/scene-detection/types.js').Scene[]} [scenes] - Pre-computed scenes from capture
 * @property {string} [id] - Stable clip identity across promote/demote round-trips
 * @property {string|null} [thumbnailDataUrl] - Small preview retained for queue display
 * @property {SavedEditorState|null} [savedEditorState] - State to restore; consumed by the editor on mount
 */

/**
 * @typedef {Object} ClipQueueEntry
 * @property {string} id - Unique clip identifier
 * @property {import('../features/capture/types.js').Frame[]} frames - Owned frames (closed only on delete/reset)
 * @property {15|30|60} fps - Capture FPS
 * @property {number} capturedAt - Timestamp when clip was created
 * @property {boolean} [sceneDetectionEnabled] - Scene detection flag carried with the clip
 * @property {import('../features/scene-detection/types.js').Scene[]} [scenes] - Scenes carried with the clip
 * @property {SavedEditorState|null} [savedEditorState] - Editor state saved at demote time
 * @property {string|null} thumbnailDataUrl - ~160px dataURL rendered from frame[0] at enqueue
 */

/**
 * Result of an operation that may be refused by the queue limit.
 * @typedef {Object} QueueResult
 * @property {boolean} ok
 * @property {'queue-full'} [reason] - Present when refused
 * @property {number} limit - Queue limit in effect
 * @property {ClipQueueEntry} [entry] - The enqueued entry (enqueue success only)
 * @property {number} [queueLength] - Queue length after the operation
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
 * @property {ClipPayload|null} clipPayload - Data from capture for editor (the active clip)
 * @property {EditorPayload|null} editorPayload - Data from editor for export
 * @property {ClipQueueEntry[]} clipQueue - Queued clips, newest first
 */

/** @type {AppState} */
const state = {
  clipPayload: null,
  editorPayload: null,
  clipQueue: [],
};

/** @type {Partial<ScreenCaptureState>|null} */
let screenCaptureState = null;

/** @type {((state: Partial<ScreenCaptureState>, options: {stopStream: boolean}) => void | Promise<void>) | null} */
let screenCaptureCleanupFn = null;

/** Monotonic suffix so ids stay unique even within one millisecond */
let clipIdCounter = 0;

/**
 * Generate a unique clip id
 * @returns {string}
 */
function generateClipId() {
  clipIdCounter += 1;
  return `clip-${Date.now()}-${clipIdCounter}`;
}

// ============================================================
// Internal: Frame Cleanup
// ============================================================

/**
 * Close every VideoFrame in a frames array.
 * ONLY call this from the two sanctioned paths documented in the ownership
 * rules at the top of this module (queue-entry delete, full reset).
 * @param {import('../features/capture/types.js').Frame[]|undefined|null} frames
 */
function closeFrameList(frames) {
  if (!frames) return;
  for (const frame of frames) {
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
  closeFrameList(payload?.clip?.frames);
}

// ============================================================
// Clip Queue (bounded, newest first)
// ============================================================

/**
 * Queue limit from user settings, clamped to the supported 1-10 range so a
 * corrupted localStorage value can never make the queue unbounded (or zero).
 * @returns {number}
 */
export function getClipQueueLimit() {
  const raw = Number(loadSettings().capture.clipQueueLimit);
  if (!Number.isFinite(raw)) return 3;
  return Math.min(10, Math.max(1, Math.round(raw)));
}

/**
 * Get a snapshot of the clip queue (newest first).
 * Returns a copy: callers must mutate the queue only through the functions
 * below, which enforce the ownership rules and emit 'queue:changed'.
 * @returns {ClipQueueEntry[]}
 */
export function getClipQueue() {
  return [...state.clipQueue];
}

/**
 * Whether the queue is at its configured limit
 * @returns {boolean}
 */
export function isClipQueueFull() {
  return state.clipQueue.length >= getClipQueueLimit();
}

/**
 * Ensure a clip payload carries a stable id and a queue thumbnail.
 * Assigned in place so identity survives {...payload} spreads (the loading
 * screen's scenes update) and object-identity checks in tests.
 * @param {ClipPayload} payload
 */
function ensureClipIdentity(payload) {
  if (!payload.id) {
    payload.id = generateClipId();
  }
  if (payload.thumbnailDataUrl === undefined) {
    payload.thumbnailDataUrl = createFrameThumbnailDataUrl(payload.frames?.[0]);
  }
}

/**
 * Build a queue entry from the active clip payload, carrying editor state.
 * MOVES frame ownership from clipPayload into the entry — closes nothing.
 * @param {ClipPayload} active
 * @param {(SavedEditorState & { scenes?: import('../features/scene-detection/types.js').Scene[] })|null} editorState
 * @returns {ClipQueueEntry}
 */
function activeToQueueEntry(active, editorState) {
  ensureClipIdentity(active);
  return {
    id: /** @type {string} */ (active.id),
    frames: active.frames,
    fps: active.fps,
    capturedAt: active.capturedAt,
    sceneDetectionEnabled: active.sceneDetectionEnabled,
    // Scenes detected while editing supersede whatever the payload carried
    scenes: editorState?.scenes?.length ? editorState.scenes : active.scenes,
    savedEditorState: editorState
      ? {
          selectedRange: editorState.selectedRange,
          cropArea: editorState.cropArea,
          playbackSpeed: editorState.playbackSpeed,
          currentFrame: editorState.currentFrame,
        }
      : (active.savedEditorState ?? null),
    thumbnailDataUrl: active.thumbnailDataUrl ?? null,
  };
}

/**
 * Notify listeners that the queue changed
 * @param {'enqueue'|'promote'|'delete'|'demote'|'reset'} type
 */
function emitQueueChanged(type) {
  emit('queue:changed', {
    type,
    queueLength: state.clipQueue.length,
    limit: getClipQueueLimit(),
  });
}

/**
 * Add a clip to the queue (newest first).
 *
 * REFUSES at the configured limit: returns { ok: false, reason: 'queue-full' }
 * and destroys nothing — the caller decides what to do with the frames it
 * still owns, and the UI must surface the refusal visibly.
 *
 * @param {ClipPayload} payload - Clip data; ownership of frames transfers to the queue on success
 * @returns {QueueResult}
 */
export function enqueueClip(payload) {
  const limit = getClipQueueLimit();
  if (state.clipQueue.length >= limit) {
    return { ok: false, reason: 'queue-full', limit };
  }

  ensureClipIdentity(payload);
  /** @type {ClipQueueEntry} */
  const entry = {
    id: /** @type {string} */ (payload.id),
    frames: payload.frames,
    fps: payload.fps,
    capturedAt: payload.capturedAt,
    sceneDetectionEnabled: payload.sceneDetectionEnabled,
    scenes: payload.scenes,
    savedEditorState: payload.savedEditorState ?? null,
    thumbnailDataUrl: payload.thumbnailDataUrl ?? null,
  };
  state.clipQueue.unshift(entry);
  emitQueueChanged('enqueue');
  return { ok: true, entry, queueLength: state.clipQueue.length, limit };
}

/**
 * Swap a queued clip with the active one.
 *
 * The current active clip (if any) demotes into the queue FRONT carrying the
 * caller's editor state; the promoted entry becomes the active clipPayload
 * with its saved editor state exposed (payload.savedEditorState) for the
 * editor to restore. NO frames are closed on either side of the swap, and
 * the queue length never grows past what it was (remove one, add at most
 * one), so the limit cannot be exceeded here.
 *
 * @param {string} id - Queue entry id to promote
 * @param {(SavedEditorState & { scenes?: import('../features/scene-detection/types.js').Scene[] })|null} [currentEditorState] - State of the editor session being demoted
 * @returns {{ payload: ClipPayload, savedEditorState: SavedEditorState|null } | null} null if id not found
 */
export function promoteQueuedClip(id, currentEditorState = null) {
  const index = state.clipQueue.findIndex((entry) => entry.id === id);
  if (index === -1) return null;

  const [entry] = state.clipQueue.splice(index, 1);

  // Demote the active clip into the queue front — ownership moves, no close
  if (state.clipPayload) {
    state.clipQueue.unshift(activeToQueueEntry(state.clipPayload, currentEditorState));
  }

  // The singleton thumbnail cache is active-clip-only; editorPayload and a
  // completed export belong to the demoted clip and must not leak into the
  // promoted one. None of this closes frames.
  resetThumbnailCache();
  state.editorPayload = null;
  exportResult = null;

  state.clipPayload = {
    id: entry.id,
    frames: entry.frames,
    fps: entry.fps,
    capturedAt: entry.capturedAt,
    sceneDetectionEnabled: entry.sceneDetectionEnabled,
    scenes: entry.scenes,
    thumbnailDataUrl: entry.thumbnailDataUrl,
    savedEditorState: entry.savedEditorState ?? null,
  };

  emitQueueChanged('promote');
  return { payload: state.clipPayload, savedEditorState: entry.savedEditorState ?? null };
}

/**
 * Delete a queued clip. One of only two paths that close frames.
 * @param {string} id
 * @returns {boolean} true if an entry was removed
 */
export function deleteQueuedClip(id) {
  const index = state.clipQueue.findIndex((entry) => entry.id === id);
  if (index === -1) return false;

  const [entry] = state.clipQueue.splice(index, 1);
  closeFrameList(entry.frames);
  emitQueueChanged('delete');
  return true;
}

/**
 * Conservative memory estimate (raw RGBA w*h*4) for the active clip plus
 * every queued clip. Exposed for the editor's memory footer.
 * @returns {number} Estimated MB
 */
export function getClipMemoryEstimateMB() {
  let total = estimateFramesMemoryMB(state.clipPayload?.frames ?? []);
  for (const entry of state.clipQueue) {
    total += estimateFramesMemoryMB(entry.frames);
  }
  return total;
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
 * Set the active clip payload.
 *
 * When the frames array actually changes, the PREVIOUS active clip demotes
 * into the queue front instead of being destroyed (ownership rules above).
 * If the queue is already at its limit the whole call is refused — nothing
 * is stored, demoted, or closed — and the caller must surface the refusal.
 *
 * Metadata-only updates (same frames reference, e.g. the loading screen
 * attaching scenes) never touch the queue and always succeed.
 *
 * @param {ClipPayload} payload
 * @returns {QueueResult}
 */
export function setClipPayload(payload) {
  const limit = getClipQueueLimit();

  // Only treat as a clip change if frames array is different
  // (prevents demoting when just adding metadata like scenes)
  if (state.clipPayload?.frames !== payload.frames) {
    if (state.clipPayload) {
      if (state.clipQueue.length >= limit) {
        return { ok: false, reason: 'queue-full', limit };
      }
      // Demote, never destroy: the old active clip's frames move to the queue
      state.clipQueue.unshift(activeToQueueEntry(state.clipPayload, null));
      emitQueueChanged('demote');
    }
    // Cached thumbnails are keyed by the previous clip's frame IDs; keeping
    // the singleton alive across clips retains canvases that can never be
    // reused for the new clip
    resetThumbnailCache();
    // Clear old editor state since frames are now different
    state.editorPayload = null;
    // A completed export belongs to the previous clip. The Export screen
    // already drops it on unmount; clearing it here too means no path — not
    // even a crash that skips cleanup — can carry it into the new clip.
    exportResult = null;
  }
  ensureClipIdentity(payload);
  state.clipPayload = payload;
  return { ok: true, limit };
}

/**
 * Clear clip payload
 * @param {boolean} [closeFrames=false] - If true, close all VideoFrames before clearing
 */
export function clearClipPayload(closeFrames = false) {
  if (closeFrames && state.clipPayload) {
    closeFrameList(state.clipPayload.frames);
  }
  resetThumbnailCache();
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
 * Release all VideoFrame resources and clear all payloads, DRAINING the clip
 * queue (closing every queued clip's frames). One of only two paths that
 * close frames. Called when starting a fresh capture session.
 */
export function releaseAllFramesAndReset() {
  closeFrameList(state.clipPayload?.frames);
  closeEditorPayloadFrames(state.editorPayload);
  for (const entry of state.clipQueue) {
    closeFrameList(entry.frames);
  }
  const hadQueue = state.clipQueue.length > 0;
  state.clipQueue.length = 0;
  state.clipPayload = null;
  state.editorPayload = null;
  exportResult = null;
  resetThumbnailCache();
  if (hadQueue) {
    emitQueueChanged('reset');
  }
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
 * Result of the export currently on screen.
 *
 * Scoped to a single visit to the Export screen: the feature clears it on
 * unmount so a later visit can never present an already-encoded GIF as its
 * own (see features/export/index.js). It exists so repeated downloads of the
 * same GIF reuse one generated filename.
 *
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
 * @param {(state: Partial<ScreenCaptureState>, options: {stopStream: boolean}) => void | Promise<void>} fn
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
 *
 * The returned promise settles when the delegated cleanup (stopping tracks,
 * terminating the capture worker) has actually finished, so callers that are
 * about to start a NEW capture session can await it and avoid racing the old
 * session's teardown. Callers that don't care may ignore the return value —
 * cleanup failures are logged either way and never thrown.
 *
 * @param {boolean} [stopStream=true] - If true, stop the MediaStream
 * @returns {Promise<void>} Settles when the delegated cleanup completes
 */
export function clearScreenCaptureState(stopStream = true) {
  const oldState = screenCaptureState;
  screenCaptureState = null;

  // Delegate side effects to registered cleanup function
  if (oldState && screenCaptureCleanupFn) {
    try {
      const result = screenCaptureCleanupFn(oldState, { stopStream });
      return Promise.resolve(result)
        .then(() => undefined)
        .catch((err) => {
          console.error('[app-store] Screen capture cleanup failed:', err);
        });
    } catch (err) {
      console.error('[app-store] Screen capture cleanup failed:', err);
    }
  }

  return Promise.resolve();
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
  state.clipQueue.length = 0;
  exportResult = null;
  clearScreenCaptureState();
}
