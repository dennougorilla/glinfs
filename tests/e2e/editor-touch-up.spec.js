/**
 * E2E: the mask brush (Background panel → Touch up).
 *
 * A synthetic clip — a red square on a green background — has its green
 * removed by the color key. Brush strokes then refine the removal: Erase on
 * the (kept) red square makes it transparent in the exported GIF, Restore
 * on the (removed) green brings the original green back. "This frame"
 * strokes change one frame, "Selection" strokes every frame in IN..OUT;
 * Undo, Clear on this frame and Clear all take strokes away again. The
 * brush only works while background removal is on and Escape leaves it
 * before anything else.
 * @module tests/e2e/editor-touch-up.spec
 */

import { expect, test } from '@playwright/test';
import {
  decodeExportedGif,
  editorFramePointToViewport,
  editorPreviewAlpha,
  exportFromEditor,
  exportGifAndWait,
  gifPixel,
  gotoCapture,
  pauseEditorPlayback,
} from './helpers/app.js';

const WIDTH = 160;
const HEIGHT = 120;
const FRAME_COUNT = 4;
/** The red square (kept by the color key) */
const SQUARE = { x0: 50, y0: 30, x1: 110, y1: 90 };
/** Brush size slider value: radius 0.1 of the 120 px side = 12 px */
const SIZE_12PX = '40';

/**
 * Make the active clip: FRAME_COUNT frames of a red square on green, then
 * open the editor on it
 * @param {import('@playwright/test').Page} page
 */
async function openSquareClip(page) {
  await gotoCapture(page);
  await page.evaluate(
    async ({ count, width, height, square }) => {
      const frames = [];
      for (let f = 0; f < count; f++) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(square.x0, square.y0, square.x1 - square.x0, square.y1 - square.y0);
        const timestamp = f * 100_000;
        frames.push({
          id: `sq-${f}`,
          frame: new VideoFrame(canvas, { timestamp }),
          timestamp,
          width,
          height,
        });
      }
      window.__TEST_HOOKS__.setClipPayload({
        frames,
        fps: 10,
        capturedAt: Date.now(),
        id: 'square-clip',
      });
      location.hash = '#/editor';
    },
    { count: FRAME_COUNT, width: WIDTH, height: HEIGHT, square: SQUARE },
  );
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
  await pauseEditorPlayback(page);
}

/** @param {import('@playwright/test').Page} page */
function readEditorState(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.getEditorState());
}

/**
 * Open the Background accordion and turn the color key on (the detected
 * edge color is the green)
 * @param {import('@playwright/test').Page} page
 */
async function enableColorKey(page) {
  const accordion = page.locator('#editor-bg-accordion');
  if ((await accordion.getAttribute('open')) === null) {
    await accordion.locator('summary').click();
  }
  await page.locator('#background-enabled').check();
  await expect
    .poll(async () => (await readEditorState(page))?.edits.background)
    .toMatchObject({ enabled: true, color: '#00ff00' });
  await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
}

/**
 * Switch the brush on with a mode and scope, at a 12 px radius
 * @param {import('@playwright/test').Page} page
 * @param {{ mode: 'erase' | 'restore', scope: 'frame' | 'selection' }} options
 */
async function useBrush(page, { mode, scope }) {
  const toggle = page.locator('#touchup-brush');
  if (!(await toggle.isChecked())) {
    await page.locator('label[for="touchup-brush"]').click();
  }
  await expect(toggle).toBeChecked();
  await page.locator(`label[for="touchup-mode-${mode}"]`).click();
  await page.locator(`label[for="touchup-scope-${scope}"]`).click();
  await page.locator('#touchup-size').fill(SIZE_12PX);
  await expect
    .poll(async () => (await readEditorState(page))?.brush)
    .toMatchObject({ on: true, mode, scope, radius: 0.1 });
  await expect(page.locator('#touchup-size-value')).toHaveText('24 px');
}

/**
 * Paint a short horizontal stroke on the preview (frame pixels)
 * @param {import('@playwright/test').Page} page
 * @param {number} x0
 * @param {number} x1
 * @param {number} y
 */
async function paint(page, x0, x1, y) {
  const before = (await readEditorState(page))?.edits.touchUps.length ?? 0;
  const from = await editorFramePointToViewport(page, x0, y);
  const to = await editorFramePointToViewport(page, x1, y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await readEditorState(page))?.edits.touchUps.length)
    .toBe(before + 1);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} frame
 */
async function goToFrame(page, frame) {
  await page.evaluate((f) => window.__TEST_HOOKS__.setEditorState({ currentFrame: f }), frame);
  await expect.poll(async () => (await readEditorState(page))?.currentFrame).toBe(frame);
}

/** @param {import('@playwright/test').Page} page */
async function exportAndDecode(page) {
  await exportFromEditor(page);
  await exportGifAndWait(page);
  const frames = await decodeExportedGif(page);
  expect(frames).toHaveLength(FRAME_COUNT);
  return frames;
}

test.describe('Mask brush (touch up)', () => {
  test.beforeEach(async ({ page }) => {
    await openSquareClip(page);
  });

  test('needs background removal: the section is disabled and says so', async ({ page }) => {
    const accordion = page.locator('#editor-bg-accordion');
    await accordion.locator('summary').click();
    await expect(page.locator('#touchup-section')).toBeVisible();
    await expect(page.locator('#touchup-needs-removal')).toBeVisible();
    await expect(page.locator('#touchup-needs-removal')).toContainText(
      'Touch-ups apply only while background removal is on',
    );
    await expect(page.locator('#touchup-brush')).toBeDisabled();

    await page.locator('#background-enabled').check();
    await expect(page.locator('#touchup-needs-removal')).toBeHidden();
    await expect(page.locator('#touchup-brush')).toBeEnabled();

    // The AI method offers the same section
    await page.locator('label[for="ai-method-ai"]').click();
    await expect(page.locator('#ai-section')).toBeVisible();
    await expect(page.locator('#touchup-section')).toBeVisible();
    await expect(page.locator('#touchup-brush')).toBeEnabled();
  });

  test('Erase on "This frame": only that frame loses the kept pixels in the export', async ({
    page,
  }) => {
    test.slow();
    await enableColorKey(page);
    await goToFrame(page, 1);
    await useBrush(page, { mode: 'erase', scope: 'frame' });

    // The circular cursor follows the pointer over the preview
    const center = await editorFramePointToViewport(page, 80, 60);
    await page.mouse.move(center.x, center.y);
    await expect(page.locator('.editor-brush-cursor')).toBeVisible();

    await paint(page, 70, 90, 60);
    const [stroke] = (await readEditorState(page))?.edits.touchUps ?? [];
    expect(stroke).toMatchObject({ mode: 'erase', start: 1, end: 1, radius: 0.1 });
    // Painted live: the preview already shows the hole
    await expect.poll(() => editorPreviewAlpha(page, 80, 60)).toBe(0);
    await expect(page.locator('#touchup-summary')).toHaveText(
      '1 stroke on this frame, 1 stroke in total.',
    );

    const frames = await exportAndDecode(page);
    // Frame 1: the stroke's path is transparent, the rest of the square red
    expect(gifPixel(frames[1], 80, 60)[3]).toBe(0);
    expect(gifPixel(frames[1], 70, 60)[3]).toBe(0);
    expect(gifPixel(frames[1], 80, 40).slice(0, 3)).toEqual([255, 0, 0]);
    expect(gifPixel(frames[1], 80, 40)[3]).toBe(255);
    // The other frames keep the whole square; the green is removed everywhere
    for (const f of [0, 2, 3]) {
      expect(gifPixel(frames[f], 80, 60), `frame ${f}`).toEqual([255, 0, 0, 255]);
    }
    for (const frame of frames) {
      expect(gifPixel(frame, 10, 10)[3]).toBe(0);
    }
  });

  test('Restore on "Selection": the original green comes back on every frame in the range', async ({
    page,
  }) => {
    test.slow();
    await enableColorKey(page);
    await useBrush(page, { mode: 'restore', scope: 'selection' });
    await paint(page, 15, 35, 20);
    const [stroke] = (await readEditorState(page))?.edits.touchUps ?? [];
    expect(stroke).toMatchObject({ mode: 'restore', start: 0, end: FRAME_COUNT - 1 });
    await expect.poll(() => editorPreviewAlpha(page, 25, 20)).toBe(255);

    const frames = await exportAndDecode(page);
    for (const [f, frame] of frames.entries()) {
      const restored = gifPixel(frame, 25, 20);
      expect(restored[3], `frame ${f}`).toBe(255);
      expect(restored[0]).toBeLessThan(40);
      expect(restored[1]).toBeGreaterThan(215);
      expect(restored[2]).toBeLessThan(40);
      // Outside the stroke the green stays removed
      expect(gifPixel(frame, 25, 60)[3]).toBe(0);
      expect(gifPixel(frame, 80, 60)).toEqual([255, 0, 0, 255]);
    }
  });

  test('Undo, Clear on this frame and Clear all take strokes away', async ({ page }) => {
    test.slow();
    await enableColorKey(page);
    await useBrush(page, { mode: 'restore', scope: 'selection' });
    await paint(page, 15, 35, 20);
    await useBrush(page, { mode: 'erase', scope: 'frame' });
    await paint(page, 70, 90, 60);
    await expect.poll(() => editorPreviewAlpha(page, 80, 60)).toBe(0);

    // Undo removes the last stroke (the erase)
    await page.locator('#touchup-undo').click();
    await expect.poll(async () => (await readEditorState(page))?.edits.touchUps.length).toBe(1);
    await expect.poll(() => editorPreviewAlpha(page, 80, 60)).toBe(255);
    await expect.poll(() => editorPreviewAlpha(page, 25, 20)).toBe(255);

    // Clear on this frame: the selection stroke loses frame 0 only
    await goToFrame(page, 0);
    await page.locator('#touchup-clear-frame').click();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.touchUps)
      .toMatchObject([{ mode: 'restore', start: 1, end: FRAME_COUNT - 1 }]);
    await expect.poll(() => editorPreviewAlpha(page, 25, 20)).toBe(0);
    await expect(page.locator('#touchup-clear-frame')).toBeDisabled();
    await goToFrame(page, 2);
    await expect.poll(() => editorPreviewAlpha(page, 25, 20)).toBe(255);

    // Clear all, then its Undo brings the strokes back
    await page.locator('#touchup-clear-all').click();
    await expect.poll(async () => (await readEditorState(page))?.edits.touchUps.length).toBe(0);
    await expect.poll(() => editorPreviewAlpha(page, 25, 20)).toBe(0);
    await expect(page.locator('#touchup-summary')).toHaveText('No touch-ups yet.');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await readEditorState(page))?.edits.touchUps.length).toBe(1);
    await expect.poll(() => editorPreviewAlpha(page, 25, 20)).toBe(255);
  });

  test('the brush outranks the crop, and Escape leaves the brush before clearing the crop', async ({
    page,
  }) => {
    await enableColorKey(page);
    await page.evaluate(() =>
      window.__TEST_HOOKS__.setEditorState({
        cropArea: { x: 10, y: 10, width: 140, height: 100, aspectRatio: 'free' },
      }),
    );
    await useBrush(page, { mode: 'erase', scope: 'frame' });
    await paint(page, 20, 60, 100);
    // The drag painted instead of drawing a new crop
    expect((await readEditorState(page))?.cropArea).toMatchObject({ x: 10, width: 140 });

    await page.locator('.editor-canvas-overlay').hover();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(false);
    await expect(page.locator('#touchup-brush')).not.toBeChecked();
    expect((await readEditorState(page))?.cropArea).not.toBeNull();
    await expect(page.locator('.editor-brush-cursor')).toBeHidden();

    // Turning removal off switches the brush off; its strokes stay stored
    await page.locator('label[for="touchup-brush"]').click();
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(true);
    await page.locator('#background-enabled').uncheck();
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(false);
    expect((await readEditorState(page))?.edits.touchUps).toHaveLength(1);
  });
});
