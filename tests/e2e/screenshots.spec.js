/**
 * UI/UX Screenshot Tests for Visual Regression
 * @module tests/e2e/screenshots.spec
 *
 * Captures screenshots of the main screen states. Each test also asserts the
 * key UI elements so the suite stays meaningful when snapshots are ignored
 * (CI runs with --ignore-snapshots because baselines are gitignored).
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
  pauseExportPreview,
} from './helpers/app.js';

// ============================================================
// Capture Screen Tests
// ============================================================

test.describe('Capture Screen Screenshots', () => {
  test('capture-initial: empty preview state', async ({ page }) => {
    await gotoCapture(page);

    // Verify key elements
    await expect(page.locator('.preview-empty')).toBeVisible();
    await expect(page.locator('button').filter({ hasText: /Select Screen/i })).toBeEnabled();

    await expect(page).toHaveScreenshot('capture-initial.png', {
      fullPage: true,
    });
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

    await expect(page).toHaveScreenshot('capture-buffered.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// Editor Screen Tests
// ============================================================

test.describe('Editor Screen Screenshots', () => {
  test('editor-initial: frames loaded state', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30, fps: 30 });
    await pauseEditorPlayback(page);

    await expect(page.locator('.editor-canvas')).toBeVisible();
    await expect(page.locator('.playback-controls')).toBeVisible();

    await expect(page).toHaveScreenshot('editor-initial.png', {
      fullPage: true,
    });
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

    await expect(page).toHaveScreenshot('editor-crop.png', {
      fullPage: true,
    });
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
    // Single-frame clip: the preview canvas shows frame 0 no matter when
    // playback is paused, keeping the snapshot deterministic.
    await gotoExportWithClip(page, { frameCount: 1, fps: 30 });
    await pauseExportPreview(page);

    await expect(page.locator('.export-settings-panel')).toBeVisible();
    await expect(page.locator('.btn-export-main')).toBeEnabled();

    await expect(page).toHaveScreenshot('export-settings.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// Full Flow Screenshots (for documentation)
// ============================================================

test.describe('Application Flow Screenshots', () => {
  test('full-flow: all screens in sequence', async ({ page }) => {
    // 1. Capture initial
    await gotoCapture(page);
    await expect(page).toHaveScreenshot('flow-1-capture.png', { fullPage: true });

    // 2. Inject frames and go to editor
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 30, fps: 30 });
      location.hash = '#/editor';
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await pauseEditorPlayback(page);
    await expect(page).toHaveScreenshot('flow-2-editor.png', { fullPage: true });

    // 3. Set editor payload and go to export (single frame for a
    // deterministic preview canvas — see pauseExportPreview)
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockEditorPayload({ frameCount: 1, fps: 30 });
      location.hash = '#/export';
    });
    await page.waitForSelector('.export-canvas', { state: 'visible' });
    await pauseExportPreview(page);
    await expect(page).toHaveScreenshot('flow-3-export.png', { fullPage: true });
  });
});
