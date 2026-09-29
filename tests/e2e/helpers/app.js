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
 * The Export GIF dialog (a modal over the editor). Scope dialog assertions
 * to it: the editor underneath stays in the DOM.
 * @param {import('@playwright/test').Page} page
 */
export function exportDialog(page) {
  return page.getByRole('dialog', { name: 'Export GIF' });
}

/**
 * Open the editor on an injected mock clip, then its Export dialog
 *
 * `pattern`/`color` style the clip's frames; `selectedRange`, `cropArea`,
 * `edits` and `playbackSpeed` are restored by the editor (saved editor
 * state, like a clip coming back from the queue); `hasAlpha` and
 * `sourceName` (imported: identical-frame merging on export) go on the clip.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ frameCount?: number, fps?: number, width?: number, height?: number, selectedRange?: { start: number, end: number }, cropArea?: object | null, pattern?: 'gradient' | 'checkerboard' | 'solid' | 'numbered', color?: string, edits?: object, hasAlpha?: boolean, sourceName?: string, playbackSpeed?: number }} [options]
 */
export async function gotoExportWithClip(page, options = {}) {
  await gotoEditorWithClip(page, options);
  await exportFromEditor(page);
}

/**
 * Click Export in the dialog and wait for its result view
 * @param {import('@playwright/test').Page} page
 */
export async function exportGifAndWait(page) {
  const dialog = exportDialog(page);
  await dialog.locator('#export-start').click();
  await expect(dialog.locator('#export-result')).toBeVisible({ timeout: 60000 });
}

/**
 * Close the Export dialog ("Back to editing" on the result, else Close) and
 * wait for the editor underneath
 * @param {import('@playwright/test').Page} page
 */
export async function closeExportDialog(page) {
  const dialog = exportDialog(page);
  const back = dialog.locator('#export-back-to-editing');
  if (await back.isVisible()) {
    await back.click();
  } else {
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
  await expect(dialog).toHaveCount(0);
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
}

/**
 * @typedef {Object} DecodedGifFrame
 * @property {number} width
 * @property {number} height
 * @property {number} durationMs - Frame duration reported by ImageDecoder
 * @property {number[]} rgba - Composited RGBA pixels (row-major)
 */

/**
 * Decode the GIF the Export dialog just produced, in the page, with
 * ImageDecoder — the same decoder a browser uses to show it. Requires the
 * dialog to still show the result (the result is dropped when it closes).
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
 * Open the Export dialog through the editor's toolbar button
 * @param {import('@playwright/test').Page} page
 */
export async function exportFromEditor(page) {
  await page.getByRole('button', { name: 'Export as GIF' }).click();
  await expect(exportDialog(page).locator('#export-start')).toBeVisible();
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

/** Served file name of each model (see src/features/ai-cutout/model-registry.js) */
export const MODEL_FILES = /** @type {const} */ ({
  anime: 'isnetis-fp16.onnx',
  general: 'isnet-general-fp16.onnx',
});

/**
 * Serve stub models in place of the real ones and count the requests.
 * Register it before the page loads the app.
 * @param {import('@playwright/test').Page} page
 * @param {Buffer} model - Stub served as the anime model (tests/fixtures/models/stub-seg.onnx)
 * @param {{ general?: Buffer }} [others] - Stub served as the general model
 *   (tests/fixtures/models/stub-seg-general.onnx)
 * @returns {Promise<{ count: number, byModel: { anime: number, general: number } }>}
 *   count: requests for any model
 */
export async function serveStubModel(page, model, others = {}) {
  const requests = { count: 0, byModel: { anime: 0, general: 0 } };
  /** @type {[keyof typeof MODEL_FILES, Buffer | undefined][]} */
  const stubs = [
    ['anime', model],
    ['general', others.general],
  ];
  for (const [modelId, body] of stubs) {
    if (!body) continue;
    await page.route(`**/models/${MODEL_FILES[modelId]}`, async (route) => {
      requests.count++;
      requests.byModel[modelId]++;
      await route.fulfill({ body, contentType: 'application/octet-stream' });
    });
  }
  return requests;
}

/**
 * Open the app with the DEV-only AI cutout hook set up for the stub model
 * @param {import('@playwright/test').Page} page
 * @param {{ sha256?: string, bytes?: number, models?: Record<string, { sha256: string, bytes: number }>, allowWasm: boolean }} override
 *   sha256/bytes: accepted for every model unless `models[id]` gives that
 *   model's own (one stub per model); allowWasm: run the WASM fallback
 *   without the user's explicit choice
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
 * Select a tab of the editor's right sidebar
 * @param {import('@playwright/test').Page} page
 * @param {'frame' | 'text' | 'background'} tab
 */
export async function openSidebarTab(page, tab) {
  const button = page.locator(`#editor-side-tab-${tab}`);
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#editor-side-panel-${tab}`)).toBeVisible();
}

/**
 * Open the Background tab and turn background removal on (the method and
 * its settings only show while it is on)
 * @param {import('@playwright/test').Page} page
 */
export async function enableBackgroundRemoval(page) {
  await openSidebarTab(page, 'background');
  await page.locator('#background-enabled').check();
  await expect(page.locator('#background-settings')).toBeVisible();
}

/**
 * Open the editor's Background tab and choose the AI cutout
 * @param {import('@playwright/test').Page} page
 */
export async function chooseAiCutout(page) {
  await enableBackgroundRemoval(page);
  await page.locator('label[for="ai-method-ai"]').click();
  await expect(page.locator('#ai-method-ai')).toBeChecked();
  await expect(page.locator('#ai-section')).toBeVisible();
}

/**
 * Open a collapsed "Advanced" disclosure of the Background tab
 * @param {import('@playwright/test').Page} page
 * @param {'background-advanced' | 'ai-advanced'} id
 */
export async function openAdvanced(page, id) {
  const details = page.locator(`#${id}`);
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
}

/**
 * Choose the AI model in the editor's AI section
 * @param {import('@playwright/test').Page} page
 * @param {'anime' | 'general'} modelId
 */
export async function chooseAiModel(page, modelId) {
  await expect(page.locator('#ai-model')).toBeVisible();
  await page.locator(`label[for="ai-model-${modelId}"]`).click();
  await expect(page.locator(`#ai-model-${modelId}`)).toBeChecked();
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
