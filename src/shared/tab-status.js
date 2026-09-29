/**
 * Tab Status
 * Mirrors what the app is doing in the tab (favicon + title) and in the header
 * logo: editing, a live capture, or an export in progress. The tab keeps
 * showing it while the user is in another tab.
 * @module shared/tab-status
 */

import { on } from './bus.js';
import { getCurrentRoute, onRouteChange } from './router.js';

/** @typedef {'idle' | 'edit' | 'recording' | 'busy'} TabState */

/** @type {Record<Exclude<TabState, 'idle'>, string>} */
const ICON_FILES = {
  edit: 'favicon-edit.svg',
  recording: 'favicon-recording.svg',
  busy: 'favicon-busy.svg',
};

/** Routes that show the editor (/export opens the editor with its dialog) */
const EDITOR_ROUTES = new Set(['/editor', '/export']);

/**
 * @typedef {Object} TabStatusDeps
 * @property {() => string} [getRoute]
 * @property {(callback: (route: string) => void) => () => void} [subscribeRoute]
 */

/**
 * Start following route, capture and export events
 * @param {Document} [doc]
 * @param {TabStatusDeps} [deps] - Router access (injectable for tests)
 * @returns {() => void} Stop following and restore the original icon, title and logo
 */
export function initTabStatus(doc = document, deps = {}) {
  const { getRoute = getCurrentRoute, subscribeRoute = onRouteChange } = deps;
  const links = /** @type {HTMLLinkElement[]} */ ([...doc.querySelectorAll('link[rel~="icon"]')]);
  const originals = links.map((link) => link.getAttribute('href') ?? '');
  // State icons sit next to favicon.svg, so they share its (Vite-rewritten) base path
  const svgHref = links.find((link) => link.type === 'image/svg+xml')?.getAttribute('href') ?? '';
  const baseTitle = doc.title;
  const logo = /** @type {HTMLElement | null} */ (doc.querySelector('.app-logo'));

  let editing = EDITOR_ROUTES.has(getRoute());
  let live = false;
  /** @type {number | null} export progress in percent, null when not exporting */
  let exportPercent = null;

  const apply = () => {
    // A live capture outranks editing: the screen is still being recorded
    /** @type {TabState} */
    const state = exportPercent !== null ? 'busy' : live ? 'recording' : editing ? 'edit' : 'idle';
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
    // The header logo shows the matching frame while it is not hovered
    if (logo) {
      if (state === 'idle') delete logo.dataset.state;
      else logo.dataset.state = state;
    }
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
    subscribeRoute((route) => {
      editing = EDITOR_ROUTES.has(route);
      apply();
    }),
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
  apply();

  return () => {
    for (const off of unsubscribers) off();
    editing = false;
    live = false;
    exportPercent = null;
    apply();
  };
}
