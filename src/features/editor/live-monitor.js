/**
 * Live Source Monitor dock (#100, Layout A)
 * @module features/editor/live-monitor
 *
 * The editor's docked view of the ongoing capture: live stream video, REC
 * badge, buffer fullness, and Clip Now — pinned at the top of the left
 * sidebar. Replaces the floating PiP overlay, which covered content and
 * had no fixed home (no professional editor floats its source monitor).
 *
 * Editor-scoped: mounted by initEditor into the sidebar's monitor slot and
 * torn down with the editor. Visible only while a live capture session
 * exists (on /editor the session is always the one stashed in app-store by
 * capture's cleanup).
 */

import { getScreenCaptureState, hasActiveScreenCapture } from '../../shared/app-store.js';
import { on as onBus } from '../../shared/bus.js';
import { createElement, on } from '../../shared/utils/dom.js';
import { clipNow } from '../capture/clip-service.js';

/** How long the "Capture ended" terminal state stays before the dock hides */
const ENDED_STATE_MS = 2000;

/**
 * Mount the live monitor into a slot element.
 *
 * @param {HTMLElement} slot - The sidebar's [data-live-monitor] element
 * @returns {() => void} Cleanup
 */
export function initLiveMonitor(slot) {
  /** @type {(() => void)[]} */
  const cleanups = [];
  /** @type {(() => void) | null} */
  let statsUnsubscribe = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let endedTimer = null;
  let showingEnded = false;

  const videoEl = /** @type {HTMLVideoElement} */ (
    createElement('video', {
      className: 'live-monitor-video',
      autoplay: 'true',
      muted: 'true',
      playsinline: 'true',
      'aria-hidden': 'true',
    })
  );
  const shutterEl = createElement('div', { className: 'live-monitor-shutter' });
  const endedEl = createElement('div', { className: 'live-monitor-ended' }, ['Capture ended']);
  const bufferTextEl = createElement('div', { className: 'live-monitor-buffer' }, ['']);
  const clipNowBtn = createElement(
    'button',
    {
      className: 'live-monitor-clip-btn',
      type: 'button',
      'data-testid': 'monitor-clip-now',
      'aria-label': 'Clip Now (Shift+C)',
    },
    ['Clip Now'],
  );

  const card = createElement(
    'div',
    {
      className: 'live-monitor',
      role: 'region',
      'aria-label': 'Live capture monitor',
      'data-testid': 'live-monitor',
    },
    [
      createElement('div', { className: 'live-monitor-viewport' }, [
        videoEl,
        shutterEl,
        endedEl,
        createElement('span', { className: 'live-monitor-rec' }, [
          createElement('span', { className: 'live-monitor-rec-dot', 'aria-hidden': 'true' }),
          'REC',
        ]),
      ]),
      createElement('div', { className: 'live-monitor-bar' }, [bufferTextEl, clipNowBtn]),
    ],
  );
  slot.appendChild(card);
  slot.hidden = true;

  cleanups.push(on(clipNowBtn, 'click', () => void clipNow()));

  /** @param {import('../capture/types.js').CaptureState} state */
  const updateBufferText = (state) => {
    const seconds = Math.round(state?.stats?.duration ?? 0);
    const capacity = state?.settings?.bufferDuration ?? 0;
    bufferTextEl.textContent = capacity ? `${seconds}s / ${capacity}s` : '';
  };

  const show = () => {
    slot.hidden = false;
    card.classList.remove('live-monitor--ended');
    const captureState = getScreenCaptureState();
    videoEl.muted = true;
    videoEl.srcObject = captureState?.stream ?? null;
    videoEl.play?.()?.catch?.(() => {});
    if (captureState?.store && !statsUnsubscribe) {
      updateBufferText(captureState.store.getState());
      statsUnsubscribe = captureState.store.subscribe(updateBufferText);
    }
  };

  const hide = () => {
    slot.hidden = true;
    if (statsUnsubscribe) {
      statsUnsubscribe();
      statsUnsubscribe = null;
    }
    videoEl.srcObject = null;
    bufferTextEl.textContent = '';
  };

  const refresh = () => {
    if (showingEnded) return; // the ended state controls its own teardown
    if (hasActiveScreenCapture()) {
      show();
    } else {
      hide();
    }
  };

  // The share ended (browser "Stop sharing" or track death): explain the
  // disappearance for a beat instead of silently vanishing
  const handleStopped = () => {
    if (slot.hidden) return;
    showingEnded = true;
    if (statsUnsubscribe) {
      statsUnsubscribe();
      statsUnsubscribe = null;
    }
    videoEl.srcObject = null;
    card.classList.add('live-monitor--ended');
    endedTimer = setTimeout(() => {
      endedTimer = null;
      showingEnded = false;
      refresh();
    }, ENDED_STATE_MS);
  };

  const flashShutter = () => {
    shutterEl.classList.remove('live-monitor-shutter--flash');
    void shutterEl.offsetWidth;
    shutterEl.classList.add('live-monitor-shutter--flash');
  };

  cleanups.push(onBus('capture:started', refresh));
  cleanups.push(onBus('capture:restored', refresh));
  cleanups.push(onBus('capture:stopped', handleStopped));
  cleanups.push(onBus('clip:queued', flashShutter));

  refresh();

  return () => {
    if (endedTimer !== null) {
      clearTimeout(endedTimer);
      endedTimer = null;
    }
    hide();
    cleanups.forEach((fn) => {
      fn();
    });
    slot.innerHTML = '';
  };
}
