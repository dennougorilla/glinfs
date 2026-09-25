/**
 * E2E: text layers authored in the editor are burned into the exported GIF.
 *
 * Uses a solid-color mock clip (the default "numbered" pattern paints white
 * text of its own). The caption is added, typed, styled and dragged through
 * the UI, its frame range is restricted with "Set to playhead", then the
 * clip is exported with the JavaScript encoder and the real GIF bytes are
 * decoded in the page.
 * @module tests/e2e/editor-text.spec
 */

import { expect, test } from '@playwright/test';
import {
  countGifPixelsNear,
  decodeExportedGif,
  editorFramePointToViewport,
  exportFromEditor,
  exportGifAndWait,
  gotoEditorWithClip,
  pauseEditorPlayback,
} from './helpers/app.js';

const WIDTH = 160;
const HEIGHT = 120;
const FRAME_COUNT = 10;
const BACKGROUND = [0x20, 0x50, 0xa0];
const RED = /** @type {[number, number, number]} */ ([255, 0, 0]);

/** @param {import('@playwright/test').Page} page */
async function readEditorState(page) {
  return page.evaluate(() => window.__TEST_HOOKS__.getEditorState());
}

/**
 * Move the playhead with the editor's keyboard shortcuts (focus must not be
 * in a form field, where shortcuts are off by design)
 * @param {import('@playwright/test').Page} page
 * @param {number} frame
 */
async function seekWithKeyboard(page, frame) {
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Home');
  for (let i = 0; i < frame; i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect.poll(async () => (await readEditorState(page))?.currentFrame).toBe(frame);
}

test.describe('Editor text layers', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, {
      frameCount: FRAME_COUNT,
      fps: 10,
      width: WIDTH,
      height: HEIGHT,
      pattern: 'solid',
      color: '#2050a0',
    });
    await pauseEditorPlayback(page);
  });

  test('typing a caption never triggers editor shortcuts', async ({ page }) => {
    await page.locator('#text-add').click();
    const textInput = page.locator('#text-layer-text');
    await expect(textInput).toBeFocused();

    // Space (play), g (grid), f (frame grid), digits (clip switch), Delete /
    // Backspace (delete clip), Home/End (seek) are all shortcuts elsewhere
    await textInput.press('ControlOrMeta+a');
    await textInput.pressSequentially('Go fig 1 2');
    await textInput.press('Backspace');
    await textInput.press('Delete');
    await textInput.press('Home');
    await textInput.press('End');

    await expect(textInput).toHaveValue('Go fig 1 ');
    const state = await readEditorState(page);
    expect(state?.edits.textLayers[0].text).toBe('Go fig 1 ');
    expect(state?.frameCount).toBe(FRAME_COUNT);
    await expect(page.locator('.btn-play')).toHaveAttribute('aria-label', 'Play');
    await expect(page.locator('.frame-grid-modal')).toBeHidden();
    expect(await page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.frames.length)).toBe(
      FRAME_COUNT,
    );

    // The layer list follows the caption (first line)
    await expect(page.locator('#text-layer-list .editor-text-item-select')).toHaveText('Go fig 1');
  });

  test('adds, styles, drags and times a caption, and exports it on those frames only', async ({
    page,
  }) => {
    // Editor authoring + a full export and decode
    test.slow();

    // Add through the UI: spans the selection, selected, focused
    await page.locator('#text-add').click();
    await expect(page.locator('#text-layer-editor')).toBeVisible();
    await page.locator('#text-layer-text').fill('HI');
    await page.locator('#text-layer-size').fill('30');
    await page.locator('#text-layer-color').fill('#ff0000');
    await expect(page.locator('#text-layer-size-value')).toHaveText('30%');

    let state = await readEditorState(page);
    expect(state?.selectedTextId).toBe(state?.edits.textLayers[0].id);
    expect(state?.edits.textLayers[0]).toMatchObject({
      text: 'HI',
      size: 0.3,
      color: '#ff0000',
      start: 0,
      end: FRAME_COUNT - 1,
      x: 0.5,
      y: 0.85,
    });

    // Drag the caption from its default spot (bottom center) up-left
    const from = await editorFramePointToViewport(page, 0.5 * WIDTH, 0.85 * HEIGHT);
    const to = await editorFramePointToViewport(page, 0.35 * WIDTH, 0.35 * HEIGHT);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await readEditorState(page))?.edits.textLayers[0].y)
      .toBeCloseTo(0.35, 1);
    state = await readEditorState(page);
    const layer = state?.edits.textLayers[0];
    expect(layer?.x).toBeCloseTo(0.35, 1);
    // Dragging text never starts a crop
    expect(state?.cropArea).toBeNull();

    // Restrict the caption to frames 3..6 with "Set to playhead"
    await seekWithKeyboard(page, 3);
    await page.locator('#text-layer-start-playhead').click();
    await seekWithKeyboard(page, 6);
    await page.locator('#text-layer-end-playhead').click();
    await expect(page.locator('#text-layer-start')).toHaveAttribute('data-frame', '3');
    await expect(page.locator('#text-layer-end')).toHaveAttribute('data-frame', '6');

    await exportFromEditor(page);
    await page.locator('[data-encoder-id="gifenc-js"]').click();
    await expect(page.locator('[data-encoder-id="gifenc-js"]')).toHaveClass(/selected/);
    await exportGifAndWait(page);
    const frames = await decodeExportedGif(page);
    expect(frames).toHaveLength(FRAME_COUNT);

    // Where the caption lands: centered on (x, y), ~1 em wide for "HI"
    const fontPx = Math.round(0.3 * HEIGHT);
    const cx = /** @type {number} */ (layer?.x) * WIDTH;
    const cy = /** @type {number} */ (layer?.y) * HEIGHT;
    const textRect = {
      x0: cx - 1.2 * fontPx,
      y0: cy - 0.8 * fontPx,
      x1: cx + 1.2 * fontPx,
      y1: cy + 0.8 * fontPx,
    };
    const whole = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT };

    frames.forEach((frame, index) => {
      expect([frame.width, frame.height]).toEqual([WIDTH, HEIGHT]);
      const inside = countGifPixelsNear(frame, textRect, RED);
      const everywhere = countGifPixelsNear(frame, whole, RED);
      if (index >= 3 && index <= 6) {
        expect(inside, `frame ${index} shows the caption`).toBeGreaterThan(150);
        expect(everywhere - inside, `frame ${index}: no caption pixels elsewhere`).toBe(0);
      } else {
        expect(everywhere, `frame ${index} has no caption`).toBe(0);
      }
      // Far from the caption the background is untouched and opaque
      expect(
        countGifPixelsNear(frame, { x0: 140, y0: 100, x1: 160, y1: 120 }, BACKGROUND, 24),
      ).toBe(400);
    });
  });

  test('Escape deselects the text before clearing the crop, and Delete removes the selected layer', async ({
    page,
  }) => {
    await page.locator('#text-add').click();
    await page.locator('#text-layer-text').fill('Caption');
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({
        cropArea: { x: 10, y: 10, width: 140, height: 100, aspectRatio: 'free' },
      });
    });
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());

    await page.keyboard.press('Escape');
    let state = await readEditorState(page);
    expect(state?.selectedTextId).toBeNull();
    expect(state?.cropArea).not.toBeNull();
    await expect(page.locator('#text-layer-editor')).toBeHidden();

    await page.keyboard.press('Escape');
    await expect.poll(async () => (await readEditorState(page))?.cropArea).toBeNull();

    // Reselect from the list, then Delete removes the caption — not the clip
    await page.locator('#text-layer-list .editor-text-item-select').click();
    await page.keyboard.press('Delete');
    state = await readEditorState(page);
    expect(state?.edits.textLayers).toHaveLength(0);
    expect(state?.frameCount).toBe(FRAME_COUNT);
    expect(await page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.frames.length)).toBe(
      FRAME_COUNT,
    );
  });

  test('deleting a layer from the list with the keyboard keeps focus in the list', async ({
    page,
  }) => {
    await page.locator('#text-add').click();
    await page.locator('#text-layer-text').fill('A');
    await page.locator('#text-add').click();
    await page.locator('#text-layer-text').fill('B');
    await expect(page.locator('#text-layer-list .editor-text-item')).toHaveCount(2);

    await page.locator('#text-layer-list .editor-text-item-delete').first().focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readEditorState(page))?.edits.textLayers).toHaveLength(1);
    await expect(page.locator('#text-layer-list .editor-text-item-select')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.locator('#text-layer-list .editor-text-item-delete')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#text-add')).toBeFocused();
  });

  test('a caption deleted with Backspace after dragging it comes back with Undo', async ({
    page,
  }) => {
    await expect(page.locator('[data-delete-hint]')).toHaveText('Delete Clip');
    await page.locator('#text-add').click();
    await page.locator('#text-layer-text').fill('Hello');
    await page.locator('#text-layer-size').fill('30');
    await expect(page.locator('[data-delete-hint]')).toHaveText('Delete Text');

    // Dragging on the preview hands the keyboard back to the editor
    const from = await editorFramePointToViewport(page, 0.5 * WIDTH, 0.85 * HEIGHT);
    const to = await editorFramePointToViewport(page, 0.5 * WIDTH, 0.5 * HEIGHT);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await readEditorState(page))?.edits.textLayers[0].y)
      .toBeCloseTo(0.5, 1);
    const [layer] = /** @type {any} */ (await readEditorState(page)).edits.textLayers;

    await page.keyboard.press('Backspace');
    await expect.poll(async () => (await readEditorState(page))?.edits.textLayers).toHaveLength(0);
    const toast = page.locator('.app-toast', { hasText: 'Text layer deleted' });
    await expect(toast).toBeVisible();
    await expect(page.locator('[data-delete-hint]')).toHaveText('Delete Clip');

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await readEditorState(page))?.edits.textLayers).toEqual([layer]);
    expect((await readEditorState(page))?.selectedTextId).toBe(layer.id);
    await expect(page.locator('#text-layer-text')).toHaveValue('Hello');
    await expect(page.locator('[data-delete-hint]')).toHaveText('Delete Text');
  });
});
