/**
 * Recording 2D context for edit-rendering unit tests (jsdom has no canvas).
 *
 * measureText returns width = characters * fontPx / 2, parsed from ctx.font,
 * so layouts are deterministic. getImageData/putImageData work on a real
 * RGBA backing buffer, and drawImage fills the drawn region from the
 * source's `fill` color (tests pass `{ fill: [r, g, b, a] }` as the source)
 * or copies a patterned source (`{ rgba, width, height }`) or another fake
 * context's canvas pixel for pixel, so keying and readback order can be
 * asserted on real pixels. A pixel source drawn at a different size is
 * resampled with a box filter over premultiplied alpha, as a real canvas
 * does (a transparent pixel adds no color to its neighbours). fillText
 * paints one pixel of the fill color at its anchor (x, y), translated by any
 * translate() calls since the last save().
 */

import { vi } from 'vitest';

/**
 * @param {number} [width]
 * @param {number} [height]
 * @param {{ width: number, height: number }} [canvas] - Canvas object to back (e.g. a stub OffscreenCanvas)
 */
export function createFakeContext(width = 0, height = 0, canvas = { width, height }) {
  /** @type {any[]} */
  const calls = [];
  let pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  let sizeKey = `${canvas.width}x${canvas.height}`;
  let tx = 0;
  let ty = 0;
  /** @type {[number, number][]} */
  const transforms = [];

  /** Reallocate the backing store when the canvas was resized (clears it, like a real canvas) */
  const sync = () => {
    const key = `${canvas.width}x${canvas.height}`;
    if (key !== sizeKey) {
      sizeKey = key;
      pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    }
  };

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number[]} rgba
   */
  const fill = (x, y, w, h, rgba) => {
    sync();
    for (let yy = Math.max(0, y); yy < Math.min(canvas.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(canvas.width, x + w); xx++) {
        pixels.set(rgba, (yy * canvas.width + xx) * 4);
      }
    }
  };

  const record =
    (/** @type {string} */ name, /** @type {(...args: any[]) => any} */ impl = () => {}) =>
    (/** @type {any[]} */ ...args) => {
      calls.push({ name, args });
      return impl(...args);
    };

  const ctx = {
    canvas,
    calls,
    font: '10px sans-serif',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineJoin: 'miter',
    miterLimit: 10,
    globalAlpha: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: record('save', () => {
      transforms.push([tx, ty]);
    }),
    restore: record('restore', () => {
      [tx, ty] = transforms.pop() ?? [0, 0];
    }),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    translate: record('translate', (x, y) => {
      tx += x;
      ty += y;
    }),
    fillRect: record('fillRect'),
    // Paints one pixel of fillStyle at the anchor so tests can see where
    // (and whether) text landed after keying
    fillText: vi.fn(
      record('fillText', (_text, x, y) => {
        const hex = /^#([0-9a-f]{6})$/i.exec(String(ctx.fillStyle))?.[1];
        if (!hex) return;
        const n = Number.parseInt(hex, 16);
        fill(Math.round(x + tx), Math.round(y + ty), 1, 1, [
          (n >> 16) & 255,
          (n >> 8) & 255,
          n & 255,
          255,
        ]);
      }),
    ),
    strokeText: vi.fn(record('strokeText')),
    clearRect: record('clearRect', (x, y, w, h) => fill(x, y, w, h, [0, 0, 0, 0])),
    measureText: (/** @type {string} */ text) => {
      const px = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 10);
      return { width: (text.length * px) / 2 };
    },
    drawImage: record('drawImage', (source, ...rest) => {
      // Pixel sources: a pattern ({ rgba, width, height }) or the canvas of
      // another fake context
      const sourcePixels = source?.rgba ?? source?.__fakeContext?.__pixels();
      if (sourcePixels) {
        const [sx, sy, sw, sh, dx, dy, dw = sw, dh = sh] =
          rest.length === 2
            ? [0, 0, source.width, source.height, rest[0], rest[1]]
            : rest.length === 4
              ? [0, 0, source.width, source.height, rest[0], rest[1], rest[2], rest[3]]
              : rest;
        sync();
        for (let yy = 0; yy < dh; yy++) {
          for (let xx = 0; xx < dw; xx++) {
            const x = dx + xx;
            const y = dy + yy;
            if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
            // Source pixels covered by this destination pixel (1:1 when unscaled)
            const x0 = sx + Math.floor((xx * sw) / dw);
            const x1 = Math.max(x0 + 1, sx + Math.floor(((xx + 1) * sw) / dw));
            const y0 = sy + Math.floor((yy * sh) / dh);
            const y1 = Math.max(y0 + 1, sy + Math.floor(((yy + 1) * sh) / dh));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let py = y0; py < y1; py++) {
              for (let px = x0; px < x1; px++) {
                const from = (py * source.width + px) * 4;
                const alpha = sourcePixels[from + 3];
                r += sourcePixels[from] * alpha;
                g += sourcePixels[from + 1] * alpha;
                b += sourcePixels[from + 2] * alpha;
                a += alpha;
                n++;
              }
            }
            const to = (y * canvas.width + x) * 4;
            pixels[to] = a > 0 ? r / a : 0;
            pixels[to + 1] = a > 0 ? g / a : 0;
            pixels[to + 2] = a > 0 ? b / a : 0;
            pixels[to + 3] = a / n;
          }
        }
        return;
      }
      const rgba = source?.fill ?? [1, 2, 3, 255];
      if (rest.length === 2) {
        fill(rest[0], rest[1], canvas.width, canvas.height, rgba);
      } else {
        fill(rest[4], rest[5], rest[6], rest[7], rgba);
      }
    }),
    getImageData: record('getImageData', (x, y, w, h) => {
      sync();
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        const start = ((y + yy) * canvas.width + x) * 4;
        data.set(pixels.subarray(start, start + w * 4), yy * w * 4);
      }
      return { data, width: w, height: h };
    }),
    putImageData: record('putImageData', (image, x, y) => {
      sync();
      for (let yy = 0; yy < image.height; yy++) {
        const start = ((y + yy) * canvas.width + x) * 4;
        pixels.set(image.data.subarray(yy * image.width * 4, (yy + 1) * image.width * 4), start);
      }
    }),
    /** Test helper: current pixel at (x, y) */
    pixelAt: (/** @type {number} */ x, /** @type {number} */ y) => {
      sync();
      return Array.from(
        pixels.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4),
      );
    },
    /** Test helper: names of recorded calls */
    names: () => calls.map((c) => c.name),
    /** Backing pixels, read without recording a call (drawImage of this canvas) */
    __pixels: () => {
      sync();
      return pixels;
    },
  };

  /** Lets drawImage(thisCanvas, ...) on another fake context read the pixels */
  Object.defineProperty(canvas, '__fakeContext', { value: ctx, configurable: true });

  return ctx;
}
