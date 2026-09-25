/**
 * Import Feature Entry Point - open a GIF / image file as the active clip
 * @module features/import
 *
 * Imported files share the screen-capture pipeline: the decoded frames
 * become a normal ClipPayload (flagged hasAlpha / sourceName) and the editor
 * opens on it. A previous active clip demotes into the clip queue exactly as
 * with "Create Clip".
 *
 * FRAME OWNERSHIP: decodeImageFile closes everything it created when it
 * throws. Once it returns, the frames belong to importFile until
 * setClipPayload accepts them; every refusal between those two points closes
 * them here (the store's ownership rules only protect frames it holds).
 */

import {
  getClipMemoryEstimateMB,
  getClipPayload,
  isClipQueueFull,
  setClipPayload,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import { announce } from '../../shared/live-region.js';
import { navigate } from '../../shared/router.js';
import { showToast } from '../../shared/toast.js';
import { loadSettings } from '../../shared/user-settings.js';
// Circular through capture/index.js (which imports this module for its
// Open button); safe because only hoisted functions are called, at event time
import {
  announceMemoryBudget,
  announceQueueFull,
  buildMemoryBudgetMessage,
  QUEUE_FULL_MESSAGE,
} from '../capture/clip-service.js';
import { ImportError, projectImportMemoryMB, validateImportFile } from './core.js';
import { decodeImageFile } from './decode.js';

/**
 * @typedef {Object} ImportResult
 * @property {boolean} ok
 * @property {import('./core.js').ImportErrorCode} [reason] - Present when not ok
 * @property {string} [message] - User-facing reason (not ok)
 * @property {number} [frameCount] - Clip frames (ok)
 * @property {number} [fps] - Clip fps (ok)
 * @property {boolean} [hasAlpha] - Clip has transparency (ok)
 */

/**
 * @typedef {Object} ImportOptions
 * @property {AbortSignal} [signal] - Abort the import (no message is shown)
 * @property {(decoded: number, total: number) => void} [onProgress] - Decode progress
 */

/** True while an import is decoding (one at a time) */
let importInFlight = false;

/** Why a file is refused while another one is still decoding */
export const IMPORT_BUSY_MESSAGE = 'Another file is still opening';

/**
 * Whether an import is currently decoding
 * @returns {boolean}
 */
export function isImporting() {
  return importInFlight;
}

/**
 * Close frames this module still owns (never entered the store)
 * @param {import('../capture/types.js').Frame[]|null} frames
 */
function closeOwnedFrames(frames) {
  if (!frames) return;
  for (const wrapper of frames) {
    try {
      if (!wrapper.frame.closed) wrapper.frame.close();
    } catch {
      // Already closed
    }
  }
}

/**
 * Memory-budget projection for an import, shaped like the capture
 * projection so the capture announcements and message builder apply.
 * Held memory includes the active clip, which will demote and stay alive.
 * @param {number} sourceFrameCount
 * @param {number} width
 * @param {number} height
 * @returns {{ over: boolean, projectedMB: number, budgetMB: number, heldMB: number, incomingMB: number }}
 */
export function projectImportBudget(sourceFrameCount, width, height) {
  const budgetMB = loadSettings().capture.memoryBudgetMB;
  const heldMB = getClipMemoryEstimateMB();
  const incomingMB = projectImportMemoryMB(sourceFrameCount, width, height);
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
 * Throw a memory-budget refusal when the import would not fit
 * @param {number} sourceFrameCount
 * @param {number} width
 * @param {number} height
 */
function assertWithinBudget(sourceFrameCount, width, height) {
  const projection = projectImportBudget(sourceFrameCount, width, height);
  if (projection.over) {
    throw new ImportError('memory-budget', buildMemoryBudgetMessage(projection), projection);
  }
}

/**
 * Tell the user why an import did not happen: toast + live region, plus the
 * capture bus events for the refusals capture already announces.
 * @param {ImportError} error
 */
function reportImportError(error) {
  switch (error.code) {
    case 'aborted':
      // The user navigated away; nothing to explain
      return;
    case 'queue-full':
      announceQueueFull();
      break;
    case 'memory-budget':
      announceMemoryBudget(
        /** @type {ReturnType<typeof projectImportBudget>} */ (
          /** @type {unknown} */ (error.detail)
        ),
      );
      break;
    default:
      announce(error.message);
  }
  emit('import:error', { code: error.code, message: error.message });
  showToast(error.message);
}

/**
 * Tell the user a file was refused because another one is still opening
 * (toast + live region). Callers that refuse a file before calling
 * importFile (e.g. while their own busy state is up) use this too, so the
 * refusal is never silent.
 */
export function reportImportBusy() {
  reportImportError(new ImportError('busy', IMPORT_BUSY_MESSAGE));
}

/**
 * Open an image file as the active clip and navigate to the editor.
 *
 * Refuses (with a toast + announcement) when the file type/size is
 * unsupported, the clip queue is full while another clip is active, the
 * decoded clip would exceed the memory budget or the frame limit, or the
 * file cannot be decoded. Never throws.
 *
 * @param {File} file
 * @param {ImportOptions} [options]
 * @returns {Promise<ImportResult>}
 */
export async function importFile(file, options = {}) {
  if (importInFlight) {
    reportImportBusy();
    return { ok: false, reason: 'busy', message: IMPORT_BUSY_MESSAGE };
  }
  importInFlight = true;

  /** @type {import('../capture/types.js').Frame[]|null} */
  let ownedFrames = null;
  try {
    const invalid = validateImportFile(file);
    if (invalid) throw invalid;

    // A new active clip demotes the current one into the queue; refuse
    // before decoding anything when there is no room for it
    if (getClipPayload() && isClipQueueFull()) {
      throw new ImportError('queue-full', QUEUE_FULL_MESSAGE);
    }

    const decoded = await decodeImageFile(file, {
      signal: options.signal,
      onProgress: options.onProgress,
      // Refuse as soon as the size is known, before decoding every frame
      onMetadata: ({ sourceFrameCount, width, height }) =>
        assertWithinBudget(sourceFrameCount, width, height),
    });
    ownedFrames = decoded.frames;

    if (options.signal?.aborted) {
      throw new ImportError('aborted', 'Opening the file was cancelled');
    }
    // Held memory may have grown while decoding (e.g. Clip Now)
    assertWithinBudget(decoded.sourceFrameCount, decoded.width, decoded.height);

    const stored = setClipPayload({
      frames: decoded.frames,
      fps: decoded.fps,
      capturedAt: Date.now(),
      sceneDetectionEnabled: false,
      hasAlpha: decoded.hasAlpha,
      sourceName: file.name,
    });
    if (!stored.ok) {
      // The queue filled while decoding: the store refused, frames are ours
      throw new ImportError('queue-full', QUEUE_FULL_MESSAGE);
    }
    ownedFrames = null; // Ownership moved into the store

    emit('import:clip-created', {
      frameCount: decoded.frames.length,
      fps: decoded.fps,
      hasAlpha: decoded.hasAlpha,
      sourceName: file.name,
    });
    announce(`Opened ${file.name} — ${decoded.frames.length} frames at ${decoded.fps} fps`);
    navigate('/editor');
    return {
      ok: true,
      frameCount: decoded.frames.length,
      fps: decoded.fps,
      hasAlpha: decoded.hasAlpha,
    };
  } catch (err) {
    closeOwnedFrames(ownedFrames);
    const error =
      err instanceof ImportError
        ? err
        : new ImportError('decode-failed', `Couldn't open "${file?.name ?? 'file'}"`);
    if (!(err instanceof ImportError)) {
      console.error('[Import] Unexpected failure:', err);
    }
    reportImportError(error);
    return { ok: false, reason: error.code, message: error.message };
  } finally {
    importInFlight = false;
  }
}
