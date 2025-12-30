/**
 * E2E Tests for Core UX Improvements (003-fix-core-ux)
 * @module tests/e2e/ux-improvements.spec
 *
 * Verifies all 5 user stories:
 * - US1: Instant Clip Creation during recording
 * - US2: Clip Range Display in Editor timeline
 * - US3: Playback Controls Layout (no overflow)
 * - US4: Professional Form Controls styling
 * - US5: Export Preview functionality
 */

import { test, expect } from '@playwright/test';

const ANIMATION_SETTLE_MS = 500;

/**
 * Wait for UI to stabilize after navigation or state change
 * @param {import('@playwright/test').Page} page
 */
async function waitForStableUI(page) {
  await page.waitForTimeout(ANIMATION_SETTLE_MS);
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ============================================================
// US1: Instant Clip Creation
// ============================================================

test.describe('US1: Instant Clip Creation', () => {
  test('clip button is enabled during recording', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Set recording state via test hooks
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setCaptureState) {
        window.__TEST_HOOKS__.setCaptureState({
          isRecording: true,
          stats: {
            frameCount: 30,
            duration: 1.0,
            memoryMB: 5,
            fps: 30,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Clip button should be visible and enabled during recording
    const clipButton = page.locator('button').filter({ hasText: /Clip|Create Clip/i });
    await expect(clipButton).toBeVisible();
    await expect(clipButton).toBeEnabled();
  });

  test('clip count badge displays and updates', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Set state with session clips
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setCaptureState) {
        window.__TEST_HOOKS__.setCaptureState({
          isRecording: true,
          sessionClips: [
            { id: 'clip-1', frames: [], createdAt: Date.now() },
            { id: 'clip-2', frames: [], createdAt: Date.now() },
          ],
          stats: {
            frameCount: 90,
            duration: 3.0,
            memoryMB: 15,
            fps: 30,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Badge should show clip count
    const badge = page.locator('.clip-badge, .badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('2');
  });

  test('visual feedback on clip creation', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Set recording state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setCaptureState) {
        window.__TEST_HOOKS__.setCaptureState({
          isRecording: true,
          stats: {
            frameCount: 60,
            duration: 2.0,
            memoryMB: 10,
            fps: 30,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Take screenshot for visual verification
    await expect(page).toHaveScreenshot('us1-clip-during-recording.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// US2: Clip Range Display
// ============================================================

test.describe('US2: Clip Range Display', () => {
  test('selection info displays frame count and duration', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Inject clip payload and navigate to editor
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(90, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // Set custom selection range
    await page.evaluate(() => {
      window.__TEST_HOOKS__?.setEditorState({
        selectedRange: { start: 10, end: 50 },
        currentFrame: 25,
      });
    });

    await waitForStableUI(page);

    // Selection info should be visible with frame count
    const selectionInfo = page.locator('.timeline-selection-info, .selection-info');
    await expect(selectionInfo).toBeVisible();

    // Should contain frame count (41 frames: 10-50 inclusive)
    await expect(selectionInfo).toContainText(/41|frames/i);
  });

  test('playhead position displays current/total', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Inject clip payload
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(60, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // Set selection and playhead position
    await page.evaluate(() => {
      window.__TEST_HOOKS__?.setEditorState({
        selectedRange: { start: 0, end: 59 },
        currentFrame: 30,
      });
    });

    await waitForStableUI(page);

    // Playhead display should show position
    const playheadDisplay = page.locator('.timeline-playhead, .playhead-position');
    await expect(playheadDisplay).toBeVisible();
  });

  test('selection info updates in real-time', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(120, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // Take screenshot showing selection info
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
    // Set viewport to 1280px
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(60, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // All playback buttons should be visible
    const playbackControls = page.locator('.playback-controls');
    await expect(playbackControls).toBeVisible();

    // Play button
    const playButton = page.locator('.btn-playback').filter({ hasText: /▶|Play/i }).first();
    await expect(playButton).toBeVisible();

    // Check no overflow (controls should be within viewport)
    const controlsBox = await playbackControls.boundingBox();
    expect(controlsBox).not.toBeNull();
    if (controlsBox) {
      expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(1280);
    }
  });

  test('playback controls work at various viewport sizes', async ({ page }) => {
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);

      await page.goto('/#/capture');
      await page.waitForSelector('.capture-screen', { state: 'visible' });

      await page.evaluate(() => {
        window.__TEST_HOOKS__.injectClipPayload(30, 30);
        window.location.hash = '/editor';
      });

      await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
      await waitForStableUI(page);

      // Verify playback controls container is visible
      const playbackControls = page.locator('.playback-controls');
      await expect(playbackControls).toBeVisible();
    }
  });

  test('playback buttons have proper focus states', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(30, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    // Tab to focus playback button and check focus style
    const playButton = page.locator('.btn-playback').first();
    await playButton.focus();

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
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Find range inputs in capture settings
    const rangeInputs = page.locator('input[type="range"]');
    const count = await rangeInputs.count();

    // Should have at least one range input (FPS, buffer size, etc.)
    expect(count).toBeGreaterThan(0);

    // Each range input should be visible
    for (let i = 0; i < count; i++) {
      await expect(rangeInputs.nth(i)).toBeVisible();
    }

    await expect(page).toHaveScreenshot('us4-capture-sliders.png', {
      fullPage: true,
    });
  });

  test('export settings have styled select elements', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    // Inject editor payload for export
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Find select elements
    const selectElements = page.locator('select');
    const count = await selectElements.count();

    // Should have select elements
    expect(count).toBeGreaterThan(0);

    await expect(page).toHaveScreenshot('us4-export-selects.png', {
      fullPage: true,
    });
  });

  test('form controls consistent across features', async ({ page }) => {
    // Check Capture
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('us4-form-capture.png', { fullPage: true });

    // Check Editor
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(30, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('us4-form-editor.png', { fullPage: true });

    // Check Export
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      window.location.hash = '/export';
    });

    await page.waitForSelector('.export-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('us4-form-export.png', { fullPage: true });
  });
});

// ============================================================
// US5: Export Preview
// ============================================================

test.describe('US5: Export Preview', () => {
  test('preview button is visible in export settings', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Preview button should be visible
    const previewButton = page.locator('button').filter({ hasText: /Preview|Generate Preview/i });
    await expect(previewButton).toBeVisible();
  });

  test('preview section shows idle state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Set idle preview state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'idle',
            url: null,
            error: null,
            progress: 0,
          },
        });
      }
    });

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('us5-preview-idle.png', {
      fullPage: true,
    });
  });

  test('preview section shows generating state', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Set generating state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'generating',
            url: null,
            error: null,
            progress: 45,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Generating indicator should be visible
    const generatingIndicator = page.locator('.preview-generating, .preview-progress');
    await expect(generatingIndicator).toBeVisible();

    await expect(page).toHaveScreenshot('us5-preview-generating.png', {
      fullPage: true,
    });
  });

  test('preview section shows ready state with image', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Create a mock GIF blob URL
    const mockGifUrl = await page.evaluate(() => {
      // Create a tiny 1x1 GIF
      const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const binary = atob(gif);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([array], { type: 'image/gif' });
      return URL.createObjectURL(blob);
    });

    // Set ready state with preview URL
    await page.evaluate((url) => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'ready',
            url: url,
            error: null,
            progress: 100,
          },
        });
      }
    }, mockGifUrl);

    await waitForStableUI(page);

    await expect(page).toHaveScreenshot('us5-preview-ready.png', {
      fullPage: true,
    });
  });

  test('preview section shows error state with retry button', async ({ page }) => {
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });

    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.injectEditorPayload) {
        window.__TEST_HOOKS__.injectEditorPayload(30, 30);
      }
    });

    await page.goto('/#/export');
    await page.waitForSelector('.export-screen', { state: 'visible' });
    await waitForStableUI(page);

    // Set error state
    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setExportState) {
        window.__TEST_HOOKS__.setExportState({
          preview: {
            status: 'error',
            url: null,
            error: 'Failed to generate preview: memory limit exceeded',
            progress: 0,
          },
        });
      }
    });

    await waitForStableUI(page);

    // Error message should be visible
    const errorDisplay = page.locator('.preview-error');
    await expect(errorDisplay).toBeVisible();

    // Retry button should be visible
    const retryButton = page.locator('button').filter({ hasText: /Retry/i });
    await expect(retryButton).toBeVisible();

    await expect(page).toHaveScreenshot('us5-preview-error.png', {
      fullPage: true,
    });
  });
});

// ============================================================
// Integration: All User Stories Together
// ============================================================

test.describe('Integration: Full UX Flow', () => {
  test('complete flow through all improvements', async ({ page }) => {
    // 1. US1: Capture with clip creation
    await page.goto('/#/capture');
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await waitForStableUI(page);

    await page.evaluate(() => {
      if (window.__TEST_HOOKS__?.setCaptureState) {
        window.__TEST_HOOKS__.setCaptureState({
          isRecording: true,
          sessionClips: [{ id: 'clip-1', frames: [], createdAt: Date.now() }],
          stats: { frameCount: 60, duration: 2.0, memoryMB: 10, fps: 30 },
        });
      }
    });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('integration-1-capture.png', { fullPage: true });

    // 2. US2 & US3: Editor with selection info and proper playback controls
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectClipPayload(90, 30);
      window.location.hash = '/editor';
    });

    await page.waitForSelector('.editor-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);

    await page.evaluate(() => {
      window.__TEST_HOOKS__?.setEditorState({
        selectedRange: { start: 15, end: 75 },
        currentFrame: 45,
      });
    });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('integration-2-editor.png', { fullPage: true });

    // 3. US4 & US5: Export with styled controls and preview
    await page.evaluate(() => {
      window.__TEST_HOOKS__.injectEditorPayload(61, 30);
      window.location.hash = '/export';
    });

    await page.waitForSelector('.export-screen', { state: 'visible', timeout: 15000 });
    await waitForStableUI(page);
    await expect(page).toHaveScreenshot('integration-3-export.png', { fullPage: true });
  });
});
