/**
 * B2 (memory audit, PR C preview): the browser's "Stop sharing" while on
 * /capture keeps the ring buffer. Create Clip stays on the capture screen,
 * first, and turns the kept buffer into a clip. Drives the real pipeline
 * through the mock-stream hook; the browser bar is simulated by ending the
 * track the way Chrome does (stop + 'ended').
 */

import { expect, test } from '@playwright/test';

test('after the browser stops the share, Create Clip turns the kept buffer into a clip', async ({
  page,
}) => {
  await page.goto('/glinfs/?testMode=true#/capture');
  await page.waitForFunction(() => window.__TEST_HOOKS__);
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
    localStorage.clear();
  });
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') {
    await sceneToggle.click();
  }

  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThan(10);

  // Chrome's "Stop sharing" bar: the track stops and fires 'ended'
  await page.evaluate(() => {
    const video = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    const track = /** @type {MediaStream} */ (video.srcObject).getVideoTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });

  const actions = page.locator('.capture-actions button');
  await expect(actions.first()).toHaveText('Create Clip');
  await expect(actions.nth(1)).toHaveText('Select Screen');
  const buffered = Number(await page.locator('.stat-value').first().textContent());
  expect(buffered).toBeGreaterThan(10);
  if (process.env.B2_SHOT) {
    await page.locator('.capture-actions').screenshot({ path: process.env.B2_SHOT });
  }

  await actions.first().click();
  await page.waitForSelector('.editor-canvas', { state: 'visible', timeout: 15000 });
  const frames = await page.evaluate(
    () => window.__TEST_HOOKS__.getClipPayload()?.frames?.length ?? 0,
  );
  expect(frames).toBe(buffered);
});
