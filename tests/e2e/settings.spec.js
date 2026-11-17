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

  test('auto stays readable by older builds after an unrelated settings save', async ({ page }) => {
    await page.addInitScript(() => {
      if (globalThis.VideoEncoder) {
        globalThis.VideoEncoder.isConfigSupported = async () => ({ supported: false });
      }
    });
    await openSettings(page);
    await page.locator('.settings-content .btn-toggle').first().click();

    // An open v0.5.x tab reads Number(clipQueueLimit): it must stay 10, not
    // null (which that reader clamps to a 1-clip queue)
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('glinfs_user_settings') ?? 'null')?.capture,
    );
    expect(stored).toMatchObject({ clipQueueLimit: 10, clipQueueLimitMode: 'auto' });

    await page.reload();
    await expect(page.locator('#main-content .settings-screen.screen')).toBeVisible();
    await expect(clipQueueRow(page).locator('.settings-range-value')).toHaveText('3 clips (auto)');
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

/** A method entry registered through the test hooks (main has none yet) */
const E2E_METHOD = {
  id: 'e2e.detector',
  area: 'scenes',
  name: 'Scene detection',
  options: [
    { id: 'fixed', name: 'Fixed threshold' },
    { id: 'adaptive', name: 'Adaptive' },
  ],
  default: 'fixed',
};

/**
 * Register E2E_METHOD and open Settings
 * @param {import('@playwright/test').Page} page
 */
async function openSettingsWithMethod(page) {
  await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.registerMethod));
  await page.evaluate((entry) => window.__TEST_HOOKS__.registerMethod(entry), E2E_METHOD);
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.locator('.settings-screen')).toBeVisible();
}

test('the Methods section lists a method and its choice persists', async ({ page }) => {
  await gotoCapture(page);
  await openSettingsWithMethod(page);

  const section = page.locator('.settings-section', {
    has: page.locator('.settings-section-title', { hasText: 'Methods' }),
  });
  const row = section.locator('[data-setting-key="e2e.detector"]');
  await expect(row.locator('.settings-item-label')).toHaveText('Scene detection');
  const select = row.locator('select');
  // The default is the first option
  await expect(select.locator('option')).toHaveText(['Fixed threshold', 'Adaptive']);
  await expect(select).toHaveValue('fixed');

  await select.selectOption('adaptive');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('glinfs_user_settings')).methods),
    )
    .toEqual({ 'e2e.detector': 'adaptive' });

  // A new page load (the registry is empty again until registered)
  await page.reload();
  await page.waitForSelector('.settings-screen', { state: 'visible' });
  await page.evaluate(() => {
    location.hash = '#/capture';
  });
  await page.waitForSelector('.capture-screen', { state: 'visible' });
  await openSettingsWithMethod(page);
  await expect(page.locator('[data-setting-key="e2e.detector"] select')).toHaveValue('adaptive');
});

test('a ?method.<id>= URL override shows in Settings and is not stored', async ({ page }) => {
  await page.goto('/?method.e2e.detector=adaptive#/capture');
  await page.waitForSelector('.capture-screen', { state: 'visible' });
  await openSettingsWithMethod(page);

  const select = page.locator('[data-setting-key="e2e.detector"] select');
  await expect(select).toHaveValue('adaptive');
  await expect(select).toBeDisabled();
  const stored = await page.evaluate(() => localStorage.getItem('glinfs_user_settings'));
  expect(stored === null || !JSON.parse(stored).methods?.['e2e.detector']).toBe(true);
});
