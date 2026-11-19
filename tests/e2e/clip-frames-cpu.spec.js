/**
 * D3's cheap half: clips from the capture buffer are CPU I420 VideoFrames
 * (1.5 B/px, off the GPU), converted by the I420 worker with WebGL2.
 *
 * - each engine of the worker (WebGPU where this browser has it, WebGL2)
 *   gives the CPU reference's bytes (shared/i420.js) exactly, at an even
 *   and an odd size, from bitmaps and from VideoFrames;
 * - Create Clip on a 1280x720 share opens on the GPU frames and ends on
 *   I420 frames of that size, swapped in the background, with no page
 *   error while it plays; a Clip Now snapshot still compresses and opens.
 */

import { expect, test } from '@playwright/test';

test('every converter engine gives the reference I420 bytes', async ({ page }) => {
  await page.goto('/glinfs/?testMode=true#/capture');
  await page.waitForFunction(() => window.__TEST_HOOKS__);
  const results = await page.evaluate(async () => {
    const { rgbaToI420 } = await import('/glinfs/shared/i420.js');
    const { convertToI420 } = await import('/glinfs/workers/i420-converter.js');
    const out = [];
    const engines = ['webgl2'];
    if (await navigator.gpu?.requestAdapter()) engines.unshift('webgpu');
    for (const engine of engines)
      for (const [w, h, kind] of [
        [1280, 720, 'bitmap'],
        [641, 361, 'bitmap'],
        [1280, 720, 'videoframe'],
        [641, 361, 'videoframe'],
      ]) {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
        // Opaque like a screen capture (a translucent pixel reads back
        // premultiplied from the GPU and unpremultiplied from getImageData)
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 6) {
          ctx.fillStyle = `hsl(${(x / w) * 360} 85% 50%)`;
          ctx.fillRect(x, 0, 6, h / 2);
        }
        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(0, h / 2, w, h / 2);
        ctx.font = '13px sans-serif';
        for (let r = 0; r < 8; r++) {
          ctx.fillStyle = ['#c0392b', '#2050d0'][r % 2];
          ctx.fillText('Red and blue text on a light page', 10, h / 2 + 20 + r * 18);
        }
        const reference = rgbaToI420(ctx.getImageData(0, 0, w, h).data, w, h);
        const bitmaps = await Promise.all([0, 1, 2].map(() => createImageBitmap(canvas)));
        const sources =
          kind === 'bitmap'
            ? bitmaps
            : bitmaps.map((bitmap, i) => {
                const frame = new VideoFrame(bitmap, { timestamp: i });
                bitmap.close();
                return frame;
              });
        const result = await convertToI420(
          sources.map((source, i) => ({ id: String(i), timestamp: i, source })),
          { engines: [engine] },
        );
        const mismatches = result.converted.map((c) => {
          const bytes = new Uint8Array(c.data);
          let diff = 0;
          for (let k = 0; k < reference.length; k++) if (bytes[k] !== reference[k]) diff++;
          return { length: bytes.length, diff };
        });
        out.push({
          w,
          h,
          kind,
          asked: engine,
          engine: result.engine,
          size: reference.length,
          mismatches,
        });
      }
    return out;
  });

  expect(results.length).toBeGreaterThanOrEqual(4);
  for (const r of results) {
    expect(r.engine).toBe(r.asked);
    expect(r.mismatches).toEqual(Array(3).fill({ length: r.size, diff: 0 }));
  }
});

test('Create Clip opens at once and moves to I420 frames; a Clip Now clip compresses and opens', async ({
  page,
}) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      let n = 0;
      const draw = () => {
        n++;
        ctx.fillStyle = `hsl(${(n * 5) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#fff';
        ctx.font = '40px sans-serif';
        ctx.fillText(`frame ${n}`, 80, 120);
      };
      draw();
      setInterval(draw, 1000 / 30);
      return canvas.captureStream(30);
    };
  });
  await page.goto('/glinfs/?testMode=true#/capture');
  await page.waitForFunction(() => window.__TEST_HOOKS__);
  await page.evaluate(() => localStorage.clear());
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') await sceneToggle.click();

  await page.locator('.btn-capture-start').click();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()))
    .toBeGreaterThan(30);
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible', timeout: 15000 });
  // Play while the frames are swapped under the preview
  await page.keyboard.press('Space');

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.__TEST_HOOKS__.getClipPayload()?.frames ?? []).every(
            (f) => f.frame.format === 'I420',
          ),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await page.keyboard.press('Space');

  const facts = await page.evaluate(() => {
    const frames = window.__TEST_HOOKS__.getClipPayload()?.frames ?? [];
    return {
      count: frames.length,
      formats: [...new Set(frames.map((f) => f.frame.format))],
      sizes: [...new Set(frames.map((f) => `${f.width}x${f.height}`))],
      alloc: frames[0]?.frame.allocationSize(),
      byteLength: frames[0]?.byteLength,
    };
  });
  expect(facts.count).toBeGreaterThan(30);
  expect(facts.formats).toEqual(['I420']);
  expect(facts.sizes).toEqual(['1280x720']);
  expect(facts.alloc).toBe(1280 * 720 * 1.5);
  expect(facts.byteLength).toBe(1280 * 720 * 1.5);
  expect(errors).toEqual([]);

  // Clip Now: the snapshot is queued and compresses from its GPU frames
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="monitor-clip-now"]').click();
  await expect(page.locator('#clip-queue-badge')).toHaveText('1');
  const queued = page.locator(
    '.sidebar-pane[data-pane="clips"] [data-testid="clip-entry"]:not([data-clip-active]) .clip-entry-main',
  );
  await expect(queued).toHaveCount(1);

  // Opening it decodes it and makes it the active clip
  const activeBefore = await page.evaluate(
    () => window.__TEST_HOOKS__.getClipPayload()?.capturedAt,
  );
  await queued.click();
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.capturedAt), {
      timeout: 15000,
    })
    .not.toBe(activeBefore);
  await expect(page.locator('.editor-canvas')).toBeVisible();
});
