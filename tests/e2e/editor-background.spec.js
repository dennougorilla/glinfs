/**
 * E2E: background removal authored in the editor.
 *
 * A solid green mock clip gets its background removed with the eyedropper
 * (and a caption on top), then exports as a transparent GIF: the decoded
 * background pixels are alpha 0 while the caption stays opaque, and the
 * WASM encoder (no transparency support) is disabled with its note.
 * @module tests/e2e/editor-background.spec
 */

import { expect, test } from '@playwright/test';
import {
  countGifPixelsNear,
  decodeExportedGif,
  editorFramePointToViewport,
  exportFromEditor,
  exportGifAndWait,
  gifPixel,
  gotoEditorWithClip,
  pauseEditorPlayback,
} from './helpers/app.js';

const WIDTH = 160;
const HEIGHT = 120;
const FRAME_COUNT = 4;

/** @param {import('@playwright/test').Page} page */
async function readEditorState(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.getEditorState());
}

/**
 * Alpha of a pixel of the editor's preview (base) canvas
 * @param {import('@playwright/test').Page} page
 * @param {number} x
 * @param {number} y
 */
async function previewAlpha(page, x, y) {
  return page.evaluate(
    ([px, py]) => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.editor-canvas'));
      return canvas.getContext('2d')?.getImageData(px, py, 1, 1).data[3];
    },
    [x, y],
  );
}

/** @param {import('@playwright/test').Page} page */
async function openBackgroundPanel(page) {
  const accordion = page.locator('#editor-bg-accordion');
  if ((await accordion.getAttribute('open')) === null) {
    await accordion.locator('summary').click();
  }
  await expect(page.locator('#background-enabled')).toBeVisible();
}

test.describe('Editor background removal', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, {
      frameCount: FRAME_COUNT,
      fps: 10,
      width: WIDTH,
      height: HEIGHT,
      pattern: 'solid',
      color: '#00ff00',
    });
    await pauseEditorPlayback(page);
  });

  test('eyedropper removes the solid background; the export is transparent with an opaque caption', async ({
    page,
  }) => {
    test.slow();

    // A red caption in the middle of the frame
    await page.locator('#text-add').click();
    await page.locator('#text-layer-text').fill('HI');
    await page.locator('#text-layer-size').fill('30');
    await page.locator('#text-layer-color').fill('#ff0000');
    const center = await editorFramePointToViewport(page, 0.5 * WIDTH, 0.85 * HEIGHT);
    const target = await editorFramePointToViewport(page, 0.5 * WIDTH, 0.5 * HEIGHT);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.textLayers[0].y)
      .toBeCloseTo(0.5, 1);

    // Eyedropper: pick the background from the preview
    await openBackgroundPanel(page);
    await page.locator('.editor-bg-pick').click();
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(true);
    await expect(page.locator('#background-pick-status')).toContainText('Click the background');
    await expect(page.locator('#background-pick')).toBeChecked();

    const corner = await editorFramePointToViewport(page, 8, 8);
    await page.mouse.click(corner.x, corner.y);

    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ enabled: true, color: '#00ff00' });
    let state = await readEditorState(page);
    expect(state?.pickingKeyColor).toBe(false);
    // The pick selected nothing else: the caption keeps its position, no crop
    expect(state?.cropArea).toBeNull();
    await expect(page.locator('#background-enabled')).toBeChecked();
    await expect(page.locator('#background-color')).toHaveValue('#00ff00');

    // The preview shows the removal (checkerboard shows through)
    await expect.poll(() => previewAlpha(page, 2, 2)).toBe(0);
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2 - 2)).toBe(255);

    // Text-only edits reuse the keyed frame: no new pixel readback
    const before = await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats());
    expect(before?.readbacks).toBeGreaterThan(0);
    await page.locator('#text-layer-text').fill('HEY');
    await page.locator('#text-layer-size').fill('25');
    await expect
      .poll(async () => (await readEditorState(page))?.edits.textLayers[0].text)
      .toBe('HEY');
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats());
    expect(after?.readbacks).toBe(before?.readbacks);

    await exportFromEditor(page);

    // Transparency forces the JavaScript encoder; the WASM card explains why
    const wasmCard = page.locator('[data-encoder-id="gifsicle-wasm"]');
    await expect(wasmCard).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('export-transparency-encoder-note')).toHaveText(
      'Transparent GIFs use the JavaScript encoder',
    );
    await expect(page.locator('[data-encoder-id="gifenc-js"]')).toHaveClass(/selected/);
    await expect(page.getByTestId('export-transparency-badge')).toBeVisible();

    await exportGifAndWait(page);
    const frames = await decodeExportedGif(page);
    expect(frames).toHaveLength(FRAME_COUNT);

    state = await readEditorState(page);
    const fontPx = Math.round(0.25 * HEIGHT);
    const textRect = {
      x0: WIDTH / 2 - 1.8 * fontPx,
      y0: HEIGHT / 2 - 0.8 * fontPx,
      x1: WIDTH / 2 + 1.8 * fontPx,
      y1: HEIGHT / 2 + 0.8 * fontPx,
    };
    for (const frame of frames) {
      expect([frame.width, frame.height]).toEqual([WIDTH, HEIGHT]);
      // Background: fully transparent at the border and far from the text
      for (const [x, y] of [
        [0, 0],
        [2, 2],
        [WIDTH - 1, HEIGHT - 1],
        [WIDTH - 5, 5],
        [5, HEIGHT - 5],
        [WIDTH / 2, 6],
      ]) {
        expect(gifPixel(frame, x, y)[3], `alpha at (${x}, ${y})`).toBe(0);
      }
      // No green survives anywhere
      expect(countGifPixelsNear(frame, { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT }, [0, 255, 0])).toBe(
        0,
      );
      // The caption stays opaque red
      expect(countGifPixelsNear(frame, textRect, [255, 0, 0])).toBeGreaterThan(100);
    }
  });

  test('Escape leaves the eyedropper without changing the background', async ({ page }) => {
    await openBackgroundPanel(page);
    await page.locator('.editor-bg-pick').click();
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(true);
    await expect(page.locator('.editor-canvas-container')).toHaveClass(/editor-bg-picking/);

    // Focus is still on the toggle (a form control): Escape must work there
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(false);
    await expect(page.locator('#background-pick')).not.toBeChecked();
    await expect(page.locator('.editor-canvas-container')).not.toHaveClass(/editor-bg-picking/);
    expect((await readEditorState(page))?.edits.background.enabled).toBe(false);
  });

  test('enabling removal without a picked color keys out the edge color', async ({ page }) => {
    await openBackgroundPanel(page);
    await page.locator('#background-enabled').check();

    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ enabled: true, color: '#00ff00' });
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2)).toBe(0);

    // Tolerance and mode controls drive the edits
    await page.locator('#background-tolerance').fill('35');
    await page.locator('#background-mode').selectOption('global');
    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ tolerance: 35, mode: 'global' });
    await expect(page.locator('#background-tolerance-value')).toHaveText('35');

    // Turning it off restores the frame
    await page.locator('#background-enabled').uncheck();
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2)).toBe(255);
  });
});
