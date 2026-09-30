/**
 * E2E: the Portrait model (MODNet) — the third segment of the editor's
 * model switch, an analysis through its own 512×512 file with the ±1
 * normalization, and its row in Settings → "AI models" (with General's
 * training-data note).
 *
 * Runs the app's real segmentation worker on the WASM fallback with
 * stub-seg-portrait.onnx served under the portrait model's URL: input
 * `input` fixed at [1, 3, 512, 512] (a 1024 feed fails, so the analysis
 * only succeeds at the model's own input side), output
 * `output = mean(input) * 0.5 + 0.5`, which undoes the mean 0.5 / std 0.5
 * preprocessing: disc A 255, disc B about 160, background 0, as with the
 * other stubs.
 * @module tests/e2e/ai-cutout-portrait.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  chooseAiCutout,
  chooseAiModel,
  discClip,
  editorPreviewAlpha,
  gotoCaptureWithStubModel,
  injectDiscClip,
  pauseEditorPlayback,
  readAiStatus,
  serveStubModel,
  waitForAiMasks,
} from './helpers/app.js';

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`../fixtures/models/${name}`, import.meta.url));
const ANIME_STUB = fixture('stub-seg.onnx');
const GENERAL_STUB = fixture('stub-seg-general.onnx');
const PORTRAIT_STUB = fixture('stub-seg-portrait.onnx');
/** @param {Buffer} bytes */
const pin = (bytes) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});
const STUBS = { anime: pin(ANIME_STUB), general: pin(GENERAL_STUB), portrait: pin(PORTRAIT_STUB) };
const { discA, discB, width, height } = discClip;

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 */
function samplePortrait(page, index) {
  const points = [
    { x: discA(index).x / width, y: discA(index).y / height },
    { x: discB(index).x / width, y: discB(index).y / height },
    { x: 5 / width, y: 5 / height },
  ];
  return page.evaluate(
    ({ i, p }) => window.__TEST_HOOKS__.aiCutout.sampleMask(i, p, 'portrait')?.values ?? null,
    { i: index, p: points },
  );
}

test.describe('Portrait AI model (stub model, WASM fallback)', () => {
  test.describe.configure({ mode: 'default', timeout: 240_000 });

  test('the switch fits three models on one row; Portrait analyzes through its own 512 file', async ({
    page,
  }) => {
    const N = 5;
    const requests = await serveStubModel(page, ANIME_STUB, {
      general: GENERAL_STUB,
      portrait: PORTRAIT_STUB,
    });
    await gotoCaptureWithStubModel(page, { models: STUBS, allowWasm: true });
    await injectDiscClip(page, { count: N });
    await pauseEditorPlayback(page);
    await chooseAiCutout(page);

    // General, Portrait, Anime (still the default)
    const order = await page
      .locator('#ai-model input')
      .evaluateAll((inputs) => inputs.map((i) => i.id));
    expect(order).toEqual(['ai-model-general', 'ai-model-portrait', 'ai-model-anime']);
    await expect(
      page.getByRole('radio', { name: 'Anime ISNet anime Download 88 MB' }),
    ).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'Portrait MODNet Download 13 MB' }),
    ).not.toBeChecked();

    // One row in the sidebar: same top for every segment, nothing clipped
    const layout = await page.locator('#ai-model .editor-text-segmented').evaluate((row) => {
      const labels = [...row.querySelectorAll('label')];
      return {
        tops: labels.map((l) => Math.round(l.getBoundingClientRect().top)),
        overflow: labels.map((l) => {
          const span = /** @type {HTMLElement} */ (l.querySelector('span'));
          return span.scrollWidth - span.clientWidth;
        }),
        rowOverflow: row.scrollWidth - row.clientWidth,
      };
    });
    expect(new Set(layout.tops).size).toBe(1);
    expect(layout.overflow.every((px) => px <= 0)).toBe(true);
    expect(layout.rowOverflow).toBeLessThanOrEqual(0);

    await chooseAiModel(page, 'portrait');
    await expect(page.locator('#ai-intro')).toContainText('Portrait model');
    await expect(page.locator('#ai-intro')).toContainText('downloads 13 MB once');
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    expect(requests.byModel).toEqual({ anime: 0, general: 0, portrait: 1 });
    expect(await readAiStatus(page)).toMatchObject({ backend: 'wasm' });
    const stats = await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.getMaskStoreStats());
    expect(stats.byModel).toEqual({ anime: 0, general: 0, portrait: N });

    // ±1 normalization round trip through the stub, stretched to 512² and back
    for (const index of [0, N - 1]) {
      const [a, b, bg] = /** @type {number[]} */ (await samplePortrait(page, index));
      expect(a).toBeGreaterThanOrEqual(250);
      expect(Math.abs(b - 160)).toBeLessThanOrEqual(6);
      expect(bg).toBeLessThanOrEqual(3);
    }

    await waitForAiMasks(page);
    const f = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().currentFrame);
    await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(f).x, discA(f).y)).toBe(255);
    await expect(page.locator('#ai-model-hint-portrait')).toHaveText(/Ready/);
  });

  test('Settings → AI models lists three models, with the note on General', async ({ page }) => {
    await serveStubModel(page, ANIME_STUB, { general: GENERAL_STUB, portrait: PORTRAIT_STUB });
    await gotoCaptureWithStubModel(page, { models: STUBS, allowWasm: true });
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    const section = page.getByRole('region', { name: 'AI models' });
    await expect(section).toBeVisible();
    const ids = await section
      .locator('[data-model-id]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-model-id')));
    expect(ids).toEqual(['general', 'portrait', 'anime']);

    const portrait = section.locator('[data-model-id="portrait"]');
    await expect(portrait.locator('h3')).toHaveText('PortraitMODNet');
    await expect(portrait).toContainText('People in live-action video (fast, small)');
    await expect(portrait).toContainText('13 MB');
    await expect(portrait.getByRole('link', { name: 'Apache-2.0' })).toBeVisible();
    await expect(portrait.locator('.settings-models-license-note')).toHaveCount(0);

    const note = section.locator('[data-model-id="general"] .settings-models-license-note');
    await expect(note).toContainText('DIS5K');
    await expect(note).toContainText('non-commercial');
    await expect(note.getByRole('link', { name: 'DIS repository' })).toHaveAttribute(
      'href',
      'https://github.com/xuebinqin/DIS',
    );

    await portrait.getByRole('button', { name: 'Download the Portrait model (13 MB)' }).click();
    await expect(portrait).toHaveAttribute('data-model-status', 'downloaded');
    await expect(section.getByRole('status')).toHaveText('The Portrait model was downloaded.');
  });
});
