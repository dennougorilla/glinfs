import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

/**
 * E2E for #95: Clip Now from the editor with the bounded clip queue.
 *
 * Drives the WHOLE live pipeline via the #91 mock-stream hook
 * (canvas.captureStream stands in for getDisplayMedia): start fake capture,
 * Create Clip, then on the editor press Shift+C twice and assert two queue
 * entries appear while the editor canvas keeps rendering — i.e. enqueueing
 * never touched the active clip's frames (no closed-frame errors).
 *
 * Extended for #92 (compressed queue): the queued entries background-encode
 * through the WebCodecs worker (Chromium's software VP8/VP9 works headless).
 * The test waits for both entries to reach a terminal state — 'compressed',
 * or 'raw' when isConfigSupported is false in the environment, in which case
 * the raw fallback path must satisfy the very same flow — then promotes
 * through a full A -> B -> A round-trip and asserts the editor canvas
 * renders decoded frames and the saved selection survives.
 */

/** Queue entries only (the active clip renders with data-clip-active) */
const QUEUE_ENTRIES = '[data-testid="clip-entry"]:not([data-clip-active])';

test('Shift+C from the editor queues clips without disturbing the open editor', async ({
  page,
}) => {
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await gotoCapture(page);

  // Route the capture pipeline through the mock canvas stream (#91) so no
  // real screen-share permission prompt is involved
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
  });

  // Scene detection off => Create Clip navigates straight to /editor
  // (no loading-screen detour, which is out of scope here)
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') {
    await sceneToggle.click();
    await expect(sceneToggle).toHaveAttribute('aria-pressed', 'false');
  }

  // Start the fake capture and let the ring buffer accumulate frames.
  // At least 10 so the clip created below has room for a non-default
  // selection range (the #92 round-trip asserts it survives).
  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThanOrEqual(10);

  // The header Clip Now button appears with a live capture session
  await expect(page.locator('#clip-now-btn')).toBeVisible();

  // Create Clip -> editor opens on the new active clip
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  // Background capture (default on) keeps the buffer refilling while we
  // edit; give it a moment so each Shift+C snapshot has frames to take
  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(1);

  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(2);

  // Active clip entry still listed first and highlighted
  const allEntries = page.locator('[data-testid="clip-entry"]');
  await expect(allEntries).toHaveCount(3);
  // Stable ordering (#100): rows sort by capture time (newest first), so
  // the active clip is highlighted IN PLACE rather than hoisted to the top
  await expect(page.locator('[data-testid="clip-entry"][data-clip-active="true"]')).toHaveCount(1);

  // Header badge reflects the queue size
  await expect(page.locator('#clip-queue-badge')).toHaveText('2');

  // Badge popover: opens with the same entries, Escape closes it
  await page.locator('#clip-queue-badge').click();
  await expect(page.locator('.clip-queue-popover')).toBeVisible();
  await expect(page.locator('.clip-queue-popover [data-testid="clip-entry"]')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('.clip-queue-popover')).toHaveCount(0);

  // The open editor was not disturbed: canvas still renders (still attached
  // and sized — a closed active frame would have blanked or thrown) ...
  await expect(page.locator('.editor-canvas')).toBeVisible();
  const canvasHasPixels = async () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.editor-canvas');
      return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
    });
  expect(await canvasHasPixels()).toBe(true);

  // ────────────────────────────────────────────────────────────────────────
  // #92: compressed clip queue — wait for both entries to reach a terminal
  // state. 'compressed' on the WebCodecs path; 'raw' on the fallback path
  // (isConfigSupported false in this environment) which must pass the same
  // promote flow below either way.
  // ────────────────────────────────────────────────────────────────────────
  const queueStatuses = async () =>
    page.$$eval('[data-testid="clip-entry"]:not([data-clip-active])', (els) =>
      els.map((el) => el.getAttribute('data-clip-status')),
    );
  await expect
    .poll(
      async () => {
        const statuses = await queueStatuses();
        return statuses.length === 2 && statuses.every((s) => s === 'compressed' || s === 'raw');
      },
      { timeout: 20000 },
    )
    .toBe(true);

  const compressionAvailable = await page.evaluate(() =>
    window.__TEST_HOOKS__.isClipCompressionAvailable(),
  );
  console.log(
    `[clip-queue e2e] codec path: ${
      compressionAvailable ? 'compressed (WebCodecs)' : 'raw fallback'
    } — entry statuses: ${(await queueStatuses()).join(', ')}`,
  );

  // Give the ACTIVE clip a distinctive selection so the demote -> promote
  // round-trip below can prove editor state survives compression
  const originalActiveId = await page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.id);
  expect(originalActiveId).toBeTruthy();
  const frameCount = await page.evaluate(
    () => window.__TEST_HOOKS__.getEditorState()?.frameCount ?? 0,
  );
  expect(frameCount).toBeGreaterThanOrEqual(3);
  const savedRange = { start: 1, end: frameCount - 2 >= 1 ? frameCount - 2 : 1 };
  await page.evaluate((range) => {
    window.__TEST_HOOKS__.setEditorState({ selectedRange: range });
  }, savedRange);

  // Promote the newest queued entry (async when compressed: decoding state,
  // then the swap). The old active clip demotes carrying savedRange.
  const promotedId = await page.locator(QUEUE_ENTRIES).first().getAttribute('data-clip-id');
  await page.locator(`${QUEUE_ENTRIES}[data-clip-id="${promotedId}"] .clip-entry-main`).click();
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.id), {
      timeout: 20000,
    })
    .toBe(promotedId);

  // The editor re-inited on the promoted (decoded) clip and renders it
  await expect(page.locator('.editor-canvas')).toBeVisible();
  expect(await canvasHasPixels()).toBe(true);
  await expect(page.locator('[data-testid="clip-entry"]').first()).toHaveAttribute(
    'data-clip-active',
    'true',
  );

  // The demoted original clip re-compresses in the background; wait for its
  // terminal state, then promote it back (decode round-trip for the SAME
  // frames the selection belongs to)
  const originalEntry = page.locator(`${QUEUE_ENTRIES}[data-clip-id="${originalActiveId}"]`);
  await expect
    .poll(async () => originalEntry.getAttribute('data-clip-status'), { timeout: 20000 })
    .toMatch(/^(compressed|raw)$/);
  await originalEntry.locator('.clip-entry-main').click();
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.id), {
      timeout: 20000,
    })
    .toBe(originalActiveId);

  // Selection survived the demote -> compress -> decode -> promote loop
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getEditorState()?.selectedRange), {
      timeout: 5000,
    })
    .toEqual(savedRange);
  await expect(page.locator('.editor-canvas')).toBeVisible();
  expect(await canvasHasPixels()).toBe(true);

  // ... and no closed-frame errors surfaced anywhere across the whole flow
  expect(pageErrors).toEqual([]);
  const frameErrors = consoleErrors.filter((text) => /closed|VideoFrame|detached/i.test(text));
  expect(frameErrors).toEqual([]);
});

test('raw fallback: queue and promote still work when WebCodecs encode is unsupported', async ({
  page,
}) => {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // Force the #92 probe down the unsupported path BEFORE the app loads —
  // Chromium supports VP8 headless, so the fallback would otherwise never
  // run in CI
  await page.addInitScript(() => {
    if (globalThis.VideoEncoder) {
      globalThis.VideoEncoder.isConfigSupported = async () => ({ supported: false });
    }
  });

  await gotoCapture(page);
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
  });

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
    .toBeGreaterThan(0);

  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(1);

  // Entries never compress on this path — the terminal state is 'raw'
  expect(await page.evaluate(() => window.__TEST_HOOKS__.isClipCompressionAvailable())).toBe(false);
  const entry = page.locator(QUEUE_ENTRIES).first();
  await expect(entry).toHaveAttribute('data-clip-status', 'raw');

  // Promote works synchronously, exactly as pre-#92
  const promotedId = await entry.getAttribute('data-clip-id');
  await entry.locator('.clip-entry-main').click();
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HOOKS__.getClipPayload()?.id), {
      timeout: 10000,
    })
    .toBe(promotedId);
  await expect(page.locator('.editor-canvas')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('digit shortcuts switch and delete clips by their list position (#100 r7)', async ({
  page,
}) => {
  await gotoCapture(page);
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
  });
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') {
    await sceneToggle.click();
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

  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(1);
  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(2);

  // Every entry carries its position badge, 1..3 in visual order, and the
  // Clips tab shows the total
  await expect(page.locator('.clip-entry-num')).toHaveText(['1', '2', '3']);
  await expect(page.locator('[data-count="clips"]')).toHaveText('3');

  // Wait until queued entries reach a terminal state so promote-by-digit
  // is deterministic (decode path vs raw path both settle)
  await expect
    .poll(
      async () =>
        page.$$eval('[data-testid="clip-entry"]:not([data-clip-active])', (els) =>
          els.every((el) =>
            ['compressed', 'raw'].includes(el.getAttribute('data-clip-status') ?? ''),
          ),
        ),
      { timeout: 20000 },
    )
    .toBe(true);

  // Press the digit of a NON-active row -> that clip becomes active,
  // keeping its position (stable ordering means the badge stays put)
  const rowIds = await page.$$eval('[data-testid="clip-entry"]', (els) =>
    els.map((el) => ({
      id: el.getAttribute('data-clip-id'),
      active: el.hasAttribute('data-clip-active'),
    })),
  );
  const target = rowIds.find((r) => !r.active);
  const targetPos = rowIds.indexOf(target) + 1;
  await page.keyboard.press(String(targetPos));
  await expect(page.locator('[data-testid="clip-entry"][data-clip-active="true"]')).toHaveAttribute(
    'data-clip-id',
    String(target.id),
    { timeout: 15000 },
  );
  await expect(page.locator('.editor-canvas')).toBeVisible();

  // Shift+digit deletes a queued row (undo toast appears)
  const queuedBefore = await page.locator(QUEUE_ENTRIES).count();
  const rows2 = await page.$$eval('[data-testid="clip-entry"]', (els) =>
    els.map((el) => el.hasAttribute('data-clip-active')),
  );
  const queuedPos = rows2.indexOf(false) + 1;
  await page.keyboard.press(`Shift+Digit${queuedPos}`);
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(queuedBefore - 1);
  await expect(page.locator('.app-toast')).toBeVisible();
  await expect(page.locator('[data-count="clips"]')).toHaveText('2');

  // Delete key removes the ACTIVE clip; the survivor is promoted in place
  const activeBefore = await page
    .locator('[data-testid="clip-entry"][data-clip-active="true"]')
    .getAttribute('data-clip-id');
  await page.keyboard.press('Delete');
  await expect
    .poll(
      async () =>
        page
          .locator('[data-testid="clip-entry"][data-clip-active="true"]')
          .getAttribute('data-clip-id'),
      { timeout: 15000 },
    )
    .not.toBe(activeBefore);
  await expect(page.locator('[data-testid="clip-entry"]')).toHaveCount(1);
  await expect(page.locator('.editor-canvas')).toBeVisible();
});
