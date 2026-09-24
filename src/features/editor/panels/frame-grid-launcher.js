/**
 * Frame grid launcher: the single-instance latch shared by the Open Grid
 * button and the F shortcut, plus opening the modal and restoring focus to
 * its opener on close (#114)
 * @module features/editor/panels/frame-grid-launcher
 */

import { renderFrameGridModal } from '../frame-grid.js';

/**
 * Create the frame grid launcher for one editor render
 * @param {import('../types.js').EditorState} state - Render-time state (fallback when handlers.getState is absent)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ open: () => void, cleanup: () => void }}
 */
export function createFrameGridLauncher(state, handlers) {
  /** @type {(() => void) | null} */
  let frameGridCleanup = null;

  /**
   * Open frame grid modal
   */
  function handleOpenFrameGrid() {
    const currentState = handlers.getState?.() ?? state;
    if (currentState.clip && currentState.clip.frames.length > 0 && !frameGridCleanup) {
      frameGridCleanup = openFrameGridModal(currentState, handlers, () => {
        frameGridCleanup = null;
      });
    }
  }

  // Track cleanup for modal when editor closes
  const cleanup = () => {
    if (frameGridCleanup) {
      frameGridCleanup();
      frameGridCleanup = null;
    }
  };

  return { open: handleOpenFrameGrid, cleanup };
}

/**
 * Open Frame Grid Modal
 * @param {import('../types.js').EditorState} state - Current editor state
 * @param {import('../ui.js').EditorUIHandlers} handlers - UI handlers
 * @param {() => void} [onClose] - Callback when modal closes
 * @returns {() => void} Cleanup function
 */
function openFrameGridModal(state, handlers, onClose) {
  if (!state.clip) return () => {};

  // Closing removes the focused modal, which drops focus to <body>; return
  // it to whatever opened the grid (#114)
  const opener = document.activeElement;

  const { cleanup } = renderFrameGridModal({
    container: document.body,
    frames: state.clip.frames,
    initialRange: state.selectedRange,
    scenes: state.scenes,
    callbacks: {
      onApply: (range) => {
        // If onRangeChange throws, the modal must still close instead of
        // leaving its document-level listeners mounted forever
        try {
          handlers.onRangeChange(range);
        } finally {
          cleanup();
          onClose?.();
          restoreFrameGridFocus(opener);
        }
      },
      onCancel: () => {
        cleanup();
        onClose?.();
        restoreFrameGridFocus(opener);
      },
    },
  });

  return cleanup;
}

/**
 * Return focus to the element that opened the frame grid. Falls back to the
 * Open Grid button when the opener is gone (e.g. the clip-queue popover
 * closed by a click inside the modal) or was <body> (the F shortcut).
 * @param {Element | null} opener
 */
function restoreFrameGridFocus(opener) {
  if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
    opener.focus();
    if (document.activeElement === opener) return;
  }
  /** @type {HTMLElement | null} */ (document.querySelector('.btn-frame-grid-compact'))?.focus();
}
