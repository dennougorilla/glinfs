/**
 * E2E: the general AI model next to the anime one — model choice in the
 * editor, masks kept apart per model, the export using the chosen model,
 * the no-WebGPU path, and Settings → "Downloaded models".
 *
 * Runs the app's real segmentation worker on the WASM fallback (headless
 * Chromium has no WebGPU) with two stubs served under the two model URLs:
 * stub-seg.onnx as the anime model (input `img`, output `mask`) and
 * stub-seg-general.onnx as the general one (input `input_image`, outputs
 * `output_image` + a side output; it undoes the 0.5 mean the general
 * preprocessing subtracts). Both give each pixel's mean brightness, so the
 * disc clip reads the same through either model: disc A 255, disc B about
 * 160, background 0.
 * @module tests/e2e/ai-cutout-general.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  chooseAiCutout,
  chooseAiModel,
  decodeExportedGif,
  discClip,
  editorPreviewAlpha,
  exportDialog,
  exportFromEditor,
  gifPixel,
  gotoCaptureWithStubModel,
  injectDiscClip,
  MODEL_FILES,
  pauseEditorPlayback,
  readAiStatus,
  serveStubModel,
  waitForAiMasks,
} from './helpers/app.js';

const ANIME_STUB = readFileSync(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const GENERAL_STUB = readFileSync(
  new URL('../fixtures/models/stub-seg-general.onnx', import.meta.url),
);
/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const STUBS = {
  anime: { sha256: sha256(ANIME_STUB), bytes: ANIME_STUB.length },
  general: { sha256: sha256(GENERAL_STUB), bytes: GENERAL_STUB.length },
};
const { discA, discB, width, height } = discClip;

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ size: number, byModel: { anime: number, general: number } }>}
 */
function maskStats(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats());
}

/**
 * Mask values of frame `index` at disc A, disc B and the background
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 * @param {'anime' | 'general'} modelId
 */
function sampleDiscs(page, index, modelId) {
  const points = [
    { x: discA(index).x / width, y: discA(index).y / height },
    { x: discB(index).x / width, y: discB(index).y / height },
    { x: 5 / width, y: 5 / height },
  ];
  return page.evaluate(
    ({ i, p, m }) => window.__TEST_HOOKS__.aiCutout.sampleMask(i, p, m)?.values ?? null,
    { i: index, p: points, m: modelId },
  );
}

/**
 * Open the editor on a disc clip with both stubs and choose the AI cutout
 * @param {import('@playwright/test').Page} page
 * @param {{ count: number, allowWasm: boolean }} options
 */
async function openDiscClip(page, { count, allowWasm }) {
  const requests = await serveStubModel(page, ANIME_STUB, { general: GENERAL_STUB });
  await gotoCaptureWithStubModel(page, { models: STUBS, allowWasm });
  await injectDiscClip(page, { count });
  await pauseEditorPlayback(page);
  await chooseAiCutout(page);
  return requests;
}

test.describe('General AI model (stub models, WASM fallback)', () => {
  // Every test compiles ONNX Runtime's WASM binary in a fresh context, and
  // a WASM session is unloaded before the other model loads
  test.describe.configure({ mode: 'default', timeout: 240_000 });

  test('the general model analyzes through its own file; each model keeps its own masks; the export uses the chosen one', async ({
    page,
  }) => {
    const N = 6;
    const requests = await openDiscClip(page, { count: N, allowWasm: true });

    // The choice, with each model's download size
    await expect(page.getByRole('radio', { name: 'Anime 88 MB' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'General 90 MB' })).not.toBeChecked();
    await chooseAiModel(page, 'general');
    await expect(page.locator('#ai-intro')).toContainText('General model');
    await expect(page.locator('#ai-intro')).toContainText('downloads 90 MB once');
    await expect(page.locator('#ai-coverage')).toHaveText(`0 of ${N} frames analyzed`);

    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    // Only the general file was downloaded
    expect(requests.byModel).toEqual({ anime: 0, general: 1 });
    expect((await readAiStatus(page))?.backend).toBe('wasm');
    expect((await maskStats(page)).byModel).toEqual({ anime: 0, general: N });

    // Stretch preprocessing and the stub's mean-0.5 round trip land every
    // disc where it is (the stretched ellipse maps back onto the circle)
    for (const index of [0, N - 1]) {
      const [a, b, bg] = /** @type {number[]} */ (await sampleDiscs(page, index, 'general'));
      expect(a).toBeGreaterThanOrEqual(250);
      expect(Math.abs(b - 160)).toBeLessThanOrEqual(6);
      expect(bg).toBeLessThanOrEqual(3);
    }
    expect(await sampleDiscs(page, 0, 'anime')).toBeNull();

    await waitForAiMasks(page);
    const f = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().currentFrame);
    await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(f).x, discA(f).y)).toBe(255);

    // Anime: its own (empty) analysis; the general masks stay untouched
    await chooseAiModel(page, 'anime');
    await expect(page.locator('#ai-coverage')).toHaveText(`0 of ${N} frames analyzed`);
    await expect(page.locator('#ai-preview-note')).toHaveText('Not analyzed yet');
    await expect(page.locator('#ai-analyze')).toHaveText(`Analyze ${N} frames`);
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 1, general: 1 });
    expect((await maskStats(page)).byModel).toEqual({ anime: N, general: N });

    // Back to general: its masks are reused — nothing to analyze, no download
    await chooseAiModel(page, 'general');
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`);
    await expect(page.locator('#ai-analyze')).toHaveText('Selection analyzed');
    await waitForAiMasks(page);

    // The export encodes with the general masks without analyzing again
    await exportFromEditor(page);
    await expect(page.locator('#export-ai-note')).toBeHidden();
    const dialog = exportDialog(page);
    await dialog.locator('#export-start').click();
    await expect(dialog.locator('#export-result')).toBeVisible({ timeout: 60_000 });
    expect(requests.byModel).toEqual({ anime: 1, general: 1 });
    const frames = await decodeExportedGif(page);
    expect(frames).toHaveLength(N);
    frames.forEach((frame, i) => {
      expect({
        a: gifPixel(frame, discA(i).x, discA(i).y)[3],
        b: gifPixel(frame, discB(i).x, discB(i).y)[3],
        bg: gifPixel(frame, 5, 5)[3],
      }).toEqual({ a: 255, b: 255, bg: 0 });
    });
  });

  test('the export analyzes the frames the general model has not analyzed yet', async ({
    page,
  }) => {
    const N = 6;
    const requests = await openDiscClip(page, { count: N, allowWasm: true });
    // Anime analyzes everything; general nothing
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    await chooseAiModel(page, 'general');
    await exportFromEditor(page);
    await expect(page.locator('#export-ai-note')).toHaveText(
      `${N} of ${N} frames are not analyzed yet. Export analyzes them first (the editor previews them without the cutout).`,
    );
    const dialog = exportDialog(page);
    await dialog.locator('#export-start').click();
    await expect(dialog.locator('#export-result')).toBeVisible({ timeout: 60_000 });
    expect(requests.byModel).toEqual({ anime: 1, general: 1 });
    expect((await maskStats(page)).byModel).toEqual({ anime: N, general: N });
    const frames = await decodeExportedGif(page);
    expect(gifPixel(frames[0], 5, 5)[3]).toBe(0);
    expect(gifPixel(frames[0], discA(0).x, discA(0).y)[3]).toBe(255);
  });

  test('without WebGPU the general model also runs only after the explicit slow choice', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', {
        configurable: true,
        get: () => undefined,
      });
    });
    const requests = await openDiscClip(page, { count: 3, allowWasm: false });
    await chooseAiModel(page, 'general');

    const warning = page.locator('#ai-webgpu-warning');
    await expect(warning).toContainText('WebGPU is not available');
    await page.locator('#ai-analyze').click();
    await expect(warning).toContainText('The analysis needs WebGPU', { timeout: 30_000 });
    expect(requests.count).toBe(0);

    await page.locator('#ai-run-wasm').click();
    await expect(page.locator('#ai-coverage')).toHaveText('3 of 3 frames analyzed', {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 0, general: 1 });
    await expect(page.locator('#ai-wasm-note')).toBeVisible();
  });

  test('Settings → Downloaded models lists the cached model and Delete removes it', async ({
    page,
  }) => {
    const requests = await openDiscClip(page, { count: 2, allowWasm: true });
    // Left over from earlier versions: the fp32 anime model of the first AI
    // cutout release, and the general file under an earlier pin
    const leftovers = await page.evaluate(async (generalFile) => {
      const cache = await caches.open('glinfs-models-v1');
      const models = new URL('models/', document.baseURI).href;
      const fp32 = `${models}isnetis.onnx?sha256=${'f'.repeat(64)}`;
      const stale = `${models}${generalFile}?sha256=${'0'.repeat(64)}`;
      const body = new Uint8Array(2_000_000);
      const headers = { 'Content-Length': String(body.byteLength) };
      await cache.put(fp32, new Response(body, { headers }));
      await cache.put(stale, new Response(body, { headers }));
      return { fp32, stale };
    }, MODEL_FILES.general);
    await chooseAiModel(page, 'general');
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText('2 of 2 frames analyzed', {
      timeout: 60_000,
    });

    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    const section = page.getByRole('region', { name: 'Downloaded models' });
    await expect(section).toBeVisible();
    const general = section.locator('[data-model-id="general"]');
    const anime = section.locator('[data-model-id="anime"]');
    await expect(general).toContainText('General');
    await expect(general).toContainText('90 MB');
    await expect(general.getByRole('link', { name: 'Apache-2.0' })).toBeVisible();
    await expect(general).toContainText('Downloaded, kept in this browser’s cache');
    await expect(anime).toContainText('Not downloaded');
    await expect(anime.getByRole('button', { name: 'Delete the Anime model' })).toBeDisabled();

    // The verified download of the general model removed its earlier pin;
    // the fp32 file of another name is listed as an old file
    const oldFiles = section.locator('[data-old-file]');
    await expect(oldFiles).toHaveCount(1);
    await expect(oldFiles).toContainText('Old model file');
    await expect(oldFiles).toContainText('isnetis.onnx · 2 MB');
    await oldFiles.getByRole('button', { name: 'Delete the old model file isnetis.onnx' }).click();
    await expect(section.getByRole('status')).toHaveText(
      'The old model file isnetis.onnx was deleted.',
    );
    await expect(oldFiles).toHaveCount(0);
    const keys = await page.evaluate(async () =>
      (await (await caches.open('glinfs-models-v1')).keys()).map((r) => r.url),
    );
    expect(keys).not.toContain(leftovers.fp32);
    expect(keys).not.toContain(leftovers.stale);

    const deleteGeneral = general.getByRole('button', { name: 'Delete the General model' });
    await deleteGeneral.focus();
    await page.keyboard.press('Enter');
    await expect(section.getByRole('status')).toHaveText('The General model was deleted.');
    await expect(general).toContainText('Not downloaded');
    await expect(deleteGeneral).toBeDisabled();

    // Gone from Cache Storage (every copy of that file)
    const left = await page.evaluate(async (file) => {
      const cache = await caches.open('glinfs-models-v1');
      return (await cache.keys()).map((r) => r.url).filter((url) => url.includes(file));
    }, MODEL_FILES.general);
    expect(left).toEqual([]);

    // The next analysis with it downloads it again
    await page.evaluate(() => {
      window.__TEST_HOOKS__.aiCutout.clearMasks();
      location.hash = '#/editor';
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await pauseEditorPlayback(page);
    await expect(page.locator('#ai-model-general')).toBeChecked();
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText('2 of 2 frames analyzed', {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 0, general: 2 });
  });
});
