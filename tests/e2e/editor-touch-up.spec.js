/**
 * E2E: the mask brush (Background panel → Touch up).
 *
 * A synthetic clip — a red square on a green background — has its green
 * removed by the color key. Brush strokes then refine the removal: Erase on
 * the (kept) red square makes it transparent in the exported GIF, Restore
 * on the (removed) green brings the original green back. "This frame"
 * strokes change one frame, "Selection" strokes every frame in IN..OUT;
 * Undo, Clear on this frame and Clear all take strokes away again. The
 * brush is the sidebar's Touch up mode (entered from the Background tab,
 * left with Done or Escape) and only works while background removal is on;
 * Escape cancels a stroke in progress, then leaves the mode before anything
 * else, and a stroke that leaves the preview stops at its edge. The
 * preview's Result / Original / Mask switch shows the removal differently
 * without changing the export. Over the AI cutout (stub model on the WASM
 * fallback, two-disc clip) the same strokes erase a kept character and
 * restore removed background.
 * @module tests/e2e/editor-touch-up.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  chooseAiCutout,
  closeExportDialog,
  decodeExportedGif,
  discClip,
  editorFramePointToViewport,
  editorPreviewAlpha,
  exportFromEditor,
  exportGifAndWait,
  gifPixel,
  gotoCapture,
  gotoCaptureWithStubModel,
  injectDiscClip,
  openSidebarTab,
  pauseEditorPlayback,
  serveStubModel,
  waitForAiMasks,
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
 * Open the Background tab and turn the color key on (the detected edge
 * color is the green)
 * @param {import('@playwright/test').Page} page
 */
async function enableColorKey(page) {
  await openSidebarTab(page, 'background');
  await page.locator('#background-enabled').check();
  await expect
    .poll(async () => (await readEditorState(page))?.edits.background)
    .toMatchObject({ enabled: true, color: '#00ff00' });
  await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
}

/**
 * RGBA of a preview canvas pixel (frame pixels)
 * @param {import('@playwright/test').Page} page
 * @param {number} x
 * @param {number} y
 * @returns {Promise<number[]>}
 */
function previewPixel(page, x, y) {
  return page.evaluate(
    ([px, py]) => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.editor-canvas'));
      return Array.from(canvas.getContext('2d')?.getImageData(px, py, 1, 1).data ?? []);
    },
    [x, y],
  );
}

/**
 * Switch the brush on with a mode and scope, at radius 0.1 of the shorter
 * side (12 px on the 120 px tall square clip)
 * @param {import('@playwright/test').Page} page
 * @param {{ mode: 'erase' | 'restore', scope: 'frame' | 'selection', diameter?: string }} options
 */
async function useBrush(page, { mode, scope, diameter = '24 px' }) {
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
  await expect(page.locator('#touchup-size-value')).toHaveText(diameter);
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} [frameCount]
 */
async function exportAndDecode(page, frameCount = FRAME_COUNT) {
  await exportFromEditor(page);
  await exportGifAndWait(page);
  const frames = await decodeExportedGif(page);
  expect(frames).toHaveLength(frameCount);
  return frames;
}

test.describe('Mask brush (touch up)', () => {
  test.beforeEach(async ({ page }) => {
    await openSquareClip(page);
  });

  test('Background tab: off shows only the switch; on shows one method and the Touch up entry', async ({
    page,
  }) => {
    await openSidebarTab(page, 'background');
    await expect(page.locator('#background-lead')).toBeVisible();
    await expect(page.locator('#background-settings')).toBeHidden();
    await expect(page.locator('label[for="touchup-brush"]')).toBeHidden();
    await expect(page.locator('#preview-view')).toBeHidden();
    await expect(page.locator('#editor-side-tab-badge')).toBeHidden();

    await page.locator('#background-enabled').check();
    await expect(page.locator('#background-lead')).toBeHidden();
    await expect(page.locator('#ai-color-fields')).toBeVisible();
    await expect(page.locator('#ai-section')).toBeHidden();
    await expect(page.locator('#background-mode')).toBeHidden(); // under Advanced
    await expect(page.locator('#touchup-brush')).toBeEnabled();
    await expect(page.locator('#touchup-needs-removal')).toBeHidden();
    await expect(page.locator('#preview-view')).toBeVisible();
    // The Background tab shows removal is on from the other tabs
    await expect(page.locator('#editor-side-tab-badge')).toBeVisible();

    // The AI method replaces the color settings and offers the same entry
    await page.locator('label[for="ai-method-ai"]').click();
    await expect(page.locator('#ai-section')).toBeVisible();
    await expect(page.locator('#ai-color-fields')).toBeHidden();
    await expect(page.locator('#ai-intro')).toBeHidden(); // under About models
    await expect(page.locator('#touchup-brush')).toBeEnabled();
  });

  test('Touch up mode: the tools replace the tabs; Done and Escape leave it and keep the strokes', async ({
    page,
  }) => {
    await enableColorKey(page);
    await page.locator('label[for="touchup-brush"]').click();
    await expect(page.locator('#touchup-section')).toBeVisible();
    await expect(page.locator('#touchup-title')).toHaveText('Touch up');
    await expect(page.getByRole('tablist', { name: 'Properties' })).toBeHidden();
    await expect(page.locator('#editor-side-panel-background')).toBeHidden();
    await expect(page.locator('.editor-canvas-container')).toHaveClass(/editor-brush-painting/);

    await page.locator('#touchup-size').fill(SIZE_12PX);
    await paint(page, 70, 90, 60);
    await page.locator('#touchup-done').click();
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(false);
    await expect(page.locator('#touchup-section')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Background', selected: true })).toBeVisible();
    await expect(page.locator('#touchup-brush')).toBeFocused();
    await expect(page.locator('#touchup-entry-summary')).toContainText('1 stroke in total');
    await expect(page.locator('.editor-canvas-container')).not.toHaveClass(/editor-brush-painting/);
    // Done keeps the stroke (already applied); painting is off outside the mode
    expect((await readEditorState(page))?.edits.touchUps).toHaveLength(1);
    await expect.poll(() => editorPreviewAlpha(page, 80, 60)).toBe(0);

    // Escape from a mode control leaves it too
    await page.locator('label[for="touchup-brush"]').click();
    await expect(page.locator('#touchup-done')).toBeFocused();
    await page.locator('label[for="touchup-mode-restore"]').click();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(false);
    await expect(page.getByRole('tablist', { name: 'Properties' })).toBeVisible();
    expect((await readEditorState(page))?.edits.touchUps).toHaveLength(1);
  });

  test('preview view switch: Original shows the frame, Mask tints the removed area; export unchanged', async ({
    page,
  }) => {
    await enableColorKey(page);
    const result = await previewPixel(page, 10, 10);
    expect(result[3]).toBe(0);

    await page.locator('label[for="preview-view-original"]').click();
    await expect.poll(async () => (await readEditorState(page))?.previewView).toBe('original');
    await expect.poll(() => previewPixel(page, 10, 10)).toEqual([0, 255, 0, 255]);

    await page.locator('label[for="preview-view-mask"]').click();
    await expect.poll(async () => (await previewPixel(page, 10, 10))[3]).toBe(255);
    const removed = await previewPixel(page, 10, 10);
    // Removed green reads red; the kept square keeps its own red untouched
    expect(removed[0]).toBeGreaterThan(removed[1]);
    expect(removed[0]).toBeGreaterThan(150);
    expect(await previewPixel(page, 80, 60)).toEqual([255, 0, 0, 255]);

    // View only: the export is still the transparent result
    const frames = await exportAndDecode(page);
    expect(gifPixel(frames[0], 10, 10)[3]).toBe(0);
    await closeExportDialog(page);

    // Removal off hides the switch and shows the plain frame
    await openSidebarTab(page, 'background');
    await page.locator('#background-enabled').uncheck();
    await expect(page.locator('#preview-view')).toBeHidden();
    await expect.poll(() => previewPixel(page, 10, 10)).toEqual([0, 255, 0, 255]);
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

  test('Escape cancels a stroke in progress; a stroke leaving the preview stops at its edge', async ({
    page,
  }) => {
    await enableColorKey(page);
    await useBrush(page, { mode: 'restore', scope: 'frame' });
    const touchUps = async () => (await readEditorState(page))?.edits.touchUps ?? [];

    // Escape while the pointer is down: the live stroke goes, nothing is added
    const a = await editorFramePointToViewport(page, 20, 20);
    const b = await editorFramePointToViewport(page, 40, 20);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await expect.poll(() => editorPreviewAlpha(page, 30, 20)).toBe(255);
    await page.keyboard.press('Escape');
    await expect.poll(() => editorPreviewAlpha(page, 30, 20)).toBe(0);
    await page.mouse.move(a.x, a.y, { steps: 4 });
    await page.mouse.up();
    expect(await touchUps()).toEqual([]);
    expect((await readEditorState(page))?.brush.on).toBe(true);

    // Out past the right edge, down, and back in: two strokes, nothing
    // painted along the edge between them
    const path = [
      [140, 30],
      [200, 30],
      [200, 90],
      [140, 90],
    ];
    const start = await editorFramePointToViewport(page, path[0][0], path[0][1]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [x, y] of path.slice(1)) {
      const to = await editorFramePointToViewport(page, x, y);
      await page.mouse.move(to.x, to.y, { steps: 6 });
    }
    await page.mouse.up();
    await expect.poll(async () => (await touchUps()).length).toBe(2);
    for (const stroke of await touchUps()) {
      for (const point of stroke.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
      }
    }
    await expect.poll(() => editorPreviewAlpha(page, 150, 30)).toBe(255);
    await expect.poll(() => editorPreviewAlpha(page, 150, 90)).toBe(255);
    expect(await editorPreviewAlpha(page, 157, 60)).toBe(0);
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

    // Turning removal off switches the brush off (and leaves the mode); its
    // strokes stay stored
    await page.locator('label[for="touchup-brush"]').click();
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(true);
    await page.evaluate(() => {
      const { edits } = window.__TEST_HOOKS__.getEditorState();
      window.__TEST_HOOKS__.setEditorState({
        edits: { ...edits, background: { ...edits.background, enabled: false } },
      });
    });
    await expect.poll(async () => (await readEditorState(page))?.brush.on).toBe(false);
    await expect(page.locator('#touchup-section')).toBeHidden();
    await expect(page.getByRole('tablist', { name: 'Properties' })).toBeVisible();
    expect((await readEditorState(page))?.edits.touchUps).toHaveLength(1);
  });
});

const STUB_MODEL = readFileSync(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const STUB_SHA256 = createHash('sha256').update(STUB_MODEL).digest('hex');

test.describe('Mask brush over the AI cutout (stub model, WASM fallback)', () => {
  // Compiles ONNX Runtime's WASM binary in a fresh context
  test.describe.configure({ timeout: 240_000 });

  test('Erase removes part of a kept character on one frame; Restore brings back background on all', async ({
    page,
  }) => {
    const count = 4;
    const { discA, discB } = discClip;
    await serveStubModel(page, STUB_MODEL);
    await gotoCaptureWithStubModel(page, {
      sha256: STUB_SHA256,
      bytes: STUB_MODEL.length,
      allowWasm: true,
    });
    await injectDiscClip(page, { count });
    await pauseEditorPlayback(page);
    await chooseAiCutout(page);
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`${count} of ${count} frames analyzed`, {
      timeout: 60_000,
    });
    await waitForAiMasks(page);

    // Touch-ups work over the AI method like over the color key
    await goToFrame(page, 0);
    await useBrush(page, { mode: 'erase', scope: 'frame', diameter: '32 px' });
    await paint(page, discA(0).x - 4, discA(0).x + 4, discA(0).y);
    await expect.poll(() => editorPreviewAlpha(page, discA(0).x, discA(0).y)).toBe(0);
    await useBrush(page, { mode: 'restore', scope: 'selection', diameter: '32 px' });
    await paint(page, 110, 130, 20);
    await expect.poll(() => editorPreviewAlpha(page, 120, 20)).toBe(255);
    // Painting never rebuilt the AI masks (strokes live outside the AI settings)
    expect((await readEditorState(page))?.aiCutout.building).toBe(false);

    const frames = await exportAndDecode(page, count);
    expect(gifPixel(frames[0], discA(0).x, discA(0).y)[3]).toBe(0);
    for (const [f, frame] of frames.entries()) {
      if (f > 0)
        expect(gifPixel(frame, discA(f).x, discA(f).y), `frame ${f}`).toEqual([255, 255, 255, 255]);
      // Disc B stays; the restored background is the original black
      expect(gifPixel(frame, discB(f).x, discB(f).y)[3]).toBe(255);
      expect(gifPixel(frame, 120, 20)).toEqual([0, 0, 0, 255]);
      expect(gifPixel(frame, 5, 5)[3]).toBe(0);
    }
  });
});
