/**
 * AI cutout with the REAL model (opt-in, never part of the default run).
 * @module tests/e2e/ai-cutout-real-model.spec
 *
 *   npm run models:fetch
 *   E2E_REAL_MODEL=1 E2E_REAL_IMAGE=/path/to/anime.jpg E2E_PORT=3106 \
 *     npx playwright test tests/e2e/ai-cutout-real-model.spec.js
 *
 * Runs isnetis.onnx (served by the dev server from public/models/) through
 * the app's own segmentation manager and worker on 12 frames made from one
 * anime-style image (shifted a few pixels per frame), then checks the mask
 * is a plausible cutout and reports the backend and per-frame latency.
 *
 * Backend: by default the full Chromium build (new headless mode, which has
 * a real WebGPU adapter; the default headless shell has none) with WebGPU
 * enabled, and the test requires the WebGPU EP. E2E_REAL_MODEL_BACKEND=wasm
 * uses the default headless shell instead (no adapter) and times the WASM
 * fallback on two frames. E2E_REAL_MODEL_CHANNEL picks another channel
 * (e.g. `chrome`). E2E_REAL_MODEL_OUT (default test-results/ai-cutout-real)
 * receives the input, the mask and a JSON report.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

const ENABLED = process.env.E2E_REAL_MODEL === '1';
const BACKEND = process.env.E2E_REAL_MODEL_BACKEND === 'wasm' ? 'wasm' : 'webgpu';
const MODEL_PATH = resolve('public/models/isnetis.onnx');
const IMAGE_PATH = process.env.E2E_REAL_IMAGE ?? '';
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

test('real anime-segmentation model produces a sensible mask', async ({ page }) => {
  test.skip(!existsSync(MODEL_PATH), 'Run npm run models:fetch first');
  test.skip(!IMAGE_PATH || !existsSync(IMAGE_PATH), 'Set E2E_REAL_IMAGE to an anime-style image');
  test.setTimeout(15 * 60_000);

  await gotoCapture(page);
  await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.aiCutout));
  await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.setModelOverride(null));

  const mime = extname(IMAGE_PATH).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const imageBase64 = readFileSync(IMAGE_PATH).toString('base64');
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
    (allowWasm) => window.__TEST_HOOKS__.aiCutout.analyzeClip({ allowWasm }),
    BACKEND === 'wasm',
  );
  expect(result.error).toBeUndefined();

  mkdirSync(OUT_DIR, { recursive: true });
  const maskDataUrl = await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.maskToPngDataUrl(0));
  writeFileSync(
    resolve(OUT_DIR, 'mask-frame0.png'),
    Buffer.from(maskDataUrl.split(',')[1], 'base64'),
  );
  writeFileSync(resolve(OUT_DIR, `input${extname(IMAGE_PATH)}`), readFileSync(IMAGE_PATH));

  // Coarse statistics of frame 0's mask: share of foreground, border mean
  const stats = await page.evaluate(() => {
    const grid = [];
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) grid.push({ x: (x + 0.5) / 32, y: (y + 0.5) / 32 });
    }
    const sampled = window.__TEST_HOOKS__.aiCutout.sampleMask(0, grid);
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
  });

  const sorted = [...result.frameMs].sort((a, b) => a - b);
  const report = {
    backend: result.backend,
    adapter: result.readyInfo.adapter,
    browser: page.context().browser()?.version(),
    image: IMAGE_PATH,
    imageSize: size,
    frames: result.analyzed,
    modelLoadMs: result.readyInfo.timings.loadMs,
    sessionCreateMs: result.readyInfo.timings.createMs,
    firstFrameMs: result.frameMs[0],
    medianFrameMs: sorted[Math.floor(sorted.length / 2)],
    frameMs: result.frameMs,
    firstMaskAfterMs: result.firstFrameAtMs,
    totalMs: result.totalMs,
    mask: stats,
  };
  writeFileSync(resolve(OUT_DIR, `report-${BACKEND}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  expect(result.backend).toBe(BACKEND);
  expect(result.analyzed).toBe(FRAME_COUNT);
  // A character on a background: some but not all of the frame is
  // foreground, and the model is confident about most pixels
  expect(stats.foregroundShare).toBeGreaterThan(0.05);
  expect(stats.foregroundShare).toBeLessThan(0.95);
  expect(stats.softShare).toBeLessThan(0.25);
});
