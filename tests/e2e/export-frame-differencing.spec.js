/**
 * E2E: frame differencing in gifenc. The browser's own GIF decoder
 * (ImageDecoder) must show every frame of a differenced GIF exactly as the
 * non-differenced GIF, on each kind of content and preset.
 * @module tests/e2e/export-frame-differencing.spec
 */

import { expect, test } from '@playwright/test';

const CONTENT = ['screen', 'video', 'fade', 'halfNoise', 'manyColors'];
const PRESETS = [
  { id: 'quality', maxColors: 256, paletteInterval: 1, format: 'rgb565' },
  { id: 'balanced', maxColors: 128, paletteInterval: 10, format: 'rgb565' },
  { id: 'fast', maxColors: 64, paletteInterval: 0, format: 'rgb444' },
];

test('differenced GIFs decode to the same frames as whole-frame GIFs', async ({ page }) => {
  await page.goto('/#/capture');
  const results = await page.evaluate(
    async ({ content, presets }) => {
      const { createGifencEncoder } = await import(
        '/glinfs/features/export/encoders/gifenc-encoder.js'
      );
      const W = 240;
      const H = 136;
      const FRAMES = 24;

      /** @param {number} seed */
      const rng = (seed) => {
        let s = seed;
        return () => {
          s = (s * 1103515245 + 12345) % 2147483648;
          return s / 2147483648;
        };
      };
      /** @type {Record<string, (f: number) => Uint8ClampedArray>} */
      const generators = {
        // Static page with a moving cursor-sized block
        screen: (f) => {
          const px = new Uint8ClampedArray(W * H * 4);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = (y * W + x) * 4;
              const block = x >= 10 + f * 6 && x < 30 + f * 6 && y >= 50 && y < 80;
              const text = y % 12 > 7 && x % 9 < 6 && y > 20;
              px[i] = block ? 230 : text ? 40 : 245;
              px[i + 1] = block ? 70 : text ? 40 : 245;
              px[i + 2] = block ? 90 : text ? 50 : 250;
              px[i + 3] = 255;
            }
          }
          return px;
        },
        // Gradient with temporal noise everywhere
        video: (f) => {
          const r = rng(f * 7919 + 1);
          const px = new Uint8ClampedArray(W * H * 4);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = (y * W + x) * 4;
              const n = (r() - 0.5) * 10;
              px[i] = 60 + x / 2 + n;
              px[i + 1] = 90 + y + n;
              px[i + 2] = 200 + n;
              px[i + 3] = 255;
            }
          }
          return px;
        },
        // Every pixel changes a little in every frame
        fade: (f) => {
          const px = new Uint8ClampedArray(W * H * 4);
          for (let i = 0; i < px.length; i += 4) {
            const x = (i >> 2) % W;
            px[i] = (x + f * 9) % 256;
            px[i + 1] = 255 - f * 8;
            px[i + 2] = f * 6;
            px[i + 3] = 255;
          }
          return px;
        },
        // Sparse noise over half the frame, the rest static
        halfNoise: (f) => {
          const r = rng(f * 104729 + 3);
          const px = generators.screen(0);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W / 2; x++) {
              if (r() < 0.3) px[(y * W + x) * 4 + 1] = 255 * r();
            }
          }
          return px;
        },
        // Hundreds of colors: the palette is full
        manyColors: (f) => {
          const px = new Uint8ClampedArray(W * H * 4);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = (y * W + x) * 4;
              const band = x >= f * 8 && x < f * 8 + 24;
              // 16 levels per channel: more than 256 colors, few enough to quantize fast
              px[i] = band ? 255 : (x * 3) & 0xf0;
              px[i + 1] = band ? 255 : (y * 5) & 0xf0;
              px[i + 2] = band ? 255 : ((x + y) * 2) & 0xf0;
              px[i + 3] = 255;
            }
          }
          return px;
        },
      };

      /** @param {Uint8Array} bytes */
      const decode = async (bytes) => {
        const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
        await decoder.tracks.ready;
        await decoder.completed;
        const frames = [];
        for (let i = 0; i < decoder.tracks.selectedTrack.frameCount; i++) {
          const { image } = await decoder.decode({ frameIndex: i });
          const canvas = new OffscreenCanvas(W, H);
          const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
          ctx.drawImage(image, 0, 0);
          frames.push(ctx.getImageData(0, 0, W, H).data);
          image.close();
        }
        decoder.close();
        return frames;
      };

      const out = [];
      for (const kind of content) {
        for (const preset of presets) {
          const sample = generators[kind](FRAMES >> 1);
          /** @param {boolean} frameDifferencing */
          const encode = (frameDifferencing) => {
            const encoder = createGifencEncoder();
            encoder.init({
              width: W,
              height: H,
              maxColors: preset.maxColors,
              frameDelayMs: 50,
              loopCount: 0,
              quantizeFormat: preset.format,
              paletteInterval: preset.paletteInterval,
              paletteSample: preset.paletteInterval === 0 ? sample : undefined,
              frameDifferencing,
            });
            for (let f = 0; f < FRAMES; f++) {
              encoder.addFrame({ rgba: generators[kind](f), width: W, height: H }, f);
            }
            return encoder.finish();
          };
          const plain = encode(false);
          const differenced = encode(true);
          const a = await decode(plain);
          const b = await decode(differenced);
          let differingPixels = 0;
          for (let f = 0; f < a.length; f++) {
            for (let p = 0; p < a[f].length; p += 4) {
              if (
                a[f][p] !== b[f][p] ||
                a[f][p + 1] !== b[f][p + 1] ||
                a[f][p + 2] !== b[f][p + 2] ||
                a[f][p + 3] !== b[f][p + 3]
              ) {
                differingPixels++;
              }
            }
          }
          out.push({
            kind,
            preset: preset.id,
            frames: [a.length, b.length],
            differingPixels,
            ratio: differenced.length / plain.length,
          });
        }
      }
      return out;
    },
    { content: CONTENT, presets: PRESETS },
  );

  for (const r of results) {
    const label = `${r.kind} / ${r.preset}`;
    expect(r.frames, label).toEqual([24, 24]);
    expect(r.differingPixels, label).toBe(0);
    // Never larger beyond a palette slot per frame (written only where smaller)
    expect(r.ratio, label).toBeLessThan(1.02);
  }
  const screen = results.filter((r) => r.kind === 'screen');
  for (const r of screen) expect(r.ratio, `screen / ${r.preset}`).toBeLessThan(0.6);
});

test('the export worker runs trials on a second worker, with the same bytes', async ({ page }) => {
  await page.goto('/#/capture');
  const result = await page.evaluate(async () => {
    const { createGifencEncoder } = await import(
      '/glinfs/features/export/encoders/gifenc-encoder.js'
    );
    const { GifEncoderManager } = await import('/glinfs/workers/worker-manager.js');
    const W = 320;
    const H = 180;
    const FRAMES = 40;
    /** A static page with a moving block, and video-like noise every 4th frame */
    const frame = (/** @type {number} */ f) => {
      let s = f * 7919 + 1;
      const r = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
      const px = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const block = x >= f * 6 && x < f * 6 + 30 && y >= 60 && y < 110;
          const n = f % 4 === 3 ? (r() - 0.5) * 60 : 0;
          px[i] = (block ? 230 : 40 + ((x * 7 + y * 3) % 90)) + n;
          px[i + 1] = (block ? 70 : 90 + ((x + y * 5) % 60)) + n;
          px[i + 2] = block ? 90 : 160;
          px[i + 3] = 255;
        }
      }
      return px;
    };
    const config = {
      width: W,
      height: H,
      maxColors: 64,
      frameDelayMs: 50,
      loopCount: 0,
      quantizeFormat: 'rgb565',
      paletteInterval: 1,
      frameDifferencing: true,
    };

    // In this thread, no second worker: every trial runs in the encoder
    const local = createGifencEncoder();
    local.init(config);
    for (let f = 0; f < FRAMES; f++) local.addFrame({ rgba: frame(f), width: W, height: H }, f);
    const expected = local.finish();

    // Through the export worker, which starts the trial worker
    const manager = new GifEncoderManager();
    let processed = 0;
    /** @type {number[]} */
    const progressOrder = [];
    manager.onProgress = (p) => {
      processed++;
      progressOrder.push(p.frameIndex);
    };
    await manager.init({ encoderId: 'gifenc-js', totalFrames: FRAMES, ...config });
    for (let f = 0; f < FRAMES; f++) {
      while (f - processed >= 4) await new Promise((r) => setTimeout(r, 1));
      manager.addFrame(frame(f), W, H, f, 50);
    }
    const blob = await manager.finish();
    manager.dispose();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const same = bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
    return { same, size: bytes.length, progressOrder };
  });

  expect(result.same).toBe(true);
  expect(result.progressOrder).toEqual(Array.from({ length: 40 }, (_, i) => i));
});

test('the trial worker answers a job with the smaller encoding', async ({ page }) => {
  await page.goto('/#/capture');
  // The worker the export worker starts, run directly: it must load and
  // answer (a nested worker that failed to load would only show as a
  // failed export)
  const answer = await page.evaluate(async () => {
    const worker = new Worker('/glinfs/workers/gif-trial-worker.js', { type: 'module' });
    const index = new Uint8Array(64 * 64);
    for (let i = 0; i < index.length; i++) index[i] = (i * 7) % 5;
    const differenced = new Uint8Array(index.length).fill(5);
    const palette = [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ];
    const reply = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message || 'worker failed'));
      worker.postMessage(
        {
          id: 7,
          width: 64,
          height: 64,
          index: index.buffer,
          differenced: differenced.buffer,
          wholeOptions: { palette, delay: 50, dispose: 1 },
          keptOptions: {
            palette: [...palette, [0, 0, 0]],
            delay: 50,
            dispose: 1,
            transparent: true,
            transparentIndex: 5,
          },
        },
        [index.buffer, differenced.buffer],
      );
    });
    worker.terminate();
    const bytes = new Uint8Array(reply.bytes);
    // A graphic control extension with the transparency flag: the all-kept frame won
    return {
      id: reply.id,
      transparent: bytes[0] === 0x21 && (bytes[3] & 1) === 1,
      returned: reply.index.byteLength,
    };
  });
  expect(answer).toEqual({ id: 7, transparent: true, returned: 64 * 64 });
});
