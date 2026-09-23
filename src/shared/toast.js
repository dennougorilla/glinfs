/**
 * Minimal toasts with an optional action (#100 round 5)
 * @module shared/toast
 *
 * Two independent slots, stacked in one body-level root:
 * - ACTION slot: a toast with an action (the deletion Undo). A new action
 *   toast replaces the old one — matches the single-undo model in
 *   app-store's deferred deletion, where a newer delete finalizes the older.
 * - NOTICE slot: a passive toast (no action). It replaces only a previous
 *   notice and NEVER evicts the action toast: a pending Undo keeps its
 *   button and its deadline, so an unrelated notice (e.g. the #92 codec
 *   crash) can never make a deleted clip unrecoverable.
 * Mounted lazily on document.body so it survives route innerHTML wipes, like
 * #live-region. Visual feedback only — callers still announce() for screen
 * readers.
 */

import { createElement } from './utils/dom.js';

/** How long a toast stays up; matches app-store's UNDO_GRACE_MS window */
const TOAST_DURATION_MS = 5000;

/**
 * @typedef {Object} ToastSlot
 * @property {HTMLElement} element
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {(() => void) | null} cleanup
 */

/** @type {HTMLElement | null} */
let root = null;
/** @type {{ action: ToastSlot | null, notice: ToastSlot | null }} */
const slots = { action: null, notice: null };

function ensureRoot() {
  if (root) return root;
  root = createElement('div', { id: 'toast-root', className: 'app-toast-root', hidden: true });
  document.body.appendChild(root);
  return root;
}

/**
 * Remove one slot's toast (no-op when empty)
 * @param {'action' | 'notice'} name
 */
function clearSlot(name) {
  const slot = slots[name];
  if (!slot) return;
  clearTimeout(slot.timer);
  slot.cleanup?.();
  slot.element.remove();
  slots[name] = null;
  if (root && !slots.action && !slots.notice) {
    root.hidden = true;
  }
}

/** Hide and clear every toast (no-op when none is shown) */
export function hideToast() {
  clearSlot('action');
  clearSlot('notice');
}

/**
 * Show a toast. One with an action replaces the current action toast; one
 * without replaces only the current notice (see module doc).
 *
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, durationMs?: number }} [options]
 */
export function showToast(message, options = {}) {
  const host = ensureRoot();
  const hasAction = Boolean(options.actionLabel && options.onAction);
  /** @type {'action' | 'notice'} */
  const name = hasAction ? 'action' : 'notice';
  clearSlot(name);

  const children = [createElement('span', { className: 'app-toast-message' }, [message])];
  /** @type {(() => void) | null} */
  let cleanup = null;
  if (hasAction) {
    const actionBtn = createElement('button', { className: 'app-toast-action', type: 'button' }, [
      options.actionLabel,
    ]);
    const handler = () => {
      clearSlot('action');
      options.onAction?.();
    };
    actionBtn.addEventListener('click', handler);
    cleanup = () => actionBtn.removeEventListener('click', handler);
    children.push(actionBtn);
  }

  const element = createElement(
    'div',
    { className: hasAction ? 'app-toast' : 'app-toast app-toast--notice', role: 'status' },
    children,
  );
  host.appendChild(element);
  host.hidden = false;

  slots[name] = {
    element,
    timer: setTimeout(() => clearSlot(name), options.durationMs ?? TOAST_DURATION_MS),
    cleanup,
  };
}
