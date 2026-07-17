/**
 * E2E Smoke Test for the Settings screen
 * @module tests/e2e/settings.spec
 */

import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

test('settings screen renders when navigating to #/settings (#36)', async ({ page }) => {
  await gotoCapture(page);

  await page.evaluate(() => {
    location.hash = '#/settings';
  });

  const container = page.locator('#main-content.settings-container');
  await expect(container).toBeVisible();

  // Header with title and a working back button
  await expect(page.locator('.settings-title')).toBeVisible();
  await page.locator('.settings-header button').first().click();
  await expect(page.locator('.capture-screen')).toBeVisible();
});
