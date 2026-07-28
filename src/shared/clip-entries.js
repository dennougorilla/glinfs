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

/**
 * The one ordering used everywhere clips are listed or addressed by
 * position (#100 round 7, plan A): newest capture first, active in place.
 * The number badges AND the 1-9 shortcuts both index into THIS array, so
 * "press what you see" always holds.
 *
 * @param {import('./app-store.js').ClipPayload|null} activeClip
 * @param {import('./app-store.js').ClipQueueEntry[]} queue
 * @returns {{ clip: any, active: boolean }[]}
 */
export function getOrderedClipRows(activeClip, queue) {
  return [
    ...(activeClip ? [{ clip: activeClip, active: true }] : []),
    ...queue.map((entry) => ({ clip: entry, active: false })),
  ].sort((a, b) => (b.clip.capturedAt ?? 0) - (a.clip.capturedAt ?? 0));
}

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

/** Small trash-can SVG for delete buttons */
function buildTrashIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>';
  return svg;
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

  // Position badge (browser-tab model, #100 r7): the number IS the list
  // position, so it matches the 1-9 switch/delete shortcuts by
  // construction. Entries past 9 have no key — badge shows position only.
  if (typeof options.position === 'number') {
    entry.appendChild(
      createElement('span', { className: 'clip-entry-num', 'aria-hidden': 'true' }, [
        options.position <= 9 ? String(options.position) : '\u00b7',
      ]),
    );
  }

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
        [buildTrashIcon()],
      );
      cleanups.push(on(activeDelete, 'click', () => options.onDeleteActive?.()));
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

  // Single-click delete (#100 r5): safe because deletion is deferred with a
  // 5s undo window (app-store hold + toast) — no confirm friction needed.
  // Trash icon at the row's trailing edge, clear of the skimming thumbnail.
  const deleteBtn = createElement(
    'button',
    {
      className: 'clip-entry-delete',
      type: 'button',
      'aria-label': `Delete clip captured at ${timeLabel}`,
      title: 'Delete clip',
    },
    [buildTrashIcon()],
  );
  if (options.onDelete && clip.id) {
    const id = clip.id;
    cleanups.push(on(deleteBtn, 'click', () => options.onDelete?.(id)));
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
  const rows = getOrderedClipRows(activeClip, queue);

  rows.forEach((row, index) => {
    list.appendChild(
      buildEntry(
        row.clip,
        { active: row.active, position: index + 1, onPromote, onDelete, onDeleteActive },
        cleanups,
      ),
    );
  });

  if (rows.length === 0) {
    list.appendChild(
      createElement('div', { className: 'clip-entries-empty' }, ['No clips in queue']),
    );
  }

  container.appendChild(list);
  return cleanups;
}
