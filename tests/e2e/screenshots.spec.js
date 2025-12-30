/**
 * UI/UX Screenshot Tests for Visual Regression
 * @module tests/e2e/screenshots.spec
 *
 * Captures screenshots of all screen states for:
 * 1. Visual regression testing (detects UI changes)
 * 2. UI/UX review with frontend-design analysis
 */

import { test, expect } from '@playwright/test';

const ANIMATION_SETTLE_MS = 500;

/**
 * Wait for UI to stabilize after navigation or state change
 * @param {import('@playwright/test').Page} page
 */
async function waitForStableUI(page) {
  await page.waitForTimeout(ANIMATION_SETTLE_MS);
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ============================================================
// Capture Screen Tests
// ============================================================

test.describe('Capture Screen Screenshots', () => {
  test('capture-initial: empty preview state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Verify key elements
    await expect(page.locator('.preview-empty')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: /Start Capture/i })).toBeEnabled();

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('capture-initial.png', {
      fullPage: true,
    });
  });

  test('capture-buffered: frames captured state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject buffered state via test hooks
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setCaptureState) {
        window.__TEST_HOOKS__.setCaptureState({
          stats: {
            frameCount: 90,
            duration: 3.0,
            memoryMB: 12.5,
            fps: 30,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('capture-buffered.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// Editor Screen Tests
// ============================================================

test.describe('Editor Screen Screenshots', () => {
  test('editor-empty: no frames loaded state', async ({ page }) => {
    // Navigate without clip payload
    await page.goto('/#/editor');
    await page.waitForSelector('.editor-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Should show empty state with back button
    await expect(page.locator('.editor-empty')).toBeVisible();

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('editor-empty.png', {
      fullPage: true,
    });
  });

  test('editor-initial: frames loaded state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Inject clip payload and navigate
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(30, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('editor-initial.png', {
      fullPage: true,
    });
  });

  test('editor-crop: crop mode active state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Inject clip payload and navigate
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(30, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // Set crop area via test hooks
    await page.evaluate(() => {
      window.__TEST_HOOKS__?.setEditorState({
        cropArea: {
          x: 100,
          y: 80,
          width: 440,
          height: 248,
          aspectRatio: '16:9',
        },
      });
    });

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('editor-crop.png', {
      fullPage: true,
    });
  });

  test('editor-selection: custom range selected state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Inject clip payload and navigate
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(60, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // Set custom selection range
    await page.evaluate(() => {
      window.__TEST_HOOKS__?.setEditorState({
        selectedRange: { start: 10, end: 45 },
        currentFrame: 20,
      });
    });

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('editor-selection.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// Export Screen Tests
// ============================================================

test.describe('Export Screen Screenshots', () => {
  test('export-settings: settings panel visible state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject editor payload for export
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Should show settings panel
    await expect(page.locator('.export-settings-panel, .settings-panel')).toBeVisible();

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('export-settings.png', {
      fullPage: true,
    });
  });

  test('export-encoding: encoding in progress state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject editor payload
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });

    // Set encoding job state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          job: {
            id: 'test-job',
            status: 'encoding',
            progress: 65,
            currentFrame: 20,
            totalFrames: 30,
            encoder: 'wasm',
            startedAt: Date.now() - 5000,
            result: null,
            error: null,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('export-encoding.png', {
      fullPage: true,
    });
  });

  test('export-complete: encoding finished state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject editor payload
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });

    // Set complete state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          job: {
            id: 'test-job',
            status: 'complete',
            progress: 100,
            currentFrame: 30,
            totalFrames: 30,
            encoder: 'wasm',
            startedAt: Date.now() - 10000,
            completedAt: Date.now(),
            result: new Blob(['mock-gif-data'], { type: 'image/gif' }),
            error: null,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('export-complete.png', {
      fullPage: true,
    });
  });

  test('export-error: encoding failed state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject editor payload
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });

    // Set error state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          job: {
            id: 'test-job',
            status: 'error',
            progress: 45,
            currentFrame: 14,
            totalFrames: 30,
            encoder: 'js',
            startedAt: Date.now() - 8000,
            result: null,
            error: 'WASM module failed to load: memory allocation error',
          },
        });
      }
    });

    await waitForStableUI(page);

    // Take visual regression snapshot
    await expect(page).toHaveScreenshot('export-error.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// Full Flow Screenshots (Optional - for documentation)
// ============================================================

test.describe('Application Flow Screenshots', () => {
  test('full-flow: all screens in sequence', async ({ page }) => {
    // This test captures all screens in a single flow for documentation

    // 1. Capture initial
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('flow-1-capture.png', { fullPage: true });

    // 2. Inject frames and go to editor
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(30, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('flow-2-editor.png', { fullPage: true });

    // 3. Set editor payload and go to export
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      window.location.hash = '/export';
    });

    await page.waitForSelector('.export-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('flow-3-export.png', { fullPage: true });
  });
});
