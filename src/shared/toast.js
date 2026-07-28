/**
 * Minimal toast with a single optional action (#100 round 5)
 * @module shared/toast
 *
 * One visible toast at a time (a new one replaces the old — matches the
 * single-undo model in app-store's deferred deletion). Mounted lazily on
 * document.body so it survives route innerHTML wipes, like #live-region.
 * Visual feedback only — callers still announce() for screen readers.
 */

import { createElement } from './utils/dom.js';

/** How long a toast stays up; matches app-store's UNDO_GRACE_MS window */
const TOAST_DURATION_MS = 5000;

/** @type {HTMLElement | null} */
let root = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let hideTimer = null;
/** @type {(() => void) | null} */
let actionCleanup = null;

function ensureRoot() {
  if (root) return root;
  root = createElement('div', { id: 'toast-root', className: 'app-toast-root', hidden: true });
  document.body.appendChild(root);
  return root;
}

/** Hide and clear the current toast (no-op when none is shown) */
export function hideToast() {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (actionCleanup) {
    actionCleanup();
    actionCleanup = null;
  }
  if (root) {
    root.hidden = true;
    root.innerHTML = '';
  }
}

/**
 * Show a toast, replacing any current one.
 *
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, durationMs?: number }} [options]
 */
export function showToast(message, options = {}) {
  const host = ensureRoot();
  hideToast();

  const children = [createElement('span', { className: 'app-toast-message' }, [message])];
  if (options.actionLabel && options.onAction) {
    const actionBtn = createElement('button', { className: 'app-toast-action', type: 'button' }, [
      options.actionLabel,
    ]);
    const handler = () => {
      hideToast();
      options.onAction?.();
    };
    actionBtn.addEventListener('click', handler);
    actionCleanup = () => actionBtn.removeEventListener('click', handler);
    children.push(actionBtn);
  }

  host.appendChild(createElement('div', { className: 'app-toast', role: 'status' }, children));
  host.hidden = false;

  hideTimer = setTimeout(hideToast, options.durationMs ?? TOAST_DURATION_MS);
}
