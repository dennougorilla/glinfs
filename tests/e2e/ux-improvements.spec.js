/**
 * E2E Tests for Core UX Improvements (003-fix-core-ux)
 * @module tests/e2e/ux-improvements.spec
 *
 * Rewritten for #48:
 * - Capture tests asserting state fields/UI that never existed
 *   (isRecording, sessionClips, .clip-badge) were replaced with a test of the
 *   real buffer stats pipeline (setCaptureState -> updateBufferStatus).
 * - Editor tests now use the awaited injection + hash navigation pattern and
 *   the selectors that actually exist (.tl-playhead, .btn-play).
 * - The old US5 preview-UI tests were removed; the Canvas preview is covered
 *   in export-preview.spec.js.
 */

import { expect, test } from '@playwright/test';
import {
  gotoCapture,
  gotoEditorWithClip,
  gotoExportWithClip,
  pauseEditorPlayback,
} from './helpers/app.js';

// ============================================================
// US1: Capture buffer feedback
// ============================================================

test.describe('US1: Capture buffer stats', () => {
  test('buffer stats update when capture state changes', async ({ page }) => {
    await gotoCapture(page);

    // Initial buffer is empty
    await expect(page.locator('.capture-stats .stat-value').first()).toHaveText('0');

    // Simulate captured frames via test hooks (real store -> UI update path)
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setCaptureState({
        stats: { frameCount: 90, duration: 3.0, memoryMB: 12.5, fps: 30 },
      });
    });

    const statValues = page.locator('.capture-stats .stat-value');
    await expect(statValues.nth(0)).toHaveText('90');
    await expect(statValues.nth(2)).toHaveText('30');
  });
});

// ============================================================
// US2: Clip Range Display
// ============================================================

test.describe('US2: Clip Range Display', () => {
  test('selection info displays frame count and duration', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 90, fps: 30 });
    await pauseEditorPlayback(page);

    // Set custom selection range
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({
        selectedRange: { start: 10, end: 50 },
        currentFrame: 25,
      });
    });

    // Selection info shows the frame count (41 frames: 10-50 inclusive)
    const selectionInfo = page.locator('.timeline-selection-info');
    await expect(selectionInfo).toBeVisible();
    await expect(selectionInfo.locator('.timeline-sel-frames')).toHaveText('(41 frames)');
  });

  test('playhead is positioned on the timeline', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 60, fps: 30 });

    // .tl-playhead is a zero-width anchor; its line is the visible element
    await expect(page.locator('.tl-playhead-line')).toBeVisible();

    // Pause auto-playback so the playhead stops advancing
    await pauseEditorPlayback(page);

    // Move the playhead to the middle of the clip and verify it tracks
    // (percent = currentFrame / (totalFrames - 1) -> 30/59 = ~50.8%)
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({ currentFrame: 30 });
    });

    await expect
      .poll(() =>
        page.evaluate(() => Number.parseFloat(document.querySelector('.tl-playhead').style.left)),
      )
      .toBeCloseTo((30 / 59) * 100, 1);
  });

  test('selection info updates in real-time', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 120, fps: 30 });
    await pauseEditorPlayback(page);

    const selFrames = page.locator('.timeline-sel-frames');
    await expect(selFrames).toHaveText('(120 frames)');

    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 0, end: 59 } });
    });
    await expect(selFrames).toHaveText('(60 frames)');

    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 20, end: 29 } });
    });
    await expect(selFrames).toHaveText('(10 frames)');

    await expect(page).toHaveScreenshot('us2-selection-info.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// US3: Playback Controls Layout
// ============================================================

test.describe('US3: Playback Controls Layout', () => {
  test('playback controls visible without overflow at 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoEditorWithClip(page, { frameCount: 60, fps: 30 });

    const playbackControls = page.locator('.playback-controls');
    await expect(playbackControls).toBeVisible();

    // Play button (dedicated .btn-play class, not .btn-playback)
    const playButton = page.locator('.btn-play');
    await expect(playButton).toBeVisible();

    // Frame stepping buttons
    await expect(page.locator('.btn-playback')).toHaveCount(4);

    // Check no overflow (controls should be within viewport)
    const controlsBox = await playbackControls.boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(1280);
  });

  test('playback controls work at various viewport sizes', async ({ page }) => {
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await gotoEditorWithClip(page, { frameCount: 30, fps: 30 });

      const playbackControls = page.locator('.playback-controls');
      await expect(playbackControls).toBeVisible();

      const controlsBox = await playbackControls.boundingBox();
      expect(controlsBox).not.toBeNull();
      expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(viewport.width);
    }
  });

  test('play button toggles playback state on click', async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30, fps: 30 });

    // Editor auto-plays on entry
    const playButton = page.locator('.btn-play');
    await expect(playButton).toHaveAttribute('aria-label', 'Pause');
    await expect(playButton).toHaveClass(/playing/);

    await playButton.click();
    await expect(playButton).toHaveAttribute('aria-label', 'Play');

    await playButton.click();
    await expect(playButton).toHaveAttribute('aria-label', 'Pause');

    await expect(page).toHaveScreenshot('us3-playback-controls.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// US4: Professional Form Controls
// ============================================================

test.describe('US4: Professional Form Controls', () => {
  test('capture settings have styled range inputs', async ({ page }) => {
    await gotoCapture(page);

    // Buffer duration slider
    const rangeInputs = page.locator('input[type="range"]');
    const count = await rangeInputs.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(rangeInputs.nth(i)).toBeVisible();
    }

    await expect(page).toHaveScreenshot('us4-capture-sliders.png', {
      fullPage: true,
    });
  });

  test('export settings have styled select elements', async ({ page }) => {
    await gotoExportWithClip(page, { frameCount: 30, fps: 30 });

    // Frame skip + speed selects
    const selectElements = page.locator('select');
    const count = await selectElements.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(selectElements.nth(i)).toBeVisible();
    }

    await expect(page).toHaveScreenshot('us4-export-selects.png', {
      fullPage: true,
    });
  });

  test('form controls consistent across features', async ({ page }) => {
    // Capture
    await gotoCapture(page);
    await expect(page.locator('.capture-settings select').first()).toBeVisible();
    await expect(page).toHaveScreenshot('us4-form-capture.png', { fullPage: true });

    // Editor
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 30, fps: 30 });
      location.hash = '#/editor';
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await expect(page.locator('.editor-sidebar select').first()).toBeVisible();
    await expect(page).toHaveScreenshot('us4-form-editor.png', { fullPage: true });

    // Export
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockEditorPayload({ frameCount: 30, fps: 30 });
      location.hash = '#/export';
    });
    await page.waitForSelector('.export-canvas', { state: 'visible' });
    await expect(page.locator('.export-settings-panel select').first()).toBeVisible();
    await expect(page).toHaveScreenshot('us4-form-export.png', { fullPage: true });
  });
});

// ============================================================
// Integration: All User Stories Together
// ============================================================

test.describe('Integration: Full UX Flow', () => {
  test('complete flow through capture, editor and export', async ({ page }) => {
    // 1. Capture with buffered frames
    await gotoCapture(page);
    await page.evaluate(() => {
      window.__TEST_HOOKS__.setCaptureState({
        stats: { frameCount: 90, duration: 3.0, memoryMB: 15, fps: 30 },
      });
    });
    await expect(page.locator('.capture-stats .stat-value').first()).toHaveText('90');
    await expect(page).toHaveScreenshot('integration-1-capture.png', { fullPage: true });

    // 2. Editor with selection info and playback controls
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 90, fps: 30 });
      location.hash = '#/editor';
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await pauseEditorPlayback(page);

    await page.evaluate(() => {
      window.__TEST_HOOKS__.setEditorState({
        selectedRange: { start: 15, end: 75 },
        currentFrame: 45,
      });
    });
    await expect(page.locator('.timeline-sel-frames')).toHaveText('(61 frames)');
    await expect(page.locator('.btn-play')).toBeVisible();
    await expect(page).toHaveScreenshot('integration-2-editor.png', { fullPage: true });

    // 3. Export with styled controls and canvas preview
    await page.evaluate(async () => {
      await window.__TEST_HOOKS__.injectMockEditorPayload({ frameCount: 61, fps: 30 });
      location.hash = '#/export';
    });
    await page.waitForSelector('.export-canvas', { state: 'visible' });

    await expect(page.locator('.export-settings-panel')).toBeVisible();
    await expect(page.locator('.export-preview-play-btn')).toBeVisible();
    await expect(page).toHaveScreenshot('integration-3-export.png', { fullPage: true });
  });
});
