/**
 * AI cutout with the REAL models (opt-in, never part of the default run).
 * @module tests/e2e/ai-cutout-real-model.spec
 *
 *   npm run models:fetch
 *   E2E_REAL_MODEL=1 E2E_REAL_IMAGE=/path/to/anime.jpg E2E_PORT=3106 \
 *     npx playwright test tests/e2e/ai-cutout-real-model.spec.js
 *   E2E_REAL_MODEL=1 E2E_REAL_MODEL_ID=general \
 *     E2E_REAL_IMAGE=/path/a.jpg,/path/b.jpg E2E_PORT=3106 \
 *     npx playwright test tests/e2e/ai-cutout-real-model.spec.js
 *
 * Runs a model (E2E_REAL_MODEL_ID: `anime`, the default, `general` or `portrait`;
 * served by the dev server from public/models/) through the app's own
 * segmentation manager and worker on 12 frames made from one image
 * (shifted a few pixels per frame), then checks the mask is a plausible
 * cutout and reports the backend, the warm-up and per-frame latency.
 * E2E_REAL_IMAGE takes one path or several separated by commas (one test
 * per image). E2E_REAL_FETCH_ALL=1 makes the worker fetch every graph
 * output instead of the mask alone (to time what side outputs cost).
 * E2E_REAL_MODEL_UNPINNED=1 runs whatever file public/models/ holds for
 * the model (its size and SHA-256 are passed as the DEV override), to try
 * a conversion before pinning it.
 *
 * Backend: by default the full Chromium build (new headless mode, which has
 * a real WebGPU adapter; the default headless shell has none) with WebGPU
 * enabled, and the test requires the WebGPU EP. E2E_REAL_MODEL_BACKEND=wasm
 * uses the default headless shell instead (no adapter) and times the WASM
 * fallback on two frames. E2E_REAL_MODEL_CHANNEL picks another channel
 * (e.g. `chrome`). E2E_REAL_MODEL_OUT (default test-results/ai-cutout-real)
 * receives the inputs, the masks and a JSON report per image.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { gotoCapture, MODEL_FILES } from './helpers/app.js';

const ENABLED = process.env.E2E_REAL_MODEL === '1';
const BACKEND = process.env.E2E_REAL_MODEL_BACKEND === 'wasm' ? 'wasm' : 'webgpu';
const MODEL_ID = /** @type {keyof typeof MODEL_FILES} */ (
  Object.hasOwn(MODEL_FILES, process.env.E2E_REAL_MODEL_ID ?? '')
    ? process.env.E2E_REAL_MODEL_ID
    : 'anime'
);
const FETCH_ALL = process.env.E2E_REAL_FETCH_ALL === '1';
const UNPINNED = process.env.E2E_REAL_MODEL_UNPINNED === '1';
const MODEL_PATH = resolve(`public/models/${MODEL_FILES[MODEL_ID]}`);
const IMAGE_PATHS = (process.env.E2E_REAL_IMAGE ?? '')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const OUT_DIR = resolve(process.env.E2E_REAL_MODEL_OUT ?? 'test-results/ai-cutout-real');
const FRAME_COUNT = BACKEND === 'webgpu' ? 12 : 2;

// Declared at file level so a normal run never even launches a browser here
test.skip(!ENABLED, 'Set E2E_REAL_MODEL=1 to run the real model');

if (ENABLED && BACKEND === 'webgpu') {
  test.use({
    channel: process.env.E2E_REAL_MODEL_CHANNEL ?? 'chromium',
    launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] },
  });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} imagePath
 */
async function runRealModel(page, imagePath) {
  test.skip(!existsSync(MODEL_PATH), 'Run npm run models:fetch first');
  test.skip(!imagePath || !existsSync(imagePath), 'Set E2E_REAL_IMAGE to an image');
  test.setTimeout(15 * 60_000);

  await gotoCapture(page);
  await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.aiCutout));
  /** @type {Record<string, unknown> | null} */
  let override = FETCH_ALL ? { fetchAllOutputs: true } : null;
  if (UNPINNED) {
    const sha256 = createHash('sha256').update(readFileSync(MODEL_PATH)).digest('hex');
    override = {
      ...override,
      models: { [MODEL_ID]: { sha256, bytes: statSync(MODEL_PATH).size } },
    };
  }
  await page.evaluate((value) => window.__TEST_HOOKS__.aiCutout.setModelOverride(value), override);

  const mime = extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const imageBase64 = readFileSync(imagePath).toString('base64');
  const size = await page.evaluate(
    async ({ base64, type, count }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type }));
      const { width, height } = image;
      const frames = [];
      for (let i = 0; i < count; i++) {
        // Shift the picture a little per frame so every frame is distinct
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, i * 2, 0);
        const timestamp = Math.round((i * 1e6) / 30);
        frames.push({
          id: `real-${i}`,
          frame: new VideoFrame(canvas, { timestamp }),
          timestamp,
          width,
          height,
        });
      }
      image.close();
      window.__TEST_HOOKS__.setClipPayload({
        frames,
        fps: 30,
        capturedAt: Date.now(),
        id: 'real-model-clip',
      });
      return { width, height };
    },
    { base64: imageBase64, type: mime, count: FRAME_COUNT },
  );

  const result = await page.evaluate(
    ({ allowWasm, modelId }) => window.__TEST_HOOKS__.aiCutout.analyzeClip({ allowWasm, modelId }),
    { allowWasm: BACKEND === 'wasm', modelId: MODEL_ID },
  );
  expect(result.error).toBeUndefined();

  const name = `${MODEL_ID}-${basename(imagePath, extname(imagePath))}`;
  mkdirSync(OUT_DIR, { recursive: true });
  const maskDataUrl = await page.evaluate(
    (modelId) => window.__TEST_HOOKS__.aiCutout.maskToPngDataUrl(0, modelId),
    MODEL_ID,
  );
  writeFileSync(
    resolve(OUT_DIR, `${name}-mask-frame0.png`),
    Buffer.from(maskDataUrl.split(',')[1], 'base64'),
  );
  writeFileSync(resolve(OUT_DIR, `${name}-input${extname(imagePath)}`), readFileSync(imagePath));

  // Coarse statistics of frame 0's mask: share of foreground, border mean
  const stats = await page.evaluate((modelId) => {
    const grid = [];
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) grid.push({ x: (x + 0.5) / 32, y: (y + 0.5) / 32 });
    }
    const sampled = window.__TEST_HOOKS__.aiCutout.sampleMask(0, grid, modelId);
    const values = sampled.values;
    const border = values.filter((_, i) => i % 32 === 0 || i % 32 === 31 || i < 32 || i >= 992);
    return {
      width: sampled.width,
      height: sampled.height,
      foregroundShare: values.filter((v) => v >= 128).length / values.length,
      softShare: values.filter((v) => v > 25 && v < 230).length / values.length,
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      borderMean: border.reduce((a, b) => a + b, 0) / border.length,
    };
  }, MODEL_ID);

  const sorted = [...result.frameMs].sort((a, b) => a - b);
  const report = {
    model: MODEL_ID,
    fetchAllOutputs: FETCH_ALL,
    backend: result.backend,
    adapter: result.readyInfo.adapter,
    browser: page.context().browser()?.version(),
    image: imagePath,
    imageSize: size,
    frames: result.analyzed,
    modelLoadMs: result.readyInfo.timings.loadMs,
    sessionCreateMs: result.readyInfo.timings.createMs,
    warmupMs: result.readyInfo.timings.warmupMs,
    firstFrameMs: result.frameMs[0],
    medianFrameMs: sorted[Math.floor(sorted.length / 2)],
    frameMs: result.frameMs,
    firstMaskAfterMs: result.firstFrameAtMs,
    totalMs: result.totalMs,
    mask: stats,
  };
  writeFileSync(
    resolve(OUT_DIR, `${name}-report-${BACKEND}${FETCH_ALL ? '-all-outputs' : ''}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));

  expect(result.backend).toBe(BACKEND);
  expect(result.readyInfo.modelId).toBe(MODEL_ID);
  expect(result.analyzed).toBe(FRAME_COUNT);
  // A subject on a background: some but not all of the frame is
  // foreground, and the model is confident about most pixels (live-action
  // test photos include a small full-body figure in a street)
  expect(stats.foregroundShare).toBeGreaterThan(MODEL_ID === 'anime' ? 0.05 : 0.01);
  expect(stats.foregroundShare).toBeLessThan(0.95);
  expect(stats.softShare).toBeLessThan(0.25);
}

if (IMAGE_PATHS.length === 0) {
  test(`real ${MODEL_ID} model produces a sensible mask`, async ({ page }) => {
    await runRealModel(page, '');
  });
}
for (const imagePath of IMAGE_PATHS) {
  test(`real ${MODEL_ID} model produces a sensible mask for ${basename(imagePath)}`, async ({
    page,
  }) => {
    await runRealModel(page, imagePath);
  });
}
