/**
 * E2E Tests for the Export screen Canvas preview
 * @module tests/e2e/export-preview.spec
 *
 * The previous version of this spec asserted a GIF-image preview UI
 * (.export-preview, .preview-generating, .preview-error, Refresh/Retry
 * buttons) that was never implemented in src (#48). These tests target the
 * Canvas-based preview that actually shipped (.export-canvas,
 * .export-preview-play-btn) plus the real encode flow.
 */

import { expect, test } from '@playwright/test';
import { gotoExportWithClip } from './helpers/app.js';

test.describe('Export Canvas Preview', () => {
  test.beforeEach(async ({ page }) => {
    await gotoExportWithClip(page, { frameCount: 10, fps: 30 });
  });

  test('canvas preview renders with play/pause control and size indicator', async ({ page }) => {
    const canvas = page.locator('.export-canvas');
    await expect(canvas).toBeVisible();

    // Preview auto-plays on entry, so the overlay button offers "Pause"
    const playBtn = page.locator('.export-preview-play-btn');
    await expect(playBtn).toBeVisible();
    await expect(playBtn).toHaveAttribute('aria-label', 'Pause preview');

    // Size indicator reflects the mock clip dimensions (640x480 default)
    await expect(page.locator('.export-preview-size')).toHaveText('640×480');
  });

  test('preview canvas draws actual frame pixels', async ({ page }) => {
    // The playback loop draws the injected mock frames onto the canvas.
    // A blank (never-drawn) canvas is fully transparent black.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const canvas = document.querySelector('.export-canvas');
            const ctx = canvas.getContext('2d');
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let sum = 0;
            for (let i = 0; i < data.length; i += 401) {
              sum += data[i];
            }
            return sum;
          }),
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
  });

  test('export flow encodes the clip and shows the complete screen', async ({ page }) => {
    await expect(page.locator('.export-settings-panel')).toBeVisible();

    await page.locator('.btn-export-main').click();

    // Encoding 10 small frames finishes quickly, but allow headroom for CI
    const complete = page.locator('.export-complete-v2');
    await expect(complete).toBeVisible({ timeout: 60000 });
    await expect(complete.locator('.complete-preview-img')).toBeVisible();
    await expect(page.locator('.btn-download-large')).toBeVisible();
  });
});
