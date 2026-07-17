/**
 * E2E Tests for Editor Crop Functionality
 * @module tests/e2e/editor-crop.spec
 *
 * Rewritten for #48: the previous version guarded every assertion behind
 * `if (await locator.isVisible())` without ever injecting a clip, so all
 * tests passed while asserting nothing. Each test now loads the editor with
 * a real mock clip and asserts unconditionally.
 */

import { expect, test } from '@playwright/test';
import { gotoEditorWithClip, pauseEditorPlayback } from './helpers/app.js';

/**
 * Draw a crop area on the overlay canvas by dragging
 * @param {import('@playwright/test').Page} page
 * @param {{ from: [number, number], to: [number, number] }} drag - Canvas-relative coordinates
 */
async function drawCrop(page, { from, to } = { from: [50, 50], to: [250, 200] }) {
  const overlay = page.locator('.editor-canvas-overlay');
  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 5 });
  await page.mouse.up();
}

/**
 * Read the crop info panel values as numbers (or null for '-')
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<number | null>>} [x, y, w, h]
 */
async function readCropInfo(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.crop-info-value'), (el) => {
      const value = Number.parseInt(el.textContent, 10);
      return Number.isNaN(value) ? null : value;
    }),
  );
}

test.describe('Editor Crop Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30, fps: 30 });
    // Crop assertions depend on state-driven UI updates; stop playback churn
    await pauseEditorPlayback(page);
  });

  test.describe('Interactive Crop Area Drawing', () => {
    test('creates crop area by click and drag', async ({ page }) => {
      // No crop yet: info panel shows placeholders, no Clear Crop button
      expect(await readCropInfo(page)).toEqual([null, null, null, null]);
      await expect(page.locator('.btn-clear-crop')).toHaveCount(0);

      await drawCrop(page);

      // Crop info panel now shows concrete values
      const clearBtn = page.locator('.btn-clear-crop');
      await expect(clearBtn).toBeVisible();

      const [, , width, height] = await readCropInfo(page);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    });

    test('moves crop when dragging inside crop area', async ({ page }) => {
      await drawCrop(page, { from: [50, 50], to: [250, 200] });
      const [x1, y1, w1, h1] = await readCropInfo(page);

      // Drag from the middle of the crop to move it right and down
      await drawCrop(page, { from: [150, 125], to: [200, 160] });

      const [x2, y2, w2, h2] = await readCropInfo(page);
      expect(x2).toBeGreaterThan(x1);
      expect(y2).toBeGreaterThan(y1);
      // Size is preserved on move
      expect(w2).toBe(w1);
      expect(h2).toBe(h1);
    });

    test('resizes crop when dragging bottom-right handle', async ({ page }) => {
      await drawCrop(page, { from: [50, 50], to: [250, 200] });
      const [, , w1, h1] = await readCropInfo(page);

      // Drag the bottom-right handle outward
      await drawCrop(page, { from: [250, 200], to: [330, 260] });

      const [, , w2, h2] = await readCropInfo(page);
      expect(w2).toBeGreaterThan(w1);
      expect(h2).toBeGreaterThan(h1);
    });
  });

  test.describe('Aspect Ratio Constraint', () => {
    test('displays aspect ratio buttons in sidebar', async ({ page }) => {
      // Free, 1:1, 16:9, 4:3, 9:16
      const aspectButtons = page.locator('.aspect-ratio-buttons .aspect-btn');
      await expect(aspectButtons).toHaveCount(5);
      await expect(aspectButtons.first()).toHaveText('Free');
    });

    test('highlights active aspect ratio button', async ({ page }) => {
      const aspectButtons = page.locator('.aspect-ratio-buttons .aspect-btn');

      // Default is Free
      await expect(aspectButtons.first()).toHaveClass(/active/);

      // Selecting another ratio moves the highlight
      await aspectButtons.nth(2).click();
      await expect(aspectButtons.nth(2)).toHaveClass(/active/);
      await expect(aspectButtons.first()).not.toHaveClass(/active/);
    });

    test('constrains drawn crop to selected 1:1 ratio', async ({ page }) => {
      await page.locator('.aspect-btn', { hasText: '1:1' }).click();

      await drawCrop(page, { from: [50, 50], to: [250, 150] });

      const [, , width, height] = await readCropInfo(page);
      // Allow 1px difference from rounding in the constraint math
      expect(Math.abs(width - height)).toBeLessThanOrEqual(1);
    });
  });

  test.describe('Rule of Thirds Grid Overlay', () => {
    test('toggles grid with G key', async ({ page }) => {
      const gridBtn = page.locator('.editor-sidebar button[aria-pressed]');
      await expect(gridBtn).toHaveText('Off');

      await page.keyboard.press('g');
      await expect(gridBtn).toHaveText('On');
      await expect(gridBtn).toHaveAttribute('aria-pressed', 'true');

      await page.keyboard.press('g');
      await expect(gridBtn).toHaveText('Off');
    });

    test('toggles grid with button click', async ({ page }) => {
      const gridBtn = page.locator('.editor-sidebar button[aria-pressed]');
      await expect(gridBtn).toHaveAttribute('aria-pressed', 'false');

      await gridBtn.click();
      await expect(gridBtn).toHaveText('On');
      await expect(gridBtn).toHaveAttribute('aria-pressed', 'true');
    });
  });

  test.describe('Clear/Reset Crop', () => {
    test('clears crop with Escape key', async ({ page }) => {
      await drawCrop(page);

      const clearBtn = page.locator('.btn-clear-crop');
      await expect(clearBtn).toBeVisible();

      await page.keyboard.press('Escape');

      await expect(clearBtn).toHaveCount(0);
      expect(await readCropInfo(page)).toEqual([null, null, null, null]);
    });

    // FIXME(#37): the Clear Crop button dies after the second crop update —
    // the subscription in editor/index.js removes its click listener via
    // cropInfoPanelCleanups on every cropArea change, but updateCropInfoPanel
    // only re-registers the listener when it creates the button. Any drag
    // (throttled setState fires multiple times) leaves the button unresponsive.
    test.fixme('clears crop with Clear Crop button (#37)', async ({ page }) => {
      await drawCrop(page);

      const clearBtn = page.locator('.btn-clear-crop');
      await expect(clearBtn).toBeVisible();
      await clearBtn.click();

      await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
      expect(await readCropInfo(page)).toEqual([null, null, null, null]);
    });

    test('only shows Clear Crop button when crop exists', async ({ page }) => {
      await expect(page.locator('.btn-clear-crop')).toHaveCount(0);

      await drawCrop(page);
      await expect(page.locator('.btn-clear-crop')).toBeVisible();
    });
  });
});
