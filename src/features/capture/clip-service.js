/**
 * Clip Service - "Clip Now" from anywhere
 * @module features/capture/clip-service
 *
 * Takes a non-stopping snapshot of the live capture ring buffer and enqueues
 * it as a clip, without touching the active clip or whatever screen is
 * mounted. Works on every route (the live session is resolved via
 * getLiveCaptureContext) and is wired to the global Shift+C hotkey and the
 * header camera button in main.js.
 */

import {
  enqueueClip,
  estimateQueuedClipMB,
  evictQueuedClips,
  getClipQueue,
  getClipQueueLimit,
  getHeldMemoryMB,
  isClipQueueFull,
  planQueueEviction,
  RING_BUFFER_HOLDER,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { registerHotkey } from '../../shared/hotkeys.js';
import { announce } from '../../shared/live-region.js';
import { showToast } from '../../shared/toast.js';
import { loadSettings } from '../../shared/user-settings.js';
import {
  BYTES_PER_MB,
  estimateFramesMemoryMB,
  formatMemory,
} from '../../shared/utils/memory-monitor.js';
import { convertBitmapFramesToVideoFrames, getLiveCaptureContext } from './index.js';

/**
 * @typedef {Object} ClipNowResult
 * @property {boolean} ok
 * @property {'no-capture'|'no-frames'|'queue-full'|'memory-budget'} [reason] - Present when refused
 */

/**
 * Would materializing the current buffer as a clip exceed the memory budget?
 *
 * Projected total = everything held right after the snapshot
 * (getHeldMemoryMB) + the snapshot as it will be held (#96, memory
 * accounting PR A):
 * - The ring buffer is left out: the snapshot drains it. It refills
 *   afterwards up to its clamp (BUFFER_BUDGET_SHARE of the budget), which is
 *   what bounds it, not a refusal.
 * - Create Clip (asActive): the snapshot becomes the active clip (raw RGBA)
 *   and the current active clip is counted as it will be once queued,
 *   compressed when the queue compresses it.
 * - Clip Now: the snapshot goes to the queue, so it is the one counted
 *   compressed. Its raw frames live on for the ~2 s the encode takes; that
 *   transient is not guarded.
 * Checked BEFORE requestFrames(): draining the ring buffer only to refuse
 * and close the result would destroy the user's buffered history for
 * nothing.
 *
 * @param {ReturnType<typeof getLiveCaptureContext>} context
 * @param {{ asActive?: boolean }} [options] - asActive: Create Clip
 * @returns {import('../../shared/app-store.js').MemoryProjection}
 */
export function projectClipMemory(context, { asActive = false } = {}) {
  const budgetMB = loadSettings().capture.memoryBudgetMB;
  const dims = context?.workerManager?.getEffectiveFrameDimensions?.() ?? null;
  const frameCount = context?.stats?.frameCount ?? 0;
  const snapshot = dims
    ? { frameCount, width: dims.width, height: dims.height, fps: context?.fps ?? 0 }
    : null;
  let incomingMB = 0;
  if (snapshot) {
    incomingMB = asActive
      ? (frameCount * snapshot.width * snapshot.height * 4) / BYTES_PER_MB
      : estimateQueuedClipMB(snapshot);
  }
  const heldMB = heldAfterSnapshotMB(asActive);
  const projectedMB = heldMB + incomingMB;
  return {
    over: budgetMB > 0 && projectedMB > budgetMB,
    projectedMB,
    budgetMB,
    heldMB,
    incomingMB,
  };
}

/**
 * Held memory right after a buffer snapshot, without the clip itself
 * @param {boolean} asActive - Create Clip: the active clip is demoted
 * @returns {number} MB
 */
function heldAfterSnapshotMB(asActive) {
  return getHeldMemoryMB({ without: [RING_BUFFER_HOLDER], activeDemotes: asActive });
}

/**
 * Human-readable refusal for a memory-budget rejection.
 *
 * Names the numbers (what is held vs what the new clip would add vs the
 * budget) and offers ONLY actions that are actually possible right now:
 * "delete a clip" with an empty queue sent a real user hunting for a
 * delete button that does not exist — the active clip is not deletable.
 *
 * @param {ReturnType<typeof projectClipMemory>} projection
 * @param {string} [clipLabel='new clip'] - What the incoming clip is
 * @returns {string}
 */
export function buildMemoryBudgetMessage(projection, clipLabel = 'new clip') {
  // "In memory": the held total counts the capture buffer and the masks too
  const summary =
    `In memory ~${formatMemory(projection.heldMB)} + ${clipLabel} ~${formatMemory(projection.incomingMB)} ` +
    `exceeds the ${formatMemory(projection.budgetMB)} budget`;
  // With automatic removal on, a refusal means removing every queued clip
  // was not enough either, so deleting one by hand cannot help (#186)
  const action =
    getClipQueue().length > 0 && !loadSettings().capture.autoRemoveOldClips
      ? 'delete a queued clip, or raise Memory Budget in Settings'
      : 'raise Memory Budget in Settings, or shorten the buffer';
  return `${summary} — ${action}`;
}

/** Surface a memory-budget refusal on every channel the UI listens to */
export function announceMemoryBudget(projection) {
  const message = buildMemoryBudgetMessage(projection);
  emit('clip:memory-budget', { ...projection, message });
  announce(message);
}

/**
 * Tell the user what the memory check of opening a queued clip did
 * (app-store prepareQueuedClipForPromote): which oldest clips were removed
 * to make room, or why the open was refused. Same surfaces as a new clip:
 * the editor's Clips banner when it is on screen, else a toast.
 * @param {{ ok: boolean, reason?: string, removed?: import('../../shared/app-store.js').ClipQueueEntry[],
 *   projection?: import('../../shared/app-store.js').MemoryProjection }} result
 */
export function reportOpenMemory(result) {
  // Removed before the decode: gone even when the open then failed
  if (result.removed?.length) announceClipsRemoved(result.removed, 'memory-budget');
  if (result.ok || result.reason !== 'memory-budget' || !result.projection) return;
  const message = buildMemoryBudgetMessage(result.projection, 'opened clip');
  let shownOnScreen = false;
  emit('clip:memory-budget', {
    ...result.projection,
    message,
    markShown: () => {
      shownOnScreen = true;
    },
  });
  announce(message);
  if (!shownOnScreen) showToast(message);
}

/**
 * Whether a live capture session exists anywhere (mounted or backgrounded).
 * Gates the header camera button and the Shift+C hotkey.
 * @returns {boolean}
 */
export function isCaptureLive() {
  return getLiveCaptureContext() !== null;
}

/**
 * Close frames that were refused by the queue. They never entered the
 * app-store, so this caller still owns them — the store's ownership rules
 * only cover frames it holds.
 * @param {import('./types.js').Frame[]} frames
 */
export function closeRefusedFrames(frames) {
  for (const frame of frames) {
    try {
      if (!frame.frame.closed) frame.frame.close();
    } catch {
      // Already closed
    }
  }
}

/** User-facing text for a queue-full refusal */
export const QUEUE_FULL_MESSAGE = 'Clip queue full — delete a clip or raise the limit in Settings';

/** Surface a queue-full refusal on every channel the UI listens to */
export function announceQueueFull() {
  emit('clip:queue-full', { limit: getClipQueueLimit() });
  announce(QUEUE_FULL_MESSAGE);
}

/**
 * @typedef {Object} ClipRoomCheck
 * @property {boolean} ok - false: refuse the clip before draining the buffer
 * @property {'queue-full'|'memory-budget'} [reason] - Present when refused
 */

/**
 * Can a new clip be stored? Decided BEFORE requestFrames(), so a refusal
 * leaves the ring buffer intact.
 *
 * Setting autoRemoveOldClips off: today's refusals (queue full, then memory
 * budget). On (#186): refused only when removing every queued clip that may
 * go would still not make room — the removal itself waits for
 * makeRoomForClip(), once the frames are in hand.
 *
 * @param {Object} need
 * @param {boolean} need.needSlot - The clip takes a queue slot (Clip Now, or
 *   Create Clip demoting the current active clip)
 * @param {ReturnType<typeof projectClipMemory>} need.projection
 * @returns {ClipRoomCheck}
 */
export function checkClipRoom({ needSlot, projection }) {
  if (!loadSettings().capture.autoRemoveOldClips) {
    if (needSlot && isClipQueueFull()) return { ok: false, reason: 'queue-full' };
    if (projection.over) return { ok: false, reason: 'memory-budget' };
    return { ok: true };
  }
  const plan = planQueueEviction({
    needSlot,
    incomingMB: projection.incomingMB,
    budgetMB: projection.budgetMB,
    heldMB: projection.heldMB,
  });
  return plan.ok ? { ok: true } : { ok: false, reason: plan.reason };
}

/**
 * @typedef {Object} ClipRoomResult
 * @property {boolean} ok - false: refuse the clip; nothing was removed
 * @property {'queue-full'|'memory-budget'} [reason] - Present when refused
 * @property {ReturnType<typeof projectClipMemory>} [projection] - The
 *   numbers for a memory-budget refusal, with the REAL frames as incoming
 * @property {import('../../shared/app-store.js').ClipQueueEntry[]} removed
 * @property {string} [message] - What the user was told, when clips were removed
 */

/**
 * Remove the oldest queued clips the new clip needs room from, and tell
 * the user which ones went (#186). Call right before storing the clip,
 * after checkClipRoom() allowed it and the frames are in hand. With the
 * setting off it removes nothing and always allows (the store's own
 * queue-full refusal still applies, as before #186).
 *
 * The plan is made again with the real frames: the queue may have changed
 * while requestFrames() was pending, and the real clip may be bigger than
 * the projection. If removing every queued clip that may go would still not
 * make room, NOTHING is removed and the clip is refused: the caller closes
 * the frames and surfaces the refusal. Removing clips for a new clip that
 * is then stored over the budget anyway would lose them for nothing.
 *
 * @param {Object} need
 * @param {boolean} need.needSlot
 * @param {import('./types.js').Frame[]} need.frames - The new clip's frames
 * @param {number} [need.fps] - Their frame rate
 * @param {boolean} [need.asActive] - Create Clip: the frames become the
 *   active clip (see projectClipMemory)
 * @returns {ClipRoomResult}
 */
export function makeRoomForClip({ needSlot, frames, fps = 0, asActive = false }) {
  const { autoRemoveOldClips, memoryBudgetMB } = loadSettings().capture;
  if (!autoRemoveOldClips) return { ok: true, removed: [] };

  const incomingMB = asActive
    ? estimateFramesMemoryMB(frames)
    : estimateQueuedClipMB({ frames, fps });
  const heldMB = heldAfterSnapshotMB(asActive);
  const plan = planQueueEviction({ needSlot, incomingMB, budgetMB: memoryBudgetMB, heldMB });
  if (!plan.ok) {
    const reason = plan.reason ?? 'queue-full';
    if (reason === 'queue-full') return { ok: false, reason, removed: [] };
    return {
      ok: false,
      reason,
      removed: [],
      projection: {
        over: true,
        projectedMB: heldMB + incomingMB,
        budgetMB: memoryBudgetMB,
        heldMB,
        incomingMB,
      },
    };
  }
  if (plan.ids.length === 0) return { ok: true, removed: [] };

  const removed = evictQueuedClips(plan.ids);
  if (removed.length === 0) return { ok: true, removed };
  const message = announceClipsRemoved(removed, plan.reason ?? 'queue-full');
  return { ok: true, removed, message };
}

/**
 * How a removed clip is named to the user: the imported file name, else
 * its capture time (as the clip list's labels name it)
 * @param {{ capturedAt: number, sourceName?: string|null }} entry
 * @returns {string}
 */
function describeRemovedClip(entry) {
  if (entry.sourceName) return entry.sourceName;
  return new Date(entry.capturedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * User-facing text for an automatic removal (#186)
 * @param {{ capturedAt: number, sourceName?: string|null }[]} removed - Oldest first
 * @param {'queue-full'|'memory-budget'} reason
 * @returns {string}
 */
export function buildClipsRemovedMessage(removed, reason) {
  const why = reason === 'memory-budget' ? 'Memory budget reached' : 'Clip queue full';
  const what =
    removed.length === 1 ? 'removed the oldest clip' : `removed the ${removed.length} oldest clips`;
  return `${why} — ${what} (${removed.map(describeRemovedClip).join(', ')}) to make room`;
}

/**
 * Tell the user which clips were removed, on exactly one visible surface:
 * - the bus first: the editor's Clips banner (the refusal surface) shows
 *   it and calls markShown() when that banner is really on screen;
 * - otherwise a passive toast, visible on every route — Create Clip leaves
 *   the Capture screen right away, so its own error line would never be
 *   seen. A passive toast never replaces a pending Undo toast.
 * The live region announces it either way (a caller that announces again
 * right away must include this message: the newer text replaces it).
 * @param {import('../../shared/app-store.js').ClipQueueEntry[]} removed
 * @param {'queue-full'|'memory-budget'} reason
 * @returns {string} The message
 */
export function announceClipsRemoved(removed, reason) {
  const message = buildClipsRemovedMessage(removed, reason);
  let shownOnScreen = false;
  emit('clip:auto-removed', {
    ids: removed.map((entry) => entry.id),
    reason,
    message,
    markShown: () => {
      shownOnScreen = true;
    },
  });
  announce(message);
  if (!shownOnScreen) showToast(message);
  return message;
}

/**
 * Create a clip from the live buffer and enqueue it.
 *
 * The snapshot is non-stopping: requestFrames() transfers the buffered
 * ImageBitmaps out but the worker loop keeps running, so the buffer refills.
 * The active clip and the mounted screen are never touched — enqueue cannot
 * close or evict anything (see app-store ownership rules). Room is made
 * beforehand by removing the oldest queued clips when the setting allows it
 * (makeRoomForClip, #186).
 *
 * @returns {Promise<ClipNowResult & Partial<import('../../shared/app-store.js').QueueResult>>}
 */
export async function clipNow() {
  const context = getLiveCaptureContext();
  if (!context) {
    return { ok: false, reason: 'no-capture' };
  }

  // Refuse before draining the ring buffer: a snapshot with nowhere to go
  // would waste the buffered frames for nothing
  const projection = projectClipMemory(context);
  const check = checkClipRoom({ needSlot: true, projection });
  if (!check.ok) {
    if (check.reason === 'queue-full') {
      announceQueueFull();
    } else {
      announceMemoryBudget(projection);
    }
    return { ok: false, reason: check.reason };
  }

  const imageBitmapFrames = await context.workerManager.requestFrames();
  if (imageBitmapFrames.length === 0) {
    announce('No frames buffered yet — try again in a moment');
    return { ok: false, reason: 'no-frames' };
  }

  const videoFrames = convertBitmapFramesToVideoFrames(imageBitmapFrames);
  if (videoFrames.length === 0) {
    return { ok: false, reason: 'no-frames' };
  }

  const room = makeRoomForClip({ needSlot: true, frames: videoFrames, fps: context.fps });
  if (!room.ok) {
    // The real snapshot does not fit even after removing every queued clip
    // that may go: nothing was removed, and these frames are still ours
    closeRefusedFrames(videoFrames);
    if (room.reason === 'memory-budget' && room.projection) {
      announceMemoryBudget(room.projection);
    } else {
      announceQueueFull();
    }
    return { ok: false, reason: room.reason ?? 'queue-full' };
  }
  const result = enqueueClip({
    frames: videoFrames,
    fps: context.fps,
    capturedAt: Date.now(),
    sceneDetectionEnabled: context.sceneDetection,
  });

  if (!result.ok) {
    // Queue filled between the early check and here; the refused frames are
    // still ours to release
    closeRefusedFrames(videoFrames);
    announceQueueFull();
    return { ok: false, reason: 'queue-full' };
  }

  emit('clip:queued', {
    entry: result.entry,
    queueLength: result.queueLength,
    limit: result.limit,
  });
  const queued = `Clip added to queue (${result.queueLength}/${result.limit})`;
  // One announcement: a second one in the same tick would replace the
  // removal notice before a screen reader reads it
  announce(room.message ? `${room.message}. ${queued}` : queued);
  return result;
}

/**
 * Register the global Shift+C "Clip Now" hotkey with the app dispatcher
 * (called once from main.js).
 *
 * The dispatcher enforces exactly Shift+C (no Cmd/Ctrl/Alt — Ctrl+Shift+C
 * is DevTools inspect and never reaches the page anyway) and keeps it inert
 * while focus is in a form field or contenteditable element. Global scope:
 * it stays live under the frame-grid modal, as before the dispatcher.
 *
 * @returns {() => void} Unsubscribe
 */
export function registerClipNowHotkey() {
  return registerHotkey({
    key: 'c',
    modifiers: { shift: true },
    scope: 'global',
    handler: handleClipNowHotkey,
  });
}

/**
 * Shift+C handler: inert without a live capture session.
 * @param {KeyboardEvent} e
 */
function handleClipNowHotkey(e) {
  if (!isCaptureLive()) {
    // The editor status bar advertises this shortcut; silence here would
    // read as "broken" whenever the share has already ended (UX review)
    announce('No live capture \u2014 start sharing to use Clip Now');
    return;
  }

  e.preventDefault();
  void clipNow();
}
