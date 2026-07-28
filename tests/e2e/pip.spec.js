import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * E2E for #94: the persistent live-capture PiP.
 *
 * Drives the whole live pipeline via the #91 mock-stream hook: start fake
 * capture, Create Clip (lands on /editor with capture still running in the
 * background), assert the PiP appears, Clip Now from the PiP bumps the
 * queue, then stopping the underlying track (simulating "Stop sharing" from
 * the browser UI) drives the PiP through its "Capture ended" terminal state
 * and finally hides it.
 */

test('PiP appears on the editor, Clip Now works from it, and it explains itself when the share ends', async ({
  page,
}) => {
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

  // PiP must not show on /capture itself even while sharing
  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  await expect(page.locator('#pip-root')).toBeHidden();

  // Create Clip -> editor opens, background capture keeps the stream alive
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  const pipRoot = page.locator('#pip-root');
  await expect(pipRoot).toBeVisible();
  await expect(pipRoot).toHaveAttribute('role', 'region');

  // Clip Now from the PiP enqueues without leaving the editor
  await page.locator('[data-testid="pip-clip-now"]').click();
  await expect(page.locator('#clip-queue-badge')).toHaveText('1');
  await expect(page.locator('.editor-canvas')).toBeVisible();

  // Stop the underlying share track (as if the user stopped it from the
  // browser's own "Stop sharing" UI) via the PiP's own video element, which
  // is fed the real stashed MediaStream. track.stop() alone does not fire
  // 'ended' per spec (that only happens when the track ends externally, the
  // real getDisplayMedia case this simulates) — the mock canvas stream (#91)
  // has no such native signal, so dispatch it explicitly, same as a real
  // "Stop sharing" click would deliver to capture/index.js's listener.
  await page.evaluate(() => {
    const video = document.querySelector('.pip-video');
    for (const track of video.srcObject.getTracks()) {
      track.stop();
      track.dispatchEvent(new Event('ended'));
    }
  });

  // Terminal state: explained before it disappears
  await expect(pipRoot).toBeVisible();
  await expect(pipRoot).toHaveClass(/pip-root--ended/);
  await expect(page.locator('.pip-ended-overlay')).toBeVisible();
  await expect(page.locator('.pip-ended-overlay')).toHaveText('Capture ended');

  // Then it hides itself
  await expect(pipRoot).toBeHidden({ timeout: 4000 });
});
