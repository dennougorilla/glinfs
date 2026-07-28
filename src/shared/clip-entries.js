/**
 * Clip Queue Entry List Renderer
 * @module shared/clip-entries
 *
 * Single renderer for clip-queue entries, shared by the editor's left-sidebar
 * "Clips" section and the header badge popover so the two views can never
 * drift apart. Pure DOM construction — all queue mutations happen through the
 * handlers the caller supplies.
 */

import { createElement, on } from './utils/dom.js';

/**
 * @typedef {Object} ClipEntriesOptions
 * @property {import('./app-store.js').ClipPayload|null} [activeClip] - Active clip, shown first and highlighted
 * @property {import('./app-store.js').ClipQueueEntry[]} [queue] - Queue entries, newest first
 * @property {(id: string) => void} [onPromote] - Queue entry clicked (promote to editor)
 * @property {(id: string) => void} [onDelete] - Delete button clicked (caller confirms)
 * @property {() => void} [onDeleteActive] - Delete confirmed on the ACTIVE
 *   entry (#100 round 4); the caller owns the succession (promote/redirect)
 */

/**
 * Format a clip's capture time as a short local time string
 * @param {number} capturedAt
 * @returns {string}
 */
function formatCapturedTime(capturedAt) {
  return new Date(capturedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Milliseconds the inline "Delete?" confirm state stays armed (#98) */
const DELETE_CONFIRM_MS = 3000;

/** Skim playback rate for hover previews (#100 v3) */
const SKIM_INTERVAL_MS = 120;

/**
 * Wire hover-skim on an entry's thumbnail (#100 v3): while hovered, cycle
 * the img through the entry's pre-baked preview frames (~10 stills sampled
 * at enqueue) — YouTube-style hover playback at effectively zero cost. No
 * decode happens: compressed entries keep skimming because the stills are
 * plain dataURLs baked before compression.
 *
 * @param {HTMLElement} hoverSurface
 * @param {HTMLImageElement} img
 * @param {string[]} previewFrames
 * @param {string} restingSrc
 * @param {(() => void)[]} cleanups
 */
function wireHoverSkim(hoverSurface, img, previewFrames, restingSrc, cleanups) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let index = 0;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    img.src = restingSrc;
  };

  cleanups.push(
    on(hoverSurface, 'mouseenter', () => {
      if (timer !== null) return;
      index = 0;
      timer = setInterval(() => {
        index = (index + 1) % previewFrames.length;
        img.src = previewFrames[index];
      }, SKIM_INTERVAL_MS);
    }),
  );
  cleanups.push(on(hoverSurface, 'mouseleave', stop));
  cleanups.push(stop);
}

/**
 * Wire a delete button as an inline two-step control (#98): first click
 * arms it ("Delete?", danger styling); a second click within
 * DELETE_CONFIRM_MS actually deletes; timeout or losing focus reverts.
 * Replaces window.confirm(), which blocked the main thread and looked
 * foreign next to the app's own UI.
 *
 * @param {HTMLButtonElement} btn
 * @param {string} armedLabel - aria-label while armed
 * @param {string} idleLabel - aria-label while idle
 * @param {() => void} onConfirmed
 * @param {(() => void)[]} cleanups
 */
function wireTwoStepDelete(btn, armedLabel, idleLabel, onConfirmed, cleanups) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let revertTimer = null;
  let armed = false;

  const disarm = () => {
    if (revertTimer !== null) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
    armed = false;
    btn.classList.remove('clip-entry-delete--armed');
    btn.textContent = '×';
    btn.setAttribute('aria-label', idleLabel);
    btn.title = 'Delete clip';
  };

  cleanups.push(
    on(btn, 'click', () => {
      if (armed) {
        disarm();
        onConfirmed();
        return;
      }
      armed = true;
      btn.classList.add('clip-entry-delete--armed');
      btn.textContent = 'Delete?';
      btn.setAttribute('aria-label', armedLabel);
      btn.title = '';
      revertTimer = setTimeout(disarm, DELETE_CONFIRM_MS);
    }),
  );
  cleanups.push(on(btn, 'blur', disarm));
  cleanups.push(disarm);
}

/**
 * Build the thumbnail element for an entry (dataURL image or placeholder)
 * @param {string|null|undefined} thumbnailDataUrl
 * @returns {HTMLElement}
 */
function buildThumbnail(thumbnailDataUrl) {
  if (thumbnailDataUrl) {
    return createElement('img', {
      className: 'clip-entry-thumb',
      src: thumbnailDataUrl,
      alt: '',
      'aria-hidden': 'true',
    });
  }
  return createElement(
    'div',
    { className: 'clip-entry-thumb clip-entry-thumb--placeholder', 'aria-hidden': 'true' },
    ['🎬'],
  );
}

/**
 * Codec lifecycle states that get a spinner + label on the entry (#92).
 * 'raw' and 'compressed' are terminal/idle and render no busy indicator.
 * @type {Record<string, string>}
 */
const BUSY_STATUS_LABELS = {
  compressing: 'Compressing…',
  decoding: 'Opening…',
};

/**
 * Build one clip entry row.
 * The row is a div (not a button) because it contains two interactive
 * controls — the promote surface and the delete button — and buttons must
 * not nest.
 *
 * @param {{ id?: string, frames?: {length: number}[]|null, frameCount?: number, status?: import('./app-store.js').ClipQueueEntryStatus, byteLengthMB?: number, fps: number, capturedAt: number, thumbnailDataUrl?: string|null }} clip
 * @param {{ active: boolean, onPromote?: (id: string) => void, onDelete?: (id: string) => void }} options
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function buildEntry(clip, options, cleanups) {
  // Compressed entries carry no frames array — frameCount is the stable
  // source (#92); the active clip has frames and no frameCount
  const frameCount = clip.frameCount ?? clip.frames?.length ?? 0;
  const durationSec = clip.fps > 0 ? frameCount / clip.fps : 0;
  const timeLabel = formatCapturedTime(clip.capturedAt);
  const shortTime = new Date(clip.capturedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const status = options.active ? undefined : (clip.status ?? 'raw');
  const sizeLabel =
    status === 'compressed' && typeof clip.byteLengthMB === 'number'
      ? ` · ${clip.byteLengthMB < 0.1 ? '<0.1' : clip.byteLengthMB.toFixed(1)} MB`
      : '';
  // One compact line ("3.9s · 117f · 08:36"); full detail lives in the
  // title tooltip - the stacked layout wrapped badly at sidebar width (#98)
  const metaLabel = `${durationSec.toFixed(1)}s · ${frameCount}f · ${shortTime}`;
  const fullDetail = `${durationSec.toFixed(1)}s · ${frameCount} frames${sizeLabel} · captured ${timeLabel}`;
  const busyLabel = status ? BUSY_STATUS_LABELS[status] : undefined;

  const entry = createElement('div', {
    className: `clip-entry ${options.active ? 'clip-entry--active' : ''}`,
    'data-testid': 'clip-entry',
    'data-clip-id': clip.id ?? '',
    'data-clip-active': options.active ? 'true' : undefined,
    'data-clip-status': status,
  });

  const info = createElement('div', { className: 'clip-entry-info', title: fullDetail }, [
    createElement('div', { className: 'clip-entry-meta' }, [
      metaLabel,
      ...(options.active
        ? [createElement('span', { className: 'clip-entry-editing-badge' }, ['Editing'])]
        : []),
    ]),
    ...(busyLabel
      ? [
          createElement('div', { className: 'clip-entry-status', role: 'status' }, [
            createElement('span', {
              className: 'clip-entry-status-spinner',
              'aria-hidden': 'true',
            }),
            busyLabel,
          ]),
        ]
      : []),
  ]);

  if (options.active) {
    // The active clip is what's already open — nothing to promote to,
    // but it IS deletable on explicit request (#100 round 4)
    entry.appendChild(
      createElement('div', { className: 'clip-entry-main' }, [
        buildThumbnail(clip.thumbnailDataUrl),
        info,
      ]),
    );
    if (options.onDeleteActive) {
      const activeDelete = createElement(
        'button',
        {
          className: 'clip-entry-delete',
          type: 'button',
          'aria-label': `Delete the clip being edited (captured at ${timeLabel})`,
          title: 'Delete clip',
          'data-testid': 'delete-active-clip',
        },
        ['×'],
      );
      wireTwoStepDelete(
        /** @type {HTMLButtonElement} */ (activeDelete),
        'Confirm delete of the clip being edited',
        `Delete the clip being edited (captured at ${timeLabel})`,
        () => options.onDeleteActive?.(),
        cleanups,
      );
      entry.appendChild(activeDelete);
    }
    return entry;
  }

  const thumbEl = buildThumbnail(clip.thumbnailDataUrl);
  const main = createElement(
    'button',
    {
      className: 'clip-entry-main',
      type: 'button',
      'aria-label': `Edit clip captured at ${timeLabel} (${metaLabel})`,
    },
    [thumbEl, info],
  );
  if (options.onPromote && clip.id) {
    const id = clip.id;
    cleanups.push(on(main, 'click', () => options.onPromote?.(id)));
  }
  if (
    thumbEl instanceof HTMLImageElement &&
    Array.isArray(clip.previewFrames) &&
    clip.previewFrames.length > 1 &&
    clip.thumbnailDataUrl
  ) {
    wireHoverSkim(main, thumbEl, clip.previewFrames, clip.thumbnailDataUrl, cleanups);
  }
  entry.appendChild(main);

  const deleteBtn = createElement(
    'button',
    {
      className: 'clip-entry-delete',
      type: 'button',
      'aria-label': `Delete clip captured at ${timeLabel}`,
      title: 'Delete clip',
    },
    ['×'],
  );
  if (options.onDelete && clip.id) {
    const id = clip.id;
    wireTwoStepDelete(
      /** @type {HTMLButtonElement} */ (deleteBtn),
      `Confirm delete of clip captured at ${timeLabel}`,
      `Delete clip captured at ${timeLabel}`,
      () => options.onDelete?.(id),
      cleanups,
    );
  }
  entry.appendChild(deleteBtn);

  return entry;
}

/**
 * Render the clip entry list into a container (replacing its contents).
 * One stable list, newest capture first; the active clip is highlighted in
 * place and never hoisted (#100).
 *
 * @param {HTMLElement} container
 * @param {ClipEntriesOptions} options
 * @returns {(() => void)[]} Cleanup functions for the attached listeners
 */
export function renderClipEntries(container, options = {}) {
  /** @type {(() => void)[]} */
  const cleanups = [];
  const { activeClip = null, queue = [], onPromote, onDelete, onDeleteActive } = options;

  container.innerHTML = '';
  const list = createElement('div', { className: 'clip-entries' });

  // ONE stable list ordered by capture time, newest first (#100). The
  // active clip is highlighted IN PLACE — hoisting it to the top made the
  // list reshuffle on every promote, which reads as the bin "jumping
  // around" (a Premiere-style media bin never reorders on selection).
  const rows = [
    ...(activeClip ? [{ clip: activeClip, active: true }] : []),
    ...queue.map((entry) => ({ clip: entry, active: false })),
  ].sort((a, b) => (b.clip.capturedAt ?? 0) - (a.clip.capturedAt ?? 0));

  for (const row of rows) {
    list.appendChild(
      buildEntry(row.clip, { active: row.active, onPromote, onDelete, onDeleteActive }, cleanups),
    );
  }

  if (rows.length === 0) {
    list.appendChild(
      createElement('div', { className: 'clip-entries-empty' }, ['No clips in queue']),
    );
  }

  container.appendChild(list);
  return cleanups;
}
