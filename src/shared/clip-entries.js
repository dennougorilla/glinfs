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
  const status = options.active ? undefined : (clip.status ?? 'raw');
  const sizeLabel =
    status === 'compressed' && typeof clip.byteLengthMB === 'number'
      ? ` · ${clip.byteLengthMB < 0.1 ? '<0.1' : clip.byteLengthMB.toFixed(1)} MB`
      : '';
  const metaLabel = `${durationSec.toFixed(1)}s · ${frameCount} frames${sizeLabel}`;
  const busyLabel = status ? BUSY_STATUS_LABELS[status] : undefined;

  const entry = createElement('div', {
    className: `clip-entry ${options.active ? 'clip-entry--active' : ''}`,
    'data-testid': 'clip-entry',
    'data-clip-id': clip.id ?? '',
    'data-clip-active': options.active ? 'true' : undefined,
    'data-clip-status': status,
  });

  const info = createElement('div', { className: 'clip-entry-info' }, [
    createElement('div', { className: 'clip-entry-meta' }, [metaLabel]),
    createElement('div', { className: 'clip-entry-time' }, [
      timeLabel,
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
    // The active clip is what's already open — nothing to promote to
    entry.appendChild(
      createElement('div', { className: 'clip-entry-main' }, [
        buildThumbnail(clip.thumbnailDataUrl),
        info,
      ]),
    );
    return entry;
  }

  const main = createElement(
    'button',
    {
      className: 'clip-entry-main',
      type: 'button',
      'aria-label': `Edit clip captured at ${timeLabel} (${metaLabel})`,
    },
    [buildThumbnail(clip.thumbnailDataUrl), info],
  );
  if (options.onPromote && clip.id) {
    const id = clip.id;
    cleanups.push(on(main, 'click', () => options.onPromote?.(id)));
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
    cleanups.push(on(deleteBtn, 'click', () => options.onDelete?.(id)));
  }
  entry.appendChild(deleteBtn);

  return entry;
}

/**
 * Render the clip entry list into a container (replacing its contents).
 * Active clip first (highlighted "Editing"), then queue entries newest first.
 *
 * @param {HTMLElement} container
 * @param {ClipEntriesOptions} options
 * @returns {(() => void)[]} Cleanup functions for the attached listeners
 */
export function renderClipEntries(container, options = {}) {
  /** @type {(() => void)[]} */
  const cleanups = [];
  const { activeClip = null, queue = [], onPromote, onDelete } = options;

  container.innerHTML = '';
  const list = createElement('div', { className: 'clip-entries' });

  if (activeClip) {
    list.appendChild(buildEntry(activeClip, { active: true }, cleanups));
  }
  for (const entry of queue) {
    list.appendChild(buildEntry(entry, { active: false, onPromote, onDelete }, cleanups));
  }

  if (!activeClip && queue.length === 0) {
    list.appendChild(
      createElement('div', { className: 'clip-entries-empty' }, ['No clips in queue']),
    );
  }

  container.appendChild(list);
  return cleanups;
}
