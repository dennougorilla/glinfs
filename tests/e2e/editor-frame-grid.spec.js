/**
 * E2E Tests for the Frame Grid Modal
 * @module tests/e2e/editor-frame-grid.spec
 *
 * Rewritten for #48: the previous version guarded every assertion behind
 * `if (await locator.isVisible())` without injecting a clip, so all tests
 * passed vacuously. Each test now loads the editor with a mock clip, opens
 * the modal for real, and asserts against the selectors/texts that actually
 * exist (.btn-frame-grid-compact, IN/OUT badges, 'IN=OUT' single selection).
 */

import { expect, test } from '@playwright/test';
import { gotoEditorWithClip, pauseEditorPlayback } from './helpers/app.js';

const FRAME_COUNT = 12;

/**
 * Open the frame grid modal from the timeline header
 * @param {import('@playwright/test').Page} page
 */
async function openFrameGrid(page) {
  await page.locator('.btn-frame-grid-compact').click();
  await expect(page.locator('.frame-grid-modal')).toBeVisible();
}

test.describe('Frame Grid Modal', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: FRAME_COUNT, fps: 30 });
    // Stop auto-playback so background state churn cannot race UI assertions
    await pauseEditorPlayback(page);
  });

  test.describe('Open and Close', () => {
    test('shows Open Grid button in timeline header', async ({ page }) => {
      const frameGridBtn = page.locator('.btn-frame-grid-compact');
      await expect(frameGridBtn).toBeVisible();
      await expect(frameGridBtn).toHaveText('Open Grid');
    });

    test('opens modal with correct ARIA attributes when clicking the button', async ({ page }) => {
      await openFrameGrid(page);

      const backdrop = page.locator('.frame-grid-backdrop');
      await expect(backdrop).toHaveAttribute('role', 'dialog');
      await expect(backdrop).toHaveAttribute('aria-modal', 'true');
    });

    test('opens modal when pressing F key', async ({ page }) => {
      await page.keyboard.press('f');
      await expect(page.locator('.frame-grid-modal')).toBeVisible();
    });

    test('closes modal on Escape key', async ({ page }) => {
      await openFrameGrid(page);

      await page.keyboard.press('Escape');
      await expect(page.locator('.frame-grid-modal')).not.toBeVisible();
    });

    test('closes modal when clicking the backdrop', async ({ page }) => {
      await openFrameGrid(page);

      const backdropBox = await page.locator('.frame-grid-backdrop').boundingBox();
      expect(backdropBox).not.toBeNull();

      // Click a corner of the backdrop, outside the centered modal
      await page.mouse.click(backdropBox.x + 5, backdropBox.y + 5);
      await expect(page.locator('.frame-grid-modal')).not.toBeVisible();
    });
  });

  test.describe('Grid Contents', () => {
    test('displays one thumbnail per frame with number labels', async ({ page }) => {
      await openFrameGrid(page);

      await expect(page.locator('.frame-grid-item')).toHaveCount(FRAME_COUNT);
      await expect(page.locator('.frame-grid-number').first()).toHaveText('1');
      await expect(page.locator('.frame-grid-number').last()).toHaveText(String(FRAME_COUNT));
    });

    test('initial selection reflects the current clip range', async ({ page }) => {
      await openFrameGrid(page);

      const items = page.locator('.frame-grid-item');
      await expect(items.first()).toHaveClass(/is-start/);
      await expect(items.first().locator('.frame-grid-badge.start-badge')).toHaveText('IN');
      await expect(items.last()).toHaveClass(/is-end/);
      await expect(items.last().locator('.frame-grid-badge.end-badge')).toHaveText('OUT');

      await expect(page.locator('.frame-grid-selection-info')).toContainText(
        `Selection: Frame 1 → Frame ${FRAME_COUNT} (${FRAME_COUNT} frames)`,
      );
    });

    test('shows grid size slider with auto-fitted value', async ({ page }) => {
      await openFrameGrid(page);

      const sizeSlider = page.locator('.grid-size-slider');
      await expect(sizeSlider).toBeVisible();

      // Bounds are device-adaptive (quality presets), so read them off the input
      const min = Number.parseInt(await sizeSlider.getAttribute('min'), 10);
      const max = Number.parseInt(await sizeSlider.getAttribute('max'), 10);
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(min);

      await expect
        .poll(async () => Number.parseInt(await sizeSlider.inputValue(), 10))
        .toBeGreaterThanOrEqual(min);
      expect(Number.parseInt(await sizeSlider.inputValue(), 10)).toBeLessThanOrEqual(max);
    });
  });

  test.describe('Selecting Start and End Frames', () => {
    test('click sets the Start frame', async ({ page }) => {
      await openFrameGrid(page);

      const items = page.locator('.frame-grid-item');
      await items.nth(3).click();

      await expect(items.nth(3)).toHaveClass(/is-start/);
      await expect(items.nth(3).locator('.frame-grid-badge.start-badge')).toHaveText('IN');
      await expect(items.first()).not.toHaveClass(/is-start/);
      await expect(page.locator('.frame-grid-selection-info')).toContainText('Frame 4');
    });

    test('Shift+click sets the End frame', async ({ page }) => {
      await openFrameGrid(page);

      const items = page.locator('.frame-grid-item');
      await items.nth(1).click();
      await items.nth(5).click({ modifiers: ['Shift'] });

      await expect(items.nth(1)).toHaveClass(/is-start/);
      await expect(items.nth(5)).toHaveClass(/is-end/);
      await expect(page.locator('.frame-grid-selection-info')).toContainText(
        'Selection: Frame 2 → Frame 6 (5 frames)',
      );
    });

    test('double-click selects a single frame (IN=OUT)', async ({ page }) => {
      await openFrameGrid(page);

      const item = page.locator('.frame-grid-item').nth(2);
      await item.dblclick();

      const singleBadge = item.locator('.frame-grid-badge.single-badge');
      await expect(singleBadge).toBeVisible();
      await expect(singleBadge).toHaveText('IN=OUT');
    });

    test('hover S/E buttons set Start and End', async ({ page }) => {
      await openFrameGrid(page);

      const items = page.locator('.frame-grid-item');

      // Set Start via [S] button on frame 2
      await items.nth(1).hover();
      await items.nth(1).locator('.action-start').click();
      await expect(items.nth(1)).toHaveClass(/is-start/);

      // Set End via [E] button on frame 7
      await items.nth(6).hover();
      await items.nth(6).locator('.action-end').click();
      await expect(items.nth(6)).toHaveClass(/is-end/);
    });
  });

  test.describe('Apply and Cancel', () => {
    test('Apply closes the modal and applies the selection to the timeline', async ({ page }) => {
      await openFrameGrid(page);

      const items = page.locator('.frame-grid-item');
      await items.nth(2).click();
      await items.nth(7).click({ modifiers: ['Shift'] });

      const applyBtn = page.locator('.frame-grid-btn-apply');
      await expect(applyBtn).toBeEnabled();
      await applyBtn.click();

      await expect(page.locator('.frame-grid-modal')).not.toBeVisible();

      // Timeline header reflects the applied range (frames 3-8 -> 6 frames)
      await expect(page.locator('.timeline-sel-frames')).toHaveText('(6 frames)');
    });

    test('Cancel closes the modal without applying', async ({ page }) => {
      await openFrameGrid(page);

      await page.locator('.frame-grid-item').nth(2).click();
      await page.locator('.frame-grid-btn-cancel').click();

      await expect(page.locator('.frame-grid-modal')).not.toBeVisible();

      // Timeline selection is unchanged
      await expect(page.locator('.timeline-sel-frames')).toHaveText(`(${FRAME_COUNT} frames)`);
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('navigates with arrow keys and selects with Enter', async ({ page }) => {
      await openFrameGrid(page);

      // The initially selected (start) frame receives focus after auto-fit
      const items = page.locator('.frame-grid-item');
      await expect(items.first()).toBeFocused();

      await page.keyboard.press('ArrowRight');
      await expect(items.nth(1)).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(items.nth(1)).toHaveClass(/is-start/);
    });

    test('selects End with Shift+Enter', async ({ page }) => {
      await openFrameGrid(page);
      await expect(page.locator('.frame-grid-item').first()).toBeFocused();

      // Select first as Start, move right twice, select as End
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+Enter');

      const items = page.locator('.frame-grid-item');
      await expect(items.first()).toHaveClass(/is-start/);
      await expect(items.nth(2)).toHaveClass(/is-end/);
    });
  });

  test.describe('Accessibility', () => {
    test('traps focus within the modal', async ({ page }) => {
      await openFrameGrid(page);
      await expect(page.locator('.frame-grid-item').first()).toBeFocused();

      const focusableCount = await page
        .locator('.frame-grid-modal')
        .locator('button, input, [tabindex]:not([tabindex="-1"])')
        .count();

      // Tab through all elements + 1 more to test wrap-around
      for (let i = 0; i < focusableCount + 1; i++) {
        await page.keyboard.press('Tab');
      }

      const focusInsideModal = await page.evaluate(
        () => document.activeElement?.closest('.frame-grid-modal') !== null,
      );
      expect(focusInsideModal).toBe(true);
    });

    test('keyboard focus shows a visible indicator on grid items', async ({ page }) => {
      await openFrameGrid(page);
      await expect(page.locator('.frame-grid-item').first()).toBeFocused();

      // Arrow navigation moves real DOM focus after a keyboard interaction,
      // so :focus-visible applies and the outline must be rendered.
      await page.keyboard.press('ArrowRight');

      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        const style = window.getComputedStyle(el);
        return {
          isGridItem: el?.classList.contains('frame-grid-item') ?? false,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      expect(focused.isGridItem).toBe(true);
      expect(focused.outlineStyle).not.toBe('none');
      expect(focused.outlineWidth).not.toBe('0px');
    });
  });
});
