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
  getClipMemoryEstimateMB,
  getClipQueue,
  getClipQueueLimit,
  isClipQueueFull,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { announce } from '../../shared/live-region.js';
import { loadSettings } from '../../shared/user-settings.js';
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
  const action =
    getClipQueue().length > 0
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

/** Surface a queue-full refusal on every channel the UI listens to */
function announceQueueFull() {
  emit('clip:queue-full', { limit: getClipQueueLimit() });
  announce('Clip queue full — delete a clip or raise the limit in Settings');
}

/**
 * Create a clip from the live buffer and enqueue it.
 *
 * The snapshot is non-stopping: requestFrames() transfers the buffered
 * ImageBitmaps out but the worker loop keeps running, so the buffer refills.
 * The active clip and the mounted screen are never touched — enqueue cannot
 * close or evict anything (see app-store ownership rules).
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
  if (isClipQueueFull()) {
    announceQueueFull();
    return { ok: false, reason: 'queue-full' };
  }

  const projection = projectClipMemory(context);
  if (projection.over) {
    announceMemoryBudget(projection);
    return { ok: false, reason: 'memory-budget' };
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
 * Global Shift+C hotkey handler, registered once on document in main.js.
 *
 * Guards, in order:
 * - exactly Shift+C (no Cmd/Ctrl/Alt — Ctrl+Shift+C is DevTools inspect and
 *   never reaches the page anyway; Cmd+Shift+G is find-previous)
 * - inert while focus is in a form control (same guard as the editor's own
 *   shortcuts)
 * - inert without a live capture session
 *
 * @param {KeyboardEvent} e
 */
export function handleClipNowHotkey(e) {
  if (e.key !== 'C' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }

  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    active instanceof HTMLTextAreaElement
  ) {
    return;
  }

  if (!isCaptureLive()) {
    // The editor status bar advertises this shortcut; silence here would
    // read as "broken" whenever the share has already ended (UX review)
    announce('No live capture \u2014 start sharing to use Clip Now');
    return;
  }

  e.preventDefault();
  void clipNow();
}
