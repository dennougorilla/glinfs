/**
 * E2E: a custom model added in Settings → AI models → Add model, end to
 * end, with the tiny stub ONNX (tests/fixtures/models/stub-seg.onnx: input
 * `img` [1, 3, 1024, 1024], output `mask` = mean of R, G, B):
 *
 * - the dialog reads the graph and proposes settings; the test frame
 *   fails with the proposed ImageNet normalization (the stub's output
 *   leaves 0..1) and passes with 0..1;
 * - Save puts the file in Cache Storage and the definition in IndexedDB:
 *   the model survives a reload, and its definition exports as JSON;
 * - the Anything card lists it; an analysis with it gives the stub's masks;
 * - deleted, a clip that uses it fails with a clear message (no fallback);
 * - the exported JSON imports it again (after the file is picked and
 *   matches), under the same id.
 *
 * Headless Chromium has no WebGPU: the dialog's test and the analysis run
 * on WASM (the override allows it without asking).
 * @module tests/e2e/ai-cutout-custom-model.spec
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  discClip,
  gotoCaptureWithStubModel,
  injectDiscClip,
  openSidebarTab,
} from './helpers/app.js';

const STUB_PATH = fileURLToPath(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const N = 4;
const { discA, discB, width, height } = discClip;

/** @param {import('@playwright/test').Page} page */
async function openSettings(page) {
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.locator('#settings-models-add')).toBeVisible();
}

/**
 * Add the stub through the dialog and return its row's model id
 * @param {import('@playwright/test').Page} page
 */
async function addStubModel(page) {
  await page.locator('#settings-models-add').click();
  const dialog = page.getByTestId('add-model-dialog');
  await expect(dialog.getByRole('heading', { name: 'Add model' })).toBeVisible();
  await page.locator('#add-model-file').setInputFiles(STUB_PATH);

  // The graph and the proposal
  await expect(page.locator('#add-model-label')).toHaveValue('stub-seg', { timeout: 30_000 });
  await expect(page.locator('#add-model-summary')).toContainText(
    'Input img: float32 1 × 3 × 1024 × 1024',
  );
  await expect(page.locator('#add-model-summary')).toContainText(
    'Output mask: float32 1 × 1 × 1024 × 1024',
  );
  await expect(page.locator('#add-model-size')).toHaveValue('1024');
  await expect(page.locator('#add-model-size')).toBeDisabled();
  await expect(page.locator('#add-model-normalization')).toHaveValue('imagenet');
  await expect(page.locator('#add-model-save')).toBeDisabled();

  // ImageNet statistics push the stub's mean out of 0..1: the test says so
  await page.locator('#add-model-test').click();
  const result = page.locator('#add-model-test-result');
  await expect(result).toHaveAttribute('data-kind', 'error', { timeout: 60_000 });
  await expect(result).toContainText('outside 0..1');
  await expect(page.locator('#add-model-save')).toBeDisabled();

  // 0..1: the mask covers the bright part of the test image
  await page.locator('#add-model-normalization').selectOption('unit');
  await expect(result).not.toHaveAttribute('data-kind');
  await page.locator('#add-model-test').click();
  await expect(result).toHaveAttribute('data-kind', 'ok', { timeout: 60_000 });
  await expect(result).toContainText('Passed');
  await expect(page.locator('#add-model-preview')).toBeVisible();

  await page.locator('#add-model-label').fill('Stub mine');
  await expect(page.locator('#add-model-card-general')).toBeChecked();
  await page.locator('#add-model-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.settings-models-status')).toHaveText(
    'The custom model Stub mine was added.',
  );
  const row = page.locator('[data-model-id^="custom-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-model-status', 'downloaded');
  return /** @type {string} */ (await row.getAttribute('data-model-id'));
}

test.describe('Custom AI models', () => {
  test('add a model from a file, use it, delete it, import it again', async ({ page }) => {
    await gotoCaptureWithStubModel(page, { allowWasm: true });
    await openSettings(page);
    const id = await addStubModel(page);
    expect(id).toMatch(/^custom-[0-9a-f]{16}-[0-9a-f]{8}$/);
    const section = page.getByRole('region', { name: 'AI models' });
    await expect(section.getByRole('heading', { name: 'Your models' })).toBeVisible();
    const row = page.locator(`[data-model-id="${id}"]`);
    await expect(row.locator('h3')).toHaveText('Stub minestub-seg.onnx');

    // Rename in place (the id stays)
    await row.locator(`[data-model-rename="${id}"]`).click();
    const field = page.locator(`[data-model-id="${id}"] input`);
    await field.fill('Stub model');
    await field.press('Enter');
    await expect(page.locator(`[data-model-id="${id}"] h3`)).toHaveText('Stub modelstub-seg.onnx');

    // Export: the definition as a JSON file, made in the browser
    const downloadPromise = page.waitForEvent('download');
    await page.locator(`[data-model-export="${id}"]`).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('stub-model.glinfs-model.json');
    const exported = JSON.parse(
      readFileSync(/** @type {string} */ (await download.path()), 'utf8'),
    );
    expect(exported).toMatchObject({
      format: 'glinfs-custom-model',
      id,
      label: 'Stub model',
      source: 'file',
      fileName: 'stub-seg.onnx',
      bytes: readFileSync(STUB_PATH).length,
      inputName: 'img',
      outputName: 'mask',
      inputSize: 1024,
      normalization: 'unit',
      output: 'probability',
      subjects: ['general'],
    });

    // A reload keeps it: definition in IndexedDB, file in Cache Storage
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.aiCutout));
    await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.setModelOverride({ allowWasm: true }));
    await expect(page.locator(`[data-model-id="${id}"]`)).toHaveAttribute(
      'data-model-status',
      'downloaded',
    );

    // The Anything card lists it under "Your models"; analyzing uses it
    await page.evaluate(
      ({ model }) => {
        localStorage.setItem(
          'glinfs_user_settings',
          JSON.stringify({
            aiCutout: { lastModel: model, lastModelBySubject: { general: model } },
          }),
        );
      },
      { model: id },
    );
    await injectDiscClip(page, { count: N });
    await openSidebarTab(page, 'background');
    await page.locator('label[for="subject-general"]').click();
    const select = page.locator('#ai-model');
    await expect(select).toHaveValue(id);
    expect(
      await select
        .locator('optgroup')
        .evaluateAll((groups) =>
          groups.map((g) => [g.getAttribute('label'), g.querySelectorAll('option').length]),
        ),
    ).toEqual([
      ['Built in', 4],
      ['Your models', 1],
    ]);
    await expect(page.locator('#ai-status-text')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    const sampled = await page.evaluate(
      ({ points, model }) => window.__TEST_HOOKS__.aiCutout.sampleMask(0, points, model)?.values,
      {
        model: id,
        points: [
          { x: discA(0).x / width, y: discA(0).y / height },
          { x: discB(0).x / width, y: discB(0).y / height },
          { x: 5 / width, y: 5 / height },
        ],
      },
    );
    expect(sampled?.[0]).toBeGreaterThanOrEqual(250);
    expect(Math.abs((sampled?.[1] ?? 0) - 160)).toBeLessThanOrEqual(6);
    expect(sampled?.[2]).toBeLessThanOrEqual(3);

    // Deleted while the clip uses it: the clip keeps the id and an
    // analysis says the model is gone instead of using another one
    await openSettings(page);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator(`[data-model-delete="${id}"]`).click();
    await expect(page.locator(`[data-model-id="${id}"]`)).toHaveCount(0);
    await page.evaluate(() => {
      location.hash = '#/editor';
    });
    await openSidebarTab(page, 'background');
    await expect(select).toHaveValue(id);
    await expect(select.locator('option:checked')).toHaveText(
      'Missing custom model (not in this browser)',
    );
    await page.evaluate(() => window.__TEST_HOOKS__.aiCutout.clearMasks());
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-error-text')).toContainText('not in this browser');
    expect(
      await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().edits.background.ai.model),
    ).toBe(id);

    // Import the exported definition: nothing is added before the file
    // is picked, matches, passes the test and Save is pressed
    await openSettings(page);
    await page.locator('#settings-models-add').click();
    await page.locator('#add-model-file').setInputFiles({
      name: 'stub-model.glinfs-model.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator('#add-model-import')).toContainText('Needs the file stub-seg.onnx');
    await expect(page.locator(`[data-model-id="${id}"]`)).toHaveCount(0);
    await page.locator('#add-model-file').setInputFiles(STUB_PATH);
    await expect(page.locator('#add-model-test-result')).toHaveAttribute('data-kind', 'ok', {
      timeout: 60_000,
    });
    await page.locator('#add-model-save').click();
    await expect(page.locator(`[data-model-id="${id}"]`)).toHaveAttribute(
      'data-model-status',
      'downloaded',
    );
    await expect(page.locator(`[data-model-id="${id}"] h3`)).toHaveText('Stub modelstub-seg.onnx');
  });

  test('a file that is not a model, and a URL on a host the page may not use', async ({ page }) => {
    await gotoCaptureWithStubModel(page, { allowWasm: true });
    await openSettings(page);
    await page.locator('#settings-models-add').click();
    await page.locator('#add-model-file').setInputFiles({
      name: 'not-a-model.onnx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('this is not an ONNX file'),
    });
    await expect(page.locator('#add-model-error')).toContainText(
      'could not be read as an ONNX model',
      { timeout: 30_000 },
    );
    await page.locator('#add-model-again').click();
    await page
      .locator('#add-model-url')
      .fill(
        'https://github.com/dennougorilla/glinfs/releases/download/models-v1/isnetis-fp16.onnx',
      );
    await page.locator('#add-model-url-go').click();
    await expect(page.locator('#add-model-status')).toContainText('Hugging Face only');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('add-model-dialog')).toHaveCount(0);
    await expect(page.locator('[data-model-id^="custom-"]')).toHaveCount(0);
  });
});
