/**
 * Export Feature Entry Point: the Export GIF dialog.
 *
 * The export is a modal dialog over the editor (the editor stays mounted
 * underneath). Content-defining settings — range, crop, edits and the
 * playback speed, which IS the GIF speed — live in the editor and reach the
 * dialog through the editor payload; output settings (encoder, quality,
 * frame rate, loop, scale, target size) live here.
 *
 * Views: settings → AI preparation (frames without a mask are analyzed
 * first) → encoding → result, or error. While the AI preparation or the
 * encode runs, Cancel is the only way out: Close and Escape are disabled.
 *
 * SIMPLIFIED MODEL (unchanged from the export screen this replaces):
 * - Frames come from the editor payload's clip (the clip on screen), sliced
 *   by its selected range; nothing here closes frames.
 * - The result of an export lives only as long as the dialog shows it
 *   (setExportResult / clearExportResult), so reopening the dialog always
 *   starts from the settings.
 *
 * @module features/export
 */

import {
  clearEditorPayload,
  clearExportResult,
  getClipPayload,
  getEditorPayload,
  getExportResult,
  setExportResult,
} from '../../shared/app-store.js';
import { emit } from '../../shared/bus.js';
import {
  isAiCutoutActive,
  normalizeEdits,
  requiresTransparency,
} from '../../shared/edits/model.js';
import { registerHotkey } from '../../shared/hotkeys.js';
import { announce } from '../../shared/live-region.js';
import { showToast } from '../../shared/toast.js';
import { updateSetting } from '../../shared/user-settings.js';
import { on } from '../../shared/utils/dom.js';
import { throttle } from '../../shared/utils/performance.js';
import { getSharedMaskStore } from '../ai-cutout/mask-store.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import { collectPendingFrames, getSegmentationManager } from '../ai-cutout/segmentation-manager.js';
import {
  buildClipMaskSourceSettled,
  describeAnalysisError,
  estimateRemainingMs,
  isAbortError,
  isWasmAllowed,
  peekClipMaskSource,
  setWasmAllowed,
} from '../editor/ai-cutout.js';
import {
  checkEncoderStatus,
  copyToClipboard,
  downloadBlob,
  encodeGif,
  openInNewTab,
} from './api.js';
import {
  applyFrameSkip,
  calculateMaxColors,
  estimateMergedRuns,
  generateFilename,
  getCroppedDimensions,
  getEffectiveEncoderId,
  getExportedFrameIndices,
  getScaledDimensions,
  getSpeedLimitInfo,
  normalizeTargetSizeMB,
  readGifInfo,
  selectPaletteSampleIndices,
} from './core.js';
import {
  BYTES_PER_MB,
  buildSizeLadder,
  describeRung,
  exportToTargetSize,
  extrapolateGifSize,
  getLadderFrameSkips,
} from './size-planner.js';
import {
  completeEncoding,
  createEncodingJob,
  createExportStore,
  failEncoding,
  resetExport,
  startEncoding,
  updateProgress,
  updateSettings,
} from './state.js';
import {
  createExportDialogShell,
  isDialogBusy,
  renderDialogView,
  updateAiPreparationUI,
  updateExportAiNote,
  updateProgressUI,
  updateSizeStepUI,
} from './ui.js';

/**
 * @typedef {Object} ExportDialogHandle
 * @property {(options?: { restoreFocus?: boolean }) => void} close - Close
 *   the dialog now, aborting a running preparation/encode (the editor's
 *   teardown uses this)
 * @property {() => boolean} isBusy
 */

/**
 * @typedef {Object} OpenExportDialogOptions
 * @property {Element | null} [opener] - Element focus returns to on close
 * @property {() => void} [onClose] - Called once the dialog closed
 */

/**
 * The open dialog's DOM and teardown
 * @typedef {Object} DialogSession
 * @property {HTMLElement} backdrop
 * @property {HTMLElement} dialog
 * @property {HTMLElement} body
 * @property {HTMLElement} title
 * @property {HTMLButtonElement} closeButton
 * @property {Element | null} opener
 * @property {(() => void) | undefined} onClose
 * @property {(() => void)[]} cleanups
 * @property {(() => void) | null} viewCleanup
 * @property {string | null} view
 * @property {ExportDialogHandle} handle
 */

/** @type {DialogSession | null} */
let session = null;

/** @type {ReturnType<typeof createExportStore> | null} */
let store = null;

/** @type {(() => void) | null} */
let storeUnsubscribe = null;

/** @type {import('../capture/types.js').Frame[]} Frames of the selected range */
let frames = [];

/** @type {import('../editor/types.js').CropArea | null} */
let cropArea = null;

/** @type {import('./ui.js').ExportClipInfo} */
let clipInfo = {
  frameCount: 0,
  width: 0,
  height: 0,
  duration: 0,
  fps: 30,
  speed: 1,
  transparent: false,
};

/**
 * Edits to burn in (normalized against the clip), or null for none
 * @type {import('../../shared/edits/model.js').ClipEdits | null}
 */
let edits = null;

/** Absolute clip index of frames[0] (the editor's selected range start) */
let rangeStart = 0;

/** Every frame of the clip (AI cutout masks are built over the whole clip) */
/** @type {import('../capture/types.js').Frame[]} */
let clipFrames = [];

/** Mask store group of the clip */
/** @type {string | undefined} */
let clipId;

/**
 * AI cutout preparation shown instead of the settings, or null
 * @type {import('./ui.js').ExportAiPrep | null}
 */
let aiPrep = null;

/** @type {import('./ui.js').ExportSizeStep | null} Target-size progress */
let sizeStep = null;

/** @type {import('./ui.js').ExportResultInfo | null} Facts of the finished GIF */
let resultInfo = null;

/**
 * Collapse runs of identical frames into one GIF frame. Only imported clips
 * (which expand a source frame's hold into repeated slots) need it; screen
 * captures keep frame-for-frame output.
 */
let mergeIdenticalFrames = false;

/** @type {Map<number, number>} GIF frame count per frame skip (merge estimate) */
const gifFrameCounts = new Map();

/** @type {AbortController | null} */
let encodingController = null;

/**
 * Minimum interval between progress-bar DOM updates during encoding.
 * Encode progress events can arrive faster than the display can usefully
 * redraw (the worker posts a PROGRESS message per frame).
 */
const PROGRESS_UI_THROTTLE_MS = 16;

/**
 * Throttled updateProgressUI, (re)created per dialog so its internal timer
 * doesn't outlive the dialog it renders into. The final 100% update is
 * always applied immediately so the bar never stalls short of completion.
 * @type {import('../../shared/utils/performance.js').ThrottledFunction | null}
 */
let throttledUpdateProgressUI = null;

/** Default FPS */
const DEFAULT_FPS = 30;

/** Frames encoded to estimate one rung of the target-size ladder */
const SIZE_SAMPLE_FRAMES = 6;

/** Focusable controls for the Tab trap */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open the Export GIF dialog for the editor payload in the app store (the
 * editor sets it right before opening). Returns null — and opens nothing —
 * when there is no clip data or the selection is empty.
 * @param {OpenExportDialogOptions} [options]
 * @returns {ExportDialogHandle | null}
 */
export function openExportDialog(options = {}) {
  if (session) return session.handle;

  registerTestHooks();

  const editorPayload = getEditorPayload();
  const clipPayload = getClipPayload();
  const sourceFrames = editorPayload?.clip?.frames ?? clipPayload?.frames;

  if (!editorPayload?.selectedRange || !sourceFrames?.length) {
    emit('export:validation-error', { errors: ['No clip data available'] });
    return null;
  }

  const { start, end } = editorPayload.selectedRange;
  const selected = sourceFrames.slice(start, end + 1);
  if (selected.length === 0) {
    emit('export:validation-error', { errors: ['No frames to export'] });
    return null;
  }

  frames = selected;
  cropArea = editorPayload.cropArea || null;
  const fps = editorPayload.fps || DEFAULT_FPS;
  rangeStart = start;
  clipFrames = sourceFrames;
  clipId = editorPayload.clipId ?? clipPayload?.id;
  aiPrep = null;
  sizeStep = null;
  resultInfo = null;
  gifFrameCounts.clear();

  // Edits and alpha travel on the editor payload (or its clip). Both are
  // optional: clips edited before these existed carry neither.
  const rawEdits = editorPayload.edits ?? editorPayload.clip?.edits;
  edits = rawEdits ? normalizeEdits(rawEdits, sourceFrames.length) : null;
  const hasAlpha = Boolean(
    editorPayload.hasAlpha ?? editorPayload.clip?.hasAlpha ?? clipPayload?.hasAlpha,
  );
  const transparent = requiresTransparency({ edits, hasAlpha });
  mergeIdenticalFrames = Boolean(
    'sourceName' in editorPayload ? editorPayload.sourceName : clipPayload?.sourceName,
  );

  // The editor's speed is the GIF's speed (settings.playbackSpeed from
  // storage is only a new clip's default and is ignored here)
  const speed =
    typeof editorPayload.playbackSpeed === 'number' && editorPayload.playbackSpeed > 0
      ? editorPayload.playbackSpeed
      : 1;

  const dims = getCroppedDimensions(frames[0], cropArea);
  clipInfo = {
    frameCount: frames.length,
    width: dims.width,
    height: dims.height,
    duration: frames.length / fps,
    fps,
    speed,
    transparent,
    aiCutout: isAiCutoutActive(edits?.background),
  };

  // Every opening starts from the settings, never from an earlier GIF
  clearExportResult();
  const dialogStore = createExportStore();
  store = dialogStore;
  dialogStore.setState((s) =>
    updateSettings({ ...s, isDialogOpen: true }, { playbackSpeed: speed }, getEstimateDims()),
  );

  checkEncoderStatus().then((status) => {
    if (store === dialogStore) {
      dialogStore.setState((s) => ({ ...s, encoderStatus: status }));
    }
  });

  mountDialog(options);

  throttledUpdateProgressUI = throttle(updateProgressUI, PROGRESS_UI_THROTTLE_MS);
  storeUnsubscribe = dialogStore.subscribe((state, prevState) => {
    if (store !== dialogStore || !session) return;
    // Throttled to avoid redundant DOM writes on every worker PROGRESS
    // message; the final 100% frame always bypasses the throttle
    if (state.job?.status === 'encoding') {
      if (state.job.progress >= 100) {
        throttledUpdateProgressUI?.cancel();
        updateProgressUI(session.body, state.job);
      } else {
        throttledUpdateProgressUI?.(session.body, state.job);
      }
    } else if (prevState.job?.status === 'encoding') {
      // Left the encoding state (e.g. cancel): drop an armed trailing timer
      // so it can't paint the previous job's progress over the next view
      throttledUpdateProgressUI?.cancel();
    }
  });

  render({ focus: 'title' });
  emit('export:opened', { frameCount: frames.length });
  return /** @type {DialogSession} */ (session).handle;
}

/**
 * Whether the Export dialog is open
 * @returns {boolean}
 */
export function isExportDialogOpen() {
  return session !== null;
}

/**
 * Build the dialog, put it on the page and take over focus and keys
 * @param {OpenExportDialogOptions} options
 */
function mountDialog(options) {
  const shell = createExportDialogShell({ onClose: requestClose });
  /** @type {(() => void)[]} */
  const cleanups = [shell.cleanup];

  document.body.appendChild(shell.backdrop);

  // Everything behind the dialog leaves the tab order and the a11y tree
  const app = document.getElementById('app');
  if (app && !app.hasAttribute('inert')) {
    app.setAttribute('inert', '');
    cleanups.push(() => app.removeAttribute('inert'));
  }

  // Modal scope: while registered, the editor's route hotkeys (and overlay
  // Escapes) are skipped entirely. Escape closes unless an export runs; it
  // is claimed either way so nothing underneath reacts to it.
  cleanups.push(
    registerHotkey({
      key: 'Escape',
      modifiers: { shift: 'any' },
      scope: 'modal',
      allowInEditable: true,
      element: shell.dialog,
      handler: (e) => {
        e.preventDefault();
        requestClose();
      },
    }),
  );

  // Tab trap (inert covers real browsers; this also keeps focus cycling in
  // environments without inert and when focus was dropped to <body>)
  cleanups.push(on(document, 'keydown', trapTab));

  const handle = {
    close: (/** @type {{ restoreFocus?: boolean }} */ closeOptions = {}) =>
      closeDialog({ restoreFocus: closeOptions.restoreFocus !== false }),
    isBusy: () => Boolean(store) && isDialogBusy(/** @type {any} */ (store).getState(), aiPrep),
  };

  session = {
    backdrop: shell.backdrop,
    dialog: shell.dialog,
    body: shell.body,
    title: shell.title,
    closeButton: shell.closeButton,
    opener: options.opener ?? null,
    onClose: options.onClose,
    cleanups,
    viewCleanup: null,
    view: null,
    handle,
  };
}

/**
 * Keep Tab / Shift+Tab inside the dialog
 * @param {KeyboardEvent} e
 */
function trapTab(e) {
  if (e.key !== 'Tab' || !session) return;
  const items = [...session.dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => el instanceof HTMLElement && el.closest('[hidden]') === null,
  );
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = /** @type {HTMLElement} */ (items[0]);
  const last = /** @type {HTMLElement} */ (items[items.length - 1]);
  const active = document.activeElement;
  const inside = active instanceof Node && session.dialog.contains(active);
  if (e.shiftKey) {
    if (!inside || active === first || active === session.title) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Render the view for the current state
 * @param {{ focus?: 'title' | 'keep' }} [options] - focus: 'title' moves
 *   focus to the dialog title (opening); 'keep' puts it back on the control
 *   with the same id (a settings re-render). Otherwise a new view focuses its
 *   primary control.
 */
function render(options = {}) {
  if (!session || !store) return;
  const current = session;
  const state = store.getState();
  const activeId =
    document.activeElement instanceof HTMLElement && current.dialog.contains(document.activeElement)
      ? document.activeElement.id
      : '';

  current.viewCleanup?.();
  const result = renderDialogView(current.body, {
    state,
    handlers,
    clipInfo,
    facts: computeFacts(state),
    aiPrep,
    sizeStep,
    resultInfo,
  });
  current.viewCleanup = result.cleanup;

  const busy = isDialogBusy(state, aiPrep);
  current.closeButton.disabled = busy;
  current.dialog.setAttribute('aria-busy', String(busy));
  updateMissingMasksNote();

  const viewChanged = result.view !== current.view;
  current.view = result.view;

  if (options.focus === 'title') {
    current.title.focus();
    return;
  }
  const kept = options.focus === 'keep' && activeId ? document.getElementById(activeId) : null;
  if (kept && current.dialog.contains(kept)) {
    kept.focus();
    return;
  }
  const focusLost =
    !(document.activeElement instanceof Node) || !current.dialog.contains(document.activeElement);
  if (viewChanged || focusLost) {
    (result.focusTarget ?? current.title).focus();
  }
}

/**
 * Facts the settings view shows for the current settings
 * @param {import('./types.js').ExportState} state
 * @returns {import('./ui.js').ExportSettingsFacts}
 */
function computeFacts(state) {
  const settings = state.settings;
  const speedLimit = getSpeedLimitInfo(clipInfo.fps, clipInfo.speed, settings.frameSkip);
  return {
    output: getScaledDimensions(clipInfo.width, clipInfo.height, settings.scale ?? 1),
    gifFrames: countGifFrames(settings.frameSkip),
    durationSeconds: clipInfo.duration / speedLimit.effectiveSpeed,
    speedLimit,
    sizeLimited: normalizeTargetSizeMB(settings.targetSizeMB) !== null,
  };
}

/**
 * GIF frames an export with this frame skip writes: one per exported frame,
 * or the estimated runs when identical frames merge
 * @param {number} frameSkip
 * @returns {number}
 */
function countGifFrames(frameSkip) {
  const skip = Math.max(1, frameSkip);
  if (!mergeIdenticalFrames) return Math.ceil(frames.length / skip);
  const cached = gifFrameCounts.get(skip);
  if (cached !== undefined) return cached;
  const indices = getExportedFrameIndices(frames.length, skip, rangeStart);
  const count = estimateMergedRuns(indices, clipFrames, edits).count;
  gifFrameCounts.set(skip, count);
  return count;
}

/**
 * Inputs of the heuristic size estimate
 * @returns {{ frameCount: number, width: number, height: number, countFrames?: (skip: number) => number }}
 */
function getEstimateDims() {
  return {
    frameCount: clipInfo.frameCount,
    width: clipInfo.width,
    height: clipInfo.height,
    ...(mergeIdenticalFrames ? { countFrames: countGifFrames } : {}),
  };
}

// ============================================================
// Closing
// ============================================================

/**
 * Close from the UI (Close button, Escape, Back to editing): refused while
 * an AI preparation or an encode runs — Cancel is the way out then
 */
function requestClose() {
  if (!store || !session) return;
  if (isDialogBusy(store.getState(), aiPrep)) return;
  closeDialog({ restoreFocus: true });
}

/**
 * Tear the dialog down: abort a running preparation/encode, drop the result
 * and the editor payload the dialog was opened for, give the page back its
 * focus and keys
 * @param {{ restoreFocus: boolean }} options
 */
function closeDialog({ restoreFocus }) {
  if (!session) return;
  const closing = session;
  session = null;

  if (encodingController) {
    encodingController.abort();
    encodingController = null;
  }
  // The result is scoped to this dialog: a later opening starts fresh
  clearExportResult();
  // The payload described this opening; left behind, the next editor mount
  // would restore it instead of the clip's own saved state
  clearEditorPayload();

  storeUnsubscribe?.();
  storeUnsubscribe = null;
  throttledUpdateProgressUI?.cancel();
  throttledUpdateProgressUI = null;
  closing.viewCleanup?.();
  for (const fn of closing.cleanups) fn();
  closing.backdrop.remove();

  store = null;
  frames = [];
  cropArea = null;
  edits = null;
  clipFrames = [];
  clipId = undefined;
  aiPrep = null;
  sizeStep = null;
  resultInfo = null;
  rangeStart = 0;
  mergeIdenticalFrames = false;
  gifFrameCounts.clear();

  if (restoreFocus) restoreOpenerFocus(closing.opener);
  emit('export:closed', {});
  closing.onClose?.();
}

/**
 * Return focus to whatever opened the dialog; the editor's Export button
 * when that was <body> (Ctrl/Cmd+E) or is gone
 * @param {Element | null} opener
 */
function restoreOpenerFocus(opener) {
  if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
    opener.focus();
    if (document.activeElement === opener) return;
  }
  /** @type {HTMLElement | null} */ (
    document.querySelector('button[aria-label="Export as GIF"]')
  )?.focus();
}

// ============================================================
// AI cutout
// ============================================================

/**
 * Absolute clip indices an export encodes for any of these frame skips
 * (a target size may use several)
 * @param {number[]} frameSkips
 * @returns {number[]} Ascending, unique
 */
function getExportedIndices(frameSkips) {
  const set = new Set();
  for (const skip of frameSkips) {
    for (const index of getExportedFrameIndices(frames.length, skip, rangeStart)) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Frame skips the next export may use: the setting, or every rung's with a
 * target size
 * @param {import('./types.js').ExportSettings} settings
 * @returns {number[]}
 */
function getPlannedFrameSkips(settings) {
  const rungs = getSizeLadder(settings);
  return rungs ? getLadderFrameSkips(rungs) : [settings.frameSkip];
}

/**
 * The target-size ladder for these settings, or null without a target
 * @param {import('./types.js').ExportSettings} settings
 */
function getSizeLadder(settings) {
  if (normalizeTargetSizeMB(settings.targetSizeMB) === null) return null;
  return buildSizeLadder({
    maxColors: calculateMaxColors(settings.quality, settings.encoderPreset),
    frameSkip: settings.frameSkip,
    scale: settings.scale ?? 1,
  });
}

/** Tell the user how many exported frames still need the analysis */
function updateMissingMasksNote() {
  if (!store || !session || !clipInfo.aiCutout) return;
  const exported = getExportedIndices(getPlannedFrameSkips(store.getState().settings))
    .map((index) => clipFrames[index])
    .filter(Boolean);
  const missing = collectPendingFrames(exported, getSharedMaskStore()).length;
  updateExportAiNote(session.body, missing, exported.length);
}

/**
 * Show a new preparation step: a new phase group re-renders, progress
 * within one patches in place
 * @param {import('./ui.js').ExportAiPrep} next
 */
function showAiPrep(next) {
  const rerender =
    !aiPrep ||
    !session?.body.querySelector('#export-ai-progress-text') ||
    (aiPrep.phase === 'building') !== (next.phase === 'building');
  aiPrep = next;
  if (!session || !store) return;
  if (rerender) {
    render();
  } else {
    updateAiPreparationUI(session.body, next);
  }
}

/**
 * Final masks for every frame the export may encode: analyze those that
 * have no mask yet (with progress; the manager reuses the loaded model),
 * then build the masks over the whole clip (picks may lie outside the
 * export range).
 * @param {number[]} frameSkips
 * @param {AbortSignal} signal
 * @returns {Promise<import('../../shared/masks/final-masks.js').MaskSource>}
 */
async function prepareAiMasks(frameSkips, signal) {
  const maskStore = getSharedMaskStore();
  const exported = getExportedIndices(frameSkips)
    .map((index) => clipFrames[index])
    .filter(Boolean);
  const pending = collectPendingFrames(exported, maskStore);
  if (pending.length > 0) {
    showAiPrep({ phase: 'starting', framesDone: 0, framesTotal: pending.length });
    if (clipId !== undefined) maskStore.touchClip(clipId);
    /** @type {number | null} */
    let analyzingSince = null;
    await getSegmentationManager().analyzeFrames(exported, {
      signal,
      clipId,
      allowWasm: isWasmAllowed(),
      onProgress(progress) {
        if (signal.aborted) return;
        if (progress.phase === 'analyzing' && analyzingSince === null) {
          analyzingSince = performance.now();
        }
        showAiPrep({
          phase: progress.phase,
          loadedBytes: progress.loadedBytes,
          totalBytes: progress.totalBytes,
          fromCache: progress.fromCache,
          framesDone: progress.framesDone,
          framesTotal: progress.framesTotal,
          remainingMs:
            analyzingSince === null
              ? null
              : estimateRemainingMs({
                  framesDone: progress.framesDone,
                  framesTotal: progress.framesTotal,
                  elapsedMs: performance.now() - analyzingSince,
                  backend: progress.backend,
                }),
        });
      },
    });
  }
  const ai = /** @type {import('../../shared/edits/model.js').ClipEdits} */ (edits).background.ai;
  const memo = peekClipMaskSource({ frames: clipFrames, ai, clipId });
  if (memo) return memo;
  showAiPrep({ phase: 'building', buildDone: 0, buildTotal: 0 });
  // Settled: a supersession by the editor's own rebuild is not the user's
  // Cancel and must not end the export as "cancelled"
  return buildClipMaskSourceSettled({
    frames: clipFrames,
    ai,
    clipId,
    signal,
    onProgress: ({ done, total }) => {
      if (aiPrep?.phase === 'building')
        showAiPrep({ ...aiPrep, buildDone: done, buildTotal: total });
    },
  });
}

// ============================================================
// Handlers
// ============================================================

/** @type {import('./ui.js').ExportUIHandlers} */
const handlers = {
  onSettingsChange: handleSettingsChange,
  onExport: () => void handleExport(),
  onCancel: handleCancel,
  onDownload: handleDownload,
  onOpenInTab: handleOpenInTab,
  onCopy: handleCopy,
  onBackToEditing: requestClose,
  onExportAgain: handleExportAgain,
  onBackToSettings: handleBackToSettings,
  onAiAllowWasm: handleAiAllowWasm,
  onAiBack: handleAiBack,
};

/**
 * Handle a settings change. Changes that alter which controls exist (the
 * encoder, a target size on/off, which forces the JavaScript encoder)
 * re-render the settings with focus kept; the rest update the derived text
 * (summary, estimate, notes) in place.
 * @param {Partial<import('./types.js').ExportSettings>} patch
 */
function handleSettingsChange(patch) {
  if (!store) return;
  const previous = store.getState().settings;
  store.setState((state) => updateSettings(state, patch, getEstimateDims()));
  emit('export:settings', { settings: store.getState().settings });

  // Persist the output settings (the speed is the editor's, never sent here)
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'playbackSpeed') updateSetting('export', key, value);
  }

  const encoderChanged = patch.encoderId !== undefined && patch.encoderId !== previous.encoderId;
  const targetToggled =
    'targetSizeMB' in patch &&
    (normalizeTargetSizeMB(patch.targetSizeMB) === null) !==
      (normalizeTargetSizeMB(previous.targetSizeMB) === null);
  if (encoderChanged || targetToggled) {
    render({ focus: 'keep' });
  } else {
    patchSettingsText();
  }
}

/** Update the settings view's derived text without rebuilding its controls */
function patchSettingsText() {
  if (!session || !store) return;
  const body = session.body;
  const scrollTop = body.scrollTop;
  const activeId =
    document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
      ? document.activeElement.id
      : '';
  // Re-render into a detached body and copy the derived nodes over: one
  // source of truth for the copy, and the live controls keep their focus
  const scratch = document.createElement('div');
  const state = store.getState();
  const result = renderDialogView(scratch, {
    state,
    handlers,
    clipInfo,
    facts: computeFacts(state),
    aiPrep,
    sizeStep,
    resultInfo,
  });
  result.cleanup();
  for (const id of [
    'export-summary',
    'export-estimate',
    'export-speed-note',
    'export-target-note',
  ]) {
    const live = body.querySelector(`#${id}`);
    const fresh = scratch.querySelector(`#${id}`);
    if (live && fresh) live.replaceWith(fresh);
  }
  updateMissingMasksNote();
  body.scrollTop = scrollTop;
  if (activeId && document.activeElement?.id !== activeId) {
    document.getElementById(activeId)?.focus();
  }
}

/**
 * Estimated bytes of one ladder rung: encode an evenly spaced sample of the
 * frames it would export (one per run when identical frames merge) and
 * extrapolate per-frame bytes to the whole GIF
 * @param {import('./size-planner.js').SizeRung} rung
 * @param {Omit<import('./api.js').EncodeParams, 'settings' | 'onProgress'>} base
 * @param {import('./types.js').ExportSettings} encodeSettings
 * @param {AbortSignal} signal
 * @returns {Promise<number>}
 */
async function estimateRungBytes(rung, base, encodeSettings, signal) {
  const indices = getExportedFrameIndices(frames.length, rung.frameSkip, rangeStart);
  let representatives = indices;
  let gifFrames = indices.length;
  if (mergeIdenticalFrames) {
    const runs = estimateMergedRuns(indices, clipFrames, edits);
    representatives = runs.representatives;
    gifFrames = runs.count;
  }
  const picks = selectPaletteSampleIndices(representatives.length, SIZE_SAMPLE_FRAMES).map(
    (k) => representatives[k],
  );
  const sample = await encodeGif(
    {
      ...base,
      frames: picks.map((index) => clipFrames[index]),
      frameIndices: picks,
      mergeIdenticalFrames: false,
      settings: { ...encodeSettings, frameSkip: /** @type {1|2|3|4|5} */ (rung.frameSkip) },
      maxColors: rung.maxColors,
      scale: rung.scale,
      onProgress: () => {},
    },
    signal,
  );
  return extrapolateGifSize(sample.size, picks.length, gifFrames);
}

/**
 * Handle the Export button (and Retry of a failed AI preparation)
 */
async function handleExport() {
  // A running preparation/encode owns the controller: ignore double clicks
  if (!store || frames.length === 0 || encodingController) return;
  const dialogStore = store;
  const isCurrent = () => store === dialogStore;

  const settings = dialogStore.getState().settings;
  const targetMB = normalizeTargetSizeMB(settings.targetSizeMB);
  const rungs = getSizeLadder(settings);
  const encodeSettings = {
    ...settings,
    playbackSpeed: clipInfo.speed,
    encoderId: getEffectiveEncoderId(settings, clipInfo.transparent, rungs !== null),
  };

  // AI preparation and encoding share the controller, so Cancel stops
  // whichever runs
  const controller = new AbortController();
  encodingController = controller;
  const signal = controller.signal;
  resultInfo = null;
  sizeStep = null;

  // AI cutout: every frame the export may encode needs its final mask
  /** @type {import('../../shared/masks/final-masks.js').MaskSource | null} */
  let exportMasks = null;
  if (isAiCutoutActive(edits?.background)) {
    try {
      exportMasks = await prepareAiMasks(getPlannedFrameSkips(settings), signal);
    } catch (error) {
      if (encodingController === controller) encodingController = null;
      if (!isCurrent()) return;
      if (isAbortError(error)) {
        aiPrep = null;
        emit('export:cancelled', {});
        announce('Export cancelled');
      } else if (
        /** @type {any} */ (error)?.code === SegmentationErrorCode.WEBGPU_UNAVAILABLE &&
        !isWasmAllowed()
      ) {
        aiPrep = { phase: 'needs-wasm' };
      } else {
        aiPrep = { phase: 'error', message: describeAnalysisError(error).message };
        emit('export:error', { error: aiPrep.message });
      }
      render();
      return;
    }
    if (!isCurrent()) return;
    // A frame the analysis could not cover makes encodeGif refuse with a
    // clear MissingCutoutMasksError, shown on the error view
    aiPrep = null;
  }

  const firstSkip = rungs ? rungs[0].frameSkip : settings.frameSkip;
  const job = createEncodingJob(applyFrameSkip(frames, firstSkip).length, encodeSettings.encoderId);
  dialogStore.setState((s) => startEncoding(s, job));
  emit('export:started', { job });
  if (rungs && targetMB !== null) {
    sizeStep = { phase: 'estimate', index: 0, total: rungs.length, targetMB };
  }
  render();

  const base = {
    frames,
    crop: cropArea,
    fps: clipInfo.fps,
    edits,
    rangeStart,
    transparent: clipInfo.transparent === true,
    mergeIdenticalFrames,
    maskSource: exportMasks,
  };
  /** @param {{ percent: number, current: number, total: number }} progress */
  const onProgress = (progress) => {
    if (!isCurrent()) return;
    dialogStore.setState((s) => updateProgress(s, progress));
    emit('export:progress', { percent: progress.percent, frame: progress.current });
  };

  try {
    /** @type {Blob} */
    let blob;
    /** @type {import('./ui.js').ExportTargetReport | null} */
    let target = null;
    let usedScale = settings.scale ?? 1;
    let usedSkip = settings.frameSkip;

    if (!rungs || targetMB === null) {
      blob = await encodeGif(
        { ...base, settings: encodeSettings, scale: usedScale, onProgress },
        signal,
      );
    } else {
      const outcome = await exportToTargetSize({
        rungs,
        targetBytes: targetMB * BYTES_PER_MB,
        signal,
        estimate: (rung) => estimateRungBytes(rung, base, encodeSettings, signal),
        encode: (rung) => {
          const totalFrames = applyFrameSkip(frames, rung.frameSkip).length;
          dialogStore.setState((s) =>
            s.job
              ? {
                  ...s,
                  job: {
                    ...s.job,
                    progress: 0,
                    currentFrame: 0,
                    totalFrames,
                    estimatedRemaining: null,
                  },
                }
              : s,
          );
          const current = dialogStore.getState().job;
          if (session && current) updateProgressUI(session.body, current);
          return encodeGif(
            {
              ...base,
              settings: { ...encodeSettings, frameSkip: /** @type {1|2|3|4|5} */ (rung.frameSkip) },
              maxColors: rung.maxColors,
              scale: rung.scale,
              onProgress,
            },
            signal,
          );
        },
        onStep: (step) => {
          if (!isCurrent()) return;
          sizeStep = { ...step, targetMB };
          if (session) updateSizeStepUI(session.body, sizeStep);
        },
      });
      blob = outcome.blob;
      usedScale = outcome.rung.scale;
      usedSkip = outcome.rung.frameSkip;
      target = { targetMB, fits: outcome.fits, settingsText: describeRung(outcome.rung) };
    }

    if (!isCurrent()) return;
    const facts = await readGifFacts(blob);
    if (!isCurrent()) return;
    const fallbackDims = getScaledDimensions(clipInfo.width, clipInfo.height, usedScale);
    resultInfo = {
      size: blob.size,
      width: facts?.width ?? fallbackDims.width,
      height: facts?.height ?? fallbackDims.height,
      frameCount: facts?.frameCount ?? (mergeIdenticalFrames ? null : countGifFrames(usedSkip)),
      target,
      canCopy: canCopyGif(),
    };
    sizeStep = null;
    dialogStore.setState((s) => completeEncoding(s, blob));

    // The filename is generated once here so repeated downloads of the same
    // GIF keep the same name; the record lives as long as the dialog shows it
    setExportResult({ blob, filename: generateFilename(), completedAt: Date.now() });
    emit('export:complete', { blob, size: blob.size });
    announce('Your GIF is ready');
    render();
  } catch (error) {
    if (!isCurrent()) return;
    sizeStep = null;
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Cancel returns to the settings
      dialogStore.setState(resetExport);
      emit('export:cancelled', {});
      announce('Export cancelled');
    } else {
      const message = error instanceof Error ? error.message : 'Encoding failed';
      dialogStore.setState((s) => failEncoding(s, message));
      emit('export:error', { error: message });
    }
    render();
  } finally {
    if (encodingController === controller) encodingController = null;
  }
}

/**
 * Size facts of an encoded GIF, or null when it cannot be read
 * @param {Blob} blob
 * @returns {Promise<{ width: number, height: number, frameCount: number } | null>}
 */
async function readGifFacts(blob) {
  try {
    const buffer =
      typeof blob.arrayBuffer === 'function'
        ? await blob.arrayBuffer()
        : await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(/** @type {ArrayBuffer} */ (reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
          });
    return readGifInfo(new Uint8Array(buffer));
  } catch {
    return null;
  }
}

/**
 * Whether this browser can put a GIF on the clipboard (Chromium only takes
 * PNG images, so Copy is not offered there)
 * @returns {boolean}
 */
function canCopyGif() {
  try {
    return (
      typeof ClipboardItem !== 'undefined' &&
      typeof ClipboardItem.supports === 'function' &&
      ClipboardItem.supports('image/gif') &&
      typeof navigator.clipboard?.write === 'function'
    );
  } catch {
    return false;
  }
}

/** Cancel the running preparation or encode (returns to the settings) */
function handleCancel() {
  encodingController?.abort();
}

/** The finished GIF on screen, if any */
function getResultBlob() {
  return store?.getState().job?.result ?? null;
}

function handleDownload() {
  const blob = getResultBlob();
  if (!blob) return;
  // Prefer the filename recorded when the export completed so repeated
  // downloads keep it
  downloadBlob(blob, getExportResult()?.filename ?? generateFilename());
}

function handleOpenInTab() {
  const blob = getResultBlob();
  if (blob) openInNewTab(blob);
}

function handleCopy() {
  const blob = getResultBlob();
  if (!blob) return;
  void copyToClipboard(blob).then((copied) => {
    const message = copied ? 'GIF copied' : 'Could not copy the GIF';
    announce(message);
    showToast(message);
  });
}

/** Result → settings, for another export */
function handleExportAgain() {
  if (!store) return;
  store.setState(resetExport);
  clearExportResult();
  resultInfo = null;
  render();
}

/** Error → settings */
function handleBackToSettings() {
  if (!store) return;
  store.setState(resetExport);
  render();
}

/** The explicit "Run without WebGPU (very slow)" choice: export again */
function handleAiAllowWasm() {
  setWasmAllowed(true);
  aiPrep = null;
  void handleExport();
}

/** Leave the AI preparation (choice or error) for the settings */
function handleAiBack() {
  if (!store) return;
  aiPrep = null;
  render();
}

/**
 * Get current export state
 * @returns {import('./types.js').ExportState | null}
 */
export function getExportState() {
  return store?.getState() ?? null;
}

// ============================================================
// Test Hooks (only available in Playwright test environment)
// ============================================================

/**
 * Register test hooks for the export dialog
 */
function registerTestHooks() {
  if (typeof window !== 'undefined' && window.__TEST_HOOKS__) {
    window.__TEST_HOOKS__.setExportState = (stateOverrides) => {
      if (!store) return;
      store.setState((currentState) => ({
        ...currentState,
        ...stateOverrides,
      }));
    };

    // Lets E2E decode the real exported GIF (e.g. with ImageDecoder)
    window.__TEST_HOOKS__.getExportResultBase64 = async () => {
      const blob = getExportResult()?.blob ?? store?.getState().job?.result ?? null;
      return blob ? blobToBase64(blob) : null;
    };
  }
}

/**
 * Base64 of a blob's bytes (no data: prefix). Uses FileReader, which
 * handles multi-MB GIFs without the argument-count limit of
 * String.fromCharCode(...bytes).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read export result'));
    reader.readAsDataURL(blob);
  });
}
