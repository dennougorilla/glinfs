/**
 * E2E for the docked live source monitor + tabbed sidebar (#100, Layout A).
 * Replaces the floating-PiP spec: the monitor now lives at the top of the
 * editor's left pane, CLIPS/SCENES are tabs, and clip ordering is stable.
 * Drives the real pipeline via the #91 mock-stream hook.
 */

import { expect, test } from '@playwright/test';

test('live monitor docks in the editor, Clip Now works, ordering is stable, tabs switch', async ({
  page,
}) => {
  await page.goto('/glinfs/?testMode=true#/capture');
  await page.waitForFunction(() => window.__TEST_HOOKS__);
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
    localStorage.clear();
  });

  // Start sharing and create the active clip
  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible', timeout: 15000 });

  // The docked monitor is visible with REC and a live buffer readout;
  // no floating overlay exists anymore
  const monitor = page.locator('[data-testid="live-monitor"]');
  await expect(monitor).toBeVisible();
  await expect(monitor.locator('.live-monitor-rec')).toContainText('REC');
  await expect(page.locator('#pip-root')).toHaveCount(0);

  // Clip Now from the dock enqueues; the editor keeps rendering
  await monitor.locator('[data-testid="monitor-clip-now"]').click();
  await expect(page.locator('#clip-queue-badge')).toHaveText('1');
  await expect(page.locator('.editor-canvas')).toBeVisible();

  // Stable ordering (#100): after a second Clip Now, rows are ordered by
  // capture time (newest first) and promoting a queued clip must NOT
  // reorder the rows — only the Editing highlight moves.
  await page.keyboard.press('Shift+C');
  await expect(page.locator('#clip-queue-badge')).toHaveText('2');
  const rows = page.locator('.sidebar-pane[data-pane="clips"] [data-testid="clip-entry"]');
  await expect(rows).toHaveCount(3);
  const idsBefore = await rows.evaluateAll((els) => els.map((e) => e.dataset.clipId));

  // Promote the newest queued clip (first non-active row)
  await page
    .locator(
      '.sidebar-pane[data-pane="clips"] [data-testid="clip-entry"]:not([data-clip-active]) .clip-entry-main',
    )
    .first()
    .click();
  await page.waitForTimeout(2500); // compressed entries decode async
  const idsAfter = await rows.evaluateAll((els) => els.map((e) => e.dataset.clipId));
  expect(idsAfter).toEqual(idsBefore);
  await expect(page.locator('.editor-canvas')).toBeVisible();

  // Source-monitor Live view (#100 follow-up): clicking the dock viewport
  // swaps the center preview to the live feed; x closes it
  await monitor.locator('.live-monitor-viewport').click();
  const overlay = page.locator('[data-testid="live-view-overlay"]');
  await expect(overlay).toBeVisible();
  await overlay.locator('[data-testid="live-view-clip-now"]').click();
  await expect(page.locator('#clip-queue-badge')).toHaveText('3');
  await overlay.locator('[data-testid="live-view-close"]').click();
  await expect(overlay).toBeHidden();

  // Header live strip: visible on non-editor routes while recording
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.locator('#header-live-thumb')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  // Tabs: switching to SCENES hides the clips pane, and back
  await page.locator('[data-testid="tab-scenes"]').click();
  await expect(page.locator('.sidebar-pane[data-pane="clips"]')).toBeHidden();
  await expect(page.locator('.sidebar-pane[data-pane="scenes"]')).toBeVisible();
  await page.locator('[data-testid="tab-clips"]').click();
  await expect(page.locator('.sidebar-pane[data-pane="clips"]')).toBeVisible();

  // Share ends -> monitor explains itself, then hides
  await page.evaluate(() => {
    const video = document.querySelector('[data-testid="live-monitor"] video');
    const stream = video?.srcObject;
    const track = stream?.getVideoTracks?.()[0];
    track?.stop();
    track?.dispatchEvent(new Event('ended'));
  });
  await expect(monitor.locator('.live-monitor-ended')).toBeVisible();
  await expect(page.locator('[data-live-monitor]')).toBeHidden({ timeout: 5000 });
});
