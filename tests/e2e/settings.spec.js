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

  const container = page.locator('#main-content .settings-screen.screen');
  await expect(container).toBeVisible();

  // Header with title and a working back button
  await expect(page.locator('.settings-title')).toHaveText('Settings');
  await page.locator('.settings-header button').first().click();
  await expect(page.locator('.capture-screen')).toBeVisible();
});

test('the Settings toggle matches the Capture sidebar toggle (#no CSS collision)', async ({
  page,
}) => {
  await gotoCapture(page);

  // Both screens use the single .btn-toggle rule in form-controls.css; the
  // Settings copy used to win by load order and shrink the Capture control.
  const captureToggleHeight = await page
    .locator('[data-setting="sceneDetection"]')
    .evaluate((el) => getComputedStyle(el).height);

  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.locator('.settings-screen')).toBeVisible();

  const settingsToggleHeight = await page
    .locator('.settings-content .btn-toggle')
    .first()
    .evaluate((el) => getComputedStyle(el).height);

  expect(settingsToggleHeight).toBe(captureToggleHeight);
});

test('the header gear icon is centred in the header, like its neighbours', async ({ page }) => {
  await gotoCapture(page);

  // .btn-icon sized a 36px box but never centred its content, so the 20px
  // glyph sat at the box's top-left — visibly higher than the logo and the
  // step indicator it sits beside.
  const centres = await page.evaluate(() => {
    const midY = (el) => {
      const r = el.getBoundingClientRect();
      return (r.top + r.bottom) / 2;
    };
    const midX = (el) => {
      const r = el.getBoundingClientRect();
      return (r.left + r.right) / 2;
    };
    // The Clip Now camera button (#95) is also a .btn-icon and sits before
    // the gear — select the gear by its accessible name, not by class
    const gear = document.querySelector('.header-actions [aria-label="Settings"]');
    const svg = gear.querySelector('svg');
    return {
      logoY: midY(document.querySelector('.app-logo')),
      stepsY: midY(document.querySelector('.step-indicator')),
      glyphY: midY(svg),
      glyphX: midX(svg),
      boxX: midX(gear),
      boxY: midY(gear),
    };
  });

  expect(Math.abs(centres.glyphY - centres.logoY)).toBeLessThanOrEqual(1);
  expect(Math.abs(centres.glyphY - centres.stepsY)).toBeLessThanOrEqual(1);
  // and the glyph is centred within its own hit area
  expect(Math.abs(centres.glyphY - centres.boxY)).toBeLessThanOrEqual(1);
  expect(Math.abs(centres.glyphX - centres.boxX)).toBeLessThanOrEqual(1);
});

test('the Settings title is centred on the screen, not between the buttons', async ({ page }) => {
  await gotoCapture(page);
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.locator('.settings-screen')).toBeVisible();

  // "← Back" and "Reset All" have different widths, so a space-between
  // header pushed the title off centre by the difference.
  const offset = await page.evaluate(() => {
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return (r.left + r.right) / 2;
    };
    const header = document.querySelector('.settings-header');
    return Math.abs(mid(header.querySelector('.settings-title')) - mid(header));
  });

  expect(offset).toBeLessThanOrEqual(1);
});

/**
 * #92: the clip queue limit's default depends on WebCodecs compression
 * support (10 compressed / 3 raw) and the Settings screen shows the
 * EFFECTIVE value, marked (auto), until the user picks one.
 */
test.describe('clip queue limit auto default (#92)', () => {
  /** @param {import('@playwright/test').Page} page */
  const clipQueueRow = (page) =>
    page.locator('.settings-item', { has: page.locator('[data-setting-note="clipQueueLimit"]') });

  /** @param {import('@playwright/test').Page} page */
  async function openSettings(page) {
    await gotoCapture(page);
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    await expect(page.locator('#main-content .settings-screen.screen')).toBeVisible();
  }

  test('shows the compressed default (10) when WebCodecs encode is available', async ({ page }) => {
    await openSettings(page);
    const row = clipQueueRow(page);
    await expect(row.locator('.settings-range-value')).toHaveText('10 clips (auto)');
    await expect(row.locator('.settings-item-note')).toHaveText(
      'Default: 10 (queued clips are compressed)',
    );
  });

  test('shows the raw-fallback default (3) when WebCodecs encode is unsupported', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (globalThis.VideoEncoder) {
        globalThis.VideoEncoder.isConfigSupported = async () => ({ supported: false });
      }
    });
    await openSettings(page);
    const row = clipQueueRow(page);
    await expect(row.locator('.settings-range-value')).toHaveText('3 clips (auto)');
    await expect(row.locator('.settings-item-note')).toContainText('Default: 3');
    await expect(row.locator('input[type="range"]')).toHaveValue('3');
  });

  test('an explicit choice is kept and shown without (auto)', async ({ page }) => {
    await page.addInitScript(() => {
      if (globalThis.VideoEncoder) {
        globalThis.VideoEncoder.isConfigSupported = async () => ({ supported: false });
      }
    });
    await openSettings(page);
    const row = clipQueueRow(page);
    await row.locator('input[type="range"]').fill('10');
    await expect(row.locator('.settings-range-value')).toHaveText('10 clips');

    // Survives a reload on the raw-fallback platform (never overridden)
    await page.reload();
    await expect(page.locator('#main-content .settings-screen.screen')).toBeVisible();
    await expect(clipQueueRow(page).locator('.settings-range-value')).toHaveText('10 clips');
  });
});
