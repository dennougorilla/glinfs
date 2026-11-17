/**
 * E2E: a clip whose open stalls (the decoder never hands out a frame) ends
 * in a visible "Couldn't open" on its row instead of "Opening..." forever,
 * and the codec queue keeps working for other clips.
 *
 * The real codec worker runs with VideoDecoder replaced by one that accepts
 * input and never emits output or finishes its flush.
 * @module tests/e2e/clip-open-stall.spec
 */

import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

const QUEUE_ENTRIES = '[data-testid="clip-entry"]:not([data-clip-active])';

const SHIM = `
self.VideoDecoder = class extends EventTarget {
  constructor() { super(); }
  configure() {}
  decode() {}
  flush() { return new Promise(() => {}); }
  close() {}
  get state() { return 'configured'; }
  static isConfigSupported() { return Promise.resolve({ supported: true }); }
};
`;

/**
 * Run the app with `shim` prepended to the clip codec worker, make a clip
 * and queue it compressed
 * @param {import('@playwright/test').Page} page
 * @param {string} shim
 * @returns {Promise<import('@playwright/test').Locator>} The queued entry
 */
async function queueClipWithShim(page, shim) {
  await page.route(/clip-codec-worker/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: shim + body });
  });
  // Collect the worker's replies and the shim's reports
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    window.__codecReplies = [];
    window.__shimStats = null;
    window.Worker = class extends RealWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (e) => {
          const type = e.data?.type;
          if (type === 'TEST_STATS') window.__shimStats = e.data.stats;
          else if (type === 'DECODE_RESULT' || type === 'JOB_ERROR') {
            window.__codecReplies.push(type);
          }
        });
      }
    };
  });

  await gotoCapture(page);
  await page.evaluate(() => {
    window.__TEST_HOOKS__.updateTestConfig({ mockStream: true });
  });
  test.skip(
    !(await page.evaluate(() => window.__TEST_HOOKS__.clipCodec.probeSupport())),
    'WebCodecs encode is not available in this browser',
  );
  const sceneToggle = page.locator('[data-setting="sceneDetection"]');
  if ((await sceneToggle.getAttribute('aria-pressed')) === 'true') await sceneToggle.click();

  await page.locator('.btn-capture-start').click();
  await expect(page.locator('.video-preview--active')).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('.stat-value').first().textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThanOrEqual(20);
  await page.locator('.btn-create-clip').click();
  await page.waitForSelector('.editor-canvas', { state: 'visible' });

  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+C');
  const entry = page.locator(QUEUE_ENTRIES).first();
  await expect(entry).toHaveAttribute('data-clip-status', 'compressed', { timeout: 30000 });
  return entry;
}

test('a stalled open shows "Couldn\'t open" on the row and the queue keeps working', async ({
  page,
}) => {
  test.setTimeout(120000);
  const entry = await queueClipWithShim(page, SHIM);

  // Open it: the decode never finishes
  const openedAt = Date.now();
  await entry.locator('.clip-entry-main').click();
  await expect(entry).toHaveAttribute('data-clip-status', 'decoding');
  await expect(entry.locator('.clip-entry-status')).toHaveText('Opening…');

  // The watchdog (15 s of silence) ends it, visibly on the row
  await expect(entry).toHaveAttribute('data-clip-open-failed', 'true', { timeout: 30000 });
  // ...after the bound, not through an early error
  expect(Date.now() - openedAt).toBeGreaterThanOrEqual(14000);
  await expect(entry).toHaveAttribute('data-clip-status', 'compressed');
  await expect(entry.locator('.clip-entry-status')).toHaveText("Couldn't open");
  await page.screenshot({ path: test.info().outputPath('clip-open-failed.png') });
  await entry.screenshot({ path: test.info().outputPath('clip-open-failed-row.png') });

  // The codec queue was not left blocked: the next clip compresses
  await page.keyboard.press('Shift+C');
  await expect(page.locator(QUEUE_ENTRIES)).toHaveCount(2);
  await expect(page.locator(QUEUE_ENTRIES).first()).toHaveAttribute(
    'data-clip-status',
    'compressed',
    { timeout: 30000 },
  );
});

/**
 * The real decoder, but copying the 6th decoded frame out fails (as a GPU
 * readback can) while the decoder goes on emitting frames. The shim counts
 * the decoder's frames and the worker's own frames still open.
 */
const COPY_FAILS_SHIM = `
(() => {
  const RealDecoder = self.VideoDecoder;
  const RealFrame = self.VideoFrame;
  const stats = { decoderOpen: 0, ownedOpen: 0, outputs: 0 };
  setInterval(() => self.postMessage({ type: 'TEST_STATS', stats: { ...stats } }), 50);
  self.VideoFrame = class extends RealFrame {
    constructor(...args) {
      super(...args);
      stats.ownedOpen += 1;
      this.__open = true;
    }
    close() {
      if (this.__open) {
        this.__open = false;
        stats.ownedOpen -= 1;
      }
      super.close();
    }
  };
  self.VideoDecoder = class extends EventTarget {
    constructor(init) {
      super();
      this.real = new RealDecoder({
        output: (frame) => {
          stats.outputs += 1;
          stats.decoderOpen += 1;
          const close = frame.close.bind(frame);
          let open = true;
          frame.close = () => {
            if (open) {
              open = false;
              stats.decoderOpen -= 1;
            }
            close();
          };
          if (stats.outputs === 6) {
            frame.copyTo = () => Promise.reject(new Error('readback failed (test)'));
          }
          init.output(frame);
        },
        error: init.error,
      });
    }
    configure(c) { return this.real.configure(c); }
    decode(c) { return this.real.decode(c); }
    flush() { return this.real.flush(); }
    reset() { return this.real.reset(); }
    close() { return this.real.close(); }
    get state() { return this.real.state; }
    get decodeQueueSize() { return this.real.decodeQueueSize; }
    static isConfigSupported(c) { return RealDecoder.isConfigSupported(c); }
  };
})();
`;

test('a frame copy that fails ends the open: nothing left open, one reply, the row says so', async ({
  page,
}) => {
  test.setTimeout(120000);
  const entry = await queueClipWithShim(page, COPY_FAILS_SHIM);

  await entry.locator('.clip-entry-main').click();
  await expect(entry).toHaveAttribute('data-clip-open-failed', 'true', { timeout: 30000 });
  await expect(entry).toHaveAttribute('data-clip-status', 'compressed');
  await expect(entry.locator('.clip-entry-status')).toHaveText("Couldn't open");

  // Give any frame the decoder still emits time to arrive, then count
  await page.waitForTimeout(1500);
  const stats = await page.evaluate(() => window.__shimStats);
  expect(stats.outputs).toBeGreaterThanOrEqual(6);
  expect(stats).toMatchObject({ decoderOpen: 0, ownedOpen: 0 });
  expect(await page.evaluate(() => window.__codecReplies)).toEqual(['JOB_ERROR']);
});
