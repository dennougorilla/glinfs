/**
 * E2E: edits (text overlays, background removal) are burned into the
 * exported GIF. Each test exports a solid-color mock clip and decodes the
 * real GIF bytes in the page with ImageDecoder.
 * @module tests/e2e/export-edits.spec
 */

import { expect, test } from '@playwright/test';
import { decodeExportedGif, exportGifAndWait, gotoExportWithClip } from './helpers/app.js';

const WIDTH = 160;
const HEIGHT = 120;

/**
 * A text layer as the editor would store it (all fields set)
 * @param {Record<string, unknown>} over
 */
function textLayer(over) {
  return {
    id: 'text-1',
    text: 'HI',
    x: 0.5,
    y: 0.5,
    size: 0.4,
    font: 'sans',
    bold: true,
    align: 'center',
    color: '#ff0000',
    outlineColor: '#000000',
    outlineWidth: 0,
    boxColor: null,
    boxOpacity: 0.6,
    start: 0,
    end: 999,
    ...over,
  };
}

/** Background removal off */
const NO_KEY = { enabled: false, color: '#00ff00', tolerance: 20, mode: 'connected' };

/**
 * @param {import('./helpers/app.js').DecodedGifFrame} frame
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number, number]}
 */
function pixel(frame, x, y) {
  const o = (y * frame.width + x) * 4;
  return [frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2], frame.rgba[o + 3]];
}

/**
 * @param {number[]} rgba
 * @param {[number, number, number]} rgb
 */
function colorDistance(rgba, rgb) {
  return Math.hypot(rgba[0] - rgb[0], rgba[1] - rgb[1], rgba[2] - rgb[2]);
}

/**
 * Count opaque pixels near `rgb` inside a rectangle
 * @param {import('./helpers/app.js').DecodedGifFrame} frame
 * @param {{ x0: number, y0: number, x1: number, y1: number }} rect - Inclusive-exclusive
 * @param {[number, number, number]} rgb
 */
function countNear(frame, rect, rgb) {
  let count = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const p = pixel(frame, x, y);
      if (p[3] === 255 && colorDistance(p, rgb) < 60) count++;
    }
  }
  return count;
}

/** Text block of a 0.4-height (48px) layer centered in a 160x120 output */
const TEXT_REGION = { x0: 40, y0: 30, x1: 120, y1: 90 };
const WHOLE = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT };

test.describe('Export with edits', () => {
  test('removes a solid background and burns in opaque text', async ({ page }) => {
    await gotoExportWithClip(page, {
      frameCount: 4,
      fps: 10,
      width: WIDTH,
      height: HEIGHT,
      pattern: 'solid',
      color: '#00ff00',
      edits: {
        textLayers: [textLayer({ color: '#ff0000' })],
        background: { enabled: true, color: '#00ff00', tolerance: 10, mode: 'connected' },
      },
    });

    // Transparent exports can only use the JavaScript encoder
    await expect(page.getByTestId('export-transparency-badge')).toBeVisible();
    await expect(page.getByTestId('export-transparency-encoder-note')).toHaveText(
      'Transparent GIFs use the JavaScript encoder',
    );
    await expect(page.locator('[data-encoder-id="gifenc-js"]')).toHaveClass(/selected/);

    await exportGifAndWait(page);
    const frames = await decodeExportedGif(page);

    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect([frame.width, frame.height]).toEqual([WIDTH, HEIGHT]);

      // Keyed background: fully transparent, at the border and far from the text
      expect(pixel(frame, 0, 0)[3]).toBe(0);
      expect(pixel(frame, 5, 5)[3]).toBe(0);
      expect(pixel(frame, WIDTH - 3, HEIGHT - 3)[3]).toBe(0);
      expect(pixel(frame, 10, HEIGHT / 2)[3]).toBe(0);

      // Text: opaque and red inside the text region
      expect(countNear(frame, TEXT_REGION, [255, 0, 0])).toBeGreaterThan(300);
      // ... and nowhere outside it
      const outside =
        countNear(frame, WHOLE, [255, 0, 0]) - countNear(frame, TEXT_REGION, [255, 0, 0]);
      expect(outside).toBe(0);

      // GIF alpha is 1-bit, and no green survives the key
      let partialAlpha = 0;
      for (let i = 3; i < frame.rgba.length; i += 4) {
        if (frame.rgba[i] !== 0 && frame.rgba[i] !== 255) partialAlpha++;
      }
      expect(partialAlpha).toBe(0);
      expect(countNear(frame, WHOLE, [0, 255, 0])).toBe(0);
    }
  });

  test('draws a text layer only on the frames in its range', async ({ page }) => {
    // Clip frames 0..7, export range 1..6: the layer covers absolute frames
    // 3..4, i.e. exported frames 2 and 3.
    await gotoExportWithClip(page, {
      frameCount: 8,
      fps: 10,
      width: WIDTH,
      height: HEIGHT,
      pattern: 'solid',
      color: '#2040c0',
      selectedRange: { start: 1, end: 6 },
      edits: {
        textLayers: [textLayer({ color: '#ffffff', start: 3, end: 4 })],
        background: NO_KEY,
      },
    });

    // Not transparent: the encoder choice is the user's; pick JS explicitly
    await expect(page.getByTestId('export-transparency-badge')).toHaveCount(0);
    await page.locator('[data-encoder-id="gifenc-js"]').click();
    await expect(page.locator('[data-encoder-id="gifenc-js"]')).toHaveClass(/selected/);

    await exportGifAndWait(page);
    const frames = await decodeExportedGif(page);

    expect(frames).toHaveLength(6);
    frames.forEach((frame, index) => {
      const white = countNear(frame, TEXT_REGION, [255, 255, 255]);
      if (index === 2 || index === 3) {
        expect(white, `frame ${index} shows the text`).toBeGreaterThan(300);
      } else {
        expect(white, `frame ${index} has no text`).toBe(0);
      }
      // Far from the text the background keeps its color, fully opaque
      const corner = pixel(frame, 4, 4);
      expect(corner[3]).toBe(255);
      expect(colorDistance(corner, [0x20, 0x40, 0xc0])).toBeLessThan(24);
      expect(colorDistance(pixel(frame, WIDTH - 5, HEIGHT - 5), [0x20, 0x40, 0xc0])).toBeLessThan(
        24,
      );
    });
  });

  test('collapses identical frames of an imported clip into one GIF frame', async ({ page }) => {
    // 6 identical source frames; text on frames 2..3 splits them into three
    // runs of two, each 2 x 100ms
    await gotoExportWithClip(page, {
      frameCount: 6,
      fps: 10,
      width: WIDTH,
      height: HEIGHT,
      pattern: 'solid',
      color: '#2040c0',
      sourceName: 'imported.gif',
      edits: {
        textLayers: [textLayer({ color: '#ffffff', start: 2, end: 3 })],
        background: NO_KEY,
      },
    });
    await page.locator('[data-encoder-id="gifenc-js"]').click();

    await exportGifAndWait(page);
    const frames = await decodeExportedGif(page);

    expect(frames.map((f) => f.durationMs)).toEqual([200, 200, 200]);
    expect(frames.map((f) => countNear(f, TEXT_REGION, [255, 255, 255]) > 300)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
