/**
 * E2E: the general AI model next to the anime one — model choice in the
 * editor, masks kept apart per model, the export using the chosen model,
 * the no-WebGPU path, Settings → "AI models" (download, delete, old files)
 * and the editor preparing a downloaded model without downloading again.
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
  openSidebarTab,
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
 * Open the editor on a disc clip with both stubs (nothing chosen yet)
 * @param {import('@playwright/test').Page} page
 * @param {{ count: number, allowWasm: boolean }} options
 */
async function openDiscClip(page, { count, allowWasm }) {
  const requests = await serveStubModel(page, ANIME_STUB, { general: GENERAL_STUB });
  await gotoCaptureWithStubModel(page, { models: STUBS, allowWasm });
  await injectDiscClip(page, { count });
  await pauseEditorPlayback(page);
  await openSidebarTab(page, 'background');
  return requests;
}

/**
 * Use an AI model without choosing its card (like a clip restored with it):
 * the edits switch, nothing is analyzed or downloaded
 * @param {import('@playwright/test').Page} page
 * @param {'anime' | 'general'} model
 */
async function setAiModelEdits(page, model) {
  await page.evaluate((m) => {
    const { edits } = window.__TEST_HOOKS__.getEditorState();
    window.__TEST_HOOKS__.setEditorState({
      edits: {
        ...edits,
        background: {
          ...edits.background,
          enabled: true,
          method: 'ai',
          ai: { ...edits.background.ai, model: m },
        },
      },
    });
  }, model);
}

/**
 * Leave the editor and come back (a fresh mount with the clip's saved edits)
 * @param {import('@playwright/test').Page} page
 */
async function remountEditor(page) {
  await page.evaluate(() => {
    location.hash = '#/capture';
  });
  await page.waitForSelector('.capture-screen', { state: 'visible' });
  await page.evaluate(() => {
    location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
  await pauseEditorPlayback(page);
  await openSidebarTab(page, 'background');
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

    // The subjects: what each is for, and each model's download size
    await expect(page.getByRole('radio', { name: /^Anime/ })).not.toBeChecked();
    await expect(page.locator('#subject-status-anime')).toContainText('88 MB');
    await expect(page.locator('#subject-status-general')).toContainText('90 MB');
    await expect(page.locator('label[for="subject-general"]')).toHaveAttribute(
      'title',
      /ISNet \(general-use\)/,
    );
    await chooseAiModel(page, 'general', { download: false });
    await expect(page.locator('#background-download-title')).toHaveText('Download 90 MB?');
    await expect(page.locator('#background-download-detail')).toContainText('Anything model');
    await page.locator('#background-download-confirm').click();
    await expect(page.locator('#ai-status-text')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    // Only the general file was downloaded
    expect(requests.byModel).toEqual({ anime: 0, general: 1 });
    expect((await readAiStatus(page))?.backend).toBe('wasm');
    expect((await maskStats(page)).byModel).toEqual({ anime: 0, general: N, portrait: 0 });

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

    // Anime: its own analysis (after its download question); the general
    // masks stay untouched
    await chooseAiModel(page, 'anime');
    await expect.poll(() => requests.byModel.anime, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await readAiStatus(page))?.phase).toBe('idle');
    await expect(page.locator('#ai-status-text')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 1, general: 1 });
    expect((await maskStats(page)).byModel).toEqual({ anime: N, general: N, portrait: 0 });

    // Back to general: downloaded now (Ready, no question) and its masks
    // are reused — nothing to analyze, no download
    await expect(page.locator('#subject-status-general')).toContainText('Ready');
    await page.locator('label[for="subject-general"]').click();
    await expect(page.locator('#background-download')).toBeHidden();
    await expect(page.locator('#ai-status-text')).toHaveText(`${N} of ${N} frames analyzed`);
    await expect(page.locator('#ai-analyze')).toBeHidden();
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
    // Anime analyzes everything; general nothing (restored with it chosen)
    await chooseAiModel(page, 'anime');
    await expect(page.locator('#ai-status-text')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    await setAiModelEdits(page, 'general');
    await expect(page.locator('#ai-status-text')).toHaveText(`${N} frames not analyzed`);
    await exportFromEditor(page);
    await expect(page.locator('#export-ai-note')).toHaveText(
      `${N} of ${N} frames are not analyzed yet. Export analyzes them first (the editor previews them without the cutout).`,
    );
    const dialog = exportDialog(page);
    await dialog.locator('#export-start').click();
    await expect(dialog.locator('#export-result')).toBeVisible({ timeout: 60_000 });
    expect(requests.byModel).toEqual({ anime: 1, general: 1 });
    expect((await maskStats(page)).byModel).toEqual({ anime: N, general: N, portrait: 0 });
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
    await expect(warning).toContainText('This needs WebGPU', { timeout: 30_000 });
    expect(requests.count).toBe(0);

    await page.locator('#ai-run-wasm').click();
    await expect(page.locator('#ai-status-text')).toHaveText('3 of 3 frames analyzed', {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 0, general: 1 });
    await expect(page.locator('#ai-wasm-note')).toBeVisible();
  });

  test('Settings → AI models lists the cached model and Delete removes it', async ({ page }) => {
    // Delete asks first
    page.on('dialog', (dialog) => void dialog.accept());
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
    await expect(page.locator('#ai-status-text')).toHaveText('2 of 2 frames analyzed', {
      timeout: 60_000,
    });

    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    const section = page.getByRole('region', { name: 'AI models' });
    await expect(section).toBeVisible();
    const general = section.locator('[data-model-id="general"]');
    const anime = section.locator('[data-model-id="anime"]');
    await expect(general).toContainText('General');
    await expect(general).toContainText('ISNet (general-use)');
    await expect(general).toContainText('90 MB');
    await expect(general.getByRole('link', { name: 'Apache-2.0' })).toBeVisible();
    // Its session is still in memory from the analysis
    await expect(general).toHaveAttribute('data-model-status', 'loaded');
    await expect(anime).toContainText('Not downloaded');
    await expect(anime.getByRole('button', { name: 'Delete the Anime model' })).toHaveCount(0);

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
    await expect(deleteGeneral).toHaveCount(0);

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
    await openSidebarTab(page, 'background');
    await expect(page.locator('#subject-general')).toBeChecked();
    await expect(page.locator('#subject-status-general')).toContainText('90 MB');
    // Analyze says it downloads
    await expect(page.locator('#ai-analyze')).toHaveText('Analyze (\u2193 90 MB)');
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-status-text')).toHaveText('2 of 2 frames analyzed', {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 0, general: 2 });
  });

  test('Settings → AI models downloads a model; the editor prepares it without downloading again', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    const requests = await serveStubModel(page, ANIME_STUB, { general: GENERAL_STUB });
    await gotoCaptureWithStubModel(page, { models: STUBS, allowWasm: true });
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    const section = page.getByRole('region', { name: 'AI models' });
    const anime = section.locator('[data-model-id="anime"]');
    await expect(anime).toHaveAttribute('data-model-status', 'not-downloaded');
    await expect(section.locator('#settings-models-preload')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await anime.getByRole('button', { name: 'Download the Anime model (88 MB)' }).click();
    await expect(anime).toHaveAttribute('data-model-status', 'downloaded');
    await expect(section.getByRole('status')).toHaveText('The Anime model was downloaded.');
    await expect(section.locator('#settings-models-storage')).toContainText('Storage used:');
    expect(requests.byModel).toEqual({ anime: 1, general: 0 });
    const keys = await page.evaluate(async () =>
      (await (await caches.open('glinfs-models-v1')).keys()).map((r) => r.url),
    );
    expect(keys.filter((url) => url.includes(MODEL_FILES.anime))).toHaveLength(1);

    // A clip with the AI (Anime) chosen: the editor prepares the downloaded
    // model from the cache when it opens, and analyzes nothing by itself
    await injectDiscClip(page, { count: 3 });
    await pauseEditorPlayback(page);
    await setAiModelEdits(page, 'anime');
    await remountEditor(page);
    await expect(page.locator('#subject-anime')).toBeChecked();
    await expect(page.locator('#subject-status-anime')).toContainText('Ready');
    await expect(page.locator('#subject-status-general')).toContainText('90 MB');
    await expect
      .poll(() => page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getManagerState()), {
        timeout: 60_000,
      })
      .toMatchObject({ loadedModelIds: ['anime'] });
    expect(requests.byModel).toEqual({ anime: 1, general: 0 });
    await expect(page.locator('#ai-status-text')).toHaveText('3 frames not analyzed');

    // Analyze reuses the prepared session: no download
    await expect(page.locator('#ai-analyze')).toHaveText('Analyze');
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-status-text')).toHaveText('3 of 3 frames analyzed', {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 1, general: 0 });

    // Settings shows it loaded; Delete frees the file and the session
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    await expect(anime).toHaveAttribute('data-model-status', 'loaded');
    await anime.getByRole('button', { name: 'Delete the Anime model' }).click();
    await expect(anime).toHaveAttribute('data-model-status', 'not-downloaded');
    await expect
      .poll(() => page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getManagerState()))
      .toMatchObject({ loadedModelIds: [] });
  });

  test('with preparing turned off, the editor loads nothing by itself', async ({ page }) => {
    const requests = await serveStubModel(page, ANIME_STUB, { general: GENERAL_STUB });
    await gotoCaptureWithStubModel(page, { models: STUBS, allowWasm: true });
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    const section = page.getByRole('region', { name: 'AI models' });
    const anime = section.locator('[data-model-id="anime"]');
    await anime.getByRole('button', { name: 'Download the Anime model (88 MB)' }).click();
    await expect(anime).toHaveAttribute('data-model-status', 'downloaded');
    await section.locator('#settings-models-preload').click();
    await expect(section.locator('#settings-models-preload')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await injectDiscClip(page, { count: 2 });
    await pauseEditorPlayback(page);
    await setAiModelEdits(page, 'anime');
    await remountEditor(page);
    await expect(page.locator('#subject-status-anime')).toContainText('Ready');
    // Give an idle-time preload the chance to (wrongly) start
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getManagerState());
    expect(state.loadedModelIds).toEqual([]);
    expect(requests.byModel).toEqual({ anime: 1, general: 0 });
  });
});
