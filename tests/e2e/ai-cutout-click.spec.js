/**
 * E2E: "Something else — click it" (click to select, MobileSAM) — the fifth
 * subject card, its download question, a click on the preview, the mask on
 * the frame on screen, Whole / Part, tracking through the clip, the export's
 * transparency and the model's row in Settings → "AI models".
 *
 * Runs the app's real segmentation worker on the WASM fallback with the two
 * click-to-select stubs served under MobileSAM's URLs
 * (scripts/generate-stub-seg-model.mjs): the encoder turns the frame into a
 * grey 64 × 64 "embedding", the decoder answers four masks thresholding it
 * at 128 / 200 / 128 / 60, whatever the prompt. On the disc clip (disc A
 * white, disc B grey 160, black background) Whole keeps both discs and Part
 * (threshold 200) only disc A.
 * @module tests/e2e/ai-cutout-click.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  decodeExportedGif,
  discClip,
  editorFramePointToViewport,
  editorPreviewAlpha,
  exportDialog,
  exportFromEditor,
  gifPixel,
  gotoCaptureWithStubModel,
  injectDiscClip,
  openSidebarTab,
  pauseEditorPlayback,
  readAiStatus,
  waitForAiMasks,
} from './helpers/app.js';

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`../fixtures/models/${name}`, import.meta.url));
const ENCODER = fixture('stub-sam-encoder.onnx');
const DECODER = fixture('stub-sam-decoder.onnx');
/** @param {Buffer} bytes */
const pin = (bytes) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});
const OVERRIDE = {
  models: { click: { files: [pin(ENCODER), pin(DECODER)] } },
  allowWasm: true,
};
const { discA, discB } = discClip;

/**
 * Serve the stubs under MobileSAM's URLs and count the requests per file
 * @param {import('@playwright/test').Page} page
 */
async function serveSamStubs(page) {
  const requests = { encoder: 0, decoder: 0, other: 0 };
  await page.route('**/models/mobilesam-image-encoder.onnx', async (route) => {
    requests.encoder++;
    await route.fulfill({ body: ENCODER, contentType: 'application/octet-stream' });
  });
  await page.route('**/models/mobilesam-mask-decoder.onnx', async (route) => {
    requests.decoder++;
    await route.fulfill({ body: DECODER, contentType: 'application/octet-stream' });
  });
  await page.route(/\/models\/(?!mobilesam-).*\.onnx$/, async (route) => {
    requests.other++;
    await route.fulfill({ status: 404 });
  });
  return requests;
}

/**
 * Mask values (click model) at disc A, disc B and the background of a frame
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 */
function sampleClick(page, index) {
  const { width, height } = discClip;
  const points = [
    { x: discA(index).x / width, y: discA(index).y / height },
    { x: discB(index).x / width, y: discB(index).y / height },
    { x: 5 / width, y: 5 / height },
  ];
  return page.evaluate(
    ({ i, p }) => window.__TEST_HOOKS__.aiCutout.sampleMask(i, p, 'click')?.values ?? null,
    { i: index, p: points },
  );
}

test.describe('Click to select (stub MobileSAM, WASM fallback)', () => {
  test.describe.configure({ mode: 'default', timeout: 240_000 });

  test('asks before downloading 45 MB, and Cancel downloads nothing', async ({ page }) => {
    const requests = await serveSamStubs(page);
    await gotoCaptureWithStubModel(page, OVERRIDE);
    await injectDiscClip(page, { count: 4 });
    await pauseEditorPlayback(page);
    await openSidebarTab(page, 'background');

    const card = page.getByRole('radio', { name: /^Something else/ });
    await expect(page.locator('#subject-status-click')).toContainText('45 MB');
    await page.locator('label[for="subject-click"]').click();
    await expect(card).toBeChecked();
    await expect(page.locator('#background-download-title')).toHaveText('Download 45 MB?');
    await expect(page.locator('#background-download-detail')).toContainText(
      'The Click to select model (MobileSAM) runs in this browser',
    );
    await page.locator('#background-download-cancel').click();
    await expect(page.locator('#background-download')).toBeHidden();
    await expect(page.locator('#subject-none')).toBeChecked();
    expect(requests).toEqual({ encoder: 0, decoder: 0, other: 0 });
  });

  test('click → mask on the frame on screen → Whole / Part → tracked through the clip → transparent export', async ({
    page,
  }) => {
    const N = 6;
    const requests = await serveSamStubs(page);
    await gotoCaptureWithStubModel(page, OVERRIDE);
    await injectDiscClip(page, { count: N });
    await pauseEditorPlayback(page);
    await page.evaluate(() => window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 }));
    await openSidebarTab(page, 'background');

    await page.locator('label[for="subject-click"]').click();
    await page.locator('#background-download-confirm').click();
    // The model loads (both files), then the preview asks for a click
    await expect(page.locator('#ai-status-text')).toHaveText('Click the thing you want to keep', {
      timeout: 60_000,
    });
    expect(requests).toEqual({ encoder: 1, decoder: 1, other: 0 });
    await expect(page.locator('#preview-tool-hint')).toContainText(
      'Click the thing you want to keep',
    );
    await expect(page.locator('#ai-click-scope')).toBeHidden();

    // Click disc A on frame 2
    const target = await editorFramePointToViewport(page, discA(2).x, discA(2).y);
    await page.mouse.click(target.x, target.y);
    await expect
      .poll(() => page.evaluate(() => window.__TEST_HOOKS__.aiCutout.hasMask(2, 'click')), {
        timeout: 60_000,
      })
      .toBe(true);
    const state = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState());
    expect(state.edits.background.ai.picks).toHaveLength(1);
    expect(state.edits.background.ai.picks[0]).toMatchObject({ frame: 2, mode: 'keep' });
    expect(state.aiPickTool).toBeNull();
    await expect(page.locator('#ai-click-scope')).toBeVisible();
    await expect(page.locator('#ai-click-scope-whole')).toBeChecked();

    // Tracked through every frame of the clip
    await expect(page.locator('#ai-status-text')).toHaveText(`Tracked through ${N} frames`, {
      timeout: 60_000,
    });
    expect(await readAiStatus(page)).toMatchObject({ backend: 'wasm', lostFrames: [] });
    const stats = await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats());
    expect(stats.byModel.click).toBe(N);
    // Whole: both discs; background out
    for (const index of [0, 2, N - 1]) {
      const [a, b, bg] = /** @type {number[]} */ (await sampleClick(page, index));
      expect(a).toBeGreaterThan(200);
      expect(b).toBeGreaterThan(200);
      expect(bg).toBeLessThan(10);
    }
    await waitForAiMasks(page);
    await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(2).x, discA(2).y)).toBe(255);

    // Part: only disc A (brighter than 200); tracked again
    await page.locator('label[for="ai-click-scope-part"]').click();
    await expect
      .poll(async () => (await sampleClick(page, 2))?.[1], { timeout: 60_000 })
      .toBeLessThan(10);
    await expect(page.locator('#ai-status-text')).toHaveText(`Tracked through ${N} frames`, {
      timeout: 60_000,
    });
    const [a2, b2] = /** @type {number[]} */ (await sampleClick(page, N - 1));
    expect(a2).toBeGreaterThan(200);
    expect(b2).toBeLessThan(10);

    // Export: disc A opaque, disc B and the background transparent
    await waitForAiMasks(page);
    await exportFromEditor(page);
    await expect(page.locator('#export-ai-note')).toBeHidden();
    const dialog = exportDialog(page);
    await dialog.locator('#export-start').click();
    await expect(dialog.locator('#export-result')).toBeVisible({ timeout: 60_000 });
    const frames = await decodeExportedGif(page);
    expect(frames).toHaveLength(N);
    frames.forEach((frame, i) => {
      expect({
        a: gifPixel(frame, discA(i).x, discA(i).y)[3],
        b: gifPixel(frame, discB(i).x, discB(i).y)[3],
        bg: gifPixel(frame, 5, 5)[3],
      }).toEqual({ a: 255, b: 0, bg: 0 });
    });
  });

  test('export tracks from a click on a frame that frame skip leaves out', async ({ page }) => {
    const N = 6;
    await serveSamStubs(page);
    await gotoCaptureWithStubModel(page, OVERRIDE);
    await injectDiscClip(page, { count: N });
    await pauseEditorPlayback(page);
    await page.evaluate(() => window.__TEST_HOOKS__.setEditorState({ currentFrame: 5 }));
    await openSidebarTab(page, 'background');
    await page.locator('label[for="subject-click"]').click();
    await page.locator('#background-download-confirm').click();
    await expect(page.locator('#ai-status-text')).toHaveText('Click the thing you want to keep', {
      timeout: 60_000,
    });
    const a = await editorFramePointToViewport(page, discA(5).x, discA(5).y);
    await page.mouse.click(a.x, a.y);
    await expect(page.locator('#ai-status-text')).toHaveText(`Tracked through ${N} frames`, {
      timeout: 60_000,
    });
    // Masks are memory-only (a reload drops them); the click on frame 5 stays
    await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.clearMasks());

    // Every other frame: 0, 2, 4 — not the clicked frame 5
    await exportFromEditor(page);
    const dialog = exportDialog(page);
    await dialog.locator('#export-frame-skip').selectOption('2');
    await dialog.locator('#export-start').click();
    await expect(dialog.locator('#export-result')).toBeVisible({ timeout: 60_000 });
    const frames = await decodeExportedGif(page);
    expect(frames).toHaveLength(3);
    frames.forEach((frame, k) => {
      const i = k * 2;
      expect({
        a: gifPixel(frame, discA(i).x, discA(i).y)[3],
        bg: gifPixel(frame, 5, 5)[3],
      }).toEqual({ a: 255, bg: 0 });
    });
  });

  test('Remove adds a point, removing the last point clears the masks', async ({ page }) => {
    const N = 3;
    await serveSamStubs(page);
    await gotoCaptureWithStubModel(page, OVERRIDE);
    await injectDiscClip(page, { count: N });
    await pauseEditorPlayback(page);
    await page.evaluate(() => window.__TEST_HOOKS__.setEditorState({ currentFrame: 0 }));
    await openSidebarTab(page, 'background');
    await page.locator('label[for="subject-click"]').click();
    await page.locator('#background-download-confirm').click();
    await expect(page.locator('#ai-status-text')).toHaveText('Click the thing you want to keep', {
      timeout: 60_000,
    });
    // A first click with Remove selects (a keep point): remove points alone select nothing
    await page.locator('label[for="ai-pick-remove"]').click();
    const a = await editorFramePointToViewport(page, discA(0).x, discA(0).y);
    await page.mouse.click(a.x, a.y);
    await expect(page.locator('#ai-status-text')).toHaveText(`Tracked through ${N} frames`, {
      timeout: 60_000,
    });
    expect(
      await page.evaluate(() =>
        window.__TEST_HOOKS__.getEditorState().edits.background.ai.picks.map((p) => p.mode),
      ),
    ).toEqual(['keep']);

    await page.locator('label[for="ai-pick-remove"]').click();
    const b = await editorFramePointToViewport(page, discB(0).x, discB(0).y);
    await page.mouse.click(b.x, b.y);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__TEST_HOOKS__.getEditorState().edits.background.ai.picks.map((p) => p.mode),
        ),
      )
      .toEqual(['keep', 'remove']);
    await expect(page.locator('#ai-pick-list li')).toHaveCount(2);
    await expect(page.locator('#ai-status-text')).toHaveText(`Tracked through ${N} frames`, {
      timeout: 60_000,
    });

    // Remove both points: the click masks go, the preview asks again
    await page.locator('#ai-pick-list .editor-cutout-pick-delete').first().click();
    await page.locator('#ai-pick-list .editor-cutout-pick-delete').first().click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats().byModel.click),
      )
      .toBe(0);
    await expect(page.locator('#ai-status-text')).toHaveText('Click the thing you want to keep');
  });

  test('Settings → AI models shows Click to select as one model of 45 MB', async ({ page }) => {
    const requests = await serveSamStubs(page);
    await gotoCaptureWithStubModel(page, OVERRIDE);
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    const section = page.getByRole('region', { name: 'AI models' });
    await expect(section).toBeVisible();
    const ids = await section
      .locator('[data-model-id]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-model-id')));
    expect(ids).toEqual(['general', 'portrait', 'anime', 'click', 'ben2', 'video-person']);
    const row = section.locator('[data-model-id="click"]');
    await expect(row.locator('h3')).toHaveText('Click to selectMobileSAM');
    await expect(row).toContainText('Anything you click, followed through the clip');
    await expect(row).toContainText('45 MB');
    await expect(row.getByRole('link', { name: 'Apache-2.0' })).toBeVisible();

    await row.getByRole('button', { name: 'Download the Click to select model (45 MB)' }).click();
    await expect(row).toHaveAttribute('data-model-status', 'downloaded');
    await expect(section.getByRole('status')).toHaveText(
      'The Click to select model was downloaded.',
    );
    expect(requests).toEqual({ encoder: 1, decoder: 1, other: 0 });

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Delete the Click to select model' }).click();
    await expect(section.getByRole('status')).toHaveText('The Click to select model was deleted.');
    await expect(row).not.toHaveAttribute('data-model-status', 'downloaded');
  });
});
