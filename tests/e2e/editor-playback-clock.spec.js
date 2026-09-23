/**
 * E2E Tests for the editor playback clock (#99 item a)
 * @module tests/e2e/editor-playback-clock.spec
 *
 * Playback must advance at the clip's fps in wall-clock time, even when the
 * main thread is busy and animation-frame ticks arrive late.
 */

import { expect, test } from '@playwright/test';
import { gotoEditorWithClip } from './helpers/app.js';

const MEASURE_MS = 2000;

/**
 * Measure playback speed in frames per wall-clock second
 * @param {import('@playwright/test').Page} page
 * @param {{ busyMs?: number, busyEveryMs?: number }} [load] - Optional main-thread long tasks
 * @returns {Promise<number>}
 */
async function measurePlaybackFps(page, load = {}) {
  return page.evaluate(
    async ({ measureMs, busyMs, busyEveryMs }) => {
      const hooks = window.__TEST_HOOKS__;
      // Seek to the first frame so the measurement window never wraps
      hooks.setEditorState({ currentFrame: 0 });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      let busyTimer = null;
      if (busyMs) {
        busyTimer = setInterval(() => {
          const until = performance.now() + busyMs;
          while (performance.now() < until) {
            // Simulate a long task blocking the main thread
          }
        }, busyEveryMs);
      }

      const startFrame = hooks.getEditorState().currentFrame;
      const startTime = performance.now();
      await new Promise((resolve) => setTimeout(resolve, measureMs));
      const endFrame = hooks.getEditorState().currentFrame;
      const endTime = performance.now();

      if (busyTimer !== null) clearInterval(busyTimer);
      return ((endFrame - startFrame) * 1000) / (endTime - startTime);
    },
    { measureMs: MEASURE_MS, busyMs: load.busyMs ?? 0, busyEveryMs: load.busyEveryMs ?? 0 },
  );
}

test.describe('Editor playback clock', () => {
  for (const fps of [15, 30]) {
    test(`plays a ${fps}fps clip at ~${fps} frames per wall-clock second`, async ({ page }) => {
      // Enough frames that the measurement window never loops
      await gotoEditorWithClip(page, { frameCount: fps * 4, fps, width: 160, height: 120 });

      const measured = await measurePlaybackFps(page);
      test.info().annotations.push({ type: 'measured-fps', description: measured.toFixed(2) });
      expect(measured).toBeGreaterThan(fps * 0.85);
      expect(measured).toBeLessThan(fps * 1.15);
    });
  }

  test('keeps ~30fps when long main-thread tasks delay animation frames', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 120, fps: 30, width: 160, height: 120 });

    // 80ms long task every 100ms: ticks land far apart, so a one-frame-per-tick
    // clock would fall to roughly a third of real time
    const measured = await measurePlaybackFps(page, { busyMs: 80, busyEveryMs: 100 });
    test.info().annotations.push({ type: 'measured-fps', description: measured.toFixed(2) });
    expect(measured).toBeGreaterThan(30 * 0.85);
    expect(measured).toBeLessThan(30 * 1.15);
  });
});
