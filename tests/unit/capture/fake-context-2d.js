/**
 * A stand-in for CanvasRenderingContext2D under jsdom, which has no canvas.
 * It keeps the drawing state a renderer must save and restore, and records
 * what was drawn: enough to check the welcome scene's drawing code without a
 * browser.
 */

import { vi } from 'vitest';

const STATE = [
  'globalAlpha',
  'globalCompositeOperation',
  'fillStyle',
  'strokeStyle',
  'lineWidth',
  'font',
  'textAlign',
  'textBaseline',
  'imageSmoothingEnabled',
  'shadowColor',
  'shadowBlur',
];

/** Every ImageData put into any fake canvas, with the canvas it went to */
export const putImages = [];

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createFakeContext2d(canvas) {
  const stack = [];
  const ctx = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowBlur: 0,
    /** Current save() depth, and whether restore() was ever called with nothing saved */
    depth: 0,
    underflow: false,
    /** fillStyle of every fillRect */
    fillStyles: new Set(),
    /** Source size and destination of every drawImage */
    draws: [],
    save() {
      stack.push(Object.fromEntries(STATE.map((key) => [key, ctx[key]])));
      ctx.depth = stack.length;
    },
    restore() {
      const saved = stack.pop();
      if (!saved) {
        ctx.underflow = true;
        return;
      }
      Object.assign(ctx, saved);
      ctx.depth = stack.length;
    },
    fillRect() {
      ctx.fillStyles.add(ctx.fillStyle);
    },
    drawImage(image, ...args) {
      ctx.draws.push({ w: image.width, h: image.height, args });
    },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image) {
      putImages.push({ canvas, image });
    },
    getImageData(_x, _y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    measureText(text) {
      return { width: String(text).length * 6 };
    },
  };
  for (const name of [
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'rect',
    'roundRect',
    'arc',
    'fill',
    'stroke',
    'clip',
    'fillText',
    'strokeRect',
    'clearRect',
    'setTransform',
    'translate',
    'scale',
  ]) {
    ctx[name] = () => {};
  }
  return ctx;
}

/**
 * Give every canvas a fake 2D context (one per canvas)
 * @returns {import('vitest').MockInstance}
 */
export function installFakeCanvas() {
  const contexts = new WeakMap();
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = createFakeContext2d(this);
      contexts.set(this, ctx);
    }
    return /** @type {any} */ (ctx);
  });
}
