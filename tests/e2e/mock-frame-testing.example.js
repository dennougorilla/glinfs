/**
 * E2E Testing Examples with Mock Frame Injection
 *
 * This file demonstrates how to test Editor and Export features
 * without going through Screen Capture API.
 *
 * The problem:
 * - Screen Capture API requires user interaction (browser permission dialog)
 * - AI agents and E2E tools cannot interact with this dialog
 * - This blocks testing of Editor and Export features
 *
 * The solution:
 * - Use mock frames that are compatible with VideoFrame API
 * - Inject them via __TEST_HOOKS__ before navigating
 * - Test Editor and Export features directly
 *
 * Requirements:
 * - Playwright or similar E2E testing framework
 * - Test mode enabled (automatic in dev mode, or via ?testMode=true)
 */

// ============================================================================
// Playwright Examples
// ============================================================================

/**
 * Example: Test Editor with mock frames
 */
async function testEditorWithMockFrames(page) {
  // Method 1: Inject data then navigate
  await page.goto('http://localhost:5173/');

  await page.evaluate(async () => {
    // Wait for test hooks to be available
    await window.__TEST_HOOKS__.injectMockClipPayload({
      frameCount: 30,
      fps: 30,
      width: 640,
      height: 480,
      pattern: 'numbered', // Shows frame numbers for easy debugging
    });
  });

  // Navigate to editor
  await page.evaluate(() => {
    location.hash = '#/editor';
  });

  // Wait for editor to load
  await page.waitForSelector('.editor-screen');

  // Now you can interact with the editor
  await page.click('.btn-play'); // Play button
  await page.waitForTimeout(1000);
  await page.click('.btn-play'); // Pause

  // Check timeline
  const timeline = await page.$('.editor-timeline-container');
  console.log('Timeline found:', !!timeline);
}

/**
 * Example: Test Export with mock frames
 */
async function testExportWithMockFrames(page) {
  await page.goto('http://localhost:5173/');

  await page.evaluate(async () => {
    await window.__TEST_HOOKS__.injectMockEditorPayload({
      frameCount: 30,
      fps: 30,
      selectedRange: { start: 5, end: 20 },
      cropArea: {
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        aspectRatio: 'free',
      },
    });
  });

  // Navigate to export
  await page.evaluate(() => {
    location.hash = '#/export';
  });

  // Wait for export screen
  await page.waitForSelector('.export-screen');

  // Start export
  await page.click('.btn-export');

  // Wait for encoding to complete
  await page.waitForSelector('.export-complete', { timeout: 30000 });

  // Download the result
  const downloadButton = await page.$('.btn-download');
  console.log('Download button available:', !!downloadButton);
}

/**
 * Example: Use navigateWithMockData helper
 */
async function testWithNavigationHelper(page) {
  await page.goto('http://localhost:5173/');

  await page.evaluate(async () => {
    await window.__TEST_HOOKS__.navigateWithMockData('editor', {
      frameCount: 60,
      fps: 60,
      pattern: 'gradient',
    });
  });

  await page.waitForSelector('.editor-screen');
}

/**
 * Example: URL-based test mode
 * No JavaScript evaluation needed - just use URL parameters
 */
async function testWithUrlParameters(page) {
  // This requires auto-injection on route change (advanced setup)
  // For now, the primary method is via __TEST_HOOKS__

  // Navigate with test mode enabled
  await page.goto('http://localhost:5173/?testMode=true');

  // Verify test mode is active
  const isTestMode = await page.evaluate(() => {
    return window.__TEST_HOOKS__?.isTestMode();
  });
  console.log('Test mode:', isTestMode);
}

/**
 * Example: Create custom mock frames for specific test scenarios
 */
async function testCustomMockFrames(page) {
  await page.goto('http://localhost:5173/');

  await page.evaluate(async () => {
    // Create frames manually for custom scenarios
    const frames = await window.__TEST_HOOKS__.createMockFrames(100, {
      width: 1920,
      height: 1080,
      pattern: 'checkerboard',
      fps: 60,
    });

    // Set clip payload manually
    window.__TEST_HOOKS__.setClipPayload({
      frames,
      fps: 60,
      capturedAt: Date.now(),
      sceneDetectionEnabled: true,
    });
  });

  await page.evaluate(() => {
    location.hash = '#/editor';
  });

  await page.waitForSelector('.editor-screen');
}

// ============================================================================
// Jest/Vitest Integration (if using JSDOM)
// ============================================================================

/**
 * Note: For unit testing with JSDOM, VideoFrame is not available.
 * Use the mock utilities in tests/unit/ instead.
 * See: tests/unit/shared/utils/mock-frame.test.js
 */

// ============================================================================
// Cypress Examples
// ============================================================================

/*
// In a Cypress test file:

describe('Editor Feature', () => {
  it('should load with mock frames', () => {
    cy.visit('/');

    cy.window().then(async (win) => {
      await win.__TEST_HOOKS__.injectMockClipPayload({
        frameCount: 30,
        fps: 30,
      });
    });

    cy.window().then((win) => {
      win.location.hash = '#/editor';
    });

    cy.get('.editor-screen').should('exist');
    cy.get('.timeline-thumbnail').should('have.length.at.least', 10);
  });
});

describe('Export Feature', () => {
  it('should export GIF successfully', () => {
    cy.visit('/');

    cy.window().then(async (win) => {
      await win.__TEST_HOOKS__.injectMockEditorPayload({
        frameCount: 20,
        fps: 30,
      });
    });

    cy.window().then((win) => {
      win.location.hash = '#/export';
    });

    cy.get('.btn-export').click();
    cy.get('.export-complete', { timeout: 30000 }).should('exist');
  });
});
*/

// Export for module usage (if needed)
export {
  testEditorWithMockFrames,
  testExportWithMockFrames,
  testWithNavigationHelper,
  testWithUrlParameters,
  testCustomMockFrames,
};
