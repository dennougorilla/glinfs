/**
 * Shared E2E navigation helpers
 * @module tests/e2e/helpers/app
 *
 * All helpers follow the reliable "awaited injection -> same-document hash
 * navigation" pattern (#48). A full `page.goto('/#/editor')` reload would wipe
 * payloads injected via __TEST_HOOKS__, so navigation after injection must be
 * done by assigning `location.hash` instead.
 */

import { expect } from '@playwright/test';

/**
 * Navigate to the capture screen (full page load, enables test mode hooks)
 * @param {import('@playwright/test').Page} page
 */
export async function gotoCapture(page) {
  await page.goto('/#/capture');
  await page.waitForSelector('.capture-screen', { state: 'visible' });
}

/**
 * Load the editor with an injected mock clip
 * @param {import('@playwright/test').Page} page
 * @param {{ frameCount?: number, fps?: number, width?: number, height?: number }} [options]
 */
export async function gotoEditorWithClip(page, options = {}) {
  await gotoCapture(page);

  await page.evaluate(async (opts) => {
    await window.__TEST_HOOKS__.injectMockClipPayload(opts);
  }, options);

  await page.evaluate(() => {
    location.hash = '#/editor';
  });

  // `.editor-screen` alone is ambiguous (the "Invalid Clip Data" error screen
  // uses it too); the canvas only exists when a clip actually loaded.
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
}

/**
 * Pause the editor's auto-playback via the play/pause button.
 *
 * The editor starts playing on entry, which mutates state every frame tick.
 * Editor state updates flow through a throttled subscription that only keeps
 * the latest (state, prevState) pair, so background playback churn can
 * swallow one-shot transitions (e.g. crop cleared) and make UI assertions
 * racy. Pause first when a test asserts on state-driven UI updates.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function pauseEditorPlayback(page) {
  const playBtn = page.locator('.btn-play');
  if ((await playBtn.getAttribute('aria-label')) === 'Pause') {
    await playBtn.click();
  }
  await expect(playBtn).toHaveAttribute('aria-label', 'Play');
}

/**
 * Pause the export screen's auto-playing canvas preview. The preview
 * playback timer keeps redrawing the canvas, so visual snapshots taken
 * without pausing can never converge.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function pauseExportPreview(page) {
  const playBtn = page.locator('.export-preview-play-btn');
  // initExport auto-starts playback; wait for the initial render to reflect
  // that before toggling, otherwise the click races the autostart.
  await expect(playBtn).toHaveClass(/playing/);
  await playBtn.click();
  // The click stops the RAF loop, but the button's label/icon never
  // re-renders after toggling (app bug, see issue #62), so the paused
  // state cannot be asserted via the DOM. Give the last RAF pass a beat.
  await page.waitForTimeout(100);
}

/**
 * Load the export screen with an injected mock editor payload
 * @param {import('@playwright/test').Page} page
 * @param {{ frameCount?: number, fps?: number, selectedRange?: { start: number, end: number }, cropArea?: object | null }} [options]
 */
export async function gotoExportWithClip(page, options = {}) {
  await gotoCapture(page);

  await page.evaluate(async (opts) => {
    await window.__TEST_HOOKS__.injectMockEditorPayload(opts);
  }, options);

  await page.evaluate(() => {
    location.hash = '#/export';
  });

  // `.export-screen` alone is ambiguous (the "No clip data available" error
  // screen uses it too); the canvas only exists when a payload actually loaded.
  await page.waitForSelector('.export-canvas', { state: 'visible' });
}
