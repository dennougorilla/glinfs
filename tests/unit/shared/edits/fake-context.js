/**
 * Recording 2D context for edit-rendering unit tests (jsdom has no canvas).
 *
 * measureText returns width = characters * fontPx / 2, parsed from ctx.font,
 * so layouts are deterministic. getImageData/putImageData work on a real
 * RGBA backing buffer, and drawImage fills the drawn region from the
 * source's `fill` color (tests pass `{ fill: [r, g, b, a] }` as the source),
 * so keying and readback order can be asserted on real pixels. fillText
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
  };

  return ctx;
}
