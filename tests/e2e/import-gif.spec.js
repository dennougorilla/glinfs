import { expect, test } from '@playwright/test';
import gifenc from 'gifenc';
import { gotoCapture } from './helpers/app.js';

/**
 * E2E: open an existing GIF from the Capture screen (standalone GIF editor).
 *
 * The fixture GIF is built here in Node with gifenc so the timing and
 * transparency are exact: 3 frames of 64x48 with delays 100/100/500 ms, the
 * third on a transparent background. Imported at the GCD rate (10 fps) the
 * 500 ms hold becomes 5 repeated slots, so the editor must show 7 frames.
 *
 * Export of imported clips (merging the repeated slots back into one GIF
 * frame) is built by a parallel task and verified after both are merged.
 */

const { GIFEncoder } = gifenc;

const WIDTH = 64;
const HEIGHT = 48;

/** Queue entries only (the active clip renders with data-clip-active) */
const QUEUE_ENTRIES = '[data-testid="clip-entry"]:not([data-clip-active])';

/**
 * Build the fixture GIF.
 * Palette: 0 = transparent (frame 3 background), 1 = red, 2 = blue, 3 = green.
 * Every frame uses disposal 2 (restore to background) so frame 3's
 * transparent pixels do not show frame 2 through them.
 * @returns {Buffer}
 */
function buildFixtureGif() {
  const palette = [
    [0, 0, 0],
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ];
  const size = WIDTH * HEIGHT;
  const red = new Uint8Array(size).fill(1);
  const blue = new Uint8Array(size).fill(2);
  // Frame 3: transparent background with an opaque green 20x16 square
  const greenOnClear = new Uint8Array(size).fill(0);
  for (let y = 16; y < 32; y++) {
    for (let x = 22; x < 42; x++) {
      greenOnClear[y * WIDTH + x] = 3;
    }
  }

  const gif = GIFEncoder();
  gif.writeFrame(red, WIDTH, HEIGHT, { palette, delay: 100, dispose: 2 });
  gif.writeFrame(blue, WIDTH, HEIGHT, { delay: 100, dispose: 2 });
  gif.writeFrame(greenOnClear, WIDTH, HEIGHT, {
    delay: 500,
    dispose: 2,
    transparent: true,
    transparentIndex: 0,
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Serializable facts about the active clip (VideoFrames must not cross the
 * page.evaluate boundary)
 * @param {import('@playwright/test').Page} page
 */
async function readActiveClip(page) {
  return page.evaluate(() => {
    const payload = window.__TEST_HOOKS__.getClipPayload();
    if (!payload) return null;
    return {
      fps: payload.fps,
      frameCount: payload.frames.length,
      hasAlpha: payload.hasAlpha,
      sourceName: payload.sourceName,
      sceneDetectionEnabled: payload.sceneDetectionEnabled,
      sharedKeys: payload.frames.map((f) => f.sharedKey),
      timestamps: payload.frames.map((f) => f.timestamp),
      openFrames: payload.frames.filter((f) => !f.frame.closed).length,
    };
  });
}

test.describe('Import a GIF from the Capture screen', () => {
  test('opens the editor on the imported clip at the GCD fps with holds as repeated slots', async ({
    page,
  }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await gotoCapture(page);
    await expect(page.locator('.capture-import-btn')).toHaveText('Open GIF or image');
    await expect(page.locator('.capture-import-hint')).toContainText('drop a GIF here');

    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'fixture.gif',
      mimeType: 'image/gif',
      buffer: buildFixtureGif(),
    });

    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    expect(await page.evaluate(() => location.hash)).toBe('#/editor');

    const clip = await readActiveClip(page);
    expect(clip).toMatchObject({
      fps: 10,
      frameCount: 7,
      hasAlpha: true,
      sourceName: 'fixture.gif',
      sceneDetectionEnabled: false,
      openFrames: 7,
    });
    // Slots 1, 1, 5: the 500 ms hold is five clones sharing one source key
    const keys = /** @type {string[]} */ (clip?.sharedKeys);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(new Set(keys.slice(2))).toEqual(new Set([keys[2]]));
    // Constant-fps timestamps (microseconds)
    expect(clip?.timestamps).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => i * 100_000));

    await expect
      .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getEditorState()?.frameCount))
      .toBe(7);

    expect(pageErrors).toEqual([]);
  });

  test('a fully opaque GIF is not flagged hasAlpha and imports 1:1', async ({ page }) => {
    const palette = [
      [255, 0, 0],
      [0, 0, 255],
    ];
    const gif = GIFEncoder();
    const size = WIDTH * HEIGHT;
    gif.writeFrame(new Uint8Array(size).fill(0), WIDTH, HEIGHT, { palette, delay: 40 });
    gif.writeFrame(new Uint8Array(size).fill(1), WIDTH, HEIGHT, { delay: 40 });
    gif.writeFrame(new Uint8Array(size).fill(0), WIDTH, HEIGHT, { delay: 40 });
    gif.finish();

    await gotoCapture(page);
    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'opaque.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from(gif.bytes()),
    });

    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    expect(await readActiveClip(page)).toMatchObject({
      fps: 25,
      frameCount: 3,
      hasAlpha: false,
      sourceName: 'opaque.gif',
    });
  });

  test('an unsupported file shows an error and stays on the Capture screen', async ({ page }) => {
    await gotoCapture(page);

    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an image'),
    });

    await expect(page.locator('.capture-screen .capture-error')).toContainText(
      `Can't open "notes.txt"`,
    );
    await expect(page.locator('#live-region')).toContainText(`Can't open "notes.txt"`);
    expect(await page.evaluate(() => location.hash)).toBe('#/capture');
    expect(await readActiveClip(page)).toBeNull();
    // The button is usable again (no stuck busy state)
    await expect(page.locator('.capture-import-btn')).toBeEnabled();
    await expect(page.locator('.capture-import-status')).toBeHidden();
  });

  test('a corrupt GIF is refused without leaving the Capture screen', async ({ page }) => {
    await gotoCapture(page);

    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'broken.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from('GIF89a this is not really a gif'),
    });

    await expect(page.locator('.capture-screen .capture-error')).toContainText('broken.gif');
    expect(await page.evaluate(() => location.hash)).toBe('#/capture');
    expect(await readActiveClip(page)).toBeNull();
  });

  test('importing while another clip is active demotes it into the queue', async ({ page }) => {
    await gotoCapture(page);
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 12, fps: 30 });
    });

    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'second.gif',
      mimeType: 'image/gif',
      buffer: buildFixtureGif(),
    });

    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    const clip = await readActiveClip(page);
    expect(clip).toMatchObject({ sourceName: 'second.gif', frameCount: 7, fps: 10 });

    // The previous (captured) clip was demoted, not destroyed
    await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(1);
  });

  test('dropping a GIF on the preview area opens it', async ({ page }) => {
    await gotoCapture(page);
    const bytes = Array.from(buildFixtureGif());

    const panel = page.locator('.capture-preview-panel');
    await panel.evaluate((el, data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], 'dropped.gif', { type: 'image/gif' }));
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
      window.__dropTransfer = transfer;
    }, bytes);
    await expect(panel).toHaveClass(/capture-import-dropzone--active/);

    await panel.evaluate((el) => {
      el.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dropTransfer,
        }),
      );
    });

    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    expect(await readActiveClip(page)).toMatchObject({ sourceName: 'dropped.gif', frameCount: 7 });
  });
});
