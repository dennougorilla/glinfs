import { expect, test } from '@playwright/test';
import { gotoEditorWithClip } from './helpers/app.js';

/**
 * A preview draw scheduled before the clip's frames were closed (a delete,
 * whose Undo hold then ends) must not throw. A real VideoFrame has no
 * `closed` property, so the guard has to read its coded size.
 */
test('a preview draw on closed frames draws nothing and throws nothing', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await gotoEditorWithClip(page, { frameCount: 6, width: 320, height: 180 });

  const closed = await page.evaluate(() => {
    const frames = window.__TEST_HOOKS__.getClipPayload()?.frames ?? [];
    for (const f of frames) f.frame.close();
    return frames.map((f) => ({ codedWidth: f.frame.codedWidth, hasClosed: 'closed' in f.frame }));
  });
  // Real frames: closed ones read 0 x 0 and have no `closed` property
  expect(closed.length).toBeGreaterThan(0);
  expect(closed.every((f) => f.codedWidth === 0 && !f.hasClosed)).toBe(true);

  // Each step schedules a preview draw of a closed frame
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);

  expect(errors.filter((m) => m.includes('closed'))).toEqual([]);
});
