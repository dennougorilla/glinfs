/**
 * E2E: a clip whose open stalls (the decoder never hands out a frame) ends
 * in a visible "Couldn't open" on its row instead of "Opening..." forever,
 * and the codec queue keeps working for other clips.
 *
 * The real codec worker runs with VideoDecoder replaced by one that accepts
 * input and never emits output or finishes its flush.
 * @module tests/e2e/clip-open-stall.spec
 */

import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

const QUEUE_ENTRIES = '[data-testid="clip-entry"]:not([data-clip-active])';

const SHIM = `
self.VideoDecoder = class extends EventTarget {
  constructor() { super(); }
  configure() {}
  decode() {}
  flush() { return new Promise(() => {}); }
  close() {}
  get state() { return 'configured'; }
  static isConfigSupported() { return Promise.resolve({ supported: true }); }
};
`;

test('a stalled open shows "Couldn\'t open" on the row and the queue keeps working', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route(/clip-codec-worker/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: SHIM + body });
  });

  await gotoCapture(page);
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
  });
  test.skip(
    !(await page.evaluate(() => window.__TEST_HOOKS__.clipCodec.probeSupport())),
    'WebCodecs encode is not available in this browser',
  );
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') await sceneToggle.click();

  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThanOrEqual(20);
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  const entry = page.locator(QUEUE_ENTRIES).first();
  await expect(entry).toHaveAttribute('data-clip-status', 'compressed', { timeout: 30000 });

  // Open it: the decode never finishes
  const openedAt = Date.now();
  await entry.locator('.clip-entry-main').click();
  await expect(entry).toHaveAttribute('data-clip-status', 'decoding');
  await expect(entry.locator('.clip-entry-status')).toHaveText('Opening…');

  // The watchdog (15 s of silence) ends it, visibly on the row
  await expect(entry).toHaveAttribute('data-clip-open-failed', 'true', { timeout: 30000 });
  // ...after the bound, not through an early error
  expect(Date.now() - openedAt).toBeGreaterThanOrEqual(14000);
  await expect(entry).toHaveAttribute('data-clip-status', 'compressed');
  await expect(entry.locator('.clip-entry-status')).toHaveText("Couldn't open");
  await page.screenshot({ path: test.info().outputPath('clip-open-failed.png') });
  await entry.screenshot({ path: test.info().outputPath('clip-open-failed-row.png') });

  // The codec queue was not left blocked: the next clip compresses
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(2);
  await expect(page.locator(QUEUE_ENTRIES).first()).toHaveAttribute(
    'data-clip-status',
    'compressed',
    { timeout: 30000 },
  );
});
