import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * The live region is for screen readers only: an announcement must not be
 * printed under the app or make the page taller than the viewport.
 */
test('announcements stay visually hidden and do not grow the page', async ({ page }) => {
  await gotoCapture(page);
  await page.evaluate(() => {
    const region = document.getElementById('live-region');
    if (region) region.textContent = 'Clip added to queue (1/3)';
  });

  const region = page.locator('#live-region');
  await expect(region).toHaveText('Clip added to queue (1/3)');
  const box = await region.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(1);
  expect(box?.height ?? 0).toBeLessThanOrEqual(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
