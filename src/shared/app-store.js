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
 * FRAME OWNERSHIP RULES (#95, #92) — read before touching any of this
 * ============================================================
 * VideoFrames pin GPU/CPU memory until close()d, and drawing a closed frame
 * silently renders black. Every frame in this store therefore has exactly one
 * owner at a time — the active clipPayload or one clipQueue entry — and moves
 * between them without ever being copied or closed in transit:
 *
 * - Frames are closed ONLY on:
 *   1. explicit queue-entry delete (deleteQueuedClip),
 *   2. releaseAllFramesAndReset (which also drains the queue),
 *   3. inside the codec worker after a successful encode (#92) — at that
 *      point the compressed bytes ARE the clip and the raw frames end,
 *   4. explicit ACTIVE-clip delete (deleteActiveClip — user-confirmed),
 *   5. decode-for-promote (prepareQueuedClipForPromote): the redundant
 *      decoded copies of a sharedKey group (imported holds) are closed and
 *      replaced by clones of the group's first decoded frame, so holds
 *      share pixels again (restoreSharedFrames).
 *   The one involuntary end is a codec-worker crash mid-encode: frames
 *   already transferred into the dying worker are gone and their entry is
 *   removed as 'compress-lost' (see FAILURE CONTRACT below).
 *   They are NEVER closed on promoteQueuedClip / demote / setClipPayload
 *   while a queue exists — those operations only MOVE ownership.
 * - The ACTIVE clip is structurally never evictable: it lives in
 *   clipPayload, not in the queue, so no queue-limit logic can reach it.
 * - Queue full => enqueue (and the demote inside setClipPayload) is REFUSED
 *   with a { ok: false, reason: 'queue-full' } result the UI must surface.
 *   Nothing is destroyed on refusal. Refusals are decided BEFORE any
 *   compression starts.
 * - Every queue mutation emits 'queue:changed' on the bus.
 *
 * Compressed queue entries (#92): when a clip codec is registered and
 * available, ONLY the active clip holds raw VideoFrames — queue entries are
 * transcoded to EncodedVideoChunk bytes in a worker. Entry lifecycle:
 *
 *   raw --> compressing --> compressed --> decoding --> raw (then promote)
 *              |     \
 *              v      `--> (removed: 'compress-lost', see failure contract)
 *             raw (recoverable encode failure: frames returned)
 *
 * FAILURE CONTRACT for 'compressing' entries:
 * - Recoverable encode error (encoder/config error inside a healthy worker):
 *   the worker transfers every frame BACK, the entry returns to 'raw' with
 *   its full clip and pre-#92 accounting. Nothing is lost.
 * - Worker crash / terminate, or a failure that cannot return every frame:
 *   the transferred VideoFrames died with the job and CANNOT be recovered.
 *   The entry is REMOVED from the queue and 'queue:changed' fires with
 *   type 'compress-lost' (+ id, error); the app shell shows a non-blocking
 *   notice (no Undo — there is nothing to restore). Only the clip whose job
 *   was running is lost: queued jobs had not transferred their frames yet.
 *   After a crash they run on a freshly created worker; after an explicit
 *   codec terminate() (teardown) they fail with every frame handed back,
 *   i.e. the recoverable path above (entry returns to 'raw').
 * - Decode failures never lose a clip: chunks are cloned into the worker,
 *   so the entry simply returns to 'compressed'.
 * - The ACTIVE clip is never handed to the codec, so it is never at risk.
 *
 * - 'compressing': the entry's VideoFrames were TRANSFERRED into the codec
 *   worker (the wrappers in entry.frames are detached husks kept only for
 *   their width/height accounting metadata). The entry cannot be promoted
 *   until the encode settles.
 * - 'compressed': entry.frames is null; entry.compressed holds plain
 *   ArrayBuffer chunks under normal GC — the close() rules above apply to
 *   raw frames only. Deleting a compressed entry just drops the buffers.
 * - 'decoding': a promote is decoding this entry (double-promote is
 *   refused). Deleting the entry mid-decode discards (closes) the decoded
 *   frames when they arrive.
 * - No codec registered / unsupported platform: entries stay 'raw' with
 *   exactly the pre-#92 semantics.
 */

import { emit } from './bus.js';
import {
  CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED,
  CLIP_QUEUE_LIMIT_DEFAULT_RAW,
  loadSettings,
} from './user-settings.js';
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
 * @property {import('./edits/model.js').ClipEdits} [edits] - Text/background edits
 */

/**
 * @typedef {Object} ClipPayload
 * @property {import('../features/capture/types.js').Frame[]} frames - Captured frames
 * @property {number} fps - Clip FPS: the capture setting (15/30/60) or, for an
 *   imported file, the rate chosen from its frame delays (integer 1..60)
 * @property {number} capturedAt - Timestamp when clip was created
 * @property {boolean} [sceneDetectionEnabled] - Whether to run scene detection in editor
 * @property {import('../features/scene-detection/types.js').Scene[]} [scenes] - Pre-computed scenes from capture
 * @property {string} [id] - Stable clip identity across promote/demote round-trips
 * @property {string|null} [thumbnailDataUrl] - Small preview retained for queue display
 * @property {SavedEditorState|null} [savedEditorState] - State to restore; consumed by the editor on mount
 * @property {boolean} [hasAlpha] - The clip has transparent pixels (imported
 *   GIF/PNG/WebP). Such clips are never codec-compressed (VP8/VP9 drop alpha)
 *   and their queue thumbnails are PNG
 * @property {string|null} [sourceName] - File name of an imported clip; absent
 *   or null for screen captures
 * @property {string[]|null} [previewFrames] - Pre-baked hover-skim thumbnails
 */

/**
 * Entry lifecycle state (#92) — see the ownership rules diagram above.
 * @typedef {'raw'|'compressing'|'compressed'|'decoding'} ClipQueueEntryStatus
 */

/**
 * Compressed form of a queued clip (#92). Chunks and description are plain
 * ArrayBuffers under normal GC. frameMeta preserves the original Frame
 * wrapper identities so a decode round-trip rebuilds the same clip.
 * @typedef {Object} CompressedClip
 * @property {import('./clip-codec.js').SerializedChunk[]} chunks
 * @property {import('./clip-codec.js').EncodedClipConfig} config
 * @property {number} byteLength - Total compressed payload bytes
 * @property {{id: string, timestamp: number, width: number, height: number, sharedKey?: string}[]} frameMeta
 */

/**
 * @typedef {Object} ClipQueueEntry
 * @property {string} id - Unique clip identifier
 * @property {import('../features/capture/types.js').Frame[]|null} frames - Owned frames
 *   (closed only on delete/reset). null while 'compressed'/'decoding';
 *   detached husks while 'compressing' (kept for accounting metadata).
 * @property {ClipQueueEntryStatus} status - Lifecycle state (#92)
 * @property {number} frameCount - Frame count, stable across compression
 * @property {CompressedClip|null} compressed - Compressed bytes ('compressed'/'decoding' only)
 * @property {number} [byteLengthMB] - Compressed size in MB (set once compressed)
 * @property {number} fps - Clip FPS (see ClipPayload.fps)
 * @property {number} capturedAt - Timestamp when clip was created
 * @property {boolean} [hasAlpha] - Carried with the clip; never compressed when true
 * @property {string|null} [sourceName] - Imported file name (null for captures)
 * @property {boolean} [sceneDetectionEnabled] - Scene detection flag carried with the clip
 * @property {import('../features/scene-detection/types.js').Scene[]} [scenes] - Scenes carried with the clip
 * @property {SavedEditorState|null} [savedEditorState] - Editor state saved at demote time
 * @property {string|null} thumbnailDataUrl - ~160px dataURL rendered from frame[0] at enqueue
 * @property {string[]|null} [previewFrames] - Pre-baked skim thumbnails for
 *   hover preview (#100 v3); survives compression because they are plain
 *   dataURLs baked from the raw frames at enqueue
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
 * @property {import('./edits/model.js').ClipEdits} [edits] - Text/background edits to burn in
 * @property {boolean} [hasAlpha] - Source clip has transparent pixels
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

/**
 * Close bare VideoFrames handed back by the codec (#92) that no queue entry
 * owns anymore (deleted/reset mid-job). Same guard convention as
 * closeFrameList, but for unwrapped frames.
 * @param {VideoFrame[]|undefined|null} videoFrames
 */
function closeVideoFrames(videoFrames) {
  if (!videoFrames) return;
  for (const vf of videoFrames) {
    try {
      if (!vf.closed) vf.close();
    } catch {
      // Ignore errors - frame may already be closed
    }
  }
}

// ============================================================
// Clip Codec seam (#92)
// ============================================================

/**
 * Minimal surface this store needs from shared/clip-codec.js. Injected (like
 * registerScreenCaptureCleanup) so jsdom tests can drive the entry state
 * machine with a mock codec and no WebCodecs.
 * @typedef {Object} ClipCodecLike
 * @property {() => boolean} isCompressionAvailable
 * @property {() => Promise<boolean>} [probeSupport] - When present, the store
 *   re-announces the queue limit once it resolves (the "auto" default moves)
 * @property {(frames: VideoFrame[], options: {fps: number, width: number, height: number}) => Promise<import('./clip-codec.js').EncodeResult>} encode
 * @property {(compressed: {chunks: import('./clip-codec.js').SerializedChunk[], config: import('./clip-codec.js').EncodedClipConfig}) => Promise<import('./clip-codec.js').DecodeResult>} decode
 */

/** @type {ClipCodecLike|null} */
let clipCodec = null;

/**
 * Pending encode jobs by entry id, so a promote of a still-'compressing'
 * entry can await the encode before decoding, and delete can let a stale
 * result be discarded on arrival.
 * @type {Map<string, Promise<void>>}
 */
const pendingEncodeJobs = new Map();

/**
 * Register the clip codec service (called once at app startup from main.js).
 * Passing null unregisters (tests).
 * @param {ClipCodecLike|null} codec
 */
export function registerClipCodec(codec) {
  clipCodec = codec;
  // The "auto" queue limit flips from the raw to the compressed default once
  // the probe finds WebCodecs support — tell limit displays to re-read it
  void codec?.probeSupport?.().then(() => {
    if (clipCodec === codec) emitQueueChanged('codec-ready');
  });
}

/**
 * Whether queued clips are being WebCodecs-compressed (#92).
 * False when no codec is registered or the platform probe failed.
 * @returns {boolean}
 */
export function isClipCompressionAvailable() {
  return clipCodec?.isCompressionAvailable() === true;
}

// ============================================================
// Clip Queue (bounded, newest first)
// ============================================================

/**
 * The queue limit that applies while the user has not chosen one (#92):
 * 10 when queued clips are compressed, 3 when they stay raw (~3.5 GiB per
 * default 1080p clip). Until the codec probe resolves, compression reads as
 * unavailable, so this is the conservative raw value — entries enqueued in
 * that window stay raw anyway.
 * @returns {number}
 */
export function getDefaultClipQueueLimit() {
  return isClipCompressionAvailable()
    ? CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED
    : CLIP_QUEUE_LIMIT_DEFAULT_RAW;
}

/**
 * The user's explicit queue limit, or null for "auto" (stored null/absent,
 * or non-numeric garbage from a corrupted localStorage value)
 * @returns {number|null}
 */
function readUserClipQueueLimit() {
  const stored = loadSettings().capture.clipQueueLimit;
  if (stored === null || stored === undefined) return null;
  const value = Number(stored);
  return Number.isFinite(value) ? value : null;
}

/**
 * Whether the user explicitly chose a queue limit (vs. "auto")
 * @returns {boolean}
 */
export function isClipQueueLimitUserSet() {
  return readUserClipQueueLimit() !== null;
}

/**
 * Effective queue limit: the user's explicit choice (never overridden),
 * else the platform default from getDefaultClipQueueLimit(). Clamped to the
 * supported 1-30 range so a corrupted localStorage value can never make the
 * queue unbounded (or zero).
 * @returns {number}
 */
export function getClipQueueLimit() {
  const userLimit = readUserClipQueueLimit();
  if (userLimit === null) return getDefaultClipQueueLimit();
  return Math.min(30, Math.max(1, Math.round(userLimit)));
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
  // JPEG has no alpha channel: transparent areas of an alpha clip would bake
  // to black in the queue list, so those thumbnails are PNG
  const mimeType = getThumbnailMimeType(payload);
  if (payload.thumbnailDataUrl === undefined) {
    payload.thumbnailDataUrl = createFrameThumbnailDataUrl(
      payload.frames?.[0],
      THUMBNAIL_MAX_DIMENSION,
      mimeType,
    );
  }
  if (payload.previewFrames === undefined) {
    payload.previewFrames = buildPreviewFrames(payload.frames, mimeType);
  }
}

/** Longest edge of queue thumbnails (px) */
const THUMBNAIL_MAX_DIMENSION = 160;

/**
 * Image format for a clip's queue thumbnails: PNG keeps transparency for
 * alpha clips, JPEG (smaller) for everything else.
 * @param {{ hasAlpha?: boolean }} payload
 * @returns {'image/png'|'image/jpeg'}
 */
export function getThumbnailMimeType(payload) {
  return payload?.hasAlpha ? 'image/png' : 'image/jpeg';
}

/** Number of pre-baked skim thumbnails per clip (hover preview, #100 v3) */
const PREVIEW_FRAME_COUNT = 10;

/**
 * Bake a small set of evenly-sampled thumbnails for hover-skim previews.
 *
 * Rendered from the RAW frames at the only moment they are guaranteed to
 * exist on this thread (before #92 compression transfers them away).
 * ~10 x 160px dataURLs ≈ 100 KB per clip — this is what makes "play the
 * clip in the list" affordable: skimming pre-baked stills instead of
 * decoding compressed chunks on hover.
 *
 * @param {import('../features/capture/types.js').Frame[]|null|undefined} frames
 * @param {'image/png'|'image/jpeg'} [mimeType='image/jpeg']
 * @returns {string[]|null}
 */
function buildPreviewFrames(frames, mimeType = 'image/jpeg') {
  if (!frames || frames.length < 2) return null;
  const n = Math.min(PREVIEW_FRAME_COUNT, frames.length);
  /** @type {string[]} */
  const urls = [];
  for (let k = 0; k < n; k++) {
    const index = Math.round((k * (frames.length - 1)) / (n - 1));
    const url = createFrameThumbnailDataUrl(frames[index], THUMBNAIL_MAX_DIMENSION, mimeType);
    if (url) urls.push(url);
  }
  return urls.length > 1 ? urls : null;
}

/**
 * Keep only the editor-state fields worth restoring on promote (the caller
 * may pass a larger object, e.g. with scenes).
 * @param {SavedEditorState} editorState
 * @returns {SavedEditorState}
 */
function toSavedEditorState(editorState) {
  /** @type {SavedEditorState} */
  const saved = {
    selectedRange: editorState.selectedRange,
    cropArea: editorState.cropArea,
    playbackSpeed: editorState.playbackSpeed,
    currentFrame: editorState.currentFrame,
  };
  if (editorState.edits !== undefined) {
    saved.edits = editorState.edits;
  }
  return saved;
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
    status: /** @type {ClipQueueEntryStatus} */ ('raw'),
    frameCount: active.frames?.length ?? 0,
    compressed: null,
    fps: active.fps,
    capturedAt: active.capturedAt,
    hasAlpha: active.hasAlpha === true,
    sourceName: active.sourceName ?? null,
    sceneDetectionEnabled: active.sceneDetectionEnabled,
    // Scenes detected while editing supersede whatever the payload carried
    scenes: editorState?.scenes?.length ? editorState.scenes : active.scenes,
    savedEditorState: editorState
      ? toSavedEditorState(editorState)
      : (active.savedEditorState ?? null),
    thumbnailDataUrl: active.thumbnailDataUrl ?? null,
    previewFrames: active.previewFrames ?? null,
  };
}

/**
 * Delete the ACTIVE clip on explicit user request (#100 round 4).
 *
 * The active clip is never evictable by queue mechanics, but the user may
 * delete it deliberately (two-step confirm in the UI). Closes its frames,
 * clears the payloads that referenced them (editorPayload aliases the same
 * frame objects — nulled, not double-closed) and the per-visit export
 * result. The queue is untouched; the caller decides the succession
 * (auto-promote / select screen / redirect).
 *
 * @returns {boolean} true if there was an active clip to delete
 */
export function deleteActiveClip() {
  if (!state.clipPayload) return false;
  // Hold for undo instead of closing (#100 round 5): the entry restores to
  // the queue front if the user changes their mind within the grace window
  holdForUndo(activeToQueueEntry(state.clipPayload, null), 0);
  state.clipPayload = null;
  state.editorPayload = null;
  exportResult = null;
  // Deliberately NOT resetting the thumbnail cache: the successor clip's
  // cached thumbnails must survive the swap or the filmstrip rebuilds dark
  // (#100 round 6). Stale entries age out of the LRU on their own.
  emitQueueChanged('delete-active');
  return true;
}

/**
 * Notify listeners that the queue changed
 * @param {'enqueue'|'promote'|'delete'|'delete-active'|'demote'|'reset'|'compress-start'|'compress'|'compress-error'|'compress-lost'|'decode-start'|'decode'|'decode-error'|'codec-ready'} type
 * @param {{ id?: string, error?: string }} [detail] - Entry id/error for
 *   'compress-lost', so listeners can tell a lost clip from a user delete
 */
function emitQueueChanged(type, detail = {}) {
  emit('queue:changed', {
    type,
    ...detail,
    queueLength: state.clipQueue.length,
    limit: getClipQueueLimit(),
  });
}

/**
 * Is this entry immediately promotable (raw frames in hand)?
 * @param {ClipQueueEntry} entry
 * @returns {boolean}
 */
function isEntryPromotableNow(entry) {
  return entry.status === 'raw' && (entry.frames?.length ?? 0) > 0;
}

/**
 * Kick background compression for a raw entry that just entered the queue.
 *
 * Called AFTER the entry is in state.clipQueue and AFTER its thumbnail was
 * rendered (ensureClipIdentity) — the VideoFrames are about to be
 * transferred into the worker and become unusable on this thread. Callers
 * emit their own 'enqueue'/'demote'/'promote' event right after, so the
 * 'compressing' state rides that emission; completion emits its own.
 *
 * No codec / codec unavailable: no-op, the entry stays 'raw' (fallback).
 *
 * @param {ClipQueueEntry} entry
 */
function maybeCompressEntry(entry) {
  const codec = clipCodec;
  if (!codec?.isCompressionAvailable()) return;
  if (entry.status !== 'raw' || !entry.frames || entry.frames.length === 0) return;
  // VP8/VP9 have no alpha channel: compressing a transparent clip would
  // silently turn its transparent pixels opaque. Alpha clips stay raw.
  if (entry.hasAlpha) return;

  const wrappers = entry.frames;
  // Identity metadata survives on this side; the VideoFrames themselves move
  const frameMeta = wrappers.map((f) => {
    /** @type {CompressedClip['frameMeta'][number]} */
    const meta = { id: f.id, timestamp: f.timestamp, width: f.width, height: f.height };
    if (f.sharedKey !== undefined) meta.sharedKey = f.sharedKey;
    return meta;
  });
  const videoFrames = wrappers.map((f) => f.frame);

  entry.status = 'compressing';

  const job = codec
    .encode(videoFrames, {
      fps: entry.fps,
      width: frameMeta[0].width,
      height: frameMeta[0].height,
    })
    .then((result) => {
      pendingEncodeJobs.delete(entry.id);
      const live = state.clipQueue.includes(entry);

      if (result.ok) {
        if (!live) return; // Deleted while compressing: chunks are plain buffers, GC takes them
        // The raw frames were closed inside the worker; the detached husks
        // in entry.frames carried only accounting metadata
        entry.frames = null;
        entry.compressed = {
          chunks: result.chunks,
          config: result.config,
          byteLength: result.byteLength,
          frameMeta,
        };
        entry.byteLengthMB = result.byteLength / (1024 * 1024);
        entry.status = 'compressed';
        emitQueueChanged('compress');
        return;
      }

      // Encode failure: when the worker transferred every VideoFrame back
      // (recoverable error), rebuild the wrappers so the entry stays raw
      // with its full clip. If the entry was deleted meanwhile, the returned
      // frames have no owner left: close them here (delete-path semantics).
      if (!live) {
        closeVideoFrames(result.frames);
        return;
      }
      if (result.frames.length === frameMeta.length) {
        // The SAME VideoFrames come back (clones still share pixels), so the
        // sharedKey memory accounting stays valid
        entry.frames = result.frames.map((vf, i) => {
          /** @type {import('../features/capture/types.js').Frame} */
          const wrapper = {
            id: frameMeta[i].id,
            frame: vf,
            timestamp: frameMeta[i].timestamp,
            width: frameMeta[i].width,
            height: frameMeta[i].height,
          };
          if (frameMeta[i].sharedKey !== undefined) wrapper.sharedKey = frameMeta[i].sharedKey;
          return wrapper;
        });
        entry.status = 'raw';
        emitQueueChanged('compress-error');
      } else {
        // LOSS (see the failure contract in the module header): the worker
        // crashed/was terminated mid-job, or could not hand every frame
        // back, so the clip's frames are gone. Nothing usable is left —
        // remove the entry (no dangling 'compressing' husk that would render
        // black) and announce it as 'compress-lost', distinct from a user
        // delete, so the UI can tell the user instead of failing silently.
        closeVideoFrames(result.frames);
        entry.frames = null;
        const index = state.clipQueue.indexOf(entry);
        if (index !== -1) {
          state.clipQueue.splice(index, 1);
          emitQueueChanged('compress-lost', { id: entry.id, error: result.error });
        }
      }
    });

  pendingEncodeJobs.set(entry.id, job);
}

/**
 * Re-share the pixels of repeated slots after a decode round trip.
 *
 * An imported clip's repeated slots (holds) are clones of one source frame
 * and carry its sharedKey, so they cost one frame of memory (see
 * estimateFramesMemoryMB). The codec decodes every slot into its OWN
 * VideoFrame, which would multiply the clip's real memory by
 * slots / source frames — unchecked by any budget — and, being lossy, could
 * make the holds differ slightly so export merging stops collapsing them.
 *
 * So the first decoded frame of each sharedKey group is kept, every other
 * slot of the group becomes a restamped clone of it, and the redundant
 * decoded frame is closed (ownership rule 5). If a clone cannot be created
 * the slot keeps its own decoded frame and is counted individually (no
 * sharedKey).
 *
 * @param {VideoFrame[]} decodedFrames - Owned by the caller's entry
 * @param {CompressedClip['frameMeta']} meta
 * @returns {{ frame: VideoFrame, sharedKey?: string }[]}
 */
function restoreSharedFrames(decodedFrames, meta) {
  /** @type {Map<string, VideoFrame>} */
  const groupSources = new Map();
  return decodedFrames.map((decoded, i) => {
    const sharedKey = meta[i]?.sharedKey;
    if (sharedKey === undefined) return { frame: decoded };
    const source = groupSources.get(sharedKey);
    if (!source) {
      groupSources.set(sharedKey, decoded);
      return { frame: decoded, sharedKey };
    }
    try {
      const clone = new VideoFrame(source, {
        timestamp: decoded.timestamp ?? meta[i].timestamp,
      });
      decoded.close();
      return { frame: clone, sharedKey };
    } catch (err) {
      console.warn('[ClipQueue] Could not re-share a decoded hold frame:', err);
      return { frame: decoded };
    }
  });
}

/**
 * Make a queue entry promotable, decoding it first when it is compressed.
 *
 * Resolves { ok: true } once the entry holds raw frames again — the caller
 * then runs the normal SYNCHRONOUS promoteQueuedClip swap (capturing the
 * editor state at swap time, so the user keeps editing while we decode).
 *
 * Lifecycle handled here (#92):
 * - 'raw': resolves immediately (also the no-codec fallback path)
 * - 'compressing': awaits the pending encode, then falls through
 * - 'compressed': flips to 'decoding' (visible via queue:changed), decodes
 *   in the worker (decode jobs jump the codec queue), rebuilds the Frame
 *   wrappers from frameMeta and returns the entry to 'raw'
 * - 'decoding': REFUSED — the double-promote guard
 * - deleted at any await point: refused with 'not-found', decoded frames
 *   (if any arrived) are closed because the entry no longer owns anything
 *
 * @param {string} id - Queue entry id
 * @returns {Promise<{ok: true} | {ok: false, reason: 'not-found'|'decoding'|'decode-failed'}>}
 */
export async function prepareQueuedClipForPromote(id) {
  let entry = state.clipQueue.find((e) => e.id === id);
  if (!entry) return { ok: false, reason: 'not-found' };
  if (entry.status === 'decoding') return { ok: false, reason: 'decoding' };

  if (entry.status === 'compressing') {
    await pendingEncodeJobs.get(id);
    entry = state.clipQueue.find((e) => e.id === id);
    if (!entry) return { ok: false, reason: 'not-found' };
  }

  if (isEntryPromotableNow(entry)) return { ok: true };
  if (entry.status !== 'compressed' || !entry.compressed || !clipCodec) {
    return { ok: false, reason: 'not-found' };
  }

  entry.status = 'decoding';
  emitQueueChanged('decode-start');

  const compressed = entry.compressed;
  const result = await clipCodec.decode({
    chunks: compressed.chunks,
    config: compressed.config,
  });
  const live = state.clipQueue.includes(entry);

  if (!result.ok) {
    if (live) {
      // The chunks were cloned into the worker, so the compressed bytes are
      // intact — the entry simply returns to 'compressed'
      entry.status = 'compressed';
      emitQueueChanged('decode-error');
    }
    return { ok: false, reason: 'decode-failed' };
  }

  if (!live) {
    // Deleted while decoding: the freshly decoded frames have no owner
    closeVideoFrames(result.frames);
    return { ok: false, reason: 'not-found' };
  }

  const meta = compressed.frameMeta;
  entry.frames = restoreSharedFrames(result.frames, meta).map((restored, i) => {
    const vf = restored.frame;
    /** @type {import('../features/capture/types.js').Frame} */
    const wrapper = {
      id: meta[i]?.id ?? `${entry.id}-decoded-${i}`,
      frame: vf,
      timestamp: meta[i]?.timestamp ?? vf.timestamp ?? i,
      width: meta[i]?.width ?? vf.codedWidth ?? 0,
      height: meta[i]?.height ?? vf.codedHeight ?? 0,
    };
    if (restored.sharedKey !== undefined) wrapper.sharedKey = restored.sharedKey;
    return wrapper;
  });
  entry.compressed = null;
  entry.byteLengthMB = undefined;
  entry.status = 'raw';
  emitQueueChanged('decode');
  return { ok: true };
}

/**
 * Re-kick compression for a raw entry sitting in the queue. Used when a
 * decode-for-promote completed but the promote was abandoned (e.g. the
 * editor unmounted while decoding) — the entry must not linger raw.
 * @param {string} id
 */
export function compressQueuedClip(id) {
  const entry = state.clipQueue.find((e) => e.id === id);
  if (!entry) return;
  maybeCompressEntry(entry);
  if (entry.status === 'compressing') {
    emitQueueChanged('compress-start');
  }
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
    status: 'raw',
    frameCount: payload.frames?.length ?? 0,
    compressed: null,
    fps: payload.fps,
    capturedAt: payload.capturedAt,
    hasAlpha: payload.hasAlpha === true,
    sourceName: payload.sourceName ?? null,
    sceneDetectionEnabled: payload.sceneDetectionEnabled,
    scenes: payload.scenes,
    savedEditorState: payload.savedEditorState ?? null,
    thumbnailDataUrl: payload.thumbnailDataUrl ?? null,
    previewFrames: payload.previewFrames ?? null,
  };
  state.clipQueue.unshift(entry);
  // Refusals above happen BEFORE this point — compression never starts for a
  // clip the queue won't take (#92). The thumbnail was rendered by
  // ensureClipIdentity while the frames were still usable on this thread.
  maybeCompressEntry(entry);
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
 * Compressed entries (#92) cannot be promoted directly — this function
 * refuses (returns null) unless the entry holds raw frames. Callers that may
 * face a compressed entry must run prepareQueuedClipForPromote(id) first and
 * call this only after it resolves ok.
 *
 * @param {string} id - Queue entry id to promote
 * @param {(SavedEditorState & { scenes?: import('../features/scene-detection/types.js').Scene[] })|null} [currentEditorState] - State of the editor session being demoted
 * @returns {{ payload: ClipPayload, savedEditorState: SavedEditorState|null } | null} null if id not found or the entry is not promotable yet
 */
export function promoteQueuedClip(id, currentEditorState = null) {
  const index = state.clipQueue.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  if (!isEntryPromotableNow(state.clipQueue[index])) return null;

  const [entry] = state.clipQueue.splice(index, 1);

  // Demote the active clip into the queue front — ownership moves, no close.
  // The demoted entry then compresses in the background (#92): after the
  // swap only the (new) active clip holds raw frames.
  if (state.clipPayload) {
    const demoted = activeToQueueEntry(state.clipPayload, currentEditorState);
    state.clipQueue.unshift(demoted);
    maybeCompressEntry(demoted);
  }

  // editorPayload and a completed export belong to the demoted clip and
  // must not leak into the promoted one. The thumbnail cache is NOT reset:
  // entries are keyed by frame id (collision-free across clips) and the
  // promoted clip's cached thumbnails keep the filmstrip instant across
  // swaps — resetting here was the dark-filmstrip flash on every promote
  // (#100 round 6). None of this closes frames.
  state.editorPayload = null;
  exportResult = null;

  state.clipPayload = {
    id: entry.id,
    frames: entry.frames,
    fps: entry.fps,
    capturedAt: entry.capturedAt,
    hasAlpha: entry.hasAlpha === true,
    sourceName: entry.sourceName ?? null,
    sceneDetectionEnabled: entry.sceneDetectionEnabled,
    scenes: entry.scenes,
    thumbnailDataUrl: entry.thumbnailDataUrl,
    savedEditorState: entry.savedEditorState ?? null,
  };

  emitQueueChanged('promote');
  return { payload: state.clipPayload, savedEditorState: entry.savedEditorState ?? null };
}

/**
 * Delete a queued clip. One of only two explicit paths that close frames.
 *
 * Compression lifecycle (#92): a 'compressed' entry's chunks are plain
 * buffers (GC). Deleting a 'compressing' or 'decoding' entry removes it
 * immediately; when its in-flight codec job settles, the job handler sees
 * the entry is gone and discards/closes the result (cancel-by-discard).
 * @param {string} id
 * @returns {boolean} true if an entry was removed
 */
export function deleteQueuedClip(id) {
  const index = state.clipQueue.findIndex((entry) => entry.id === id);
  if (index === -1) return false;

  const [entry] = state.clipQueue.splice(index, 1);
  holdForUndo(entry, index);
  emitQueueChanged('delete');
  return true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * Deferred deletion with undo (#100 round 5, plan A)
 * ═══════════════════════════════════════════════════════════════════════
 * Deletion is a single click, so it must be reversible: a deleted entry is
 * HELD (frames untouched) for UNDO_GRACE_MS before its resources are truly
 * released. One slot — a new delete finalizes the previous hold first,
 * mirroring the single-undo toast the UI shows. releaseAllFramesAndReset
 * finalizes the hold too, so a full reset never leaks held frames.
 */
const UNDO_GRACE_MS = 5000;

/** @type {{ entry: ClipQueueEntry, index: number, timer: ReturnType<typeof setTimeout> } | null} */
let pendingDeletion = null;

/**
 * @param {ClipQueueEntry} entry - Entry just removed from the queue (or the
 *   demoted active clip); its frames are still owned by this hold
 * @param {number} index - Queue position to restore to on undo
 */
function holdForUndo(entry, index) {
  finalizePendingDeletion();
  pendingDeletion = {
    entry,
    index,
    timer: setTimeout(() => {
      finalizePendingDeletion();
    }, UNDO_GRACE_MS),
  };
}

/** Actually release the held entry's resources (grace expired / superseded) */
function finalizePendingDeletion() {
  if (!pendingDeletion) return;
  clearTimeout(pendingDeletion.timer);
  closeFrameList(pendingDeletion.entry.frames);
  pendingDeletion = null;
}

/**
 * Restore the most recent deletion. Queue entries return to their original
 * position; a deleted ACTIVE clip returns to the queue front (never
 * re-activated — silently swapping the open editor would be worse than the
 * deletion was).
 * @returns {boolean} true if something was restored
 */
export function undoDelete() {
  if (!pendingDeletion) return false;
  const { entry, index, timer } = pendingDeletion;
  clearTimeout(timer);
  pendingDeletion = null;
  state.clipQueue.splice(Math.min(index, state.clipQueue.length), 0, entry);
  emitQueueChanged('enqueue');
  return true;
}

/**
 * Memory estimate for the active clip plus every queued clip, exposed for
 * the editor's memory footer. Raw frames count at conservative RGBA w*h*4;
 * compressed entries count at their ACTUAL compressed byteLength (#92) —
 * 'compressing' entries still count raw, since the real frames are alive in
 * the codec worker until the encode finishes.
 * @returns {number} Estimated MB
 */
export function getClipMemoryEstimateMB() {
  let total = estimateFramesMemoryMB(state.clipPayload?.frames ?? []);
  for (const entry of state.clipQueue) {
    if (entry.status === 'compressed' || entry.status === 'decoding') {
      total += (entry.compressed?.byteLength ?? 0) / (1024 * 1024);
    } else {
      total += estimateFramesMemoryMB(entry.frames ?? []);
    }
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
      // Demote, never destroy: the old active clip's frames move to the
      // queue, then compress in the background (#92)
      const demoted = activeToQueueEntry(state.clipPayload, null);
      state.clipQueue.unshift(demoted);
      maybeCompressEntry(demoted);
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
  finalizePendingDeletion();
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

  // Capture offers 15/30/60; imported files pick any integer rate from their
  // frame delays (features/import/core.js chooseImportFps)
  if (typeof p.fps !== 'number' || !Number.isInteger(p.fps) || p.fps < 1 || p.fps > 60) {
    errors.push('ClipPayload.fps must be an integer between 1 and 60');
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
