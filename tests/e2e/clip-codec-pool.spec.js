/**
 * E2E: the clip codec worker opens clips on a decoder with a small picture
 * pool. Hardware decoders (Chromium's D3D11 decoder on Windows: 14 pictures
 * on an RTX 3080 Ti) stop emitting frames until the app closes one; a decode
 * that held every frame until flush() never finished, so a queued clip
 * longer than the pool stayed "Opening..." forever.
 *
 * The real worker runs with VideoDecoder wrapped by a shim that hands out at
 * most POOL frames at once, as such a decoder does, and reports how many
 * the worker held.
 * @module tests/e2e/clip-codec-pool.spec
 */

import { expect, test } from '@playwright/test';
import { gotoCapture } from './helpers/app.js';

const POOL = 4;
const FRAMES = 300;

const SHIM = `
(() => {
  const Real = self.VideoDecoder;
  const POOL = ${POOL};
  let maxHeld = 0;
  self.VideoDecoder = class {
    constructor(init) {
      this.held = 0;
      this.buffered = [];
      this.flushWaiters = [];
      this.init = init;
      this.real = new Real({
        output: (frame) => { this.buffered.push(frame); this.pump(); },
        error: init.error,
      });
    }
    pump() {
      while (this.buffered.length && this.held < POOL) {
        const frame = this.buffered.shift();
        this.held += 1;
        maxHeld = Math.max(maxHeld, this.held);
        self.postMessage({ type: 'TEST_POOL', maxHeld });
        const close = frame.close.bind(frame);
        let closed = false;
        frame.close = () => {
          if (closed) return;
          closed = true;
          close();
          this.held -= 1;
          this.pump();
        };
        this.init.output(frame);
      }
      if (!this.buffered.length) for (const w of this.flushWaiters.splice(0)) w();
    }
    configure(c) { return this.real.configure(c); }
    decode(c) { return this.real.decode(c); }
    async flush() {
      await this.real.flush();
      if (this.buffered.length) await new Promise((r) => this.flushWaiters.push(r));
    }
    close() { return this.real.close(); }
    get state() { return this.real.state; }
    static isConfigSupported(c) { return Real.isConfigSupported(c); }
  };
})();
`;

test(`a ${FRAMES}-frame clip decodes on a decoder with a ${POOL}-picture pool`, async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route(/clip-codec-worker/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: SHIM + body });
  });
  // Record the shim's report from every worker the page starts
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    window.__poolMaxHeld = 0;
    window.Worker = class extends RealWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (e) => {
          if (e.data?.type === 'TEST_POOL') {
            window.__poolMaxHeld = Math.max(window.__poolMaxHeld, e.data.maxHeld);
          }
        });
      }
    };
  });

  await gotoCapture(page);
  await page.waitForFunction(() => Boolean(window.__TEST_HOOKS__?.clipCodec));
  const available = await page.evaluate(() => window.__TEST_HOOKS__.clipCodec.probeSupport());
  test.skip(!available, 'WebCodecs encode is not available in this browser');

  const result = await page.evaluate(
    async ({ count }) => {
      const codec = window.__TEST_HOOKS__.clipCodec;
      const [width, height] = [320, 180];
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const frames = [];
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = `hsl(${(i * 7) % 360} 60% 50%)`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#fff';
        ctx.fillRect((i * 3) % width, 40, 40, 40);
        frames.push(new VideoFrame(canvas, { timestamp: i * 33333 }));
      }
      const encoded = await codec.encode(frames, { fps: 30, width, height });
      if (!encoded.ok) return { error: `encode: ${encoded.error}` };
      const decoded = await Promise.race([
        codec.decode({ chunks: encoded.chunks, config: encoded.config }),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 60000)),
      ]);
      if (!decoded.ok) return { error: `decode: ${decoded.error}` };
      const n = decoded.frames.length;
      const ordered = decoded.frames.every(
        (f, i, all) => i === 0 || f.timestamp > all[i - 1].timestamp,
      );
      for (const f of decoded.frames) f.close();
      return { n, ordered, maxHeld: window.__poolMaxHeld };
    },
    { count: FRAMES },
  );

  expect(result).toEqual({ n: FRAMES, ordered: true, maxHeld: expect.any(Number) });
  // The shim never had to hand out more than its pool...
  expect(result.maxHeld).toBeGreaterThan(0);
  expect(result.maxHeld).toBeLessThanOrEqual(POOL);
});
