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
