/**
 * Screen reader live-region announcements
 * @module shared/live-region
 *
 * Split out of main.js so feature modules (e.g. capture's route-independent
 * "ended" handler) can call announce() without importing main.js itself -
 * main.js's own module graph pulls in every feature's index.js, which would
 * make this a circular import for any feature that needs to announce
 * something.
 */

/**
 * Announce message to screen readers via the app's live region
 * @param {string} message - Message to announce
 */
export function announce(message) {
  const liveRegion = document.getElementById('live-region');
  if (liveRegion) {
    liveRegion.textContent = message;
  }
}

/**
 * Create the app's one live region (called once from main.js; a second call
 * returns the existing element).
 *
 * Visually hidden with the shared .sr-only rule (global.css): it is for
 * screen readers only. Without it every announcement was printed as plain
 * text under the app and made the page taller than the viewport.
 *
 * @returns {HTMLElement}
 */
export function mountLiveRegion() {
  const existing = document.getElementById('live-region');
  if (existing) return existing;
  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'live-region sr-only';
  liveRegion.id = 'live-region';
  document.body.appendChild(liveRegion);
  return liveRegion;
}
