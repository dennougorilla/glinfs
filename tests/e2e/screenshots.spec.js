/**
 * Main screen state tests
 * @module tests/e2e/screenshots.spec
 *
 * Drives each main screen into a key state (via test hooks) and asserts the
 * UI that state should render. The visual-regression screenshot comparisons
 * that used to live here were dropped in #131: their baselines were never
 * committed, so nothing ever checked them.
 *
 * Rewritten for #48:
 * - editor-empty was removed: the empty state it asserted is dead code; the
 *   app renders an "Invalid Clip Data" error screen instead.
 * - export encoding/complete/error state-injection tests were removed:
 *   setExportState does not trigger a re-render, so they captured the idle
 *   screen. The real encode flow is covered in export-preview.spec.js.
 */

import { expect, test } from '@playwright/test';
import {
  gotoCapture,
  gotoEditorWithClip,
  gotoExportWithClip,
  pauseEditorPlayback,
} from './helpers/app.js';

// ============================================================
// Capture Screen Tests
// ============================================================

test.describe('Capture Screen States', () => {
  test('capture-initial: empty preview state', async ({ page }) => {
    await gotoCapture(page);

    // Verify key elements
    await expect(page.locator('.preview-empty')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: /Select Screen/i })).toBeEnabled();
  });

  test('capture-buffered: frames captured state', async ({ page }) => {
    await gotoCapture(page);

    // Inject buffered state via test hooks
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setCaptureState({
        stats: { frameCount: 90, duration: 3.0, memoryMB: 12.5, fps: 30 },
      });
    });

    await expect(page.locator('.capture-stats .stat-value').first()).toHaveText('90');
  });
});

// ============================================================
// Editor Screen Tests
// ============================================================

test.describe('Editor Screen States', () => {
  test('editor-initial: frames loaded state', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30, fps: 30 });
    await pauseEditorPlayback(page);

    await expect(page.locator('.editor-canvas')).toBeVisible();
    await expect(page.locator('.playback-controls')).toBeVisible();
  });

  test('editor-crop: crop mode active state', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30, fps: 30 });
    await pauseEditorPlayback(page);

    // Set crop area via test hooks
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({
        cropArea: { x: 100, y: 80, width: 440, height: 248, aspectRatio: '16:9' },
      });
    });

    // Crop info panel reflects the injected crop and Clear Crop appears
    await expect(page.locator('.btn-clear-crop')).toBeVisible();
    await expect(page.locator('.crop-info-value').first()).toHaveText('100');
  });

  test('editor-selection: custom range selected state', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 60, fps: 30 });
    await pauseEditorPlayback(page);

    // Set custom selection range
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({
        selectedRange: { start: 10, end: 45 },
        currentFrame: 20,
      });
    });

    await expect(page.locator('.timeline-sel-frames')).toHaveText('(36 frames)');
  });
});

// ============================================================
// Export Screen Tests
// ============================================================

test.describe('Export Screen States', () => {
  test('export-settings: settings panel visible state', async ({ page }) => {
    await gotoExportWithClip(page, { frameCount: 30, fps: 30 });

    await expect(page.locator('.export-settings-panel')).toBeVisible();
    await expect(page.locator('.btn-export-main')).toBeEnabled();
  });
});
