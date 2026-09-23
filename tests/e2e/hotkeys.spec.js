import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * E2E for #102: every app shortcut now routes through one document-level
 * dispatcher (modal > overlay > route > global). Walks the real key flows
 * end to end so a precedence regression shows up as a user-visible failure:
 * Shift+C (global), popover Escape vs. crop (overlay over route), 1-9 /
 * Shift+digit (route), Space play/pause (route), and F + Escape on the
 * frame grid (foreign aria-modal the dispatcher yields to).
 *
 * Drives the #91 mock stream: capture -> Create Clip -> editor.
 */

/** @param {import('@playwright/test').Page} page */
async function drawCrop(page) {
  const box = await page.locator('.editor-canvas-overlay').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
  await page.mouse.up();
}

/** @param {import('@playwright/test').Page} page */
async function blurToBody(page) {
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
}

const ENTRIES = '.editor-screen [data-testid="clip-entry"]';

test.describe('App hotkeys through the shared dispatcher (#102)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoCapture(page);
    await page.evaluate(() => {
      window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
    });

    // Scene detection off => Create Clip navigates straight to /editor
    const sceneToggle = page.locator('[data-setting="sceneDetection"]');
    if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') {
      await sceneToggle.click();
      await expect(sceneToggle).toHaveAttribute('aria-pressed', 'false');
    }

    await page.locator('.btn-capture-start').click();
    await expect(page.locator('.video-preview--active')).toBeVisible();
    await expect
      .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
        timeout: 10000,
      })
      .toBeGreaterThanOrEqual(10);

    await page.locator('.btn-create-clip').click();
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await blurToBody(page);
  });

  test('Shift+C queues a clip from the editor (global scope)', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');

    // Modifier combos are not ours: Ctrl+Shift+C leaves the queue alone
    await page.keyboard.press('Control+Shift+C');
    await page.waitForTimeout(200);
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');
  });

  test('Space toggles playback; Cmd/Ctrl+Space does not', async ({ page }) => {
    // The editor may autoplay on mount; assert relative to whatever it shows
    const playBtn = page.locator('.btn-play');
    const initial = await playBtn.getAttribute('aria-label');
    const toggled = initial === 'Play' ? 'Pause' : 'Play';

    await page.keyboard.press('Space');
    await expect(playBtn).toHaveAttribute('aria-label', toggled);
    await page.keyboard.press('Space');
    await expect(playBtn).toHaveAttribute('aria-label', /** @type {string} */ (initial));

    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(100);
    await expect(playBtn).toHaveAttribute('aria-label', /** @type {string} */ (initial));
  });

  test('F opens the frame grid, which owns Space and Escape until it closes', async ({ page }) => {
    await drawCrop(page);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();
    const playBtn = page.locator('.btn-play');

    await page.keyboard.press('f');
    const modal = page.locator('.frame-grid-backdrop');
    await expect(modal).toBeVisible();

    // Space selects a grid frame instead of toggling editor playback
    const playLabel = /** @type {string} */ (await playBtn.getAttribute('aria-label'));
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await expect(playBtn).toHaveAttribute('aria-label', playLabel);

    // Escape closes the grid only; the crop survives
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    // With the grid gone the editor owns Escape again
    await blurToBody(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });

  test('popover Escape wins over the editor crop Escape', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');
    await drawCrop(page);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    await page.locator('#clip-queue-badge').click();
    await expect(page.locator('.clip-queue-popover')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);
    await expect(page.locator('#clip-queue-badge')).toBeFocused();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });

  test('1-9 switch clips by position and Shift+digit deletes', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');

    // Newest first: the queued Shift+C clip is #1, the active clip #2
    const entries = page.locator(ENTRIES);
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(1)).toHaveAttribute('data-clip-active', 'true');
    const queuedId = await entries.nth(0).getAttribute('data-clip-id');

    // A position with no clip is inert
    await page.keyboard.press('9');
    await expect(entries.nth(1)).toHaveAttribute('data-clip-active', 'true');

    // Cmd/Ctrl+digit stays with the browser (tab switching)
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(200);
    await expect(entries.nth(1)).toHaveAttribute('data-clip-active', 'true');

    await blurToBody(page);
    await page.keyboard.press('1');
    await expect(entries.nth(0)).toHaveAttribute('data-clip-active', 'true', { timeout: 10000 });
    await expect(entries.nth(0)).toHaveAttribute('data-clip-id', queuedId ?? '');

    // Shift+2 deletes the (now queued) original clip at position 2
    await blurToBody(page);
    await page.keyboard.press('Shift+Digit2');
    await expect(entries).toHaveCount(1);
    await expect(entries.nth(0)).toHaveAttribute('data-clip-active', 'true');
  });
});
