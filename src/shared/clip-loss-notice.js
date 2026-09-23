/**
 * User-facing notice for the #92 codec failure contract
 * @module shared/clip-loss-notice
 *
 * A codec-worker crash mid-encode loses that queued clip (its frames died
 * with the worker). Say so instead of letting the entry silently vanish. No
 * Undo — there is nothing left to restore. The notice is a passive toast, so
 * it never evicts a pending deletion's Undo toast (see shared/toast.js).
 */

import { on } from './bus.js';
import { announce } from './live-region.js';
import { showToast } from './toast.js';

/**
 * Show a notice (toast + screen-reader announcement) whenever a queued clip
 * is lost to a codec-worker crash ('queue:changed' type 'compress-lost').
 * @returns {() => void} Unsubscribe
 */
export function setupClipLossNotice() {
  return on('queue:changed', ({ type }) => {
    if (type !== 'compress-lost') return;
    showToast('A queued clip was lost: its compression worker crashed');
    announce('A queued clip was lost because its compression worker crashed');
  });
}
