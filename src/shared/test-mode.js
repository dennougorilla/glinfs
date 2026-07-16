/**
 * Test Mode Configuration and Utilities
 * @module shared/test-mode
 *
 * Provides test mode detection and configuration for E2E testing.
 * Allows AI agents and automated tests to bypass Screen Capture API.
 *
 * Test mode is enabled when:
 * 1. URL has ?testMode=true parameter
 * 2. window.__PLAYWRIGHT_TEST__ is set
 * 3. navigator.webdriver is true (Selenium/Puppeteer)
 * 4. Running in development mode (import.meta.env.DEV)
 *
 * Usage:
 * ```javascript
 * // In Playwright
 * await page.goto('http://localhost:5173/?testMode=true#/editor');
 *
 * // Or inject mock data before navigation
 * await page.evaluate(async () => {
 *   await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 30 });
 * });
 * await page.goto('#/editor');
 * ```
 */

/**
 * @typedef {Object} TestModeConfig
 * @property {boolean} enabled - Whether test mode is active
 * @property {boolean} mockFramesEnabled - Auto-inject mock frames when navigating
 * @property {number} defaultFrameCount - Default number of mock frames
 * @property {15 | 30 | 60} defaultFps - Default FPS for mock clips
 * @property {number} defaultWidth - Default frame width
 * @property {number} defaultHeight - Default frame height
 * @property {'gradient' | 'checkerboard' | 'numbered'} defaultPattern - Default visual pattern
 */

/** @type {TestModeConfig} */
let config = {
  enabled: false,
  mockFramesEnabled: true,
  defaultFrameCount: 30,
  defaultFps: 30,
  defaultWidth: 640,
  defaultHeight: 480,
  defaultPattern: 'numbered',
};

/** @type {boolean} */
let initialized = false;

/**
 * Detect if test mode should be enabled based on environment
 *
 * @returns {boolean} True if test mode should be enabled
 */
function detectTestMode() {
  if (typeof window === 'undefined') return false;

  // Check URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('testMode') === 'true') {
    return true;
  }

  // Check Playwright flag
  if (window.__PLAYWRIGHT_TEST__) {
    return true;
  }

  // Check WebDriver (Selenium/Puppeteer)
  if (navigator.webdriver) {
    return true;
  }

  // Check development mode
  if (import.meta.env?.DEV) {
    return true;
  }

  return false;
}

/**
 * Parse test configuration from URL parameters
 *
 * Supported parameters:
 * - testMode=true - Enable test mode
 * - mockFrames=30 - Number of mock frames to inject
 * - mockFps=30 - FPS for mock clips
 * - mockWidth=640 - Frame width
 * - mockHeight=480 - Frame height
 * - mockPattern=numbered - Visual pattern (gradient|checkerboard|numbered)
 *
 * @returns {Partial<TestModeConfig>} Configuration from URL
 */
function parseUrlConfig() {
  if (typeof window === 'undefined') return {};

  const urlParams = new URLSearchParams(window.location.search);
  /** @type {Partial<TestModeConfig>} */
  const urlConfig = {};

  const mockFrames = urlParams.get('mockFrames');
  if (mockFrames) {
    const count = parseInt(mockFrames, 10);
    if (!isNaN(count) && count > 0 && count <= 300) {
      urlConfig.defaultFrameCount = count;
    }
  }

  const mockFps = urlParams.get('mockFps');
  if (mockFps) {
    const fps = parseInt(mockFps, 10);
    if (fps === 15 || fps === 30 || fps === 60) {
      urlConfig.defaultFps = fps;
    }
  }

  const mockWidth = urlParams.get('mockWidth');
  if (mockWidth) {
    const width = parseInt(mockWidth, 10);
    if (!isNaN(width) && width >= 100 && width <= 3840) {
      urlConfig.defaultWidth = width;
    }
  }

  const mockHeight = urlParams.get('mockHeight');
  if (mockHeight) {
    const height = parseInt(mockHeight, 10);
    if (!isNaN(height) && height >= 100 && height <= 2160) {
      urlConfig.defaultHeight = height;
    }
  }

  const mockPattern = urlParams.get('mockPattern');
  if (mockPattern === 'gradient' || mockPattern === 'checkerboard' || mockPattern === 'numbered') {
    urlConfig.defaultPattern = mockPattern;
  }

  const autoMock = urlParams.get('autoMock');
  if (autoMock === 'false') {
    urlConfig.mockFramesEnabled = false;
  }

  return urlConfig;
}

/**
 * Initialize test mode configuration
 * Should be called once at application startup
 */
export function initTestMode() {
  if (initialized) return;

  const isTestMode = detectTestMode();
  const urlConfig = parseUrlConfig();

  config = {
    ...config,
    ...urlConfig,
    enabled: isTestMode,
  };

  initialized = true;

  if (config.enabled) {
    console.log('[TestMode] Enabled with config:', config);
  }
}

/**
 * Check if test mode is enabled
 *
 * @returns {boolean} True if test mode is active
 */
export function isTestMode() {
  if (!initialized) {
    initTestMode();
  }
  return config.enabled;
}

/**
 * Get current test mode configuration
 *
 * @returns {TestModeConfig} Current configuration
 */
export function getTestConfig() {
  if (!initialized) {
    initTestMode();
  }
  return { ...config };
}

/**
 * Update test mode configuration at runtime
 *
 * @param {Partial<TestModeConfig>} updates - Configuration updates
 */
export function updateTestConfig(updates) {
  config = { ...config, ...updates };
}

/**
 * Check if mock frames should be auto-injected for a route
 *
 * @param {string} route - Route path (e.g., '/editor', '/export')
 * @returns {boolean} True if mock frames should be injected
 */
export function shouldAutoInjectMockFrames(route) {
  if (!config.enabled || !config.mockFramesEnabled) {
    return false;
  }

  // Only inject for routes that need frames
  return route === '/editor' || route === '/export';
}

/**
 * Get default mock frame options from config
 *
 * @returns {Object} Mock frame options
 */
export function getDefaultMockOptions() {
  return {
    frameCount: config.defaultFrameCount,
    fps: config.defaultFps,
    width: config.defaultWidth,
    height: config.defaultHeight,
    pattern: config.defaultPattern,
  };
}
