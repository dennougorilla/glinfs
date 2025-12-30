/**
 * Screenshot utilities for E2E tests
 * @module tests/e2e/helpers/screenshot-utils
 */

const ANIMATION_SETTLE_MS = 300;

/**
 * Wait for UI to stabilize (animations complete)
 * @param {import('@playwright/test').Page} page
 * @param {number} [ms=300] - Time to wait in milliseconds
 */
export async function waitForStableUI(page, ms = ANIMATION_SETTLE_MS) {
  // Wait for any pending animations
  await page.waitForTimeout(ms);

  // Optionally wait for network idle
  await page.waitForLoadState('networkidle').catch(() => {
    // Ignore timeout, proceed anyway
  });
}

/**
 * Capture a screenshot with standardized naming
 * @param {import('@playwright/test').Page} page
 * @param {string} screen - Screen name (capture, editor, export)
 * @param {string} state - State name (initial, recording, etc.)
 * @param {Object} [options]
 * @param {boolean} [options.fullPage=true] - Capture full page
 * @param {boolean} [options.waitForAnimations=true] - Wait for animations
 * @returns {Promise<Buffer>} Screenshot buffer
 */
export async function captureScreenshot(page, screen, state, options = {}) {
  const { fullPage = true, waitForAnimations = true } = options;

  if (waitForAnimations) {
    await waitForStableUI(page);
  }

  const name = `${screen}-${state}`;

  return page.screenshot({
    fullPage,
    animations: 'disabled',
    path: `screenshots/${name}.png`,
  });
}

/**
 * Take a snapshot for visual regression testing
 * Uses Playwright's built-in snapshot comparison
 * @param {import('@playwright/test').Page} page
 * @param {string} screen - Screen name
 * @param {string} state - State name
 * @param {import('@playwright/test').TestInfo} testInfo - Test info for snapshot naming
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
export async function takeSnapshot(page, screen, state, testInfo, options = {}) {
  const { waitForAnimations = true } = options;

  if (waitForAnimations) {
    await waitForStableUI(page);
  }

  const name = `${screen}-${state}`;

  // Use Playwright's expect for visual comparison
  const { expect } = await import('@playwright/test');
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixels: 100,
    threshold: 0.2,
  });
}

/**
 * Navigate to a screen and wait for it to load
 * @param {import('@playwright/test').Page} page
 * @param {'capture'|'editor'|'export'} screen
 */
export async function navigateToScreen(page, screen) {
  await page.goto(`/#/${screen}`);
  await page.waitForSelector(`.${screen}-screen`, { state: 'visible' });
  await waitForStableUI(page);
}

/**
 * Setup capture screen state via window injection
 * @param {import('@playwright/test').Page} page
 * @param {Object} stateOverrides
 */
export async function setupCaptureState(page, stateOverrides) {
  await page.evaluate((overrides) => {
    if (window.__TEST_HOOKS__?.setCaptureState) {
      window.__TEST_HOOKS__.setCaptureState(overrides);
    }
  }, stateOverrides);
}

/**
 * Inject ClipPayload for editor screen testing
 * @param {import('@playwright/test').Page} page
 * @param {Object} clipPayload
 */
export async function injectClipPayload(page, clipPayload) {
  await page.evaluate((payload) => {
    if (window.__TEST_HOOKS__?.setClipPayload) {
      window.__TEST_HOOKS__.setClipPayload(payload);
    }
  }, clipPayload);
}

/**
 * Setup editor screen state
 * @param {import('@playwright/test').Page} page
 * @param {Object} stateOverrides
 */
export async function setupEditorState(page, stateOverrides) {
  await page.evaluate((overrides) => {
    if (window.__TEST_HOOKS__?.setEditorState) {
      window.__TEST_HOOKS__.setEditorState(overrides);
    }
  }, stateOverrides);
}

/**
 * Inject EditorPayload for export screen testing
 * @param {import('@playwright/test').Page} page
 * @param {Object} editorPayload
 */
export async function injectEditorPayload(page, editorPayload) {
  await page.evaluate((payload) => {
    if (window.__TEST_HOOKS__?.setEditorPayload) {
      window.__TEST_HOOKS__.setEditorPayload(payload);
    }
  }, editorPayload);
}

/**
 * Setup export screen state (job status, progress)
 * @param {import('@playwright/test').Page} page
 * @param {Object} stateOverrides
 */
export async function setupExportState(page, stateOverrides) {
  await page.evaluate((overrides) => {
    if (window.__TEST_HOOKS__?.setExportState) {
      window.__TEST_HOOKS__.setExportState(overrides);
    }
  }, stateOverrides);
}

/**
 * Get all screen states configuration for comprehensive screenshot capture
 * @returns {Array<{screen: string, state: string, setup: Function}>}
 */
export function getAllScreenStates() {
  return [
    // Capture screen states
    { screen: 'capture', state: 'initial', requiresSetup: false },
    { screen: 'capture', state: 'buffered', requiresSetup: true },

    // Editor screen states
    { screen: 'editor', state: 'empty', requiresSetup: false },
    { screen: 'editor', state: 'initial', requiresSetup: true },
    { screen: 'editor', state: 'crop', requiresSetup: true },
    { screen: 'editor', state: 'selection', requiresSetup: true },

    // Export screen states
    { screen: 'export', state: 'settings', requiresSetup: true },
    { screen: 'export', state: 'encoding', requiresSetup: true },
    { screen: 'export', state: 'complete', requiresSetup: true },
    { screen: 'export', state: 'error', requiresSetup: true },
  ];
}
