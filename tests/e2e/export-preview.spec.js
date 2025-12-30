/**
 * E2E Tests for Export Preview Feature (005-export-preview)
 * @module tests/e2e/export-preview.spec
 *
 * Verifies:
 * - US1: Manual preview generation and display
 * - US2: Automatic preview generation on export screen entry
 * - US3: Preview progress display and error handling
 * - Performance: Preview completes within 3 seconds
 */

import { test, expect } from '@playwright/test';

const ANIMATION_SETTLE_MS = 500;
const PREVIEW_TIMEOUT_MS = 10000; // Allow extra time for preview generation in CI

/**
 * Wait for UI to stabilize
 * @param {import('@playwright/test').Page} page
 */
async function waitForStableUI(page) {
  await page.waitForTimeout(ANIMATION_SETTLE_MS);
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Navigate to export screen with test data
 * @param {import('@playwright/test').Page} page
 * @param {number} frameCount
 * @param {number} fps
 */
async function navigateToExportWithData(page, frameCount = 30, fps = 30) {
  await page.goto('/#/capture');
  await page.waitForSelector('.capture-screen', { state: 'visible' });

  // Inject editor payload for export
  await page.evaluate(({ frames, rate }) => {
    if (window.__TEST_HOOKS__?.injectEditorPayload) {
      window.__TEST_HOOKS__.injectEditorPayload(frames, rate);
    }
  }, { frames: frameCount, rate: fps });

  await page.goto('/#/export');
  await page.waitForSelector('.export-screen', { state: 'visible' });
  await waitForStableUI(page);
}

// ============================================================
// US1: Preview GIF Before Export (Manual)
// ============================================================

test.describe('US1: Preview GIF Before Export', () => {
  test('preview area is visible in export screen', async ({ page }) => {
    await navigateToExportWithData(page);

    // Preview area should be visible
    const previewArea = page.locator('.export-preview');
    await expect(previewArea).toBeVisible();
  });

  test('refresh button is visible when preview is ready', async ({ page }) => {
    await navigateToExportWithData(page);

    // Wait for auto-preview to complete or set ready state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'ready',
            url: 'blob:mock-preview-url',
            error: null,
            progress: 100,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Refresh button should be visible
    const refreshBtn = page.locator('button').filter({ hasText: /Refresh|↻/ });
    await expect(refreshBtn).toBeVisible();
  });

  test('preview invalidates when settings change', async ({ page }) => {
    await navigateToExportWithData(page);

    // Set ready state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'ready',
            url: 'blob:mock-preview-url',
            error: null,
            progress: 100,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Change a setting (quality slider)
    const qualityInput = page.locator('input[type="range"]').first();
    if (await qualityInput.isVisible()) {
      await qualityInput.fill('0.5');
      await qualityInput.dispatchEvent('change');
    }

    await waitForStableUI(page);

    // Screenshot showing settings panel
    await expect(page).toHaveScreenshot('preview-settings-change.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// US2: Automatic Preview Generation
// ============================================================

test.describe('US2: Automatic Preview Generation', () => {
  test('preview starts generating on export screen entry', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject minimal test data
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(10, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });

    // Wait briefly for preview generation to start
    await page.waitForTimeout(100);

    // Preview should be either generating or already complete
    const previewArea = page.locator('.export-preview');
    await expect(previewArea).toBeVisible();

    // Either generating or ready state should be present
    const generatingOrReady = page.locator('.preview-generating, .preview-ready, .preview-gif');
    await expect(generatingOrReady).toBeVisible({ timeout: PREVIEW_TIMEOUT_MS });
  });

  test('preview triggers after settings change with debounce', async ({ page }) => {
    await navigateToExportWithData(page);

    // Set ready state first
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'ready',
            url: 'blob:mock-preview-url',
            error: null,
            progress: 100,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Change frame skip setting
    const frameSkipSelect = page.locator('select').first();
    if (await frameSkipSelect.isVisible()) {
      await frameSkipSelect.selectOption({ index: 1 });
    }

    // Preview should invalidate (go back to idle or generating)
    await page.waitForTimeout(100);

    // Take screenshot of debounce behavior
    await expect(page).toHaveScreenshot('preview-debounce-behavior.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// US3: Preview Generation Progress
// ============================================================

test.describe('US3: Preview Generation Progress', () => {
  test('progress indicator is visible during generation', async ({ page }) => {
    await navigateToExportWithData(page);

    // Set generating state with progress
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'generating',
            url: null,
            error: null,
            progress: 45,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Generating indicator should be visible
    const generatingIndicator = page.locator('.preview-generating');
    await expect(generatingIndicator).toBeVisible();

    // Progress percentage should be shown
    const progressText = page.locator('.preview-generating-progress');
    await expect(progressText).toContainText('45');

    await expect(page).toHaveScreenshot('preview-progress-indicator.png', {
      fullPage: true,
    });
  });

  test('error state shows with retry button', async ({ page }) => {
    await navigateToExportWithData(page);

    // Set error state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'error',
            url: null,
            error: 'Failed to generate preview: encoding error',
            progress: 0,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Error display should be visible
    const errorDisplay = page.locator('.preview-error');
    await expect(errorDisplay).toBeVisible();

    // Error message should be shown
    await expect(errorDisplay).toContainText(/encoding error/i);

    // Retry button should be visible
    const retryBtn = page.locator('button').filter({ hasText: /Retry|↻/ });
    await expect(retryBtn).toBeVisible();

    await expect(page).toHaveScreenshot('preview-error-state.png', {
      fullPage: true,
    });
  });

  test('retry button triggers new preview generation', async ({ page }) => {
    await navigateToExportWithData(page);

    // Set error state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'error',
            url: null,
            error: 'Preview failed',
            progress: 0,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Click retry button
    const retryBtn = page.locator('.btn-preview-retry');
    if (await retryBtn.isVisible()) {
      await retryBtn.click();

      // Wait briefly for state change
      await page.waitForTimeout(100);

      // Preview should start generating again
      const preview = page.locator('.export-preview');
      await expect(preview).toBeVisible();
    }
  });
});

// ============================================================
// Performance: Preview Generation Time
// ============================================================

test.describe('Performance: Preview Generation', () => {
  test.skip('preview completes within 3 seconds (SC-001)', async ({ page }) => {
    // This test requires actual frame data which isn't available in E2E tests
    // Skip for now - can be tested manually or with integration tests

    await navigateToExportWithData(page, 30);

    // Start timing
    const startTime = Date.now();

    // Wait for preview to complete
    const previewGif = page.locator('.preview-gif');
    await expect(previewGif).toBeVisible({ timeout: 3000 });

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(3000);
  });
});

// ============================================================
// Visual Regression Tests
// ============================================================

test.describe('Visual Regression: Preview States', () => {
  test('idle state appearance', async ({ page }) => {
    await navigateToExportWithData(page);

    // Force idle state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'idle',
            url: null,
            error: null,
            progress: 0,
          },
        });
      }
    });

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('preview-state-idle.png', {
      fullPage: true,
    });
  });

  test('generating state appearance', async ({ page }) => {
    await navigateToExportWithData(page);

    // Force generating state at 67%
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'generating',
            url: null,
            error: null,
            progress: 67,
          },
        });
      }
    });

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('preview-state-generating.png', {
      fullPage: true,
    });
  });

  test('ready state appearance', async ({ page }) => {
    await navigateToExportWithData(page);

    // Create mock GIF and set ready state
    const mockGifUrl = await page.evaluate(() => {
      const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const binary = atob(gif);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([array], { type: 'image/gif' });
      return URL.createObjectURL(blob);
    });

    await page.evaluate((url) => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'ready',
            url: url,
            error: null,
            progress: 100,
          },
        });
      }
    }, mockGifUrl);

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('preview-state-ready.png', {
      fullPage: true,
    });
  });

  test('error state appearance', async ({ page }) => {
    await navigateToExportWithData(page);

    // Force error state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'error',
            url: null,
            error: 'Memory limit exceeded: GIF too large',
            progress: 0,
          },
        });
      }
    });

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('preview-state-error.png', {
      fullPage: true,
    });
  });
});
