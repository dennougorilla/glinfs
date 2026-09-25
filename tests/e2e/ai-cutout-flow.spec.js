/**
 * E2E: AI cutout analysis flow through the UI — cancel and resume, masks
 * surviving navigation, the export analyzing frames that still lack masks,
 * and the no-WebGPU confirmation.
 *
 * Runs the app's real segmentation worker with the stub model on the WASM
 * fallback (headless Chromium has no WebGPU). The stub is fast, so to see
 * an analysis mid-way the tests hold the worker's 'segment' messages in the
 * page (Worker.prototype.postMessage is wrapped): the manager then waits for
 * frames that never arrive, exactly like a slow model would make it wait.
 * @module tests/e2e/ai-cutout-flow.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  chooseAiCutout,
  decodeExportedGif,
  discClip,
  editorPreviewAlpha,
  exportFromEditor,
  gifPixel,
  gotoCaptureWithStubModel,
  injectDiscClip,
  maskCount,
  pauseEditorPlayback,
  readAiStatus,
  serveStubModel,
  waitForAiMasks,
} from './helpers/app.js';

const STUB_MODEL = readFileSync(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const STUB_SHA256 = createHash('sha256').update(STUB_MODEL).digest('hex');
const { discA, discB } = discClip;

/**
 * Let `allowed` more frames reach the segmentation worker, then hold the
 * rest in the page
 * @param {import('@playwright/test').Page} page
 * @param {number} allowed
 */
async function holdFramesAfter(page, allowed) {
  await page.evaluate((n) => {
    const proto = /** @type {any} */ (Worker.prototype);
    proto.__originalPostMessage ??= proto.postMessage;
    const original = proto.__originalPostMessage;
    const gate = { allowed: n, held: /** @type {any[]} */ ([]) };
    /** @type {any} */ (window).__frameGate = gate;
    proto.postMessage = function (/** @type {any} */ message, /** @type {any} */ transfer) {
      if (message?.type === 'segment') {
        if (gate.allowed <= 0) {
          gate.held.push({ worker: this, message, transfer });
          return;
        }
        gate.allowed--;
      }
      return original.call(this, message, transfer);
    };
  }, allowed);
}

/**
 * Stop holding frames: deliver the held ones, or drop them (closing their
 * bitmaps) when their analysis was cancelled
 * @param {import('@playwright/test').Page} page
 * @param {{ drop: boolean }} options
 */
async function releaseFrames(page, { drop }) {
  await page.evaluate((dropHeld) => {
    const proto = /** @type {any} */ (Worker.prototype);
    proto.postMessage = proto.__originalPostMessage;
    const gate = /** @type {any} */ (window).__frameGate;
    for (const { worker, message, transfer } of gate.held) {
      if (dropHeld) {
        message.bitmap.close();
      } else {
        proto.postMessage.call(worker, message, transfer);
      }
    }
    gate.held = [];
  }, drop);
}

/**
 * Open the editor on a disc clip with the stub model and choose the AI cutout
 * @param {import('@playwright/test').Page} page
 * @param {{ count: number, allowWasm: boolean }} options
 * @returns {Promise<{ count: number }>} Model requests
 */
async function openDiscClip(page, { count, allowWasm }) {
  const requests = await serveStubModel(page, STUB_MODEL);
  await gotoCaptureWithStubModel(page, {
    sha256: STUB_SHA256,
    bytes: STUB_MODEL.length,
    allowWasm,
  });
  await injectDiscClip(page, { count });
  await pauseEditorPlayback(page);
  await chooseAiCutout(page);
  return requests;
}

test.describe('AI cutout analysis flow (stub model, WASM fallback)', () => {
  // Every test compiles ONNX Runtime's WASM binary in a fresh context
  test.describe.configure({ mode: 'default', timeout: 240_000 });

  test('cancel keeps finished masks, Analyze finishes the rest, masks survive Editor → Capture → Editor', async ({
    page,
  }) => {
    const N = 12;
    await openDiscClip(page, { count: N, allowWasm: true });

    await holdFramesAfter(page, 3);
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-progress')).toBeVisible();
    await expect(page.locator('#ai-progress-text')).toHaveText(
      /^Analyzed 3 of 12 frames · .* left$/,
      { timeout: 60_000 },
    );
    await expect(page.locator('#ai-progress-bar')).toHaveJSProperty('value', 0.25);

    // Editing stays possible while the analysis runs
    await page.locator('#ai-threshold').fill('40');
    await expect(page.locator('#ai-threshold-value')).toHaveText('40%');

    await page.locator('#ai-cancel').click();
    await expect(page.locator('#ai-notice')).toContainText('Analysis cancelled');
    await expect(page.locator('#ai-progress')).toBeHidden();
    await releaseFrames(page, { drop: true });
    expect(await maskCount(page)).toBe(3);
    await expect(page.locator('#ai-coverage')).toHaveText(`3 of ${N} frames analyzed`);

    // A second Analyze only does the 9 frames still missing
    await expect(page.locator('#ai-analyze')).toHaveText('Analyze selection (9 frames)');
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`, {
      timeout: 60_000,
    });
    expect((await readAiStatus(page))?.framesTotal).toBe(9);
    expect(await maskCount(page)).toBe(N);
    await waitForAiMasks(page);

    // Editor → Capture → Editor: the masks, the method and its parameters stay
    await page.evaluate(() => {
      location.hash = '#/capture';
    });
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await page.evaluate(() => {
      location.hash = '#/editor';
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await pauseEditorPlayback(page);
    await expect(page.locator('#ai-method-ai')).toBeChecked();
    await expect(page.locator('#ai-coverage')).toHaveText(`${N} of ${N} frames analyzed`);
    await expect(page.locator('#ai-threshold')).toHaveValue('40');
    expect(await maskCount(page)).toBe(N);
    await waitForAiMasks(page);
    const f = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().currentFrame);
    await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(f).x, discA(f).y)).toBe(255);
  });

  test('the export analyzes the exported frames that still lack masks, with progress', async ({
    page,
  }) => {
    const N = 12;
    await openDiscClip(page, { count: N, allowWasm: true });

    // Analyze only the first half
    await page.evaluate(() =>
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 5 } }),
    );
    await expect(page.locator('#ai-analyze')).toHaveText('Analyze selection (6 frames)');
    await page.locator('#ai-analyze').click();
    await expect(page.locator('#ai-coverage')).toHaveText(`6 of ${N} frames analyzed`, {
      timeout: 60_000,
    });

    // Export the whole clip: the other half is analyzed before encoding
    await page.evaluate((end) => {
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end } });
    }, N - 1);
    await exportFromEditor(page);
    await expect(page.locator('#export-ai-note')).toHaveText(
      `6 of ${N} frames are not analyzed yet. Export analyzes them first (they preview without the cutout).`,
    );

    await holdFramesAfter(page, 2);
    await page.locator('.btn-export-main').click();
    await expect(page.locator('#export-ai-prep')).toBeVisible();
    await expect(page.locator('#export-ai-progress-text')).toHaveText(
      /^Analyzed 2 of 6 frames · .* left$/,
      { timeout: 60_000 },
    );
    await expect(page.locator('#export-ai-cancel')).toBeVisible();
    await releaseFrames(page, { drop: false });

    await expect(page.locator('.export-complete-v2')).toBeVisible({ timeout: 60_000 });
    expect(await maskCount(page)).toBe(N);
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

  test('without WebGPU the analysis runs only after the explicit slow choice', async ({ page }) => {
    // No auto-allow: the stub is accepted, but WASM needs the user's choice.
    // The page reports no WebGPU (headless workers have no adapter either).
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', {
        configurable: true,
        get: () => undefined,
      });
    });
    const requests = await openDiscClip(page, { count: 4, allowWasm: false });

    const warning = page.locator('#ai-webgpu-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('WebGPU is not available');
    await expect(page.locator('#ai-run-wasm')).toHaveText('Run without WebGPU (very slow)');

    // Analyze alone does not run the slow fallback, and downloads nothing
    await page.locator('#ai-analyze').click();
    await expect(warning).toContainText('The analysis needs WebGPU', { timeout: 30_000 });
    expect((await readAiStatus(page))?.needsWasmChoice).toBe(true);
    expect(await maskCount(page)).toBe(0);
    expect(requests.count).toBe(0);
    await expect(page.locator('#ai-coverage')).toHaveText('0 of 4 frames analyzed');

    // The explicit choice runs it
    await page.locator('#ai-run-wasm').click();
    await expect(page.locator('#ai-coverage')).toHaveText('4 of 4 frames analyzed', {
      timeout: 60_000,
    });
    expect(requests.count).toBe(1);
    await expect(warning).toBeHidden();
    await expect(page.locator('#ai-wasm-note')).toBeVisible();
    expect((await readAiStatus(page))?.backend).toBe('wasm');
  });
});
