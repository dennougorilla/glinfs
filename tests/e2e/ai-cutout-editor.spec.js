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
  chooseAiModel,
  closeExportDialog,
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
 * DEV hook), choose the Anime subject and confirm its download: the
 * analysis starts by itself, the frame on screen first
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
  await chooseAiModel(page, 'anime', { download: false });

  // Not downloaded: asked inline first, nothing changed or downloaded yet
  await expect(page.locator('#subject-status-anime')).toContainText('88 MB');
  await expect(page.locator('#background-download-title')).toHaveText('Download 88 MB?');
  await expect(page.locator('#background-download-detail')).toContainText(
    'your frames never leave it',
  );
  expect(
    await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().edits.background.enabled),
  ).toBe(false);

  await page.locator('#background-download-confirm').click();
  await expect(page.locator('#ai-status-text')).toHaveText(
    `${FRAME_COUNT} of ${FRAME_COUNT} frames analyzed`,
    { timeout: 60_000 },
  );
  await expect(page.locator('#ai-analyze')).toBeHidden();
  await expect(page.locator('#ai-fit')).toBeVisible();
  await expect(page.locator('#subject-status-anime')).toContainText('Ready');
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
  await closeExportDialog(page);
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
  await expect(page.locator('#preview-tool-hint')).toContainText('click a character');
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
    await page.locator('.editor-cutout-pick-delete').click();
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
    await expect(page.locator('#preview-tool-hint')).toContainText('click a character');

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

    // The pick's × removes it: focus moves to the Keep tool, not <body>
    await page.locator('.editor-cutout-pick-delete').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#ai-pick-list li')).toHaveCount(0);
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

  test('Fit changes the exported coverage in the expected direction', async ({ page }) => {
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

    // Tighter 5 (threshold 70 %, edge −3 px): grey disc B (63 %) falls
    // below it, white disc A stays
    await page.locator('#ai-fit').fill('-5');
    await expect(page.locator('#ai-fit')).toHaveAttribute('aria-valuetext', /Tighter 5/);
    await expect
      .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getEditorState().edits.background.ai))
      .toMatchObject({ threshold: 0.7, edge: -3 });
    await waitForAiMasks(page);
    const strict = await exportAndSample(page, probes);
    for (const frame of strict) {
      expect(frame).toMatchObject({ a: 255, b: 0, bg: 0 });
    }

    // Looser 10 (threshold 10 %, edge +5 px): the cutout grows past the
    // disc's edge; the black background (0 %) stays out
    await page.locator('#ai-fit').fill('10');
    await waitForAiMasks(page);
    const grown = await exportAndSample(page, probes);
    for (const frame of grown) {
      expect(frame).toMatchObject({ a: 255, b: 255, bg: 0, extra: [255, 255] });
    }

    // Tighter 10 (threshold 90 %, edge −5 px): the cutout shrinks inside
    // disc A's edge, disc B is gone
    await page.locator('#ai-fit').fill('-10');
    await waitForAiMasks(page);
    const shrunk = await exportAndSample(page, probes);
    for (const frame of shrunk) {
      expect(frame).toMatchObject({ a: 255, b: 0, bg: 0, extra: [0, 0] });
    }
  });

  test('dragging Fit updates the preview live without flicker or layout shift', async ({
    page,
  }) => {
    await analyzeDiscClip(page);
    const f = await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().currentFrame);
    await expect.poll(() => editorPreviewAlpha(page, discB(f).x, discB(f).y)).toBe(255);
    const slider = page.locator('#ai-fit');
    await slider.scrollIntoViewIfNeeded();

    // Every animation frame: the background and disc B on the preview, where
    // the slider is (a status line popping in above it would move it) and
    // whether the pointer was released yet
    await page.evaluate(
      ({ bx, by }) => {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.editor-canvas'));
        const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        const input = /** @type {HTMLElement} */ (document.querySelector('#ai-fit'));
        const w = /** @type {any} */ (window);
        w.__samples = [];
        w.__probe = true;
        w.__released = false;
        const tick = () => {
          w.__samples.push({
            bg: ctx.getImageData(5, 5, 1, 1).data[3],
            b: ctx.getImageData(bx, by, 1, 1).data[3],
            top: Math.round(input.getBoundingClientRect().top),
            status: document.querySelector('#ai-status')?.getBoundingClientRect().height,
            released: w.__released,
          });
          if (w.__probe) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { bx: discB(f).x, by: discB(f).y },
    );

    // From the middle (0) towards Tighter: past −4 the threshold passes disc
    // B's 63 %
    const box = await slider.boundingBox();
    if (!box) throw new Error('Fit slider not visible');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(box.x + box.width * (0.5 - (0.45 * i) / 24), y);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      /** @type {any} */ (window).__released = true;
    });
    await page.mouse.up();
    await waitForAiMasks(page);
    await page.waitForTimeout(100);
    const samples = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__probe = false;
      return /** @type {{ bg: number, b: number, top: number, status: number, released: boolean }[]} */ (
        w.__samples
      );
    });

    expect(samples.length).toBeGreaterThan(20);
    // Never an unkeyed (or blank-then-redrawn) background
    expect(samples.filter((s) => s.bg !== 0)).toEqual([]);
    // Nothing moved in the panel: same slider position, same status height
    expect(new Set(samples.map((s) => s.top)).size).toBe(1);
    expect(new Set(samples.map((s) => s.status)).size).toBe(1);
    // Live: disc B went away while the pointer was still down
    expect(samples.some((s) => !s.released && s.b === 0)).toBe(true);
    // And stays away once the full build landed
    expect(samples.at(-1)?.b).toBe(0);
    expect(
      await page.evaluate(() => window.__TEST_HOOKS__.getEditorState().edits.background.ai),
    ).toMatchObject({ threshold: expect.any(Number) });
  });
});
