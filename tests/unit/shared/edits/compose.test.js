import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetComposeCacheForTests,
  composeEditorFrame,
  composeOutputFrame,
  composeOutputFrameRGBA,
  snapCanvasAlphaToBinary,
} from '../../../../src/shared/edits/compose.js';
import { createDefaultEdits, createTextLayer } from '../../../../src/shared/edits/model.js';
import { createFakeContext } from './fake-context.js';

const GREEN = [0, 255, 0, 255];

/**
 * Frame whose "VideoFrame" paints a solid color through the fake drawImage
 * @param {number} width
 * @param {number} height
 * @param {number[]} [fill]
 */
function solidFrame(width, height, fill = GREEN) {
  return /** @type {any} */ ({
    id: 'f',
    frame: { closed: false, fill },
    timestamp: 0,
    width,
    height,
  });
}

/**
 * Edits: key out green (optional) and one red text layer on frames 2..4
 * @param {{ key?: boolean, text?: boolean }} opts
 */
function makeEdits({ key = false, text = false }) {
  const edits = createDefaultEdits();
  if (key) edits.background = { enabled: true, color: '#00ff00', tolerance: 10, mode: 'global' };
  if (text) {
    edits.textLayers.push(
      createTextLayer(
        {
          id: 't',
          text: 'Hi',
          x: 0.5,
          y: 0.5,
          color: '#ff0000',
          outlineWidth: 0,
          start: 2,
          end: 4,
        },
        10,
      ),
    );
  }
  return edits;
}

describe('composeOutputFrame', () => {
  it('sizes the canvas to the crop, clears it and draws the cropped source', () => {
    const ctx = createFakeContext(1, 1);
    const crop = { x: 2, y: 3, width: 6, height: 4, aspectRatio: 'free' };
    composeOutputFrame(ctx, solidFrame(20, 10), crop, null, 0);

    expect([ctx.canvas.width, ctx.canvas.height]).toEqual([6, 4]);
    expect(ctx.names()).toEqual(['clearRect', 'drawImage']);
    expect(ctx.calls[1].args.slice(1)).toEqual([2, 3, 6, 4, 0, 0, 6, 4]);
    expect(ctx.pixelAt(5, 3)).toEqual(GREEN);
  });

  it('draws the whole frame without a crop', () => {
    const ctx = createFakeContext();
    composeOutputFrame(ctx, solidFrame(8, 5), null, createDefaultEdits(), 0);
    expect([ctx.canvas.width, ctx.canvas.height]).toEqual([8, 5]);
    expect(ctx.calls[1]).toMatchObject({ name: 'drawImage', args: [expect.anything(), 0, 0] });
  });

  it('keys the background, then draws active text on top', () => {
    const ctx = createFakeContext();
    composeOutputFrame(ctx, solidFrame(10, 10), null, makeEdits({ key: true, text: true }), 3);

    expect(ctx.names().filter((n) => n !== 'save' && n !== 'restore')).toEqual([
      'clearRect',
      'drawImage',
      'getImageData',
      'putImageData',
      'fillText',
    ]);
    expect(ctx.pixelAt(0, 0)).toEqual([0, 0, 0, 0]);
    // Text drawn after keying is never removed by the key
    expect(ctx.pixelAt(5, 5)).toEqual([255, 0, 0, 255]);
  });

  it('skips text outside its frame range and the readback when the key is off', () => {
    const ctx = createFakeContext();
    composeOutputFrame(ctx, solidFrame(10, 10), null, makeEdits({ text: true }), 5);
    expect(ctx.names()).toEqual(['clearRect', 'drawImage']);
    expect(ctx.pixelAt(0, 0)).toEqual(GREEN);
  });

  it('draws the placeholder for a closed or missing frame without clearing', () => {
    const ctx = createFakeContext(4, 4);
    const closed = solidFrame(12, 6);
    closed.frame.closed = true;
    composeOutputFrame(ctx, closed, null, makeEdits({ key: true }), 0);
    expect(ctx.names()).not.toContain('clearRect');
    expect(ctx.names()).toContain('fillRect');
    expect([ctx.canvas.width, ctx.canvas.height]).toEqual([12, 6]);

    const ctx2 = createFakeContext(7, 3);
    composeOutputFrame(ctx2, undefined, null, null, 0);
    expect(ctx2.names()).toContain('fillRect');
    expect([ctx2.canvas.width, ctx2.canvas.height]).toEqual([7, 3]);
  });
});

describe('composeOutputFrameRGBA', () => {
  /** @type {any[]} */
  let contexts;

  beforeEach(() => {
    __resetComposeCacheForTests();
    contexts = [];
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        /** @param {number} w @param {number} h */
        constructor(w, h) {
          this.width = w;
          this.height = h;
        }

        /** @param {string} _type @param {any} options */
        getContext(_type, options) {
          const ctx = createFakeContext(0, 0, this);
          contexts.push({ ctx, options });
          return ctx;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetComposeCacheForTests();
  });

  it('uses a cached willReadFrequently context', async () => {
    await composeOutputFrameRGBA(solidFrame(4, 4), null, makeEdits({ key: true }), 0);
    await composeOutputFrameRGBA(solidFrame(6, 2), null, makeEdits({ key: true }), 0);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].options).toEqual({ willReadFrequently: true });
  });

  it('keys the single readback directly when no text is active', async () => {
    const result = await composeOutputFrameRGBA(
      solidFrame(4, 4),
      null,
      makeEdits({ key: true, text: true }),
      0,
    );
    const { ctx } = contexts[0];
    expect(ctx.names().filter((n) => n === 'getImageData' || n === 'putImageData')).toEqual([
      'getImageData',
    ]);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(Array.from(result.data.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('draws text and reads back once when the key is off', async () => {
    const result = await composeOutputFrameRGBA(
      solidFrame(10, 10),
      null,
      makeEdits({ text: true }),
      2,
    );
    const { ctx } = contexts[0];
    const names = ctx.names().filter((n) => n !== 'save' && n !== 'restore');
    expect(names).toEqual(['drawImage', 'fillText', 'getImageData']);
    expect(Array.from(result.data.subarray((5 * 10 + 5) * 4, (5 * 10 + 5) * 4 + 4))).toEqual([
      255, 0, 0, 255,
    ]);
    expect(Array.from(result.data.subarray(0, 4))).toEqual(GREEN);
  });

  it('keys, writes back, draws text and reads back when both are active', async () => {
    const crop = { x: 0, y: 0, width: 10, height: 10, aspectRatio: 'free' };
    const result = await composeOutputFrameRGBA(
      solidFrame(20, 20),
      crop,
      makeEdits({ key: true, text: true }),
      4,
    );
    const { ctx } = contexts[0];
    const names = ctx.names().filter((n) => n !== 'save' && n !== 'restore');
    expect(names).toEqual([
      'drawImage',
      'getImageData',
      'putImageData',
      'fillText',
      'getImageData',
    ]);
    expect(Array.from(result.data.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(result.data.subarray((5 * 10 + 5) * 4, (5 * 10 + 5) * 4 + 4))).toEqual([
      255, 0, 0, 255,
    ]);
  });

  it('clears the reused canvas between same-size frames', async () => {
    await composeOutputFrameRGBA(solidFrame(4, 4), null, makeEdits({ key: true }), 0);
    await composeOutputFrameRGBA(solidFrame(4, 4), null, makeEdits({ key: true }), 0);
    const { ctx } = contexts[0];
    expect(ctx.names().filter((n) => n === 'clearRect')).toHaveLength(1);
  });

  it('keys a scaled output at full size, scales the result down, then draws text', async () => {
    const crop = { x: 4, y: 2, width: 12, height: 8, aspectRatio: 'free' };
    const result = await composeOutputFrameRGBA(
      solidFrame(20, 20),
      crop,
      makeEdits({ key: true, text: true }),
      4,
      null,
      0.5,
    );
    expect([result.width, result.height]).toEqual([6, 4]);
    expect(result.data).toHaveLength(6 * 4 * 4);
    // The removal canvas: the crop drawn 1:1 and keyed at full size
    const removal = contexts.find(({ ctx }) => ctx.canvas.width === 12)?.ctx;
    expect(removal.calls.find((c) => c.name === 'drawImage')?.args.slice(1)).toEqual([
      4, 2, 12, 8, 0, 0, 12, 8,
    ]);
    expect(removal.calls.find((c) => c.name === 'getImageData')?.args).toEqual([0, 0, 12, 8]);
    // The output canvas: the keyed canvas scaled into 6x4 with high-quality
    // smoothing, then the text at that size
    const output = contexts.find(({ ctx }) => ctx.canvas.width === 6)?.ctx;
    const draw = output.calls.find((c) => c.name === 'drawImage');
    expect(draw?.args[0]).toBe(removal.canvas);
    expect(draw?.args.slice(1)).toEqual([0, 0, 12, 8, 0, 0, 6, 4]);
    expect(output.imageSmoothingQuality).toBe('high');
    expect(output.names().filter((n) => n === 'fillText')).toHaveLength(1);
    expect(Array.from(result.data.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(result.data.subarray((2 * 6 + 3) * 4, (2 * 6 + 3) * 4 + 4))).toEqual([
      255, 0, 0, 255,
    ]);
  });

  it('draws the source scaled right away when nothing is removed', async () => {
    const crop = { x: 4, y: 2, width: 12, height: 8, aspectRatio: 'free' };
    const result = await composeOutputFrameRGBA(solidFrame(20, 20), crop, null, 0, null, 0.5);
    expect([result.width, result.height]).toEqual([6, 4]);
    expect(contexts).toHaveLength(1);
    const { ctx } = contexts[0];
    expect(ctx.calls.find((c) => c.name === 'drawImage')?.args.slice(1)).toEqual([
      4, 2, 12, 8, 0, 0, 6, 4,
    ]);
    expect(ctx.names().filter((n) => n === 'getImageData')).toHaveLength(1);
    expect(Array.from(result.data.subarray(0, 4))).toEqual(GREEN);
  });

  it('keys at full resolution before scaling, so no key color bleeds into kept edges', async () => {
    // 4x2 source of alternating green (keyed) and white (kept) columns
    const rgba = new Uint8ClampedArray(4 * 2 * 4);
    for (let p = 0; p < 8; p++) rgba.set(p % 2 === 0 ? GREEN : [255, 255, 255, 255], p * 4);
    const frame = /** @type {any} */ ({
      id: 's',
      frame: { closed: false, rgba, width: 4, height: 2 },
      timestamp: 0,
      width: 4,
      height: 2,
    });
    const result = await composeOutputFrameRGBA(
      frame,
      null,
      makeEdits({ key: true }),
      0,
      null,
      0.5,
    );
    expect([result.width, result.height]).toEqual([2, 1]);
    for (let p = 0; p < 2; p++) {
      const [r, g, b, a] = result.data.subarray(p * 4, p * 4 + 4);
      // Half of each output pixel is the kept white column: white at about
      // half alpha, never the green-white blend a key after scaling leaves
      expect([r, g, b]).toEqual([255, 255, 255]);
      expect(a).toBeGreaterThan(100);
      expect(a).toBeLessThan(160);
    }
  });

  it('draws the full-size source unscaled with default smoothing at scale 1', async () => {
    await composeOutputFrameRGBA(solidFrame(8, 8), null, makeEdits({ key: true }), 0, null, 0.5);
    await composeOutputFrameRGBA(solidFrame(8, 8), null, makeEdits({ key: true }), 0, null, 1);
    // The output context: the one the scaled frame was drawn into
    const { ctx } = /** @type {any} */ (
      contexts.find(({ ctx: c }) =>
        c.calls.some(
          (/** @type {any} */ call) => call.name === 'drawImage' && call.args.length === 9,
        ),
      )
    );
    const draws = ctx.calls.filter((c) => c.name === 'drawImage');
    expect(draws.at(-1)?.args.slice(1)).toEqual([0, 0]);
    // The cached context is reset from the previous scaled frame
    expect(ctx.imageSmoothingQuality).toBe('low');
  });

  it('rejects a closed or missing frame', async () => {
    const closed = solidFrame(4, 4);
    closed.frame.closed = true;
    await expect(composeOutputFrameRGBA(closed, null, null, 0)).rejects.toThrow(
      /missing or closed/,
    );
    await expect(
      composeOutputFrameRGBA(/** @type {any} */ ({ width: 4, height: 4 }), null, null, 0),
    ).rejects.toThrow(/missing or closed/);
  });
});

describe('composeEditorFrame', () => {
  it('draws the full frame and keys only inside the crop region', () => {
    const ctx = createFakeContext();
    const crop = { x: 2, y: 2, width: 4, height: 4, aspectRatio: 'free' };
    composeEditorFrame(ctx, solidFrame(10, 10), crop, makeEdits({ key: true }), 0);

    expect([ctx.canvas.width, ctx.canvas.height]).toEqual([10, 10]);
    expect(ctx.calls.find((c) => c.name === 'getImageData')?.args).toEqual([2, 2, 4, 4]);
    expect(ctx.pixelAt(0, 0)).toEqual(GREEN);
    expect(ctx.pixelAt(3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('draws text translated to the region origin and clipped to it', () => {
    const ctx = createFakeContext();
    const crop = { x: 4, y: 2, width: 6, height: 6, aspectRatio: 'free' };
    composeEditorFrame(ctx, solidFrame(12, 12), crop, makeEdits({ text: true }), 3);

    expect(ctx.calls.find((c) => c.name === 'rect')?.args).toEqual([4, 2, 6, 6]);
    expect(ctx.names()).toContain('clip');
    expect(ctx.calls.find((c) => c.name === 'translate')?.args).toEqual([4, 2]);
    // Centered text in the 6x6 region lands at (4 + 3, 2 + 3)
    expect(ctx.pixelAt(7, 5)).toEqual([255, 0, 0, 255]);
  });

  it('uses the whole frame as the region without a crop, and skips text setup when none is active', () => {
    const ctx = createFakeContext();
    composeEditorFrame(ctx, solidFrame(8, 8), null, makeEdits({ key: true, text: true }), 9);
    expect(ctx.calls.find((c) => c.name === 'getImageData')?.args).toEqual([0, 0, 8, 8]);
    expect(ctx.names()).not.toContain('clip');
  });

  it('draws the placeholder for an invalid frame', () => {
    const ctx = createFakeContext(5, 5);
    composeEditorFrame(ctx, null, null, null, 0);
    expect(ctx.names()).toContain('fillRect');
    expect(ctx.names()).not.toContain('clearRect');
  });
});

describe('snapCanvasAlphaToBinary', () => {
  it('snaps a see-through box to what the GIF encoder writes', () => {
    const ctx = createFakeContext(3, 1);
    // A red box at 0.6 opacity (alpha 153) and at 0.4 (alpha 102) over a
    // transparent background, next to an opaque green pixel
    const data = new Uint8ClampedArray([...[255, 0, 0, 153], ...[255, 0, 0, 102], ...GREEN]);
    ctx.putImageData({ data, width: 3, height: 1 }, 0, 0);
    ctx.calls.length = 0;

    const snapped = snapCanvasAlphaToBinary(ctx);

    expect(ctx.pixelAt(0, 0)).toEqual([255, 0, 0, 255]);
    // The snapped pixels come back for callers that cache the frame
    expect(Array.from(snapped?.data ?? [])).toEqual([255, 0, 0, 255, 255, 0, 0, 0, ...GREEN]);
    expect(ctx.pixelAt(1, 0)[3]).toBe(0);
    expect(ctx.pixelAt(2, 0)).toEqual([0, 255, 0, 255]);
    expect(ctx.names()).toEqual(['getImageData', 'putImageData']);
  });

  it('skips the write-back when the canvas is already 1-bit', () => {
    const ctx = createFakeContext(2, 1);
    composeOutputFrame(ctx, solidFrame(2, 1), null, null, 0);
    ctx.calls.length = 0;

    expect(snapCanvasAlphaToBinary(ctx)?.width).toBe(2);

    expect(ctx.names()).toEqual(['getImageData']);
    expect(snapCanvasAlphaToBinary(createFakeContext(0, 0))).toBeNull();
  });

  it('does nothing on an empty canvas', () => {
    const ctx = createFakeContext(0, 0);
    snapCanvasAlphaToBinary(ctx);
    expect(ctx.names()).toEqual([]);
  });
});
