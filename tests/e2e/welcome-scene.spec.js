/**
 * Welcome scene on the empty capture screen
 * @module tests/e2e/welcome-scene.spec
 *
 * The scene is a canvas (features/capture/welcome-scene.js): it should draw,
 * move, hold still under reduced motion, stay out of the way of a real
 * capture, and never log errors.
 */

import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * A cheap fingerprint of what the canvas shows
 * @param {import('@playwright/test').Page} page
 */
function canvasStats(page) {
  return page.locator('.welcome-canvas').evaluate((canvas) => {
    const c = /** @type {HTMLCanvasElement} */ (canvas);
    const ctx = c.getContext('2d');
    if (!ctx || !c.width) return { width: 0, painted: 0, hash: 0 };
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let painted = 0;
    let hash = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] > 0) painted++;
      hash = (hash * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) | 0;
    }
    return { width: c.width, painted, hash };
  });
}

test.describe('welcome scene', () => {
  test('draws an animated scene on the empty capture screen', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await gotoCapture(page);

    const welcome = page.locator('.welcome');
    await expect(welcome).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.welcome-canvas')).toBeVisible();

    await expect
      .poll(async () => (await canvasStats(page)).painted, { timeout: 5000 })
      .toBeGreaterThan(500);
    const first = await canvasStats(page);
    await page.waitForTimeout(600);
    const later = await canvasStats(page);
    expect(later.hash).not.toBe(first.hash);
    expect(errors).toEqual([]);
  });

  test('holds one still frame when motion is reduced', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoCapture(page);
    await expect
      .poll(async () => (await canvasStats(page)).painted, { timeout: 5000 })
      .toBeGreaterThan(500);
    // the still is drawn again once the web fonts are in; compare after that
    await page.evaluate(() => document.fonts.ready);
    const first = await canvasStats(page);
    await page.waitForTimeout(800);
    expect((await canvasStats(page)).hash).toBe(first.hash);
  });

  test('stops moving as soon as motion is reduced', async ({ page }) => {
    await gotoCapture(page);
    await expect
      .poll(async () => (await canvasStats(page)).painted, { timeout: 5000 })
      .toBeGreaterThan(500);
    await page.evaluate(() => document.fonts.ready);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    const first = await canvasStats(page);
    await page.waitForTimeout(600);
    expect((await canvasStats(page)).hash).toBe(first.hash);
  });

  test('gives way to the live preview once a screen is shared', async ({ page }) => {
    await page.goto('/#/capture?testMode=true');
    await page.waitForFunction(() => window.__TEST_HOOKS__);
    await page.evaluate(() => window.__TEST_HOOKS__.updateTestConfig({ mockStream: true }));
    await expect(page.locator('.welcome-canvas')).toBeVisible();

    await page.locator('.btn-capture-start').click();
    await expect(page.locator('.video-preview--active')).toBeVisible();
    await expect(page.locator('.welcome')).toHaveCount(0);
  });

  test('stops with the capture screen and comes back on return', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoCapture(page);
    await expect(page.locator('.welcome-canvas')).toBeVisible();

    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    await expect(page.locator('.settings-screen')).toBeVisible();
    await expect(page.locator('.welcome')).toHaveCount(0);

    await page.evaluate(() => {
      location.hash = '#/capture';
    });
    await expect(page.locator('.welcome-canvas')).toBeVisible();
    await expect
      .poll(async () => (await canvasStats(page)).painted, { timeout: 5000 })
      .toBeGreaterThan(500);
    expect(errors).toEqual([]);
  });
});
