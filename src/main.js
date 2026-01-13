/**
 * Application Entry Point
 * @module main
 */

import { initRouter } from './shared/router.js';
import { initCapture } from './features/capture/index.js';
import { initEditor } from './features/editor/index.js';
import { initExport } from './features/export/index.js';
import { initLoading } from './features/loading/index.js';
import {
  setClipPayload,
  setEditorPayload,
  resetAppStore,
  registerScreenCaptureCleanup,
} from './shared/app-store.js';
import { cleanupScreenCaptureResources } from './features/capture/api.js';

// Test environment detection
// Enable test hooks in development mode or when Playwright is detected
const IS_PLAYWRIGHT_TEST =
  typeof window !== 'undefined' &&
  (import.meta.env?.DEV || window.navigator?.webdriver || window.__PLAYWRIGHT_TEST__);

if (IS_PLAYWRIGHT_TEST) {
  window.__PLAYWRIGHT_TEST__ = true;

  /**
   * Test hooks for E2E testing - allows state injection
   * Only available in Playwright test environment
   */
  window.__TEST_HOOKS__ = {
    // App store management
    setClipPayload,
    setEditorPayload,
    resetAppStore,

    // Feature state setters (populated by each feature)
    setCaptureState: null,
    setEditorState: null,
    setExportState: null,

    // Helper to create mock frames for injection
    createMockFrames: (count = 30, fps = 30) => {
      const width = 640;
      const height = 480;
      return Array.from({ length: count }, (_, i) => ({
        id: `mock-frame-${i}`,
        data: createMockImageDataForTest(width, height),
        timestamp: (i / fps) * 1000,
        width,
        height,
      }));
    },

    // Helper to inject clip payload with mock frames
    injectClipPayload: (frameCount = 30, fps = 30) => {
      const frames = window.__TEST_HOOKS__.createMockFrames(frameCount, fps);
      setClipPayload({ frames, fps, capturedAt: Date.now() });
    },

    // Helper to inject editor payload with mock frames
    injectEditorPayload: (frameCount = 30, fps = 30, cropArea = null) => {
      const frames = window.__TEST_HOOKS__.createMockFrames(frameCount, fps);
      setEditorPayload({
        frames,
        cropArea,
        clip: { frames, fps, duration: frameCount / fps, createdAt: Date.now() },
        fps,
      });
    },
  };

  /**
   * Create mock ImageData for test injection
   * Uses real ImageData constructor for canvas compatibility
   * @param {number} width
   * @param {number} height
   * @returns {ImageData}
   */
  function createMockImageDataForTest(width, height) {
    // Create real ImageData object for canvas compatibility
    const imageData = new ImageData(width, height);
    const data = imageData.data;

    // Fill with gradient pattern
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = Math.floor((x / width) * 255);     // R: horizontal gradient
        data[i + 1] = Math.floor((y / height) * 255); // G: vertical gradient
        data[i + 2] = 128;                            // B: constant
        data[i + 3] = 255;                            // A: opaque
      }
    }

    return imageData;
  }
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
