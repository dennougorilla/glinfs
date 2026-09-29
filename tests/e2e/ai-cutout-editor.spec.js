/**
 * E2E: the AI cutout authored in the editor and exported as a transparent
 * GIF, through the real UI, segmentation worker (stub model on the WASM
 * fallback, which headless Chromium always uses) and encoder.
 *
 * The clip is two discs over a black background (see injectDiscClip):
 * disc A white (probability 1), disc B grey 160 (probability 0.63). The
 * exported GIF is decoded with ImageDecoder and checked pixel by pixel.
 * @module tests/e2e/ai-cutout-editor.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  chooseAiCutout,
  decodeExportedGif,
  discClip,
  editorFramePointToViewport,
  editorPreviewAlpha,
  exportFromEditor,
  exportGifAndWait,
  gifPixel,
  gotoCaptureWithStubModel,
  injectDiscClip,
  pauseEditorPlayback,
  serveStubModel,
  waitForAiMasks,
} from './helpers/app.js';

const STUB_MODEL = readFileSync(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const STUB_SHA256 = createHash('sha256').update(STUB_MODEL).digest('hex');
const FRAME_COUNT = 8;
const { discA, discB, radius } = discClip;

/**
 * Open the editor on the disc clip with the stub model (WASM allowed by the
 * DEV hook, no confirmation step), choose the AI cutout and analyze
 * @param {import('@playwright/test').Page} page
 */
async function analyzeDiscClip(page) {
  await serveStubModel(page, STUB_MODEL);
  await gotoCaptureWithStubModel(page, {
    sha256: STUB_SHA256,
    bytes: STUB_MODEL.length,
    allowWasm: true,
  });
  await injectDiscClip(page, { count: FRAME_COUNT });
  await pauseEditorPlayback(page);
  await chooseAiCutout(page);

  // Nothing analyzed yet: the preview is unkeyed and says so
  await expect(page.locator('#ai-preview-note')).toHaveText('Not analyzed yet');
  await expect(page.locator('#ai-analyze')).toHaveText(`Analyze selection (${FRAME_COUNT} frames)`);
  await expect(page.locator('#ai-intro')).toContainText('about 200 MB');
  await expect(page.locator('#ai-intro')).toContainText('never leave this device');

  await page.locator('#ai-analyze').click();
  await expect(page.locator('#ai-coverage')).toHaveText(
    `${FRAME_COUNT} of ${FRAME_COUNT} frames analyzed`,
    { timeout: 60_000 },
  );
  await expect(page.locator('#ai-analyze')).toHaveText('Selection analyzed');
  await expect(page.locator('#ai-analyze')).toBeDisabled();
  await expect(page.locator('#ai-controls')).toBeVisible();
  await waitForAiMasks(page);
  await expect(page.locator('#ai-preview-note')).toBeHidden();
}

/**
 * Export from the editor with the JavaScript encoder, decode the GIF, and
 * return to the editor
 * @param {import('@playwright/test').Page} page
 * @param {(f: number) => { x: number, y: number }[]} [extraPoints]
 * @returns {Promise<{ a: number, b: number, bg: number, extra: number[] }[]>} Alpha per frame
 */
async function exportAndSample(page, extraPoints = () => []) {
  await exportFromEditor(page);
  // Transparent exports always use the JavaScript encoder
  await expect(page.locator('[data-encoder-id="gifsicle-wasm"]')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await exportGifAndWait(page);
  const frames = await decodeExportedGif(page);
  expect(frames).toHaveLength(FRAME_COUNT);
  const alpha = frames.map((frame, f) => ({
    a: gifPixel(frame, discA(f).x, discA(f).y)[3],
    b: gifPixel(frame, discB(f).x, discB(f).y)[3],
    bg: gifPixel(frame, 5, 5)[3],
    extra: extraPoints(f).map(({ x, y }) => gifPixel(frame, x, y)[3]),
  }));
  await page.locator('.export-toolbar button[aria-label="Back to editor"]').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
  await pauseEditorPlayback(page);
  return alpha;
}

/**
 * Add a pick on disc A of the middle frame through the preview
 * @param {import('@playwright/test').Page} page
 * @param {'keep' | 'remove'} mode
 */
async function pickDiscA(page, mode) {
  const middle = FRAME_COUNT / 2;
  await page.evaluate((f) => window.__TEST_HOOKS__.setEditorState({ currentFrame: f }), middle);
  await page.locator(`label[for="ai-pick-${mode}"]`).click();
  await expect(page.locator(`#ai-pick-${mode}`)).toBeChecked();
  await expect(page.locator('#ai-pick-status')).toContainText('Click a character');
  const point = await editorFramePointToViewport(page, discA(middle).x, discA(middle).y);
  await page.mouse.click(point.x, point.y);
  // One pick, the tool is left afterwards
  await expect(page.locator('#ai-pick-list li')).toHaveCount(1);
  await expect(page.locator('#ai-pick-list')).toContainText(mode === 'keep' ? 'Keep' : 'Remove');
  await expect(page.locator(`#ai-pick-${mode}`)).not.toBeChecked();
  await waitForAiMasks(page);
}

test.describe('AI cutout in the editor (stub model, WASM fallback)', () => {
  // Every test compiles ONNX Runtime's WASM binary in a fresh context
  test.describe.configure({ mode: 'default', timeout: 240_000 });

  test('analyze, export, then Keep and Remove picks follow disc A through the clip', async ({
    page,
  }) => {
    await analyzeDiscClip(page);

    // The preview is keyed: background transparent, both discs opaque
    const f0 = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().currentFrame);
    await expect.poll(() => editorPreviewAlpha(page, 5, 5)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(f0).x, discA(f0).y)).toBe(255);
    expect(await editorPreviewAlpha(page, discB(f0).x, discB(f0).y)).toBe(255);

    // Both discs opaque, background transparent on every frame
    const plain = await exportAndSample(page);
    for (const frame of plain) {
      expect(frame).toMatchObject({ a: 255, b: 255, bg: 0 });
    }

    // Keep pick on disc A in the middle frame: only disc A is left, also
    // on the frames before the pick
    await pickDiscA(page, 'keep');
    const kept = await exportAndSample(page);
    for (const frame of kept) {
      expect(frame).toMatchObject({ a: 255, b: 0, bg: 0 });
    }

    // Remove pick instead: disc A disappears, disc B stays
    await page.locator('#ai-picks-clear').click();
    await expect(page.locator('#ai-pick-list li')).toHaveCount(0);
    await pickDiscA(page, 'remove');
    const removed = await exportAndSample(page);
    for (const frame of removed) {
      expect(frame).toMatchObject({ a: 0, b: 255, bg: 0 });
    }

    // Picks persist in the edits
    const edits = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().edits);
    expect(edits.background).toMatchObject({ enabled: true, method: 'ai' });
    expect(edits.background.ai.picks).toEqual([
      expect.objectContaining({ frame: FRAME_COUNT / 2, mode: 'remove' }),
    ]);
  });

  test('keyboard only: a Keep pick placed with the arrow keys, and focus never drops to <body>', async ({
    page,
  }) => {
    await analyzeDiscClip(page);
    const middle = FRAME_COUNT / 2;
    await page.evaluate((f) => window.__TEST_HOOKS__.setEditorState({ currentFrame: f }), middle);

    // Space on the Keep toggle: the preview takes focus as the pick target
    await page.locator('#ai-pick-keep').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#ai-pick-keep')).toBeChecked();
    const overlay = page.locator('.editor-canvas-overlay');
    await expect(overlay).toBeFocused();
    await expect(overlay).toHaveAttribute('aria-label', /Arrow keys move the marker/);
    await expect(page.locator('#ai-pick-status')).toContainText('arrow keys');

    // Marker from the centre (0.5, 0.5) to disc A (≈ 0.27, 0.31)
    for (const key of ['Shift+ArrowLeft', 'Shift+ArrowLeft', 'ArrowLeft', 'ArrowLeft']) {
      await page.keyboard.press(key);
    }
    for (const key of ['Shift+ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
      await page.keyboard.press(key);
    }
    // The arrows moved the marker, not the playhead
    expect(await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().currentFrame)).toBe(
      middle,
    );
    await page.keyboard.press('Enter');
    await expect(page.locator('#ai-pick-list li')).toHaveCount(1);
    await expect(page.locator('#ai-pick-list')).toContainText('Keep');
    await expect(page.locator('#ai-pick-keep')).not.toBeChecked();
    await expect(page.locator('#ai-pick-keep')).toBeFocused();
    await waitForAiMasks(page);
    // Only disc A is kept
    await expect.poll(() => editorPreviewAlpha(page, discB(middle).x, discB(middle).y)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(middle).x, discA(middle).y)).toBe(255);

    // Clear picks hides itself: focus moves to the Keep tool, not <body>
    await page.locator('#ai-picks-clear').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#ai-pick-list li')).toHaveCount(0);
    await expect(page.locator('#ai-picks-clear')).toBeHidden();
    await expect(page.locator('#ai-pick-keep')).toBeFocused();
  });

  test('a pick on the background is refused with a notice; a pick on a character then lands', async ({
    page,
  }) => {
    await analyzeDiscClip(page);
    const middle = FRAME_COUNT / 2;
    await page.evaluate((f) => window.__TEST_HOOKS__.setEditorState({ currentFrame: f }), middle);
    await page.locator('label[for="ai-pick-keep"]').click();
    await expect(page.locator('#ai-pick-keep')).toBeChecked();

    // Top middle: black background, far from both discs
    const background = await editorFramePointToViewport(page, 120, 12);
    await page.mouse.click(background.x, background.y);
    await expect(page.locator('#ai-notice')).toHaveText('No character here. Click on a character.');
    await expect(page.locator('#ai-pick-list li')).toHaveCount(0);
    await expect(page.locator('#ai-pick-keep')).toBeChecked();
    const edits = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().edits);
    expect(edits.background.ai.picks).toEqual([]);
    // Nothing changed: both discs are still cut out
    expect(await editorPreviewAlpha(page, discA(middle).x, discA(middle).y)).toBe(255);
    expect(await editorPreviewAlpha(page, discB(middle).x, discB(middle).y)).toBe(255);

    // The tool is still on: a click on disc A adds the pick and ends the notice
    const onDisc = await editorFramePointToViewport(page, discA(middle).x, discA(middle).y);
    await page.mouse.click(onDisc.x, onDisc.y);
    await expect(page.locator('#ai-pick-list li')).toHaveCount(1);
    await expect(page.locator('#ai-pick-keep')).not.toBeChecked();
    await expect(page.locator('#ai-notice')).not.toContainText('No character here');
    await waitForAiMasks(page);
    await expect.poll(() => editorPreviewAlpha(page, discB(middle).x, discB(middle).y)).toBe(0);
    expect(await editorPreviewAlpha(page, discA(middle).x, discA(middle).y)).toBe(255);
  });

  test('threshold and edge change the exported coverage in the expected direction', async ({
    page,
  }) => {
    await analyzeDiscClip(page);
    // Just outside and just inside disc A (vertically: the discs move
    // horizontally, so smoothing between frames does not move these edges)
    const probes = (/** @type {number} */ f) => [
      { x: discA(f).x, y: discA(f).y - radius - 3 },
      { x: discA(f).x, y: discA(f).y - radius + 3 },
    ];

    const base = await exportAndSample(page, probes);
    for (const frame of base) {
      expect(frame).toMatchObject({ a: 255, b: 255, bg: 0, extra: [0, 255] });
    }

    // Threshold 70 %: grey disc B (63 %) falls below it, white disc A stays
    await page.locator('#ai-threshold').fill('70');
    await expect(page.locator('#ai-threshold-value')).toHaveText('70%');
    await waitForAiMasks(page);
    const strict = await exportAndSample(page, probes);
    for (const frame of strict) {
      expect(frame).toMatchObject({ a: 255, b: 0, bg: 0 });
    }

    // Back to 50 %, edge +5 px: the cutout grows past the disc's edge
    await page.locator('#ai-threshold').fill('50');
    await page.locator('#ai-edge').fill('5');
    await expect(page.locator('#ai-edge-value')).toHaveText('+5 px');
    await waitForAiMasks(page);
    const grown = await exportAndSample(page, probes);
    for (const frame of grown) {
      expect(frame).toMatchObject({ a: 255, b: 255, bg: 0, extra: [255, 255] });
    }

    // Edge −5 px: the cutout shrinks inside the disc's edge
    await page.locator('#ai-edge').fill('-5');
    await expect(page.locator('#ai-edge-value')).toHaveText('−5 px');
    await waitForAiMasks(page);
    const shrunk = await exportAndSample(page, probes);
    for (const frame of shrunk) {
      expect(frame).toMatchObject({ a: 255, b: 255, bg: 0, extra: [0, 0] });
    }
  });
});
