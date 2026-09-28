/**
 * E2E: the Export GIF dialog over the editor.
 * @module tests/e2e/export-dialog.spec
 *
 * Replaces the export screen's canvas-preview spec: the export is a modal
 * dialog on top of the editor (the editor preview behind it shows the
 * content, the result view shows the real GIF). Covers the dialog's
 * keyboard/focus contract, a full export to the result view, the editor
 * speed as the GIF speed, the `#/export` deep link, the output scale and the
 * target size.
 */

import { expect, test } from '@playwright/test';
import {
  closeExportDialog,
  decodeExportedGif,
  exportDialog,
  exportFromEditor,
  exportGifAndWait,
  gotoCapture,
  gotoEditorWithClip,
  gotoExportWithClip,
  pauseEditorPlayback,
} from './helpers/app.js';

/**
 * Size in bytes of the GIF the dialog produced
 * @param {import('@playwright/test').Page} page
 */
async function exportedGifBytes(page) {
  return page.evaluate(async () => {
    const base64 = await window.__TEST_HOOKS__.getExportResultBase64();
    return base64 ? atob(base64).length : 0;
  });
}

/**
 * Pick the editor's playback speed through its Playback panel
 * @param {import('@playwright/test').Page} page
 * @param {string} value - e.g. '2'
 */
async function setEditorSpeed(page, value) {
  const select = page.locator('#editor-speed');
  if (!(await select.isVisible())) {
    await page.locator('.prop-accordion-summary', { hasText: 'Playback' }).click();
  }
  await select.selectOption(value);
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getEditorState()?.playbackSpeed))
    .toBe(Number(value));
}

test.describe('Export dialog: opening, focus and keys', () => {
  test('opens over the editor as a modal dialog and closes with Escape', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 10, fps: 30 });
    await expect(page.locator('.btn-play')).toHaveAttribute('aria-label', 'Pause');

    const opener = page.getByRole('button', { name: 'Export as GIF' });
    await opener.click();
    const dialog = exportDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus moved in (onto the title that labels the dialog)
    await expect(dialog.getByRole('heading', { name: 'Export GIF' })).toBeFocused();
    // The editor stays mounted underneath, paused, and out of reach
    await expect(page.locator('.editor-canvas')).toBeAttached();
    await expect(page.locator('.btn-play')).toHaveAttribute('aria-label', 'Play');
    await expect(page.locator('#app')).toHaveAttribute('inert', '');
    // No preview canvas of its own
    await expect(dialog.locator('canvas')).toHaveCount(0);

    // Route hotkeys are suspended: G would toggle the editor's grid
    const gridBefore = await page.locator('.btn-grid-toggle').getAttribute('aria-pressed');
    await page.keyboard.press('g');
    await expect(page.locator('.btn-grid-toggle')).toHaveAttribute('aria-pressed', `${gridBefore}`);

    // Tab never leaves the dialog
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
      ).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
      ).toBe(true);
    }

    // Escape closes it (even from a select), focus returns to the opener
    await dialog.locator('#export-frame-skip').focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator('#app')).not.toHaveAttribute('inert', '');
    // Playback resumes, and the editor's keys work again
    await expect(page.locator('.btn-play')).toHaveAttribute('aria-label', 'Pause');
    await pauseEditorPlayback(page);
    await page.keyboard.press('g');
    await expect(page.locator('.btn-grid-toggle')).not.toHaveAttribute(
      'aria-pressed',
      `${gridBefore}`,
    );
  });

  test('opens with Ctrl/Cmd+E; the Close button closes it', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 10, fps: 30 });
    // Nothing focused: the shortcut comes from the page itself
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    await page.keyboard.press('ControlOrMeta+e');
    const dialog = exportDialog(page);
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    // Opened from the page, not a button: focus lands on the Export button
    await expect(page.getByRole('button', { name: 'Export as GIF' })).toBeFocused();
  });

  test('the step indicator is Capture → Edit, with no Export step', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 5 });
    await expect(page.locator('.step-indicator .step')).toHaveCount(2);
    await expect(page.locator('.step-indicator [data-step="export"]')).toHaveCount(0);
    await expect(page.locator('.step-indicator [data-step="editor"]')).toHaveClass(/step--active/);
  });
});

test.describe('Export dialog: exporting', () => {
  test('exports from the dialog and shows the real GIF with its facts', async ({ page }) => {
    await gotoExportWithClip(page, { frameCount: 10, fps: 30 });
    const dialog = exportDialog(page);
    await expect(dialog.locator('#export-summary')).toHaveText('640×480 · 10 frames · 0.33s at 1×');
    await expect(dialog.locator('#export-estimate')).toContainText('Estimated size');

    await exportGifAndWait(page);

    const img = dialog.locator('.export-result-img');
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth))
      .toBe(640);
    const bytes = await exportedGifBytes(page);
    expect(bytes).toBeGreaterThan(0);
    await expect(dialog.locator('#export-result-dimensions')).toHaveText('640×480');
    await expect(dialog.locator('#export-result-frames')).toHaveText('10');
    await expect(dialog.locator('#export-result-size')).toContainText('KB');
    await expect(dialog.locator('#export-download')).toBeFocused();

    // Download saves the GIF under a glinfs-*.gif name
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.locator('#export-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^glinfs-.*\.gif$/);

    // Open in new tab shows the same GIF
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      dialog.locator('#export-open-tab').click(),
    ]);
    expect(popup.url()).toMatch(/^blob:/);
    await popup.close();

    // Export again: back to the settings, the GIF is dropped
    await dialog.locator('#export-again').click();
    await expect(dialog.locator('#export-settings')).toBeVisible();
    expect(await page.evaluate(() => window.__TEST_HOOKS__.getExportResultBase64())).toBeNull();

    // Back to editing closes the dialog
    await exportGifAndWait(page);
    await closeExportDialog(page);
    await expect(dialog).toHaveCount(0);
  });

  test("the editor's speed changes the GIF frame delays", async ({ page }) => {
    // 10 fps: one frame is exactly 10 cs at 1x
    await gotoEditorWithClip(page, { frameCount: 6, fps: 10, width: 64, height: 48 });
    await pauseEditorPlayback(page);

    await setEditorSpeed(page, '2');
    await exportFromEditor(page);
    const dialog = exportDialog(page);
    await expect(dialog.locator('#export-speed')).toHaveText('2×');
    // The dialog has no speed control of its own
    await expect(dialog.getByLabel(/speed/i)).toHaveCount(0);
    await exportGifAndWait(page);
    let frames = await decodeExportedGif(page);
    expect(frames.map((f) => f.durationMs)).toEqual(new Array(6).fill(50));
    await closeExportDialog(page);

    await setEditorSpeed(page, '0.5');
    await exportFromEditor(page);
    await exportGifAndWait(page);
    frames = await decodeExportedGif(page);
    expect(frames.map((f) => f.durationMs)).toEqual(new Array(6).fill(200));
  });

  test('says when GIF delays cannot play the editor speed', async ({ page }) => {
    await gotoExportWithClip(page, { frameCount: 10, fps: 30, playbackSpeed: 4 });
    const note = exportDialog(page).locator('#export-speed-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('plays at about 1.67×');
  });

  test('Scale 50 % halves the GIF dimensions', async ({ page }) => {
    await gotoExportWithClip(page, {
      frameCount: 4,
      fps: 10,
      width: 160,
      height: 120,
      pattern: 'checkerboard',
    });
    const dialog = exportDialog(page);
    await dialog.getByLabel('Scale').selectOption({ label: '50 % (80×60)' });
    await expect(dialog.locator('#export-summary')).toContainText('80×60');

    await exportGifAndWait(page);
    await expect(dialog.locator('#export-result-dimensions')).toHaveText('80×60');
    const frames = await decodeExportedGif(page);
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect([frame.width, frame.height]).toEqual([80, 60]);
    }
  });

  test('a target size below the default output produces a GIF at or under it', async ({ page }) => {
    test.slow();
    const clip = { frameCount: 30, fps: 30, width: 480, height: 360, pattern: 'gradient' };
    await gotoExportWithClip(page, clip);
    const dialog = exportDialog(page);

    // The default output first, to aim well below it
    await exportGifAndWait(page);
    const defaultBytes = await exportedGifBytes(page);
    expect(defaultBytes).toBeGreaterThan(100_000);
    await dialog.locator('#export-again').click();

    // Decimal megabytes, as the dialog counts them (1 MB = 1,000,000 bytes)
    const targetMB = Math.floor((defaultBytes * 0.35 * 100) / 1_000_000) / 100;
    await dialog.getByLabel('Target size', { exact: true }).check();
    const amount = dialog.getByLabel('Target size in MB');
    await amount.fill(String(targetMB));
    await amount.press('Tab');
    await expect(dialog.getByTestId('export-target-encoder-note')).toHaveText(
      'A target size uses the JavaScript encoder',
    );

    await exportGifAndWait(page);
    const bytes = await exportedGifBytes(page);
    expect(bytes).toBeLessThanOrEqual(targetMB * 1_000_000);
    await expect(dialog.locator('#export-result-target')).toContainText('Fits the');

    // The result view reports the real GIF
    const frames = await decodeExportedGif(page);
    const dims = await dialog.locator('#export-result-dimensions').textContent();
    expect(`${frames[0].width}×${frames[0].height}`).toBe(dims);
    await expect(dialog.locator('#export-result-frames')).toHaveText(String(frames.length));
    expect(frames[0].width).toBeLessThanOrEqual(480);
  });
});

test.describe('Export dialog: #/export', () => {
  test('opens the editor with the dialog when a clip exists', async ({ page }) => {
    await gotoCapture(page);
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockEditorPayload({
        frameCount: 12,
        fps: 30,
        selectedRange: { start: 2, end: 9 },
      });
      location.hash = '#/export';
    });
    const dialog = exportDialog(page);
    await expect(dialog.locator('#export-settings')).toBeVisible();
    await expect(page.locator('.editor-canvas')).toBeVisible();
    await expect(page).toHaveURL(/#\/editor$/);
    // The dialog exports the restored selection
    await expect(dialog.locator('#export-summary')).toContainText('8 frames');

    // Not a dead end: closing leaves the working editor
    await closeExportDialog(page);
    await expect(page.locator('.timeline-sel-frames')).toHaveText('(8 frames)');
  });

  test('goes to Capture without a clip', async ({ page }) => {
    await page.goto('/#/export');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await expect(page).toHaveURL(/#\/capture$/);
    await expect(exportDialog(page)).toHaveCount(0);
  });
});
