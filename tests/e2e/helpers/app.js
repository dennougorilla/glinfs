/**
 * Shared E2E navigation helpers
 * @module tests/e2e/helpers/app
 *
 * All helpers follow the reliable "awaited injection -> same-document hash
 * navigation" pattern (#48). A full `page.goto('/#/editor')` reload would wipe
 * payloads injected via __TEST_HOOKS__, so navigation after injection must be
 * done by assigning `location.hash` instead.
 */

import { expect } from '@playwright/test';

/**
 * Navigate to the capture screen (full page load, enables test mode hooks)
 * @param {import('@playwright/test').Page} page
 */
export async function gotoCapture(page) {
  await page.goto('/#/capture');
  await page.waitForSelector('.capture-screen', { state: 'visible' });
}

/**
 * Load the editor with an injected mock clip
 * @param {import('@playwright/test').Page} page
 * @param {{ frameCount?: number, fps?: number, width?: number, height?: number }} [options]
 */
export async function gotoEditorWithClip(page, options = {}) {
  await gotoCapture(page);

  await page.evaluate(async (opts) => {
    await window.__TEST_HOOKS__.injectMockClipPayload(opts);
  }, options);

  await page.evaluate(() => {
    location.hash = '#/editor';
  });

  // `.editor-screen` alone is ambiguous (the "Invalid Clip Data" error screen
  // uses it too); the canvas only exists when a clip actually loaded.
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
}

/**
 * Pause the editor's auto-playback via the play/pause button.
 *
 * The editor starts playing on entry, which mutates state every frame tick.
 * Editor state updates flow through a throttled subscription that only keeps
 * the latest (state, prevState) pair, so background playback churn can
 * swallow one-shot transitions (e.g. crop cleared) and make UI assertions
 * racy. Pause first when a test asserts on state-driven UI updates.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function pauseEditorPlayback(page) {
  const playBtn = page.locator('.btn-play');
  if ((await playBtn.getAttribute('aria-label')) === 'Pause') {
    await playBtn.click();
  }
  await expect(playBtn).toHaveAttribute('aria-label', 'Play');
}

/**
 * Load the export screen with an injected mock editor payload
 *
 * `pattern`/`color` style both payloads' frames (the export reads the clip
 * payload's), `edits`/`hasAlpha` go on the editor payload, and `sourceName`
 * marks the clip as imported (identical-frame merging on export).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ frameCount?: number, fps?: number, width?: number, height?: number, selectedRange?: { start: number, end: number }, cropArea?: object | null, pattern?: 'gradient' | 'checkerboard' | 'solid' | 'numbered', color?: string, edits?: object, hasAlpha?: boolean, sourceName?: string }} [options]
 */
export async function gotoExportWithClip(page, options = {}) {
  await gotoCapture(page);

  await page.evaluate(async (opts) => {
    await window.__TEST_HOOKS__.injectMockEditorPayload(opts);
  }, options);

  await page.evaluate(() => {
    location.hash = '#/export';
  });

  // `.export-screen` alone is ambiguous (the "No clip data available" error
  // screen uses it too); the canvas only exists when a payload actually loaded.
  await page.waitForSelector('.export-canvas', { state: 'visible' });
}

/**
 * Click Export on the export screen and wait for the complete screen
 * @param {import('@playwright/test').Page} page
 */
export async function exportGifAndWait(page) {
  await page.locator('.btn-export-main').click();
  await expect(page.locator('.export-complete-v2')).toBeVisible({ timeout: 60000 });
}

/**
 * @typedef {Object} DecodedGifFrame
 * @property {number} width
 * @property {number} height
 * @property {number} durationMs - Frame duration reported by ImageDecoder
 * @property {number[]} rgba - Composited RGBA pixels (row-major)
 */

/**
 * Decode the GIF the export screen just produced, in the page, with
 * ImageDecoder — the same decoder a browser uses to show it. Requires the
 * export screen to still be mounted (the result is dropped on leave).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<DecodedGifFrame[]>}
 */
export async function decodeExportedGif(page) {
  return page.evaluate(async () => {
    const base64 = await window.__TEST_HOOKS__.getExportResultBase64();
    if (!base64) throw new Error('No exported GIF');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await decoder.tracks.ready;
    await decoder.completed;
    const { frameCount } = decoder.tracks.selectedTrack;

    const frames = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const { image } = await decoder.decode({ frameIndex });
      const width = image.displayWidth;
      const height = image.displayHeight;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      frames.push({
        width,
        height,
        durationMs: (image.duration ?? 0) / 1000,
        rgba: Array.from(data),
      });
      image.close();
    }
    decoder.close();
    return frames;
  });
}

/**
 * Leave the editor for the export screen through its toolbar button
 * @param {import('@playwright/test').Page} page
 */
export async function exportFromEditor(page) {
  await page.getByRole('button', { name: 'Export as GIF' }).click();
  await page.waitForSelector('.export-canvas', { state: 'visible' });
}

/**
 * Viewport position of a frame-pixel point on the editor preview (the
 * overlay canvas is CSS-scaled to fit the preview area)
 * @param {import('@playwright/test').Page} page
 * @param {number} x - Frame pixel x
 * @param {number} y - Frame pixel y
 * @returns {Promise<{ x: number, y: number }>}
 */
export async function editorFramePointToViewport(page, x, y) {
  const overlay = page.locator('.editor-canvas-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('Editor overlay is not visible');
  const size = await overlay.evaluate((el) => ({
    width: /** @type {HTMLCanvasElement} */ (el).width,
    height: /** @type {HTMLCanvasElement} */ (el).height,
  }));
  return {
    x: box.x + (x * box.width) / size.width,
    y: box.y + (y * box.height) / size.height,
  };
}

/**
 * RGBA of one pixel of a decoded GIF frame
 * @param {DecodedGifFrame} frame
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number, number]}
 */
export function gifPixel(frame, x, y) {
  const o = (y * frame.width + x) * 4;
  return [frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2], frame.rgba[o + 3]];
}

/**
 * Count opaque pixels within `maxDistance` (RGB Euclidean) of `rgb` inside a
 * rectangle of a decoded GIF frame
 * @param {DecodedGifFrame} frame
 * @param {{ x0: number, y0: number, x1: number, y1: number }} rect - Inclusive-exclusive, clamped to the frame
 * @param {[number, number, number]} rgb
 * @param {number} [maxDistance]
 * @returns {number}
 */
export function countGifPixelsNear(frame, rect, rgb, maxDistance = 60) {
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(frame.width, Math.ceil(rect.x1));
  const y1 = Math.min(frame.height, Math.ceil(rect.y1));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = gifPixel(frame, x, y);
      if (p[3] === 255 && Math.hypot(p[0] - rgb[0], p[1] - rgb[1], p[2] - rgb[2]) < maxDistance) {
        count++;
      }
    }
  }
  return count;
}
