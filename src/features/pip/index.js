/**
 * Persistent Live-Capture PiP (#94)
 * @module features/pip
 *
 * A small floating preview of the live capture stream, shown on every route
 * except /capture while a (possibly backgrounded, #91) capture session is
 * live. initPip() is called once from main.js at DOMContentLoaded and mounts
 * `#pip-root` on document.body (NOT inside #app — its overflow:hidden clips
 * fixed children; same reason #live-region lives on body, see main.js).
 *
 * Whenever the PiP is visible it is, by construction, showing a BACKGROUNDED
 * session: the capture feature only stashes its live resources into
 * app-store's screenCaptureState when the user navigates off /capture (see
 * cleanup() in features/capture/index.js), and the PiP never shows on
 * /capture itself. So getScreenCaptureState() is the single source for the
 * stream and the stats store while this module is visible.
 */

import { getScreenCaptureState, hasActiveScreenCapture } from '../../shared/app-store.js';
import { on as onBus } from '../../shared/bus.js';
import { announce } from '../../shared/live-region.js';
import { getCurrentRoute, navigate, onRouteChange } from '../../shared/router.js';
import { createElement, on } from '../../shared/utils/dom.js';
import { clipNow } from '../capture/clip-service.js';

/** Routes whose bottom timeline+status strip the PiP must clear (spec amendment 1) */
const ROUTES_ABOVE_DOCK = new Set(['/editor', '/export']);

/** How long the "Capture ended" terminal state stays up before hiding (spec amendment 4) */
const ENDED_DISPLAY_MS = 2000;

/** @type {HTMLElement | null} */
let root = null;
/** @type {HTMLVideoElement | null} */
let videoEl = null;
/** @type {HTMLElement | null} */
let bufferTextEl = null;
/** @type {HTMLElement | null} */
let minimizeBtn = null;
/** @type {HTMLElement | null} */
let shutterEl = null;
/** @type {HTMLButtonElement | null} */
let pillEl = null;
/** @type {HTMLElement | null} */
let endedOverlayEl = null;

/** Collapsed-to-pill state, remembered for the session (module state, not reset on hide) */
let collapsed = false;

/** True once the user explicitly toggled; stops route defaults from overriding their choice */
let userToggled = false;

/** True while showing the ~2s "Capture ended" terminal state, overriding normal visibility */
let showingEnded = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let endedTimer = null;

/** Unsubscribe from the stashed capture store's stats; only ever set while visible */
let statsUnsubscribe = null;

/**
 * Mount the PiP root once. Safe to call more than once (subsequent calls
 * no-op) so a stray double-init can't duplicate the DOM or double-subscribe.
 */
export function initPip() {
  if (root) return;

  buildDom();
  document.body.appendChild(root);

  onRouteChange(handleRouteChange);
  onBus('capture:started', refresh);
  onBus('capture:restored', refresh);
  onBus('capture:stopped', handleCaptureStopped);
  onBus('clip:queued', handleClipQueued);

  applyRouteClass(getCurrentRoute());
  refresh();
}

/** Build the static DOM once; nothing here depends on capture state */
function buildDom() {
  videoEl = /** @type {HTMLVideoElement} */ (
    createElement('video', {
      className: 'pip-video',
      muted: 'true',
      autoplay: 'true',
      playsinline: 'true',
      'aria-hidden': 'true',
    })
  );

  shutterEl = createElement('div', { className: 'pip-shutter', 'aria-hidden': 'true' });
  endedOverlayEl = createElement('div', { className: 'pip-ended-overlay' }, ['Capture ended']);

  const recBadge = createElement('span', { className: 'pip-rec-badge' }, [
    createElement('span', { className: 'pip-rec-dot', 'aria-hidden': 'true' }, []),
    'REC',
  ]);

  const videoWrap = createElement('div', { className: 'pip-video-wrap' }, [
    videoEl,
    shutterEl,
    endedOverlayEl,
    recBadge,
  ]);

  bufferTextEl = createElement('div', { className: 'pip-buffer-text' }, ['']);

  const clipNowBtn = createElement(
    'button',
    {
      type: 'button',
      className: 'pip-btn pip-btn-primary',
      'data-testid': 'pip-clip-now',
      'aria-label': 'Clip Now',
    },
    ['Clip Now'],
  );
  const openCaptureBtn = createElement(
    'button',
    {
      type: 'button',
      className: 'pip-btn',
      'data-testid': 'pip-open-capture',
      'aria-label': 'Open Capture',
    },
    ['Open Capture'],
  );
  const actions = createElement('div', { className: 'pip-actions' }, [clipNowBtn, openCaptureBtn]);

  minimizeBtn = createElement(
    'button',
    {
      type: 'button',
      className: 'pip-minimize',
      'data-testid': 'pip-minimize',
      'aria-label': 'Minimize live capture preview',
      'aria-expanded': 'true',
    },
    ['−'],
  );

  const card = createElement('div', { className: 'pip-card' }, [
    videoWrap,
    bufferTextEl,
    actions,
    minimizeBtn,
  ]);

  const pill = createElement(
    'button',
    {
      type: 'button',
      className: 'pip-pill',
      'aria-label': 'Expand live capture preview',
      'aria-expanded': 'false',
    },
    ['● REC'],
  );
  pillEl = /** @type {HTMLButtonElement} */ (pill);

  root = createElement(
    'div',
    {
      id: 'pip-root',
      className: 'pip-root',
      role: 'region',
      'aria-label': 'Live capture preview',
      hidden: true,
    },
    [card, pill],
  );

  on(clipNowBtn, 'click', () => {
    void clipNow();
  });
  on(openCaptureBtn, 'click', () => navigate('/capture'));
  on(minimizeBtn, 'click', toggleCollapse);
  on(pill, 'click', toggleCollapse);
}

/** @param {import('../../shared/router.js').Route} route */
function handleRouteChange(route) {
  applyRouteClass(route);
  // Default to the pill on /editor: the expanded 240px card is wider than
  // the left sidebar and covered the queue entries and Scenes it shipped
  // alongside (UX review). The pill keeps the REC signal; expanding is one
  // click, and an explicit user toggle is never overridden. Applied before
  // refresh() so the default is in place the moment the PiP becomes visible.
  if (!userToggled) {
    collapsed = route === '/editor';
    syncCollapsedUi();
  }
  refresh();
}

/** @param {import('../../shared/router.js').Route} route */
function applyRouteClass(route) {
  if (!root) return;
  root.classList.toggle('pip-root--above-dock', ROUTES_ABOVE_DOCK.has(route));
}

function toggleCollapse() {
  collapsed = !collapsed;
  userToggled = true;
  syncCollapsedUi();
}

function syncCollapsedUi() {
  if (!root || !minimizeBtn) return;
  root.classList.toggle('pip-root--collapsed', collapsed);
  minimizeBtn.setAttribute('aria-expanded', String(!collapsed));
  minimizeBtn.setAttribute(
    'aria-label',
    collapsed ? 'Expand live capture preview' : 'Minimize live capture preview',
  );
  // The minimize button is display:none while collapsed, so the pill must
  // carry the expanded/collapsed state for the a11y tree (UX review)
  pillEl?.setAttribute('aria-expanded', String(!collapsed));
}

/** Whether the PiP should currently be shown */
function computeVisible() {
  if (showingEnded) return true;
  return hasActiveScreenCapture() && getCurrentRoute() !== '/capture';
}

/** Re-evaluate visibility and show/hide accordingly */
function refresh() {
  if (!root) return;
  const visible = computeVisible();
  if (visible === !root.hidden) return;
  if (visible) {
    show();
  } else {
    hide();
  }
}

function show() {
  if (!root) return;
  root.hidden = false;
  syncCollapsedUi();

  const captureState = getScreenCaptureState();
  if (videoEl) {
    // The muted attribute alone is not always enough for autoplay policies;
    // set the IDL property too, and swallow play() rejections (e.g. jsdom).
    videoEl.muted = true;
    videoEl.srcObject = captureState?.stream ?? null;
    // jsdom's play() returns undefined (no Promise); real browsers return one
    videoEl.play?.()?.catch?.(() => {});
  }

  // Subscribe to the stashed capture store for buffer fullness text.
  // Unsubscribed in hide() — never leak this across show/hide cycles.
  if (captureState?.store) {
    updateBufferText(captureState.store.getState());
    statsUnsubscribe = captureState.store.subscribe(updateBufferText);
  }
}

function hide() {
  if (!root) return;
  root.hidden = true;
  if (statsUnsubscribe) {
    statsUnsubscribe();
    statsUnsubscribe = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
  if (bufferTextEl) {
    bufferTextEl.textContent = '';
  }
}

/**
 * @param {import('../capture/types.js').CaptureState} state
 */
function updateBufferText(state) {
  if (!bufferTextEl) return;
  const duration = Math.round(state.stats?.duration ?? 0);
  const limit = state.settings?.bufferDuration ?? 0;
  bufferTextEl.textContent = `${duration}s / ${limit}s`;
}

/** capture:stopped — show the "Capture ended" terminal state if we were up */
function handleCaptureStopped() {
  if (!root || root.hidden) {
    refresh();
    return;
  }

  showingEnded = true;
  root.classList.add('pip-root--ended');
  if (statsUnsubscribe) {
    statsUnsubscribe();
    statsUnsubscribe = null;
  }
  announce('Live capture preview: capture ended');

  if (endedTimer) clearTimeout(endedTimer);
  endedTimer = setTimeout(() => {
    endedTimer = null;
    showingEnded = false;
    root?.classList.remove('pip-root--ended');
    refresh();
  }, ENDED_DISPLAY_MS);
}

/** clip:queued — brief shutter-flash regardless of where the clip came from */
function handleClipQueued() {
  if (!shutterEl) return;
  shutterEl.classList.remove('pip-shutter--flash');
  // Force reflow so re-adding the class restarts the animation
  void shutterEl.offsetWidth;
  shutterEl.classList.add('pip-shutter--flash');
}
