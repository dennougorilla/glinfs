/**
 * AI cutout runtime end to end: the app's segmentation manager and worker
 * (ONNX Runtime Web) with the stub model.
 * @module tests/e2e/ai-cutout-runtime.spec
 *
 * Headless Chromium has no WebGPU adapter, so these runs exercise the WASM
 * fallback. `page.route` serves tests/fixtures/models/stub-seg.onnx in place
 * of the real 176 MB model, and the DEV-only `__TEST_HOOKS__.aiCutout` hook
 * makes the manager accept the stub's size/hash. The stub computes
 * mask = mean(R, G, B) / 255, so every expected mask value below follows
 * directly from the colours drawn into the frames.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

const STUB_MODEL = readFileSync(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const STUB_SHA256 = createHash('sha256').update(STUB_MODEL).digest('hex');
const MODEL_ROUTE = '**/models/isnetis.onnx';

/** Mask values are bytes; allow for resampling at shape edges only */
const TOLERANCE = 2;

/**
 * Serve the stub in place of the real model and count the requests.
 * @param {import('@playwright/test').Page} page
 * @param {{ status?: number }} [options]
 * @returns {Promise<{ count: number }>}
 */
async function serveStubModel(page, { status = 200 } = {}) {
  const requests = { count: 0 };
  await page.route(MODEL_ROUTE, async (route) => {
    requests.count++;
    if (status !== 200) {
      await route.fulfill({ status, body: 'nope' });
      return;
    }
    await route.fulfill({ body: STUB_MODEL, contentType: 'application/octet-stream' });
  });
  return requests;
}

/**
 * Open the app and wait for the DEV-only AI cutout hooks.
 * @param {import('@playwright/test').Page} page
 * @param {{ sha256?: string, bytes?: number, allowWasm?: boolean }} override
 */
async function openAppWithStub(page, override) {
  await gotoCapture(page);
  await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.aiCutout));
  await page.evaluate((o) => window.__TEST_HOOKS__.aiCutout.setModelOverride(o), override);
}

/**
 * Make the active clip from synthetic frames drawn in the page.
 *
 * Landscape frames: black background, a white disc that moves right each
 * frame, a red block (mean 85), a grey block (128) and a white bar along the
 * top edge (catches a wrong letterbox offset: the padding sits above it).
 * Portrait frames: black with a white bar along the left edge.
 * `shareLast` makes the last frame a hold of the one before it (same
 * sharedKey, same pixels), like an imported GIF's repeated frame.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ count: number, width: number, height: number, shareLast?: boolean }} options
 */
async function injectSyntheticClip(page, options) {
  await page.evaluate(async ({ count, width, height, shareLast }) => {
    const frames = [];
    for (let i = 0; i < count; i++) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      if (width >= height) {
        ctx.beginPath();
        ctx.arc(320 + 20 * i, 360, 120, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(0, 0, width, 24);
        ctx.fillStyle = '#f00';
        ctx.fillRect(800, 100, 200, 200);
        ctx.fillStyle = 'rgb(128,128,128)';
        ctx.fillRect(800, 450, 200, 200);
      } else {
        ctx.fillRect(0, 0, 24, height);
      }
      const timestamp = Math.round((i * 1e6) / 30);
      frames.push({
        id: `ai-e2e-${i}`,
        frame: new VideoFrame(canvas, { timestamp }),
        timestamp,
        width,
        height,
      });
    }
    if (shareLast && count >= 2) {
      const held = frames[count - 2];
      held.sharedKey = held.id;
      frames[count - 1].frame.close();
      frames[count - 1] = {
        ...frames[count - 1],
        frame: held.frame.clone(),
        sharedKey: held.id,
      };
    }
    window.__TEST_HOOKS__.setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      id: 'ai-e2e-clip',
    });
  }, options);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {Object} [options]
 */
function analyzeClip(page, options = {}) {
  return page.evaluate((o) => window.__TEST_HOOKS__.aiCutout.analyzeClip(o), options);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 * @param {{ x: number, y: number }[]} points - Normalized source coordinates
 */
function sampleMask(page, index, points) {
  return page.evaluate(({ i, p }) => window.__TEST_HOOKS__.aiCutout.sampleMask(i, p), {
    i: index,
    p: points,
  });
}

/**
 * @param {number} actual
 * @param {number} expected
 */
function expectNear(actual, expected) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE);
}

test.describe('AI cutout runtime (stub model, WASM fallback)', () => {
  test('analyzes a clip through the worker and returns probability masks', async ({ page }) => {
    const requests = await serveStubModel(page);
    await openAppWithStub(page, { sha256: STUB_SHA256, bytes: STUB_MODEL.length, allowWasm: true });
    const capabilities = await page.evaluate(() =>
      window.__TEST_HOOKS__.aiCutout.getCapabilities(),
    );
    test.skip(capabilities.webgpu, 'This browser has a WebGPU adapter; the WASM path is not used');

    await injectSyntheticClip(page, { count: 4, width: 1280, height: 720, shareLast: true });
    const result = await analyzeClip(page);

    expect(result.error).toBeUndefined();
    expect(result.backend).toBe('wasm');
    expect(result.readyInfo.backend).toBe('wasm');
    expect(result.readyInfo.fromCache).toBe(false);
    // Frame 3 is a hold of frame 2: one mask serves both
    expect(result.analyzed).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.frameMs).toHaveLength(3);
    expect(result.phases).toEqual(['downloading', 'verifying', 'initializing', 'analyzing']);
    expect(result.maxLoadedBytes).toBe(STUB_MODEL.length);
    expect(requests.count).toBe(1);

    // 1280×720 → mask at 1024×576 (long side capped at 1024)
    const w = 1280;
    const h = 720;
    const points = [
      { x: 320 / w, y: 360 / h }, // disc centre (frame 0) → white
      { x: 900 / w, y: 200 / h }, // red block → (255 + 0 + 0) / 3
      { x: 900 / w, y: 550 / h }, // grey block → 128
      { x: 640 / w, y: 5 / h }, // top bar → white
      { x: 640 / w, y: 40 / h }, // just below the bar → black
      { x: 100 / w, y: 700 / h }, // background → black
    ];
    const frame0 = await sampleMask(page, 0, points);
    expect(frame0.width).toBe(1024);
    expect(frame0.height).toBe(576);
    const [disc, red, grey, bar, belowBar, background] = frame0.values;
    expectNear(disc, 255);
    expectNear(red, 85);
    expectNear(grey, 128);
    expectNear(bar, 255);
    expectNear(belowBar, 0);
    expectNear(background, 0);

    // The disc moved right by 20 px per frame: each mask follows its frame
    const discEdge = [{ x: (320 - 110) / w, y: 360 / h }];
    expectNear((await sampleMask(page, 0, discEdge)).values[0], 255);
    expectNear((await sampleMask(page, 2, discEdge)).values[0], 0);
    // The hold shares its source frame's mask
    expect(await sampleMask(page, 3, points)).toEqual(await sampleMask(page, 2, points));

    const stats = await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats());
    expect(stats.size).toBe(3);
    expect(stats.byteLength).toBe(3 * 1024 * 576);

    // Everything is analyzed: a second call does nothing and downloads nothing
    const again = await analyzeClip(page);
    expect(again.analyzed).toBe(0);
    expect(again.skipped).toBe(4);
    expect(requests.count).toBe(1);

    // A new visit (fresh page, empty mask store, new worker) loads the
    // verified model from Cache Storage instead of the network
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.aiCutout));
    await page.evaluate((o) => window.__TEST_HOOKS__.aiCutout.setModelOverride(o), {
      sha256: STUB_SHA256,
      bytes: STUB_MODEL.length,
      allowWasm: true,
    });
    await injectSyntheticClip(page, { count: 2, width: 1280, height: 720 });
    const cached = await analyzeClip(page);
    expect(cached.error).toBeUndefined();
    expect(cached.readyInfo.fromCache).toBe(true);
    expect(cached.analyzed).toBe(2);
    expect(requests.count).toBe(1);
    const cachedKeys = await page.evaluate(async () => {
      const cache = await caches.open('glinfs-models-v1');
      return (await cache.keys()).map((request) => request.url);
    });
    expect(cachedKeys).toHaveLength(1);
    expect(cachedKeys[0]).toContain(`models/isnetis.onnx?sha256=${STUB_SHA256}`);
  });

  test('portrait frames are letterboxed and cropped back horizontally', async ({ page }) => {
    await serveStubModel(page);
    await openAppWithStub(page, { sha256: STUB_SHA256, bytes: STUB_MODEL.length, allowWasm: true });
    await injectSyntheticClip(page, { count: 1, width: 480, height: 640 });
    const result = await analyzeClip(page);
    expect(result.error).toBeUndefined();

    // 480×640 stays 480×640 (never scaled up); the white bar is x < 24
    const mask = await sampleMask(page, 0, [
      { x: 5 / 480, y: 0.5 },
      { x: 60 / 480, y: 0.5 },
      { x: 475 / 480, y: 0.5 },
    ]);
    expect(mask.width).toBe(480);
    expect(mask.height).toBe(640);
    expectNear(mask.values[0], 255);
    expectNear(mask.values[1], 0);
    expectNear(mask.values[2], 0);
  });

  test('cancelling drops the queued frames and keeps finished masks', async ({ page }) => {
    await serveStubModel(page);
    await openAppWithStub(page, { sha256: STUB_SHA256, bytes: STUB_MODEL.length, allowWasm: true });
    await injectSyntheticClip(page, { count: 12, width: 640, height: 360 });

    const cancelled = await analyzeClip(page, { abortAfterFrames: 1 });
    expect(cancelled.error?.name).toBe('AbortError');
    const afterCancel = await page.evaluate(() =>
      window.__TEST_HOOKS__.aiCutout.getMaskStoreStats(),
    );
    expect(afterCancel.size).toBeGreaterThanOrEqual(1);
    expect(afterCancel.size).toBeLessThan(12);

    // The worker keeps serving: the next call analyzes only what is missing
    const resumed = await analyzeClip(page);
    expect(resumed.error).toBeUndefined();
    const stats = await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats());
    expect(stats.size).toBe(12);
    expect(resumed.analyzed + resumed.skipped).toBe(12);
    expect(resumed.skipped).toBeGreaterThanOrEqual(afterCancel.size);
  });

  test('a model with the wrong SHA-256 is rejected and not cached', async ({ page }) => {
    await serveStubModel(page);
    await openAppWithStub(page, {
      sha256: '0'.repeat(64),
      bytes: STUB_MODEL.length,
      allowWasm: true,
    });
    await injectSyntheticClip(page, { count: 2, width: 640, height: 360 });
    const result = await analyzeClip(page);
    expect(result.error?.code).toBe('hash-mismatch');
    const state = await page.evaluate(async () => ({
      stats: window.__TEST_HOOKS__.aiCutout.getMaskStoreStats(),
      cached: (await (await caches.open('glinfs-models-v1')).keys()).length,
    }));
    expect(state.stats.size).toBe(0);
    expect(state.cached).toBe(0);
  });

  test('a failed download surfaces a download error', async ({ page }) => {
    const requests = await serveStubModel(page, { status: 404 });
    await openAppWithStub(page, { sha256: STUB_SHA256, bytes: STUB_MODEL.length, allowWasm: true });
    await injectSyntheticClip(page, { count: 1, width: 640, height: 360 });
    const result = await analyzeClip(page);
    expect(result.error?.code).toBe('download-failed');
    expect(result.error?.message).toContain('404');
    expect(requests.count).toBe(1);
  });

  test('without WebGPU and without WASM permission nothing is downloaded', async ({ page }) => {
    const requests = await serveStubModel(page);
    await openAppWithStub(page, {
      sha256: STUB_SHA256,
      bytes: STUB_MODEL.length,
      allowWasm: false,
    });
    const capabilities = await page.evaluate(() =>
      window.__TEST_HOOKS__.aiCutout.getCapabilities(),
    );
    test.skip(capabilities.webgpu, 'This browser has a WebGPU adapter');

    await injectSyntheticClip(page, { count: 1, width: 640, height: 360 });
    const refused = await analyzeClip(page, { allowWasm: false });
    expect(refused.error?.code).toBe('webgpu-unavailable');
    expect(requests.count).toBe(0);

    // Once the user allows the slow path, the same manager runs on WASM
    const allowed = await analyzeClip(page, { allowWasm: true });
    expect(allowed.error).toBeUndefined();
    expect(allowed.backend).toBe('wasm');
    expect(requests.count).toBe(1);
  });
});
