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
import gifenc from 'gifenc';
import {
  countGifPixelsNear,
  decodeExportedGif,
  editorFramePointToViewport,
  exportFromEditor,
  exportGifAndWait,
  gifPixel,
  gotoCapture,
  gotoEditorWithClip,
  openSidebarTab,
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
  await openSidebarTab(page, 'background');
  await expect(page.locator('label[for="subject-none"]')).toBeVisible();
}

/**
 * Turn removal on (the key color controls only show then) and set a key
 * color that is not the clip's, so a later eyedropper pick visibly changes it
 * @param {import('@playwright/test').Page} page
 */
async function enableWithOtherColor(page) {
  await openBackgroundPanel(page);
  await page.locator('label[for="subject-color"]').click();
  await page.locator('#background-color').fill('#ff00ff');
  await expect
    .poll(async () => (await readEditorState(page))?.edits.background)
    .toMatchObject({ enabled: true, color: '#ff00ff' });
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
    await openSidebarTab(page, 'text');
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

    // Eyedropper: pick the background from the preview (its controls show
    // once removal is on)
    await enableWithOtherColor(page);
    await page.locator('label[for="background-pick"]').click();
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(true);
    // The active tool is obvious: its button, the cursor and a hint on the preview
    await expect(page.locator('#background-pick')).toBeChecked();
    await expect(page.locator('#preview-tool-hint')).toHaveText(/Click the color to remove/);
    await expect(page.locator('.editor-canvas-container')).toHaveAttribute(
      'data-tool',
      'eyedropper',
    );

    const corner = await editorFramePointToViewport(page, 8, 8);
    await page.mouse.click(corner.x, corner.y);

    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ enabled: true, color: '#00ff00' });
    let state = await readEditorState(page);
    expect(state?.pickingKeyColor).toBe(false);
    // The pick selected nothing else: the caption keeps its position, no crop
    expect(state?.cropArea).toBeNull();
    await expect(page.locator('#subject-color')).toBeChecked();
    await expect(page.locator('#background-color')).toHaveValue('#00ff00');
    await expect(page.locator('#preview-tool-hint')).toBeHidden();

    // The preview shows the removal (checkerboard shows through)
    await expect.poll(() => previewAlpha(page, 2, 2)).toBe(0);
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2 - 2)).toBe(255);

    // Text-only edits reuse the keyed frame: no new pixel readback
    const before = await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats());
    expect(before?.readbacks).toBeGreaterThan(0);
    await openSidebarTab(page, 'text');
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

  test('a crop drag does not re-key the frame on every pointer move', async ({ page }) => {
    await openBackgroundPanel(page);
    await page.locator('label[for="subject-color"]').click();
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2)).toBe(0);
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats());

    const from = await editorFramePointToViewport(page, 20, 20);
    const to = await editorFramePointToViewport(page, 120, 90);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await expect
      .poll(async () => (await readEditorState(page))?.cropArea?.width ?? 0)
      .toBeGreaterThan(80);
    await page.waitForTimeout(100);
    // Mid-drag: the crop moved several times, nothing was read back
    const during = await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats());
    expect(during?.readbacks).toBe(before?.readbacks);

    await page.mouse.up();
    // Released: the final region is keyed exactly once
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats()))?.readbacks,
      )
      .toBe((before?.readbacks ?? 0) + 1);
    await expect.poll(() => previewAlpha(page, 60, 50)).toBe(0);
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => window.__TEST_HOOKS__.getEditorPreviewStats());
    expect(after?.readbacks).toBe((before?.readbacks ?? 0) + 1);
  });

  test('dragging Similar colors never flickers: no unkeyed frame, no layout shift', async ({
    page,
  }) => {
    await openBackgroundPanel(page);
    await page.locator('label[for="subject-color"]').click();
    await expect.poll(() => previewAlpha(page, 2, 2)).toBe(0);
    const slider = page.locator('#background-tolerance');
    await slider.scrollIntoViewIfNeeded();

    // Every animation frame: the preview's background pixel, and where the
    // slider is (a status line popping in above it would move it)
    await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.editor-canvas'));
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      const input = /** @type {HTMLElement} */ (document.querySelector('#background-tolerance'));
      const w = /** @type {any} */ (window);
      w.__samples = [];
      w.__probe = true;
      const tick = () => {
        w.__samples.push({
          alpha: ctx.getImageData(2, 2, 1, 1).data[3],
          top: Math.round(input.getBoundingClientRect().top),
        });
        if (w.__probe) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const box = await slider.boundingBox();
    if (!box) throw new Error('slider not visible');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.15, y);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) {
      await page.mouse.move(box.x + box.width * (0.15 + (0.35 * i) / 30), y);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    const samples = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__probe = false;
      return /** @type {{ alpha: number, top: number }[]} */ (w.__samples);
    });
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.filter((s) => s.alpha !== 0)).toEqual([]);
    expect(new Set(samples.map((s) => s.top)).size).toBe(1);
    expect((await readEditorState(page))?.edits.background.tolerance).toBeGreaterThan(20);
  });

  test('Escape leaves the eyedropper without changing the background', async ({ page }) => {
    await enableWithOtherColor(page);
    await page.locator('label[for="background-pick"]').click();
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(true);
    await expect(page.locator('.editor-canvas-container')).toHaveClass(/editor-bg-picking/);

    // Focus is still on the toggle (a form control): Escape must work there
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(false);
    await expect(page.locator('#background-pick')).not.toBeChecked();
    await expect(page.locator('.editor-canvas-container')).not.toHaveClass(/editor-bg-picking/);
    expect((await readEditorState(page))?.edits.background).toMatchObject({
      enabled: true,
      color: '#ff00ff',
    });
  });

  test('enabling removal without a picked color keys out the edge color', async ({ page }) => {
    await openBackgroundPanel(page);
    await page.locator('label[for="subject-color"]').click();

    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ enabled: true, color: '#00ff00' });
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2)).toBe(0);

    // Similar colors and Edges only / Everywhere (always visible) drive the edits
    await expect(page.locator('#background-tolerance')).toBeVisible();
    await page.locator('#background-tolerance').fill('35');
    await page.locator('label[for="background-mode-global"]').click();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ tolerance: 35, mode: 'global' });
    await expect(page.locator('#background-tolerance')).toHaveAttribute('aria-valuetext', '35');

    // Reset: defaults back, the edge color detected again
    await page.locator('#background-reset').click();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ tolerance: 20, mode: 'connected', color: '#00ff00', colorChosen: false });

    // Turning it off restores the frame
    await page.locator('label[for="subject-none"]').click();
    await expect.poll(() => previewAlpha(page, WIDTH / 2, HEIGHT / 2)).toBe(255);
  });
});

/**
 * A transparent sticker GIF (built in Node with gifenc): a white 24x16 box
 * with a 2 px black outline in the middle of a transparent 64x48 frame.
 * Palette: 0 = transparent, 1 = black, 2 = white.
 * @returns {Buffer}
 */
function buildStickerGif() {
  const width = 64;
  const height = 48;
  const index = new Uint8Array(width * height);
  for (let y = 16; y < 32; y++) {
    for (let x = 20; x < 44; x++) {
      const outline = y < 18 || y >= 30 || x < 22 || x >= 42;
      index[y * width + x] = outline ? 1 : 2;
    }
  }
  const gif = gifenc.GIFEncoder();
  gif.writeFrame(index, width, height, {
    palette: [
      [0, 0, 0],
      [0, 0, 0],
      [255, 255, 255],
    ],
    delay: 100,
    transparent: true,
    transparentIndex: 0,
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

test.describe('Background removal on an already transparent clip', () => {
  test.beforeEach(async ({ page }) => {
    await gotoCapture(page);
    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'sticker.gif',
      mimeType: 'image/gif',
      buffer: buildStickerGif(),
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await expect.poll(async () => (await readEditorState(page))?.hasAlpha).toBe(true);
    await pauseEditorPlayback(page);
    await openBackgroundPanel(page);
  });

  test('enabling removal does not key out black and keeps the dark outline', async ({ page }) => {
    await page.locator('label[for="subject-color"]').click();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.background.enabled)
      .toBe(true);
    // No opaque border color to detect: the key color is not the black that
    // transparent pixels read back as
    expect((await readEditorState(page))?.edits.background.color).not.toBe('#000000');
    await expect(page.locator('#live-region')).toContainText('already transparent');
    // The outline and the fill survive in the preview
    await page.waitForTimeout(100);
    expect(await previewAlpha(page, 20, 20)).toBe(255);
    expect(await previewAlpha(page, 30, 24)).toBe(255);
    expect(await previewAlpha(page, 2, 2)).toBe(0);
  });

  test('the eyedropper on a transparent area picks nothing and stays on', async ({ page }) => {
    await page.locator('label[for="subject-color"]').click();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.background.enabled)
      .toBe(true);
    const keyBefore = (await readEditorState(page))?.edits.background.color;
    await page.evaluate(() => {
      const live = document.getElementById('live-region');
      if (live) live.textContent = '';
    });
    await page.locator('label[for="background-pick"]').click();
    await expect.poll(async () => (await readEditorState(page))?.pickingKeyColor).toBe(true);
    const corner = await editorFramePointToViewport(page, 4, 4);
    await page.mouse.click(corner.x, corner.y);

    await expect(page.locator('#live-region')).toContainText('already transparent');
    const state = await readEditorState(page);
    expect(state?.edits.background.color).toBe(keyBefore);
    expect(state?.edits.background.color).not.toBe('#000000');
    expect(state?.pickingKeyColor).toBe(true);

    // A colored pixel still picks: white inside the outline
    const inside = await editorFramePointToViewport(page, 32, 24);
    await page.mouse.click(inside.x, inside.y);
    await expect
      .poll(async () => (await readEditorState(page))?.edits.background)
      .toMatchObject({ enabled: true, color: '#ffffff' });
    expect(await previewAlpha(page, 20, 20)).toBe(255);
  });
});
