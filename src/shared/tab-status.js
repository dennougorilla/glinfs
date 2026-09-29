/**
 * Tab Status
 * Swaps the favicon and document title while a capture is live or an export
 * is running, so the state shows in the tab bar while the user is elsewhere.
 * @module shared/tab-status
 */

import { on } from './bus.js';

/** @typedef {'idle' | 'recording' | 'busy'} TabState */

/** @type {Record<Exclude<TabState, 'idle'>, string>} */
const ICON_FILES = {
  recording: 'favicon-recording.svg',
  busy: 'favicon-busy.svg',
};

/**
 * Start following capture/export events
 * @param {Document} [doc]
 * @returns {() => void} Stop following and restore the original icon and title
 */
export function initTabStatus(doc = document) {
  const links = /** @type {HTMLLinkElement[]} */ ([...doc.querySelectorAll('link[rel~="icon"]')]);
  const originals = links.map((link) => link.getAttribute('href') ?? '');
  // State icons sit next to favicon.svg, so they share its (Vite-rewritten) base path
  const svgHref = links.find((link) => link.type === 'image/svg+xml')?.getAttribute('href') ?? '';
  const baseTitle = doc.title;

  let live = false;
  /** @type {number | null} export progress in percent, null when not exporting */
  let exportPercent = null;

  const apply = () => {
    /** @type {TabState} */
    const state = exportPercent !== null ? 'busy' : live ? 'recording' : 'idle';
    links.forEach((link, i) => {
      const href =
        state === 'idle' || !svgHref
          ? originals[i]
          : svgHref.replace(/favicon\.svg$/, ICON_FILES[state]);
      // Setting href again makes the browser refetch, so only touch real changes
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    });
    doc.title =
      state === 'busy'
        ? `Exporting ${exportPercent}% - Glinfs`
        : state === 'recording'
          ? '● Recording - Glinfs'
          : baseTitle;
  };

  const setLive = (value) => () => {
    live = value;
    apply();
  };
  const endExport = () => {
    exportPercent = null;
    apply();
  };

  const unsubscribers = [
    on('capture:started', setLive(true)),
    on('capture:restored', setLive(true)),
    on('capture:stopped', setLive(false)),
    on('capture:error', setLive(false)),
    on('export:started', () => {
      exportPercent = 0;
      apply();
    }),
    on('export:progress', (/** @type {{ percent: number }} */ { percent }) => {
      if (exportPercent === null) return;
      exportPercent = Math.max(0, Math.min(100, Math.round(percent)));
      apply();
    }),
    on('export:complete', endExport),
    on('export:cancelled', endExport),
    on('export:error', endExport),
    on('export:closed', endExport),
  ];

  return () => {
    for (const off of unsubscribers) off();
    live = false;
    exportPercent = null;
    apply();
  };
}
