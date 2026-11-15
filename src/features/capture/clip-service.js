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
  evictQueuedClips,
  getClipMemoryEstimateMB,
  getClipQueue,
  getClipQueueLimit,
  isClipQueueFull,
  planQueueEviction,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { registerHotkey } from '../../shared/hotkeys.js';
import { announce } from '../../shared/live-region.js';
import { showToast } from '../../shared/toast.js';
import { loadSettings } from '../../shared/user-settings.js';
import { estimateFramesMemoryMB } from '../../shared/utils/memory-monitor.js';
import { convertBitmapFramesToVideoFrames, getLiveCaptureContext } from './index.js';

/**
 * @typedef {Object} ClipNowResult
 * @property {boolean} ok
 * @property {'no-capture'|'no-frames'|'queue-full'|'memory-budget'} [reason] - Present when refused
 */

/**
 * Would materializing the current buffer as a clip exceed the memory budget?
 *
 * Projected total = frames already held (active clip + queue) + the buffer
 * snapshot about to become VideoFrames, all at conservative raw RGBA (#96).
 * Checked BEFORE requestFrames(): draining the ring buffer only to refuse
 * and close the result would destroy the user's buffered history for
 * nothing.
 *
 * @param {ReturnType<typeof getLiveCaptureContext>} context
 * @returns {{ over: boolean, projectedMB: number, budgetMB: number }}
 */
export function projectClipMemory(context) {
  const budgetMB = loadSettings().capture.memoryBudgetMB;
  const dims = context?.workerManager?.getEffectiveFrameDimensions?.() ?? null;
  const frameCount = context?.stats?.frameCount ?? 0;
  const incomingMB = dims ? (frameCount * dims.width * dims.height * 4) / (1024 * 1024) : 0;
  const heldMB = getClipMemoryEstimateMB();
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
 * Human-readable refusal for a memory-budget rejection.
 *
 * Names the numbers (what is held vs what the new clip would add vs the
 * budget) and offers ONLY actions that are actually possible right now:
 * "delete a clip" with an empty queue sent a real user hunting for a
 * delete button that does not exist — the active clip is not deletable.
 *
 * @param {ReturnType<typeof projectClipMemory>} projection
 * @returns {string}
 */
export function buildMemoryBudgetMessage(projection) {
  const gb = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  const summary =
    `Clips in memory ~${gb(projection.heldMB)} + new clip ~${gb(projection.incomingMB)} ` +
    `exceeds the ${gb(projection.budgetMB)} budget`;
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
function closeRefusedFrames(frames) {
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
  });
  return plan.ok ? { ok: true } : { ok: false, reason: plan.reason };
}

/**
 * Remove the oldest queued clips the new clip needs room from, and tell
 * the user which ones went (#186). Call right before storing the clip,
 * after checkClipRoom() allowed it and the frames are in hand. No-op with
 * the setting off.
 *
 * The plan is made again with the real frames: the queue may have changed
 * while requestFrames() was pending, and the real clip may differ from the
 * projection. If the real frames no longer fit the memory budget even
 * after removing every queued clip, only the queue slot is made: the memory
 * gate is the early check, exactly as without this setting (a drained
 * buffer is never thrown away for the budget). If not even a slot can be
 * made, nothing is removed and the store's own refusal applies.
 *
 * @param {Object} need
 * @param {boolean} need.needSlot
 * @param {import('./types.js').Frame[]} need.frames - The new clip's frames
 * @returns {import('../../shared/app-store.js').ClipQueueEntry[]} Removed entries
 */
export function makeRoomForClip({ needSlot, frames }) {
  const { autoRemoveOldClips, memoryBudgetMB } = loadSettings().capture;
  if (!autoRemoveOldClips) return [];

  let plan = planQueueEviction({
    needSlot,
    incomingMB: estimateFramesMemoryMB(frames),
    budgetMB: memoryBudgetMB,
  });
  if (!plan.ok && plan.reason === 'memory-budget') {
    plan = planQueueEviction({ needSlot });
  }
  if (!plan.ok || plan.ids.length === 0) return [];

  const removed = evictQueuedClips(plan.ids);
  if (removed.length > 0) {
    announceClipsRemoved(removed, plan.reason ?? 'queue-full');
  }
  return removed;
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
 * Tell the user which clips were removed: the bus (the editor's Clips
 * banner, as for refusals), the live region, and a passive toast — Create
 * Clip leaves the Capture screen right away, so its own error line would
 * never be seen. A passive toast never replaces a pending Undo toast.
 * @param {import('../../shared/app-store.js').ClipQueueEntry[]} removed
 * @param {'queue-full'|'memory-budget'} reason
 */
function announceClipsRemoved(removed, reason) {
  const message = buildClipsRemovedMessage(removed, reason);
  emit('clip:auto-removed', { ids: removed.map((entry) => entry.id), reason, message });
  announce(message);
  showToast(message);
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
  const room = checkClipRoom({ needSlot: true, projection });
  if (!room.ok) {
    if (room.reason === 'queue-full') {
      announceQueueFull();
    } else {
      announceMemoryBudget(projection);
    }
    return { ok: false, reason: room.reason };
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

  makeRoomForClip({ needSlot: true, frames: videoFrames });
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
  announce(`Clip added to queue (${result.queueLength}/${result.limit})`);
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
