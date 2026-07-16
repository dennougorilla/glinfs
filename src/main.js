/**
 * Application Entry Point
 * @module main
 */

import { initRouter } from './shared/router.js';
import { initCapture } from './features/capture/index.js';
import { initEditor } from './features/editor/index.js';
import { initExport } from './features/export/index.js';
import { initLoading } from './features/loading/index.js';
import { initSettings } from './features/settings/index.js';
import {
  setClipPayload,
  setEditorPayload,
  getClipPayload,
  getEditorPayload,
  resetAppStore,
  registerScreenCaptureCleanup,
} from './shared/app-store.js';
import { cleanupScreenCaptureResources } from './features/capture/api.js';
import { initTestMode, isTestMode, getTestConfig, updateTestConfig, getDefaultMockOptions } from './shared/test-mode.js';
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

      console.log('[TestHooks] Injected mock EditorPayload:', editorPayload.clip.frames.length, 'frames');
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

  // Initialize router
  initRouter(routes);
});

/**
 * Announce message to screen readers
 * @param {string} message - Message to announce
 */
export function announce(message) {
  const liveRegion = document.getElementById('live-region');
  if (liveRegion) {
    liveRegion.textContent = message;
  }
}
