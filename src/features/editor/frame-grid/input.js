/**
 * Frame Grid input handling
 * Delegated pointer/touch listeners, grid hotkeys and the modal's Tab trap.
 * Each attach function returns its own cleanup so the modal can tear it down.
 * @module features/editor/frame-grid/input
 */

import { registerHotkey } from '../../../shared/hotkeys.js';
import { on } from '../../../shared/utils/dom.js';

/** Controls that must retain their native keyboard behavior inside the modal. */
const INTERACTIVE_ELEMENT_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ');

/**
 * Check whether a keyboard event came from a control with its own key semantics.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isInteractiveElement(target) {
  return target instanceof Element && target.closest(INTERACTIVE_ELEMENT_SELECTOR) !== null;
}

/**
 * Run a list of cleanups in registration order.
 * @param {(() => void)[]} cleanups
 * @returns {() => void}
 */
function combine(cleanups) {
  return () => {
    cleanups.forEach((fn) => {
      fn();
    });
  };
}

/**
 * Long-press on a grid item marks it `touch-active` (reveals the S/E actions
 * on touch devices). Handlers are delegated so the listener count stays
 * constant even for non-virtualized clips near the threshold.
 * @param {HTMLElement} gridContainer
 * @returns {{ forgetItem: (item: HTMLElement) => void, cleanup: () => void }}
 */
export function attachTouchLongPress(gridContainer) {
  /** @type {number | null} */
  let touchTimer = null;
  /** @type {HTMLElement | null} */
  let touchPendingItem = null;
  /** @type {HTMLElement | null} */
  let touchActiveItem = null;

  /**
   * Clear touch-active state from any item
   */
  function clearTouchActive() {
    if (touchActiveItem) {
      touchActiveItem.classList.remove('touch-active');
      touchActiveItem = null;
    }
  }

  /** Cancel a pending long-press timer. */
  function cancelTouchTimer() {
    if (touchTimer !== null) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    touchPendingItem = null;
  }

  const cleanups = [
    on(
      gridContainer,
      'touchstart',
      (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const item = /** @type {HTMLElement | null} */ (target?.closest('.frame-grid-item'));
        if (!item) return;

        cancelTouchTimer();
        clearTouchActive();
        touchPendingItem = item;
        touchTimer = window.setTimeout(() => {
          touchTimer = null;
          touchPendingItem = null;
          if (!item.isConnected) return;
          item.classList.add('touch-active');
          touchActiveItem = item;
        }, 400);
      },
      { passive: true },
    ),
    on(gridContainer, 'touchend', cancelTouchTimer),
    on(gridContainer, 'touchmove', cancelTouchTimer),
    on(gridContainer, 'touchcancel', cancelTouchTimer),
    cancelTouchTimer,
  ];

  /**
   * Drop touch state held for an item that is about to be removed.
   * @param {HTMLElement} item
   */
  function forgetItem(item) {
    if (touchPendingItem === item) {
      cancelTouchTimer();
    }
    if (touchActiveItem === item) {
      touchActiveItem = null;
    }
  }

  return { forgetItem, cleanup: combine(cleanups) };
}

/**
 * Delegate focus and mouse events instead of registering them per item.
 * @param {HTMLElement} gridContainer
 * @param {Object} handlers
 * @param {(index: number) => void} handlers.onFocusFrame - A grid item received focus
 * @param {(index: number) => void} handlers.onStartButton - [S] hover action
 * @param {(index: number) => void} handlers.onEndButton - [E] hover action
 * @param {(index: number, shiftKey: boolean) => void} handlers.onFrameClick
 * @param {(index: number) => void} handlers.onFrameDoubleClick
 * @returns {() => void} Cleanup
 */
export function attachGridPointer(
  gridContainer,
  { onFocusFrame, onStartButton, onEndButton, onFrameClick, onFrameDoubleClick },
) {
  return combine([
    on(gridContainer, 'focusin', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.classList.contains('frame-grid-item')) return;
      onFocusFrame(Number.parseInt(/** @type {HTMLElement} */ (target).dataset.index, 10));
    }),

    on(gridContainer, 'click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const item = target.closest('.frame-grid-item');
      if (!item) return;

      const index = parseInt(item.dataset.index, 10);

      // [S] button click
      if (target.closest('.action-start')) {
        e.stopPropagation();
        onStartButton(index);
        return;
      }

      // [E] button click
      if (target.closest('.action-end')) {
        e.stopPropagation();
        onEndButton(index);
        return;
      }

      // Frame item click (shift+click support)
      const shiftKey = /** @type {MouseEvent} */ (e).shiftKey;
      onFrameClick(index, shiftKey);
    }),

    on(gridContainer, 'dblclick', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const item = target.closest('.frame-grid-item');
      if (!item) return;

      const index = parseInt(item.dataset.index, 10);
      onFrameDoubleClick(index);
    }),
  ]);
}

/**
 * Register the grid's keys with the app dispatcher in the modal scope.
 *
 * Grid keys go through the app dispatcher in the modal scope for as long
 * as the modal is open (#102): the dispatcher skips IME keystrokes, lets
 * Cmd/Ctrl/Alt combos (Cmd+F, Alt+Arrow) reach the browser, and keeps
 * route/overlay shortcuts (Delete, 1-9, crop Escape) off the page below.
 * Shift is accepted: Shift+Enter/Space set End, Shift+Arrow navigates.
 * allowInEditable because isInteractiveElement is the grid's own, broader
 * guard; returning without handling still claims the key for the modal.
 * @param {Object} handlers
 * @param {() => void} handlers.onEscape
 * @param {(key: string) => void} handlers.onNavigate - Arrow key
 * @param {(shiftKey: boolean) => void} handlers.onSelect - Enter/Space on the focused frame
 * @returns {() => void} Cleanup
 */
export function registerGridHotkeys({ onEscape, onNavigate, onSelect }) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  /**
   * @param {string} key
   * @param {(e: KeyboardEvent) => void} handler
   */
  const gridHotkey = (key, handler) =>
    registerHotkey({
      key,
      modifiers: { shift: 'any' },
      scope: 'modal',
      allowInEditable: true,
      handler,
    });

  // Escape closes even from a focused control (e.g. the size slider)
  cleanups.push(
    gridHotkey('Escape', (e) => {
      e.preventDefault();
      onEscape();
    }),
  );

  /** @param {KeyboardEvent} e */
  const isFromInteractiveControl = (e) =>
    isInteractiveElement(e.target instanceof Element ? e.target : document.activeElement);

  // Arrow key navigation
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    cleanups.push(
      gridHotkey(key, (e) => {
        if (isFromInteractiveControl(e)) return;
        e.preventDefault();
        onNavigate(key);
      }),
    );
  }

  // Enter/Space to select
  for (const key of ['Enter', ' ']) {
    cleanups.push(
      gridHotkey(key, (e) => {
        if (isFromInteractiveControl(e)) return;
        e.preventDefault();
        onSelect(e.shiftKey);
      }),
    );
  }

  return combine(cleanups);
}

/**
 * Trap Tab/Shift+Tab focus within the modal.
 * @param {HTMLElement} modal
 * @returns {() => void} Cleanup
 */
export function attachTabTrap(modal) {
  /** @param {KeyboardEvent} e */
  const handleTabTrap = (e) => {
    if (e.key !== 'Tab') return;

    const focusableElements = modal.querySelectorAll(
      'button, input, [tabindex]:not([tabindex="-1"])',
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable?.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable?.focus();
      }
    }
  };
  modal.addEventListener('keydown', handleTabTrap);
  return () => modal.removeEventListener('keydown', handleTabTrap);
}
