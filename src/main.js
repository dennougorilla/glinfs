/**
 * Application Entry Point
 * @module main
 */

import { cleanupScreenCaptureResources } from './features/capture/api.js';
import { clipNow, handleClipNowHotkey, isCaptureLive } from './features/capture/clip-service.js';
import { initCapture } from './features/capture/index.js';
import { initEditor, promoteClipFromQueue } from './features/editor/index.js';
import { initExport } from './features/export/index.js';
import { initLoading } from './features/loading/index.js';
import { initPip } from './features/pip/index.js';
import { initSettings } from './features/settings/index.js';
import {
  deleteQueuedClip,
  getClipPayload,
  getClipQueue,
  getEditorPayload,
  registerScreenCaptureCleanup,
  resetAppStore,
  setClipPayload,
  setEditorPayload,
} from './shared/app-store.js';
import { on as onBus } from './shared/bus.js';
import { renderClipEntries } from './shared/clip-entries.js';
import { announce } from './shared/live-region.js';
import { getCurrentRoute, initRouter, navigate, onRouteChange } from './shared/router.js';
import {
  getDefaultMockOptions,
  getTestConfig,
  initTestMode,
  isTestMode,
  updateTestConfig,
} from './shared/test-mode.js';
import { createElement } from './shared/utils/dom.js';
import {
  createMockClipPayload,
  createMockEditorPayload,
  createMockFrames,
  isMockFrameSupported,
} from './shared/utils/mock-frame.js';

/**
 * Application version string injected at build time by Vite
 * @type {string}
 */
/* global __APP_VERSION__ */

// Initialize test mode detection
initTestMode();

// Test environment detection - use centralized test mode
const IS_TEST_MODE = isTestMode();

if (IS_TEST_MODE) {
  window.__PLAYWRIGHT_TEST__ = true;

  /**
   * Test hooks for E2E testing - allows state injection
   * Only available in test environment (Playwright, dev mode, testMode=true)
   *
   * @example
   * // In Playwright test
   * await page.evaluate(async () => {
   *   await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 30 });
   * });
   * await page.goto('#/editor');
   *
   * @example
   * // Direct URL with test mode
   * await page.goto('http://localhost:5173/?testMode=true&mockFrames=30#/editor');
   */
  window.__TEST_HOOKS__ = {
    // ============================================================
    // App Store Management
    // ============================================================

    /** Set clip payload directly */
    setClipPayload,
    /** Set editor payload directly */
    setEditorPayload,
    /** Get current clip payload */
    getClipPayload,
    /** Get current editor payload */
    getEditorPayload,
    /** Reset all app state */
    resetAppStore,

    // ============================================================
    // Feature State Setters (populated by each feature on init)
    // ============================================================

    /** Set capture state (available after capture init) */
    setCaptureState: null,
    /** Set editor state (available after editor init) */
    setEditorState: null,
    /** Set export state (available after export init) */
    setExportState: null,

    // ============================================================
    // Test Mode Configuration
    // ============================================================

    /** Check if test mode is enabled */
    isTestMode: () => isTestMode(),
    /** Get current test configuration */
    getTestConfig: () => getTestConfig(),
    /** Update test configuration */
    updateTestConfig: (updates) => updateTestConfig(updates),
    /** Check if mock frames are supported */
    isMockFrameSupported: () => isMockFrameSupported(),

    // ============================================================
    // Mock Frame Creation (VideoFrame-compatible)
    // ============================================================

    /**
     * Create mock frames for testing (async)
     * These frames work with canvas.drawImage() like real VideoFrames
     *
     * @param {number} count - Number of frames
     * @param {Object} options - Options (width, height, pattern, fps)
     * @returns {Promise<Frame[]>} Array of mock frames
     *
     * @example
     * const frames = await __TEST_HOOKS__.createMockFrames(30, {
     *   width: 1280, height: 720, pattern: 'numbered'
     * });
     */
    createMockFrames: async (count = 30, options = {}) => {
      const defaults = getDefaultMockOptions();
      return createMockFrames(count, { ...defaults, ...options });
    },

    /**
     * Create and inject a mock ClipPayload (Capture → Editor)
     * This is the primary method for testing Editor without Screen Capture
     *
     * @param {Object} options - Options
     * @param {number} [options.frameCount=30] - Number of frames
     * @param {15|30|60} [options.fps=30] - FPS
     * @param {number} [options.width=640] - Frame width
     * @param {number} [options.height=480] - Frame height
     * @param {'gradient'|'checkerboard'|'numbered'} [options.pattern='numbered'] - Visual pattern
     * @returns {Promise<void>}
     *
     * @example
     * await __TEST_HOOKS__.injectMockClipPayload({ frameCount: 60, fps: 30 });
     * location.hash = '#/editor';
     */
    injectMockClipPayload: async (options = {}) => {
      const defaults = getDefaultMockOptions();
      const payload = await createMockClipPayload({ ...defaults, ...options });
      setClipPayload(payload);
      console.log('[TestHooks] Injected mock ClipPayload:', payload.frames.length, 'frames');
    },

    /**
     * Create and inject a mock EditorPayload (Editor → Export)
     * Use this to test Export without going through Editor
     *
     * @param {Object} options - Options
     * @param {number} [options.frameCount=30] - Number of frames
     * @param {15|30|60} [options.fps=30] - FPS
     * @param {{ start: number, end: number }} [options.selectedRange] - Selected range
     * @param {Object} [options.cropArea=null] - Crop area
     * @returns {Promise<void>}
     *
     * @example
     * await __TEST_HOOKS__.injectMockEditorPayload({
     *   frameCount: 30,
     *   selectedRange: { start: 5, end: 20 },
     *   cropArea: { x: 100, y: 100, width: 400, height: 300, aspectRatio: 'free' }
     * });
     * location.hash = '#/export';
     */
    injectMockEditorPayload: async (options = {}) => {
      const defaults = getDefaultMockOptions();
      const editorPayload = await createMockEditorPayload({ ...defaults, ...options });

      // Also inject clip payload since export reads from both
      const clipPayload = await createMockClipPayload({ ...defaults, ...options });
      setClipPayload(clipPayload);
      setEditorPayload(editorPayload);

      console.log(
        '[TestHooks] Injected mock EditorPayload:',
        editorPayload.clip.frames.length,
        'frames',
      );
    },

    /**
     * Navigate to a route with mock data pre-injected
     * This is the easiest way to test Editor or Export
     *
     * @param {'editor' | 'export'} route - Target route
     * @param {Object} options - Mock frame options
     * @returns {Promise<void>}
     *
     * @example
     * await __TEST_HOOKS__.navigateWithMockData('editor', { frameCount: 30 });
     */
    navigateWithMockData: async (route, options = {}) => {
      if (route === 'editor') {
        await window.__TEST_HOOKS__.injectMockClipPayload(options);
        location.hash = '#/editor';
      } else if (route === 'export') {
        await window.__TEST_HOOKS__.injectMockEditorPayload(options);
        location.hash = '#/export';
      }
    },

    // ============================================================
    // Legacy API (backward compatibility)
    // ============================================================

    /**
     * @deprecated Use injectMockClipPayload instead
     */
    injectClipPayload: async (frameCount = 30, fps = 30) => {
      console.warn('[TestHooks] injectClipPayload is deprecated, use injectMockClipPayload');
      await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount, fps });
    },

    /**
     * @deprecated Use injectMockEditorPayload instead
     */
    injectEditorPayload: async (frameCount = 30, fps = 30, cropArea = null) => {
      console.warn('[TestHooks] injectEditorPayload is deprecated, use injectMockEditorPayload');
      await window.__TEST_HOOKS__.injectMockEditorPayload({ frameCount, fps, cropArea });
    },
  };

  console.log('[App] Test mode enabled. Use __TEST_HOOKS__ for E2E testing.');
}

/**
 * Route handlers map
 * @type {Record<import('./shared/router.js').Route, () => void>}
 */
const routes = {
  '/capture': initCapture,
  '/editor': initEditor,
  '/export': initExport,
  '/loading': initLoading,
  '/settings': initSettings,
};

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  // Display app version in header
  const versionElement = document.getElementById('app-version');
  if (versionElement) {
    versionElement.textContent = `v${__APP_VERSION__}`;
  }
  // Register screen capture cleanup function (dependency injection)
  // This ensures side effects are handled in capture/api.js, not app-store.js
  registerScreenCaptureCleanup(cleanupScreenCaptureResources);

  // Create live region for screen reader announcements
  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'live-region';
  liveRegion.id = 'live-region';
  document.body.appendChild(liveRegion);

  // Clip Now header button, queue badge popover and global Shift+C (#95)
  setupClipQueueHeader();

  // Persistent live-capture PiP (#94) — mounted once, reacts to route/bus
  // events on its own; must be wired before initRouter() processes the
  // initial hash so its onRouteChange listener sees that first navigation.
  initPip();

  // Initialize router
  initRouter(routes);
});

// ============================================================
// Clip Queue Header (#95)
// ============================================================

/**
 * Wire the header camera button (Clip Now), the queue count badge with its
 * compact popover, and the global Shift+C hotkey.
 *
 * Visibility rules:
 * - camera button: only while a live capture session exists (mounted or
 *   backgrounded); hides on the stream-ended terminal state
 * - badge: whenever the queue is non-empty — it stays reachable even after
 *   capture ends, and it is the ONLY queue surface below 900px where the
 *   editor's left sidebar is display:none
 */
function setupClipQueueHeader() {
  const group = document.getElementById('clip-now-group');
  const clipNowBtn = document.getElementById('clip-now-btn');
  const badge = document.getElementById('clip-queue-badge');
  if (!group || !clipNowBtn || !badge) return;

  /** @type {HTMLElement | null} */
  let popover = null;
  /** @type {HTMLElement | null} */
  let popoverList = null;
  /** @type {(() => void)[]} */
  let popoverCleanups = [];
  /** @type {(() => void)[]} */
  let popoverEntryCleanups = [];
  let lastCount = 0;

  /** Re-render popover entries from the current queue state */
  const renderPopoverEntries = () => {
    if (!popoverList) return;
    popoverEntryCleanups.forEach((fn) => {
      fn();
    });
    popoverEntryCleanups = renderClipEntries(popoverList, {
      activeClip: getClipPayload(),
      queue: getClipQueue(),
      onPromote: (id) => {
        closePopover();
        // When the editor is mounted this swaps in place; otherwise the clip
        // just becomes active and we navigate to it
        if (promoteClipFromQueue(id) && getCurrentRoute() !== '/editor') {
          navigate('/editor');
        }
      },
      onDelete: (id) => {
        if (!confirm('Delete this clip? Its frames will be discarded.')) return;
        if (deleteQueuedClip(id)) {
          announce('Clip deleted from queue');
        }
      },
    });
  };

  const closePopover = () => {
    if (!popover) return;
    popoverEntryCleanups.forEach((fn) => {
      fn();
    });
    popoverEntryCleanups = [];
    popoverCleanups.forEach((fn) => {
      fn();
    });
    popoverCleanups = [];
    popover.remove();
    popover = null;
    popoverList = null;
    badge.setAttribute('aria-expanded', 'false');
  };

  const openPopover = () => {
    if (popover) return;
    popoverList = createElement('div', { className: 'clip-queue-popover-list' });
    popover = createElement(
      'div',
      {
        className: 'clip-queue-popover',
        role: 'dialog',
        'aria-label': 'Clip queue',
        tabindex: '-1',
      },
      [createElement('div', { className: 'clip-queue-popover-title' }, ['Clips']), popoverList],
    );
    group.appendChild(popover);
    renderPopoverEntries();
    badge.setAttribute('aria-expanded', 'true');
    // role=dialog implies focus management: move focus into the popover so
    // screen readers announce the newly rendered list (Escape restores it)
    popover.focus();

    // Escape closes and returns focus to the badge (keyboard reachability)
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        closePopover();
        badge.focus();
      }
    };
    // Click outside (badge itself toggles via its own handler)
    const onPointerDown = (e) => {
      const target = /** @type {Node | null} */ (e.target);
      if (target instanceof Node && !popover?.contains(target) && target !== badge) {
        closePopover();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    popoverCleanups.push(() => document.removeEventListener('keydown', onKeyDown));
    popoverCleanups.push(() => document.removeEventListener('pointerdown', onPointerDown));
  };

  /** Sync button/badge visibility and count with capture + queue state */
  const refresh = () => {
    const live = isCaptureLive();
    const count = getClipQueue().length;

    clipNowBtn.hidden = !live;
    badge.hidden = count === 0;
    group.hidden = !live && count === 0;
    badge.textContent = String(count);

    if (count > lastCount) {
      // Restart the pulse animation on every increment
      badge.classList.remove('clip-queue-badge--pulse');
      void badge.offsetWidth;
      badge.classList.add('clip-queue-badge--pulse');
    }
    lastCount = count;

    if (popover) {
      if (count === 0 && !getClipPayload()) {
        closePopover();
      } else {
        renderPopoverEntries();
      }
    }
  };

  clipNowBtn.addEventListener('click', () => {
    void clipNow();
  });

  badge.addEventListener('click', () => {
    if (popover) {
      closePopover();
    } else {
      openPopover();
    }
  });

  // Global hotkey — guards (form focus, no live capture) live in clip-service
  document.addEventListener('keydown', handleClipNowHotkey);

  onBus('queue:changed', refresh);
  onBus('capture:started', refresh);
  onBus('capture:restored', refresh);
  onBus('capture:stopped', () => {
    // Terminal state (amendment 5): stream ended, possibly while away from
    // /capture — hide the camera button and clear the pulsing live dot that
    // only per-screen renders would otherwise refresh.
    refresh();
    document.querySelectorAll('.step--live').forEach((el) => {
      el.classList.remove('step--live');
    });
  });
  onBus('clip:queue-full', () => {
    // Shake the badge so the refusal is visible even when the Clips section
    // banner is off-screen
    badge.classList.remove('clip-queue-badge--shake');
    void badge.offsetWidth;
    badge.classList.add('clip-queue-badge--shake');
  });

  // The live session's location (mounted vs stashed) changes on navigation
  onRouteChange(() => {
    closePopover();
    refresh();
  });

  refresh();
}

/**
 * Announce message to screen readers
 * @param {string} message - Message to announce
 */
export { announce };
