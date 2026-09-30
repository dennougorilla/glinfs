/**
 * E2E: the timeline's AI analysis marks - a thin track under the filmstrip
 * showing which frames of the selection the chosen model has analyzed.
 *
 * Runs the real segmentation worker with the stub model on the WASM
 * fallback. The stub is fast, so to see the track mid-way the test holds the
 * worker's 'segment' messages in the page (as ai-cutout-flow.spec.js does).
 * @module tests/e2e/editor-timeline-ai-marks.spec
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  chooseAiModel,
  gotoCaptureWithStubModel,
  injectDiscClip,
  openSidebarTab,
  pauseEditorPlayback,
  serveStubModel,
} from './helpers/app.js';

const STUB_MODEL = readFileSync(new URL('../fixtures/models/stub-seg.onnx', import.meta.url));
const STUB_SHA256 = createHash('sha256').update(STUB_MODEL).digest('hex');

/**
 * Let `allowed` frames reach the segmentation worker, then hold the rest
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
 * Deliver the held frames and stop holding
 * @param {import('@playwright/test').Page} page
 */
async function releaseFrames(page) {
  await page.evaluate(() => {
    const proto = /** @type {any} */ (Worker.prototype);
    proto.postMessage = proto.__originalPostMessage;
    const gate = /** @type {any} */ (window).__frameGate;
    for (const { worker, message, transfer } of gate.held) {
      proto.postMessage.call(worker, message, transfer);
    }
    gate.held = [];
  });
}

/**
 * Classify the marks canvas pixel under frame `frame` (at `frame / (n - 1)`
 * of the track): transparent, accent (analyzed) or grey (not analyzed)
 * @param {import('@playwright/test').Page} page
 * @param {number} frame
 * @param {number} total
 * @returns {Promise<'transparent' | 'accent' | 'muted' | 'other'>}
 */
function markAt(page, frame, total) {
  return page.evaluate(
    ([f, n]) => {
      const canvas = /** @type {HTMLCanvasElement} */ (
        document.querySelector('.editor-timeline-ai-marks-canvas')
      );
      const x = Math.min(canvas.width - 1, Math.round((f / (n - 1)) * canvas.width));
      const [r, g, b, a] = /** @type {CanvasRenderingContext2D} */ (
        canvas.getContext('2d')
      ).getImageData(x, 0, 1, 1).data;
      if (a === 0) return 'transparent';
      if (b > r + 60 && g > r + 60) return 'accent';
      if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) return 'muted';
      return 'other';
    },
    [frame, total],
  );
}

test.describe('Timeline AI analysis marks (stub model, WASM fallback)', () => {
  // Compiles ONNX Runtime's WASM binary in a fresh context
  test.describe.configure({ timeout: 240_000 });

  test('appears with an AI subject, fills as frames are analyzed, hides for Off and Solid color', async ({
    page,
  }) => {
    const N = 12;
    const selection = { start: 2, end: 9 };
    await serveStubModel(page, STUB_MODEL);
    await gotoCaptureWithStubModel(page, {
      sha256: STUB_SHA256,
      bytes: STUB_MODEL.length,
      allowWasm: true,
    });
    await injectDiscClip(page, { count: N });
    await pauseEditorPlayback(page);
    await page.evaluate(
      (r) => window.__TEST_HOOKS__.setEditorState({ selectedRange: r, currentFrame: r.start }),
      selection,
    );

    const marks = page.locator('.editor-timeline-ai-marks');
    const trackBox = await page.locator('.tl-track').boundingBox();
    // No AI subject yet: no track
    await expect(marks).toBeHidden();

    await chooseAiModel(page, 'anime', { download: false });
    await holdFramesAfter(page, 3);
    await page.locator('#background-download-confirm').click();

    // Mid-way: 3 of the 8 selected frames analyzed, the rest muted
    await expect(marks).toBeVisible();
    await expect(marks).toHaveAttribute('data-analyzed', '3', { timeout: 60_000 });
    await expect(marks).toHaveAttribute('data-selected', '8');
    // Described on the focusable slider (its descendants are presentational)
    await expect(page.locator('.tl')).toHaveAttribute('aria-description', '3 of 8 frames analyzed');
    await expect(page.locator('.editor-timeline-ai-marks-canvas')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // Outside the selection stays transparent
    expect(await markAt(page, 0, N)).toBe('transparent');
    expect(await markAt(page, 11, N)).toBe('transparent');
    // The frame on screen (IN) goes first
    expect(await markAt(page, selection.start, N)).toBe('accent');
    expect(await markAt(page, 8, N)).toBe('muted');

    // Showing the track shifts nothing
    expect(await page.locator('.tl-track').boundingBox()).toEqual(trackBox);

    // The rest arrives: the whole selection fills
    await releaseFrames(page);
    await expect(marks).toHaveAttribute('data-analyzed', '8', { timeout: 60_000 });
    await expect(page.locator('.tl')).toHaveAttribute('aria-description', '8 of 8 frames analyzed');
    await expect(page.locator('#ai-status-text')).toHaveText('8 of 12 frames analyzed');
    await expect.poll(() => markAt(page, 8, N)).toBe('accent');
    expect(await markAt(page, 0, N)).toBe('transparent');

    // Off hides it
    await openSidebarTab(page, 'background');
    await page.locator('label[for="subject-none"]').click();
    await expect(marks).toBeHidden();

    // Solid color too
    await page.locator('label[for="subject-color"]').click();
    await expect(page.locator('#subject-color')).toBeChecked();
    await expect(marks).toBeHidden();

    // Back to Anime: the masks are still there, so it shows full at once
    await page.locator('label[for="subject-anime"]').click();
    await expect(marks).toBeVisible();
    await expect(marks).toHaveAttribute('data-analyzed', '8');
  });
});
