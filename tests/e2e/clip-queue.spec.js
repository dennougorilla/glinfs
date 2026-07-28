import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * E2E for #95: Clip Now from the editor with the bounded clip queue.
 *
 * Drives the WHOLE live pipeline via the #91 mock-stream hook
 * (canvas.captureStream stands in for getDisplayMedia): start fake capture,
 * Create Clip, then on the editor press Shift+C twice and assert two queue
 * entries appear while the editor canvas keeps rendering — i.e. enqueueing
 * never touched the active clip's frames (no closed-frame errors).
 */

/** Queue entries only (the active clip renders with data-clip-active) */
const QUEUE_ENTRIES = '[data-testid="clip-entry"]:not([data-clip-active])';

test('Shift+C from the editor queues clips without disturbing the open editor', async ({
  page,
}) => {
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await gotoCapture(page);

  // Route the capture pipeline through the mock canvas stream (#91) so no
  // real screen-share permission prompt is involved
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
  });

  // Scene detection off => Create Clip navigates straight to /editor
  // (no loading-screen detour, which is out of scope here)
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') {
    await sceneToggle.click();
    await expect(sceneToggle).toHaveAttribute('aria-pressed', 'false');
  }

  // Start the fake capture and let the ring buffer accumulate frames
  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThan(0);

  // The header Clip Now button appears with a live capture session
  await expect(page.locator('#clip-now-btn')).toBeVisible();

  // Create Clip -> editor opens on the new active clip
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  // Background capture (default on) keeps the buffer refilling while we
  // edit; give it a moment so each Shift+C snapshot has frames to take
  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(1);

  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(2);

  // Active clip entry still listed first and highlighted
  const allEntries = page.locator('[data-testid="clip-entry"]');
  await expect(allEntries).toHaveCount(3);
  await expect(allEntries.first()).toHaveAttribute('data-clip-active', 'true');

  // Header badge reflects the queue size
  await expect(page.locator('#clip-queue-badge')).toHaveText('2');

  // Badge popover: opens with the same entries, Escape closes it
  await page.locator('#clip-queue-badge').click();
  await expect(page.locator('.clip-queue-popover')).toBeVisible();
  await expect(page.locator('.clip-queue-popover [data-testid="clip-entry"]')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('.clip-queue-popover')).toHaveCount(0);

  // The open editor was not disturbed: canvas still renders (still attached
  // and sized — a closed active frame would have blanked or thrown) ...
  await expect(page.locator('.editor-canvas')).toBeVisible();
  const canvasHasPixels = await page.evaluate(() => {
    const canvas = document.querySelector('.editor-canvas');
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  });
  expect(canvasHasPixels).toBe(true);

  // ... and no closed-frame errors surfaced anywhere
  expect(pageErrors).toEqual([]);
  const frameErrors = consoleErrors.filter((text) => /closed|VideoFrame|detached/i.test(text));
  expect(frameErrors).toEqual([]);
});
