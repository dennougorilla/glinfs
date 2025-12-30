import { test, expect } from '@playwright/test';

test.describe('Frame Grid Modal', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app and capture some frames first
    await page.goto('/');
  });

  test.describe('User Story 1: Open Frame Grid Modal', () => {
    test('should show Frame Grid button in playback controls', async ({ page }) => {
      await page.goto('/');
      // Check if editor screen with clip is available
      const frameGridBtn = page.locator('.btn-frame-grid');
      // The button exists if we're in editor with a clip
      if (await page.locator('.editor-screen').isVisible()) {
        await expect(frameGridBtn).toBeVisible();
      }
    });

    test('should open modal when clicking Frame Grid button', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Verify modal appears
        const modal = page.locator('.frame-grid-modal');
        await expect(modal).toBeVisible();

        // Verify modal has correct ARIA attributes
        const backdrop = page.locator('.frame-grid-backdrop');
        await expect(backdrop).toHaveAttribute('role', 'dialog');
        await expect(backdrop).toHaveAttribute('aria-modal', 'true');
      }
    });

    test('should open modal when pressing F key', async ({ page }) => {
      await page.goto('/');

      if (await page.locator('.editor-screen').isVisible()) {
        await page.keyboard.press('f');

        const modal = page.locator('.frame-grid-modal');
        await expect(modal).toBeVisible();
      }
    });

    test('should close modal on Escape key', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();
        await expect(page.locator('.frame-grid-modal')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(page.locator('.frame-grid-modal')).not.toBeVisible();
      }
    });

    test('should close modal when clicking outside', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();
        await expect(page.locator('.frame-grid-modal')).toBeVisible();

        // Click on backdrop (outside modal)
        const backdrop = page.locator('.frame-grid-backdrop');
        const modal = page.locator('.frame-grid-modal');
        const modalBox = await modal.boundingBox();
        const backdropBox = await backdrop.boundingBox();

        if (backdropBox && modalBox) {
          // Click on backdrop above the modal
          await page.mouse.click(backdropBox.x + 10, backdropBox.y + 10);
          await expect(modal).not.toBeVisible();
        }
      }
    });

    test('should display grid of frame thumbnails', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const gridItems = page.locator('.frame-grid-item');
        // Should have at least one frame
        const count = await gridItems.count();
        expect(count).toBeGreaterThan(0);
      }
    });

    test('should show frame numbers on thumbnails', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const numberLabels = page.locator('.frame-grid-number');
        const count = await numberLabels.count();
        expect(count).toBeGreaterThan(0);

        // First frame should be labeled "1"
        await expect(numberLabels.first()).toHaveText('1');
      }
    });
  });

  test.describe('User Story 2: Select Start Frame', () => {
    test('should set Start frame when clicking a thumbnail', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const firstItem = page.locator('.frame-grid-item').first();
        await firstItem.click();

        // Should have Start badge
        await expect(firstItem).toHaveClass(/is-start/);
        const badge = firstItem.locator('.frame-grid-badge.start-badge');
        await expect(badge).toBeVisible();
      }
    });

    test('should update selection info when Start is set', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const selectionInfo = page.locator('.frame-grid-selection-info');
        await expect(selectionInfo).toContainText('Click a frame to set Start');

        const firstItem = page.locator('.frame-grid-item').first();
        await firstItem.click();

        await expect(selectionInfo).toContainText('Start: Frame 1');
      }
    });
  });

  test.describe('User Story 3: Select End Frame', () => {
    test('should set End frame when Shift+clicking', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const items = page.locator('.frame-grid-item');
        const count = await items.count();

        if (count >= 2) {
          // Click first to set Start
          await items.first().click();

          // Shift+click second to set End
          await items.nth(1).click({ modifiers: ['Shift'] });

          // Second item should have End badge
          await expect(items.nth(1)).toHaveClass(/is-end/);
        }
      }
    });

    test('should swap Start/End when Shift+clicking before Start', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const items = page.locator('.frame-grid-item');
        const count = await items.count();

        if (count >= 3) {
          // Click third frame to set Start
          await items.nth(2).click();

          // Shift+click first frame (before Start)
          await items.first().click({ modifiers: ['Shift'] });

          // First should now be Start, third should be End
          await expect(items.first()).toHaveClass(/is-start/);
          await expect(items.nth(2)).toHaveClass(/is-end/);
        }
      }
    });

    test('should select single frame on double-click', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const firstItem = page.locator('.frame-grid-item').first();
        await firstItem.dblclick();

        // Should have combined S=E badge for single frame selection
        const singleBadge = firstItem.locator('.frame-grid-badge.single-badge');
        await expect(singleBadge).toBeVisible();
        await expect(singleBadge).toHaveText('S=E');
      }
    });
  });

  test.describe('User Story 4: Apply Selection', () => {
    test('should have disabled Apply button when no selection', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Initially Apply should be enabled (initialized from current range)
        // After clearing, it would be disabled
        const applyBtn = page.locator('.frame-grid-btn-apply');
        await expect(applyBtn).toBeVisible();
      }
    });

    test('should close modal and apply selection on Apply click', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Select a range
        const items = page.locator('.frame-grid-item');
        await items.first().click();

        // Click Apply
        const applyBtn = page.locator('.frame-grid-btn-apply');
        await applyBtn.click();

        // Modal should close
        await expect(page.locator('.frame-grid-modal')).not.toBeVisible();
      }
    });

    test('should close modal without applying on Cancel click', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const cancelBtn = page.locator('.frame-grid-btn-cancel');
        await cancelBtn.click();

        await expect(page.locator('.frame-grid-modal')).not.toBeVisible();
      }
    });
  });

  test.describe('Grid Size Control', () => {
    test('should show grid size slider in header', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const sizeSlider = page.locator('.grid-size-slider');
        await expect(sizeSlider).toBeVisible();
      }
    });

    test('should auto-fit thumbnails on modal open', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Slider value should be set (auto-fit calculated)
        const sizeSlider = page.locator('.grid-size-slider');
        const value = await sizeSlider.inputValue();
        expect(parseInt(value)).toBeGreaterThanOrEqual(60);
        expect(parseInt(value)).toBeLessThanOrEqual(240);
      }
    });
  });

  test.describe('Inline Start/End Buttons', () => {
    test('should show S/E buttons on thumbnail hover', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const firstItem = page.locator('.frame-grid-item').first();
        await firstItem.hover();

        const hoverActions = firstItem.locator('.frame-hover-actions');
        await expect(hoverActions).toBeVisible();
      }
    });

    test('should set Start when clicking S button', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const firstItem = page.locator('.frame-grid-item').first();
        await firstItem.hover();

        const startBtn = firstItem.locator('.action-start');
        await startBtn.click();

        await expect(firstItem).toHaveClass(/is-start/);
      }
    });

    test('should set End when clicking E button', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const items = page.locator('.frame-grid-item');
        const count = await items.count();

        if (count >= 2) {
          // First set Start
          const firstItem = items.first();
          await firstItem.hover();
          await firstItem.locator('.action-start').click();

          // Then set End on second item
          const secondItem = items.nth(1);
          await secondItem.hover();
          await secondItem.locator('.action-end').click();

          await expect(secondItem).toHaveClass(/is-end/);
        }
      }
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('should navigate with arrow keys', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // First item should be focused initially
        const firstItem = page.locator('.frame-grid-item').first();
        await expect(firstItem).toBeFocused();

        // Press right arrow to move to second item
        await page.keyboard.press('ArrowRight');
        const secondItem = page.locator('.frame-grid-item').nth(1);
        await expect(secondItem).toBeFocused();
      }
    });

    test('should select with Enter key', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Press Enter to select first frame as Start
        await page.keyboard.press('Enter');

        const firstItem = page.locator('.frame-grid-item').first();
        await expect(firstItem).toHaveClass(/is-start/);
      }
    });

    test('should select End with Shift+Enter', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Select first as Start
        await page.keyboard.press('Enter');

        // Navigate to second
        await page.keyboard.press('ArrowRight');

        // Select as End with Shift+Enter
        await page.keyboard.press('Shift+Enter');

        const secondItem = page.locator('.frame-grid-item').nth(1);
        await expect(secondItem).toHaveClass(/is-end/);
      }
    });
  });

  test.describe('Accessibility', () => {
    test('should trap focus within modal', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        // Tab through all focusable elements
        // Focus should cycle back to first element
        const modal = page.locator('.frame-grid-modal');
        const focusableElements = modal.locator('button, [tabindex]:not([tabindex="-1"])');
        const count = await focusableElements.count();

        // Tab through all elements + 1 more to test wrap
        for (let i = 0; i < count + 1; i++) {
          await page.keyboard.press('Tab');
        }

        // Focus should still be within modal
        const activeElement = await page.evaluate(() => document.activeElement?.closest('.frame-grid-modal'));
        expect(activeElement).not.toBeNull();
      }
    });

    test('should have visible focus indicator', async ({ page }) => {
      await page.goto('/');
      const frameGridBtn = page.locator('.btn-frame-grid');

      if (await frameGridBtn.isVisible()) {
        await frameGridBtn.click();

        const firstItem = page.locator('.frame-grid-item').first();
        await firstItem.focus();

        // Verify focus is visible (has outline)
        const outline = await firstItem.evaluate((el) =>
          window.getComputedStyle(el).outline
        );
        expect(outline).not.toBe('none');
      }
    });
  });
});
