/**
 * E2E: clip edits (text layers, background removal) survive every way of
 * leaving and re-entering the editor: Capture and back, Export and back,
 * a queue demote/promote round trip (raw and codec-compressed entries), and
 * opening another file while the edited clip is active.
 * @module tests/e2e/editor-persistence.spec
 */

import { expect, test } from '@playwright/test';
import gifenc from 'gifenc';
import { exportFromEditor, gotoEditorWithClip, pauseEditorPlayback } from './helpers/app.js';

const { GIFEncoder } = gifenc;

/** Queue entries only (the active clip renders with data-clip-active) */
const QUEUE_ENTRIES = '[data-testid="clip-entry"]:not([data-clip-active])';

/** @param {import('@playwright/test').Page} page */
async function readEditorState(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.getEditorState());
}

/** @param {import('@playwright/test').Page} page */
async function activeClipId(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.id ?? null);
}

/**
 * Author a caption and background removal through the UI
 * @param {import('@playwright/test').Page} page
 * @param {string} caption
 */
async function addEdits(page, caption) {
  await page.locator('#text-add').click();
  await page.locator('#text-layer-text').fill(caption);
  await page.locator('#text-layer-color').fill('#ff8800');
  await page.locator('#editor-bg-accordion summary').click();
  await page.locator('#background-enabled').check();
  await page.locator('#background-tolerance').fill('42');
  await expect.poll(async () => (await readEditorState(page))?.edits.background.tolerance).toBe(42);
}

/**
 * Assert the editor shows the edits addEdits authored
 * @param {import('@playwright/test').Page} page
 * @param {string} caption
 */
async function expectEdits(page, caption) {
  await expect
    .poll(async () => (await readEditorState(page))?.edits.textLayers.map((l) => l.text))
    .toEqual([caption]);
  const state = await readEditorState(page);
  expect(state?.edits.textLayers[0].color).toBe('#ff8800');
  expect(state?.edits.background).toMatchObject({ enabled: true, tolerance: 42 });
  // The panels reflect the restored edits
  await expect(page.locator('#text-layer-list .editor-text-item-select')).toHaveText(caption);
  await expect(page.locator('#background-enabled')).toBeChecked();
  await expect(page.locator('#background-tolerance')).toHaveValue('42');
}

/** @param {import('@playwright/test').Page} page */
async function goToCaptureScreen(page) {
  await page.evaluate(() => {
    location.hash = '#/capture';
  });
  await page.waitForSelector('.capture-screen', { state: 'visible' });
}

/** @param {import('@playwright/test').Page} page */
async function goToEditorScreen(page) {
  await page.evaluate(() => {
    location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
}

/**
 * Promote a queued clip by clicking its entry and wait until it is active
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function promoteFromQueue(page, id) {
  await page.locator(`${QUEUE_ENTRIES}[data-clip-id="${id}"] .clip-entry-main`).click();
  await expect.poll(() => activeClipId(page), { timeout: 20000 }).toBe(id);
  await page.waitForSelector('.editor-canvas', { state: 'visible' });
}

/** A small opaque 2-frame GIF */
function buildGif() {
  const palette = [
    [255, 0, 0],
    [0, 0, 255],
  ];
  const size = 32 * 24;
  const gif = GIFEncoder();
  gif.writeFrame(new Uint8Array(size).fill(0), 32, 24, { palette, delay: 100 });
  gif.writeFrame(new Uint8Array(size).fill(1), 32, 24, { delay: 100 });
  gif.finish();
  return Buffer.from(gif.bytes());
}

test.describe('Editor edits persistence', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, {
      frameCount: 12,
      fps: 10,
      width: 160,
      height: 120,
      pattern: 'solid',
      color: '#2050a0',
    });
    await pauseEditorPlayback(page);
  });

  test('survives Editor -> Capture -> Editor', async ({ page }) => {
    await addEdits(page, 'Round trip');
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 2, end: 9 } });
    });

    await goToCaptureScreen(page);
    await goToEditorScreen(page);

    await expectEdits(page, 'Round trip');
    // The rest of the session state comes back too
    expect((await readEditorState(page))?.selectedRange).toEqual({ start: 2, end: 9 });
  });

  test('survives Editor -> Export -> Editor', async ({ page }) => {
    await addEdits(page, 'Exported');

    await exportFromEditor(page);
    // The export screen sees the edits: removal makes it transparent
    await expect(page.getByTestId('export-transparency-badge')).toBeVisible();
    await page.getByRole('button', { name: 'Back to editor' }).click();
    await page.waitForSelector('.editor-canvas', { state: 'visible' });

    await expectEdits(page, 'Exported');
  });

  test('survives a queue demote/promote round trip (raw and compressed)', async ({ page }) => {
    test.slow();
    const idA = /** @type {string} */ (await activeClipId(page));
    await addEdits(page, 'Clip A');

    // A second clip becomes active: A demotes into the queue with its edits
    await goToCaptureScreen(page);
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockClipPayload({
        frameCount: 8,
        fps: 10,
        width: 160,
        height: 120,
        pattern: 'solid',
        color: '#a02050',
      });
    });
    await goToEditorScreen(page);
    const idB = /** @type {string} */ (await activeClipId(page));
    expect(idB).not.toBe(idA);
    expect((await readEditorState(page))?.edits.textLayers).toEqual([]);
    await pauseEditorPlayback(page);

    // Compressed path: wait for A's entry to settle (compressed when the
    // clip codec is available, raw otherwise)
    const entryA = page.locator(`${QUEUE_ENTRIES}[data-clip-id="${idA}"]`);
    await expect
      .poll(async () => entryA.getAttribute('data-clip-status'), { timeout: 20000 })
      .toMatch(/^(compressed|raw)$/);
    if (await page.evaluate(() => window.__TEST_HOOKS__.isClipCompressionAvailable())) {
      await expect(entryA).toHaveAttribute('data-clip-status', 'compressed');
    }

    // Edit B, then promote A from the queue: B demotes with its edits (the
    // swap carries them explicitly), A comes back with its own
    await page.locator('#text-add').click();
    await page.locator('#text-layer-text').fill('Clip B');
    await promoteFromQueue(page, idA);
    await expectEdits(page, 'Clip A');

    // Raw path: B was just demoted and is promoted straight back
    await pauseEditorPlayback(page);
    await promoteFromQueue(page, idB);
    await expect
      .poll(async () => (await readEditorState(page))?.edits.textLayers.map((l) => l.text))
      .toEqual(['Clip B']);
    expect((await readEditorState(page))?.edits.background.enabled).toBe(false);
  });

  test('opening another file keeps the edited clip and its edits in the queue', async ({
    page,
  }) => {
    const idA = /** @type {string} */ (await activeClipId(page));
    await addEdits(page, 'Before import');

    await goToCaptureScreen(page);
    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'other.gif',
      mimeType: 'image/gif',
      buffer: buildGif(),
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await expect
      .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.sourceName))
      .toBe('other.gif');
    // The imported clip starts clean
    expect((await readEditorState(page))?.edits.textLayers).toEqual([]);

    await pauseEditorPlayback(page);
    await promoteFromQueue(page, idA);
    await expectEdits(page, 'Before import');
  });

  test('edits injected with a clip are normalized on mount', async ({ page }) => {
    await goToCaptureScreen(page);
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockClipPayload({
        frameCount: 5,
        fps: 10,
        pattern: 'solid',
        edits: {
          textLayers: [{ id: 't1', text: 'Injected', size: 9, x: -1, end: 99 }, 'garbage'],
          background: { enabled: true, color: 'nope', tolerance: 500 },
        },
      });
    });
    await goToEditorScreen(page);

    const state = await readEditorState(page);
    expect(state?.edits.textLayers).toHaveLength(1);
    expect(state?.edits.textLayers[0]).toMatchObject({
      id: 't1',
      text: 'Injected',
      size: 0.5,
      x: 0,
      start: 0,
      end: 4,
    });
    expect(state?.edits.background).toMatchObject({
      enabled: true,
      color: '#00ff00',
      tolerance: 100,
    });
  });
});
