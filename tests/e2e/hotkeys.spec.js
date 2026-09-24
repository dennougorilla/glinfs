import { expect, test } from '@playwright/test';
import { gotoCapture, gotoEditorWithClip, pauseEditorPlayback } from './helpers/app.js';

/**
 * E2E for #102: every app shortcut now routes through one document-level
 * dispatcher (modal > overlay > route > global). Walks the real key flows
 * end to end so a precedence regression shows up as a user-visible failure:
 * Shift+C (global), popover Escape vs. crop (overlay over route), 1-9 /
 * Shift+digit (route), Space play/pause (route), and F + Escape on the
 * frame grid (modal scope, which shuts out the overlay and route scopes).
 *
 * Drives the #91 mock stream: capture -> Create Clip -> editor. The
 * timeline / IME cases use an injected 30-frame clip instead.
 */

/** @param {import('@playwright/test').Page} page */
async function drawCrop(page) {
  const box = await page.locator('.editor-canvas-overlay').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
  await page.mouse.up();
}

/** @param {import('@playwright/test').Page} page */
async function blurToBody(page) {
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
}

const ENTRIES = '.editor-screen [data-testid="clip-entry"]';

/** @param {import('@playwright/test').Page} page */
const editorState = (page) => page.evaluate(() => window.__TEST_HOOKS__.getEditorState());

/** @param {import('@playwright/test').Page} page */
const setCurrentFrame = (page, /** @type {number} */ currentFrame) =>
  page.evaluate(
    (frame) => window.__TEST_HOOKS__.setEditorState({ currentFrame: frame }),
    currentFrame,
  );

/**
 * Dispatch a synthetic keydown (for flags real key presses can't carry,
 * e.g. isComposing) and report whether anything claimed it.
 * @param {import('@playwright/test').Page} page
 * @param {KeyboardEventInit} init
 * @param {string} [selector] - Target; defaults to the focused element
 */
function dispatchKey(page, init, selector) {
  return page.evaluate(
    ({ init, selector }) => {
      const target = selector ? document.querySelector(selector) : document.activeElement;
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      /** @type {Element} */ (target ?? document.body).dispatchEvent(e);
      return e.defaultPrevented;
    },
    { init, selector },
  );
}

test.describe('App hotkeys through the shared dispatcher (#102)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoCapture(page);
    await page.evaluate(() => {
      window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
    });

    // Scene detection off => Create Clip navigates straight to /editor
    const sceneToggle = page.locator('[data-setting="sceneDetection"]');
    if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') {
      await sceneToggle.click();
      await expect(sceneToggle).toHaveAttribute('aria-pressed', 'false');
    }

    await page.locator('.btn-capture-start').click();
    await expect(page.locator('.video-preview--active')).toBeVisible();
    await expect
      .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
        timeout: 10000,
      })
      .toBeGreaterThanOrEqual(10);

    await page.locator('.btn-create-clip').click();
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await blurToBody(page);
  });

  test('Shift+C queues a clip from the editor (global scope)', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');

    // Modifier combos are not ours: Ctrl+Shift+C leaves the queue alone
    await page.keyboard.press('Control+Shift+C');
    await page.waitForTimeout(200);
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');
  });

  test('Space toggles playback; Cmd/Ctrl+Space does not', async ({ page }) => {
    // The editor may autoplay on mount; assert relative to whatever it shows
    const playBtn = page.locator('.btn-play');
    const initial = await playBtn.getAttribute('aria-label');
    const toggled = initial === 'Play' ? 'Pause' : 'Play';

    await page.keyboard.press('Space');
    await expect(playBtn).toHaveAttribute('aria-label', toggled);
    await page.keyboard.press('Space');
    await expect(playBtn).toHaveAttribute('aria-label', /** @type {string} */ (initial));

    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(100);
    await expect(playBtn).toHaveAttribute('aria-label', /** @type {string} */ (initial));
  });

  test('F opens the frame grid, which owns Space and Escape until it closes', async ({ page }) => {
    await drawCrop(page);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();
    const playBtn = page.locator('.btn-play');

    await page.keyboard.press('f');
    const modal = page.locator('.frame-grid-backdrop');
    await expect(modal).toBeVisible();

    // Space selects a grid frame instead of toggling editor playback
    const playLabel = /** @type {string} */ (await playBtn.getAttribute('aria-label'));
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await expect(playBtn).toHaveAttribute('aria-label', playLabel);

    // Escape closes the grid only; the crop survives
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    // With the grid gone the editor owns Escape again
    await blurToBody(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });

  test('popover Escape wins over the editor crop Escape', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');
    await drawCrop(page);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    await page.locator('#clip-queue-badge').click();
    await expect(page.locator('.clip-queue-popover')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.clip-queue-popover')).toHaveCount(0);
    await expect(page.locator('#clip-queue-badge')).toBeFocused();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });

  test('1-9 switch clips by position and Shift+digit deletes', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');

    // Newest first: the queued Shift+C clip is #1, the active clip #2
    const entries = page.locator(ENTRIES);
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(1)).toHaveAttribute('data-clip-active', 'true');
    const queuedId = await entries.nth(0).getAttribute('data-clip-id');

    // A position with no clip is inert
    await page.keyboard.press('9');
    await expect(entries.nth(1)).toHaveAttribute('data-clip-active', 'true');

    // Cmd/Ctrl+digit stays with the browser (tab switching)
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(200);
    await expect(entries.nth(1)).toHaveAttribute('data-clip-active', 'true');

    await blurToBody(page);
    await page.keyboard.press('1');
    await expect(entries.nth(0)).toHaveAttribute('data-clip-active', 'true', { timeout: 10000 });
    await expect(entries.nth(0)).toHaveAttribute('data-clip-id', queuedId ?? '');

    // Shift+2 deletes the (now queued) original clip at position 2
    await blurToBody(page);
    await page.keyboard.press('Shift+Digit2');
    await expect(entries).toHaveCount(1);
    await expect(entries.nth(0)).toHaveAttribute('data-clip-active', 'true');
  });

  test('live monitor viewport owns Space/Enter but not modifier or IME combos', async ({
    page,
  }) => {
    await pauseEditorPlayback(page);
    const viewport = page.locator('.live-monitor-viewport');
    const overlay = page.locator('[data-testid="live-view-overlay"]');
    await viewport.focus();

    for (const init of [
      { key: ' ', ctrlKey: true },
      { key: 'Enter', altKey: true },
      { key: ' ', isComposing: true },
    ]) {
      expect(await dispatchKey(page, init)).toBe(false);
    }
    await expect(overlay).toHaveCount(0);

    // Space opens the live view without also toggling editor playback
    await page.keyboard.press('Space');
    await expect(overlay).toBeVisible();
    await expect(page.locator('.btn-play')).toHaveAttribute('aria-label', 'Play');
    await page.keyboard.press('Enter');
    await expect(overlay).toBeHidden();
  });

  test('Escape peels live view + frame grid one layer at a time (#127)', async ({ page }) => {
    await pauseEditorPlayback(page);
    await drawCrop(page);
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    const overlay = page.locator('[data-testid="live-view-overlay"]');
    await page.locator('.live-monitor-viewport').click();
    await expect(overlay).toBeVisible();

    await page.keyboard.press('f');
    const modal = page.locator('.frame-grid-backdrop');
    await expect(modal).toBeVisible();

    // First Escape: the grid only
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(overlay).toBeVisible();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    // Second Escape: the live view only; the crop survives
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.locator('.btn-clear-crop')).toBeVisible();

    // Third Escape: back to the editor's crop Escape
    await blurToBody(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.btn-clear-crop')).toHaveCount(0);
  });

  test('popover opened over live view closes first on Escape (#127)', async ({ page }) => {
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+C');
    await expect(page.locator('#clip-queue-badge')).toHaveText('1');

    const overlay = page.locator('[data-testid="live-view-overlay"]');
    await page.locator('.live-monitor-viewport').click();
    await expect(overlay).toBeVisible();

    await page.locator('#clip-queue-badge').click();
    const popover = page.locator('.clip-queue-popover');
    await expect(popover).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(page.locator('#clip-queue-badge')).toBeFocused();
    await expect(overlay).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });
});

test.describe('Timeline keys and IME guard (#102 review)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30 });
    await pauseEditorPlayback(page);
  });

  test('focused timeline at full range: Arrow/Home/End seek exactly once', async ({ page }) => {
    await setCurrentFrame(page, 10);
    await page.locator('.tl').focus();

    for (const [key, frame] of /** @type {const} */ ([
      ['ArrowRight', 11],
      ['ArrowLeft', 10],
      ['Home', 0],
      ['End', 29],
    ])) {
      await page.keyboard.press(key);
      const state = await editorState(page);
      expect(state.currentFrame, key).toBe(frame);
      expect(state.selectedRange, key).toEqual({ start: 0, end: 29 });
    }
  });

  test('unfocused editor: Arrow/Home/End still seek', async ({ page }) => {
    await blurToBody(page);
    await setCurrentFrame(page, 10);

    for (const [key, frame] of /** @type {const} */ ([
      ['ArrowRight', 11],
      ['ArrowRight', 12],
      ['ArrowLeft', 11],
      ['Home', 0],
      ['End', 29],
    ])) {
      await page.keyboard.press(key);
      expect((await editorState(page)).currentFrame, key).toBe(frame);
    }
  });

  test('focused timeline with a partial range moves the range once, never also seeking', async ({
    page,
  }) => {
    // A real drag, so the timeline's own range state matches the editor's
    const box = await page.locator('.tl-track').boundingBox();
    expect(box).not.toBeNull();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
    await page.mouse.up();
    const { start, end } = (await editorState(page)).selectedRange;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeLessThan(29);

    await setCurrentFrame(page, start + 2);
    await page.locator('.tl').focus();
    await page.keyboard.press('ArrowRight');
    let state = await editorState(page);
    expect(state.selectedRange).toEqual({ start: start + 1, end: end + 1 });
    expect(state.currentFrame).toBe(start + 2);

    // Playhead on the IN point: the range reducer carries it to the new IN
    // point, and the route seek must not add a second step on top
    await setCurrentFrame(page, start + 1);
    await page.keyboard.press('ArrowRight');
    state = await editorState(page);
    expect(state.selectedRange).toEqual({ start: start + 2, end: end + 2 });
    expect(state.currentFrame).toBe(start + 2);

    // Alt+Arrow is the browser's (history navigation), not a range shift
    expect(await dispatchKey(page, { key: 'ArrowLeft', altKey: true })).toBe(false);
    expect((await editorState(page)).selectedRange).toEqual({ start: start + 2, end: end + 2 });
  });

  for (const [label, init] of /** @type {const} */ ([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])) {
    test(`IME Escape (${label}) keeps the crop`, async ({ page }) => {
      await page.evaluate(() =>
        window.__TEST_HOOKS__.setEditorState({
          cropArea: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' },
        }),
      );
      await blurToBody(page);

      expect(await dispatchKey(page, { key: 'Escape', ...init })).toBe(false);
      expect((await editorState(page)).cropArea).not.toBeNull();

      // The same key outside composition still clears it
      expect(await dispatchKey(page, { key: 'Escape' })).toBe(true);
      expect((await editorState(page)).cropArea).toBeNull();
    });
  }
});

test.describe('Frame grid keys on the dispatcher (#102)', () => {
  const GRID = '.frame-grid-backdrop';

  test.beforeEach(async ({ page }) => {
    await gotoEditorWithClip(page, { frameCount: 30 });
    await pauseEditorPlayback(page);
    await page.evaluate(() =>
      window.__TEST_HOOKS__.setEditorState({
        cropArea: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' },
      }),
    );
    await blurToBody(page);
    await page.keyboard.press('f');
    await expect(page.locator(GRID)).toBeVisible();
    await expect(page.locator('.frame-grid-item').first()).toBeFocused();
  });

  for (const [label, init] of /** @type {const} */ ([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])) {
    test(`IME Escape (${label}) keeps the grid open`, async ({ page }) => {
      expect(await dispatchKey(page, { key: 'Escape', ...init })).toBe(false);
      await expect(page.locator(GRID)).toBeVisible();

      // Outside composition Escape closes the grid, and only the grid
      await page.keyboard.press('Escape');
      await expect(page.locator(GRID)).toHaveCount(0);
      expect((await editorState(page)).cropArea).not.toBeNull();
    });
  }

  test('Cmd/Ctrl+F and other browser combos pass through the grid', async ({ page }) => {
    const first = page.locator('.frame-grid-item').first();

    for (const init of [
      { key: 'f', metaKey: true },
      { key: 'f', ctrlKey: true },
      { key: 'ArrowRight', metaKey: true },
      { key: 'Escape', ctrlKey: true },
    ]) {
      expect(await dispatchKey(page, init), JSON.stringify(init)).toBe(false);
    }
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator(GRID)).toBeVisible();
    await expect(first).toBeFocused();

    // The plain keys are still the grid's
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.frame-grid-item').nth(1)).toBeFocused();
  });

  test('editor shortcuts the grid does not own stay off the page below', async ({ page }) => {
    await setCurrentFrame(page, 10);

    for (const key of ['Delete', 'Backspace', 'g', 'Home', '1']) {
      await page.keyboard.press(key);
    }

    await expect(page.locator(GRID)).toBeVisible();
    await expect(page.locator('.editor-canvas')).toBeVisible();
    expect((await editorState(page)).currentFrame).toBe(10);
  });

  test('leaving the route with the grid open leaves no grid keys behind', async ({ page }) => {
    await page.evaluate(() => {
      location.hash = '#/capture';
    });
    await page.waitForSelector('.capture-screen', { state: 'visible' });
    await expect(page.locator(GRID)).toHaveCount(0);

    await page.evaluate(() => {
      location.hash = '#/editor';
    });
    await page.waitForSelector('.editor-canvas', { state: 'visible' });
    await pauseEditorPlayback(page);
    await blurToBody(page);
    await page.evaluate(() =>
      window.__TEST_HOOKS__.setEditorState({
        currentFrame: 10,
        cropArea: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' },
      }),
    );

    // A stale modal registration would shut these route keys out
    await page.keyboard.press('ArrowRight');
    expect((await editorState(page)).currentFrame).toBe(11);
    await page.keyboard.press('Escape');
    expect((await editorState(page)).cropArea).toBeNull();
  });
});
