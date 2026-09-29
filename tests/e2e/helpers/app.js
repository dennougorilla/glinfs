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

// ============================================================
// AI cutout (stub model, WASM fallback)
// ============================================================

/**
 * Serve the stub model in place of the real one and count the requests.
 * Register it before the page loads the app.
 * @param {import('@playwright/test').Page} page
 * @param {Buffer} model - Stub model bytes (tests/fixtures/models/stub-seg.onnx)
 * @returns {Promise<{ count: number }>}
 */
export async function serveStubModel(page, model) {
  const requests = { count: 0 };
  await page.route('**/models/isnetis.onnx', async (route) => {
    requests.count++;
    await route.fulfill({ body: model, contentType: 'application/octet-stream' });
  });
  return requests;
}

/**
 * Open the app with the DEV-only AI cutout hook set up for the stub model
 * @param {import('@playwright/test').Page} page
 * @param {{ sha256: string, bytes: number, allowWasm: boolean }} override - allowWasm:
 *   run the WASM fallback without the user's explicit choice
 */
export async function gotoCaptureWithStubModel(page, override) {
  await gotoCapture(page);
  await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.aiCutout));
  await page.evaluate((o) => window.__TEST_HOOKS__.aiCutout.setModelOverride(o), override);
}

/** Geometry of the synthetic two-disc clip (see injectDiscClip) */
export const discClip = {
  width: 240,
  height: 160,
  radius: 18,
  /** White disc moving right @param {number} f */
  discA: (f) => ({ x: 40 + 6 * f, y: 50 }),
  /** Grey (160) disc moving left @param {number} f */
  discB: (f) => ({ x: 200 - 6 * f, y: 115 }),
};

/**
 * Make the active clip from `count` synthetic frames and open the editor:
 * a white disc (A) and a light grey disc (B, value 160) moving in opposite
 * directions over a black background. They never touch (65 px apart
 * vertically, radius 18), so the component tracking sees two separate
 * characters. With the stub model disc A has probability 1, disc B
 * 160/255 and the background 0.
 * @param {import('@playwright/test').Page} page
 * @param {{ count: number, fps?: number }} options
 */
export async function injectDiscClip(page, { count, fps = 10 }) {
  await page.evaluate(
    async ({ count, fps, width, height, radius }) => {
      const frames = [];
      for (let f = 0; f < count; f++) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(40 + 6 * f, 50, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgb(160,160,160)';
        ctx.beginPath();
        ctx.arc(200 - 6 * f, 115, radius, 0, Math.PI * 2);
        ctx.fill();
        const timestamp = Math.round((f * 1e6) / fps);
        frames.push({
          id: `disc-${f}`,
          frame: new VideoFrame(canvas, { timestamp }),
          timestamp,
          width,
          height,
        });
      }
      window.__TEST_HOOKS__.setClipPayload({
        frames,
        fps,
        capturedAt: Date.now(),
        id: 'disc-clip',
      });
      location.hash = '#/editor';
    },
    { count, fps, width: discClip.width, height: discClip.height, radius: discClip.radius },
  );
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
}

/**
 * Open the editor's Background accordion and choose the AI cutout
 * @param {import('@playwright/test').Page} page
 */
export async function chooseAiCutout(page) {
  const accordion = page.locator('#editor-bg-accordion');
  if ((await accordion.getAttribute('open')) === null) {
    await accordion.locator('summary').click();
  }
  await page.locator('label[for="ai-method-ai"]').click();
  await expect(page.locator('#ai-method-ai')).toBeChecked();
  await expect(page.locator('#ai-section')).toBeVisible();
}

/**
 * The editor's AI cutout runtime status (see EditorState.aiCutout)
 * @param {import('@playwright/test').Page} page
 */
export function readAiStatus(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.getEditorState()?.aiCutout ?? null);
}

/**
 * Wait until the editor's final masks are built for the current settings
 * @param {import('@playwright/test').Page} page
 */
export async function waitForAiMasks(page) {
  await expect
    .poll(
      async () => {
        const status = await readAiStatus(page);
        return Boolean(status && !status.building && status.maskVersion > 0);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Number of probability masks in the mask store
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>}
 */
export function maskCount(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats().size);
}

/**
 * Alpha of one pixel of the editor's preview (base) canvas
 * @param {import('@playwright/test').Page} page
 * @param {number} x
 * @param {number} y
 * @returns {Promise<number | undefined>}
 */
export function editorPreviewAlpha(page, x, y) {
  return page.evaluate(
    ([px, py]) => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.editor-canvas'));
      return canvas.getContext('2d')?.getImageData(px, py, 1, 1).data[3];
    },
    [x, y],
  );
}
