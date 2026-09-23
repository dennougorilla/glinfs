import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * E2E for #102 (Escape conflict slice): Escape is shared by the header
 * clip-queue popover (close) and the editor (clear crop). An Escape consumed
 * by the open popover must not also clear the crop; with no popover open,
 * Escape keeps clearing the crop.
 *
 * The badge only renders with a live capture or a non-empty queue, so the
 * flow drives the #91 mock stream: capture -> Create Clip -> Shift+C.
 */

/**
 * Draw a crop area on the overlay canvas by dragging
 * @param {import('@playwright/test').Page} page
 */
async function drawCrop(page) {
  const box = await page.locator('.editor-canvas-overlay').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
  await page.mouse.up();
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
function activeElementIsBody(page) {
  return page.evaluate(() => document.activeElement === document.body);
}

test.describe('Escape with the clip-queue popover open (#102)', () => {
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

    // One queued clip so the header badge (popover trigger) is shown
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');

    await drawCrop(page);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();
  });

  test('Escape closes the popover without clearing the crop', async ({ page }) => {
    await page.locator('#clip-queue-badge').click();
    await expect(page.locator('.clip-queue-popover')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);

    // Focus returns to the badge and the crop survives
    await expect(page.locator('#clip-queue-badge')).toBeFocused();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    // A second Escape (no popover now) is the editor's again
    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });

  test('a modal opened over the popover owns Escape', async ({ page }) => {
    await page.locator('#clip-queue-badge').click();
    await expect(page.locator('.clip-queue-popover')).toBeVisible();

    // F opens the frame grid above the popover and moves focus into it
    await page.keyboard.press('f');
    const modal = page.locator('.frame-grid-backdrop');
    await expect(modal).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('.frame-grid-backdrop')))
      .toBe(true);

    // The first Escape closes the modal, not the underlying popover, and
    // focus returns to the popover that opened the grid (#114) rather than
    // being pulled out to the badge or dropped on <body>
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.clip-queue-popover')).toBeVisible();
    await expect(page.locator('.clip-queue-popover')).toBeFocused();
    await expect(page.locator('#clip-queue-badge')).not.toBeFocused();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    // The next Escape belongs to the popover again; the crop still survives
    await page.keyboard.press('Escape');
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);
    await expect(page.locator('#clip-queue-badge')).toBeFocused();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();
  });

  test('closing the frame grid by its button falls back to Open Grid when the popover is gone', async ({
    page,
  }) => {
    await page.locator('#clip-queue-badge').click();
    await expect(page.locator('.clip-queue-popover')).toBeFocused();

    await page.keyboard.press('f');
    await expect(page.locator('.frame-grid-backdrop')).toBeVisible();

    // The click inside the modal dismisses the popover (the opener), so focus
    // lands on the editor's Open Grid button instead of <body> (#114)
    await page.locator('.frame-grid-close').click();
    await expect(page.locator('.frame-grid-backdrop')).toHaveCount(0);
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);
    await expect(page.locator('.btn-frame-grid-compact')).toBeFocused();
    expect(await activeElementIsBody(page)).toBe(false);
  });

  test('Escape with no popover open still clears the crop', async ({ page }) => {
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });
});

test.describe('Frame grid focus restore without the popover (#114)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoCapture(page);
    await page.evaluate(() => {
      window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
    });

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
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);
  });

  test('Escape returns focus to the Open Grid button that opened it', async ({ page }) => {
    const openGrid = page.locator('.btn-frame-grid-compact');
    await openGrid.click();
    await expect(page.locator('.frame-grid-backdrop')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.frame-grid-backdrop')).toHaveCount(0);
    await expect(openGrid).toBeFocused();
  });

  test('Apply returns focus to the Open Grid button', async ({ page }) => {
    await page.locator('.btn-frame-grid-compact').click();
    const items = page.locator('.frame-grid-item');
    await items.nth(1).click();
    await items.nth(3).click({ modifiers: ['Shift'] });
    await page.locator('.frame-grid-btn-apply').click();

    await expect(page.locator('.frame-grid-backdrop')).toHaveCount(0);
    await expect(page.locator('.btn-frame-grid-compact')).toBeFocused();
  });

  test('the F shortcut from <body> falls back to the Open Grid button', async ({ page }) => {
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
    expect(await activeElementIsBody(page)).toBe(true);

    await page.keyboard.press('f');
    await expect(page.locator('.frame-grid-backdrop')).toBeVisible();

    await page.locator('.frame-grid-close').click();
    await expect(page.locator('.frame-grid-backdrop')).toHaveCount(0);
    await expect(page.locator('.btn-frame-grid-compact')).toBeFocused();
    expect(await activeElementIsBody(page)).toBe(false);
  });
});
