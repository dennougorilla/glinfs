/**
 * Frame composition with the AI cutout: a maskSource's final mask replaces
 * the color key at the same place in the pipeline (removal, then text), and
 * the color key path stays byte-identical whether or not a mask source is
 * passed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyColorKey } from '../../../../src/shared/edits/color-key.js';
import {
  __resetComposeCacheForTests,
  composeEditorFrame,
  composeOutputFrame,
  composeOutputFrameRGBA,
  getRemovalStep,
} from '../../../../src/shared/edits/compose.js';
import { createDefaultEdits, createTextLayer } from '../../../../src/shared/edits/model.js';
import { packMask } from '../../../../src/shared/masks/mask-ops.js';
import { createFakeContext } from './fake-context.js';

const W = 8;
const H = 6;
const GREEN = [0, 255, 0, 255];

/**
 * Source pixels: green on the left three columns, a unique color elsewhere
 * @returns {Uint8ClampedArray}
 */
function pattern() {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      rgba.set(x < 3 ? GREEN : [x * 20, y * 30, 200, 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

/** Frame whose fake VideoFrame is the pattern */
function patternFrame() {
  return /** @type {any} */ ({
    id: 'p',
    frame: { closed: false, rgba: pattern(), width: W, height: H },
    timestamp: 0,
    width: W,
    height: H,
  });
}

/**
 * Pixels of the pattern inside a rectangle, row-major RGBA
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
function patternRegion(rect) {
  const src = pattern();
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * W + rect.x) * 4;
    out.set(src.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

/** @param {{ method?: 'color' | 'ai', text?: boolean }} [opts] */
function editsOf({ method = 'color', text = false } = {}) {
  const edits = createDefaultEdits();
  edits.background = {
    ...edits.background,
    enabled: true,
    method,
    color: '#00ff00',
    tolerance: 5,
    mode: 'global',
  };
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
          start: 0,
          end: 9,
        },
        10,
      ),
    );
  }
  return edits;
}

/**
 * Mask source over the whole 8x6 frame at half resolution (4x3): keeps the
 * mask pixels marked '#'
 * @param {string[]} rows - 3 rows of 4
 */
function halfResMaskSource(rows) {
  const binary = Uint8Array.from(rows.join(''), (ch) => (ch === '#' ? 1 : 0));
  const mask = packMask(binary, 4, 3);
  return {
    version: 1,
    getFinalMask: vi.fn((/** @type {number} */ _frame) => mask),
  };
}

/**
 * Alpha of every pixel as rows of '#' (opaque) / '.' (cleared)
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 */
function alphaRows(rgba, width) {
  const rows = [];
  for (let i = 0; i < rgba.length / 4; i += width) {
    let row = '';
    for (let x = 0; x < width; x++) row += rgba[(i + x) * 4 + 3] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

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

      getContext() {
        const ctx = createFakeContext(0, 0, this);
        contexts.push(ctx);
        return ctx;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetComposeCacheForTests();
});

describe('color key path is unchanged by the mask pipeline', () => {
  const crop = { x: 1, y: 1, width: 5, height: 4, aspectRatio: 'free' };

  it('composeOutputFrameRGBA: byte-identical to v0.7.0 keying, mask source never read', async () => {
    const maskSource = halfResMaskSource(['....', '....', '....']);
    const legacy = patternRegion(crop);
    applyColorKey(legacy, crop.width, crop.height, editsOf().background);

    const withSource = await composeOutputFrameRGBA(patternFrame(), crop, editsOf(), 0, maskSource);
    const without = await composeOutputFrameRGBA(patternFrame(), crop, editsOf(), 0);

    expect(withSource.data).toEqual(legacy);
    expect(without.data).toEqual(legacy);
    expect(maskSource.getFinalMask).not.toHaveBeenCalled();
    // The key really did something
    expect(alphaRows(withSource.data, crop.width)[0]).toBe('..###');
  });

  it('composeOutputFrame and composeEditorFrame: identical pixels with or without a mask source', () => {
    const maskSource = halfResMaskSource(['....', '....', '....']);
    for (const compose of [composeOutputFrame, composeEditorFrame]) {
      const a = createFakeContext();
      const b = createFakeContext();
      compose(a, patternFrame(), crop, editsOf({ text: true }), 0, maskSource);
      compose(b, patternFrame(), crop, editsOf({ text: true }), 0);
      expect(a.getImageData(0, 0, a.canvas.width, a.canvas.height).data).toEqual(
        b.getImageData(0, 0, b.canvas.width, b.canvas.height).data,
      );
      expect(a.names()).toEqual(b.names());
    }
    expect(maskSource.getFinalMask).not.toHaveBeenCalled();
  });

  it('plain clips (removal off) never read back or consult the mask source', async () => {
    const maskSource = halfResMaskSource(['####', '####', '####']);
    const off = editsOf({ method: 'ai' });
    off.background.enabled = false;
    const result = await composeOutputFrameRGBA(patternFrame(), null, off, 0, maskSource);
    expect(result.data).toEqual(pattern());
    expect(maskSource.getFinalMask).not.toHaveBeenCalled();
    expect(getRemovalStep(patternFrame(), crop, null, 0, maskSource)).toBeNull();
  });
});

describe('AI cutout masks', () => {
  // Mask pixel (mx, my) covers source pixels (2mx..2mx+1, 2my..2my+1)
  const rows = ['.##.', '.##.', '....'];

  it('clear RGBA where the mask is 0 on the full frame (nearest neighbour)', async () => {
    const maskSource = halfResMaskSource(rows);
    const result = await composeOutputFrameRGBA(
      patternFrame(),
      null,
      editsOf({ method: 'ai' }),
      7,
      maskSource,
    );
    expect(maskSource.getFinalMask).toHaveBeenCalledWith(7);
    expect(alphaRows(result.data, W)).toEqual([
      '..####..',
      '..####..',
      '..####..',
      '..####..',
      '........',
      '........',
    ]);
    // Kept pixels keep their color (even green: no color key runs); cleared
    // ones are 0,0,0,0
    expect(Array.from(result.data.subarray((0 * W + 2) * 4, (0 * W + 2) * 4 + 4))).toEqual(GREEN);
    expect(Array.from(result.data.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('sample the mask at the crop position', async () => {
    const maskSource = halfResMaskSource(rows);
    const crop = { x: 3, y: 2, width: 4, height: 4, aspectRatio: 'free' };
    const result = await composeOutputFrameRGBA(
      patternFrame(),
      crop,
      editsOf({ method: 'ai' }),
      0,
      maskSource,
    );
    expect(alphaRows(result.data, 4)).toEqual(['###.', '###.', '....', '....']);
  });

  it('are applied before the text, so a caption over a removed area stays', async () => {
    const maskSource = halfResMaskSource(['....', '....', '....']);
    const result = await composeOutputFrameRGBA(
      patternFrame(),
      null,
      editsOf({ method: 'ai', text: true }),
      0,
      maskSource,
    );
    const names = contexts[0]
      .names()
      .filter((/** @type {string} */ n) => n !== 'save' && n !== 'restore');
    expect(names).toEqual([
      'drawImage',
      'getImageData',
      'putImageData',
      'fillText',
      'getImageData',
    ]);
    // Text anchor at the output center
    const p = (3 * W + 4) * 4;
    expect(Array.from(result.data.subarray(p, p + 4))).toEqual([255, 0, 0, 255]);
    expect(result.data[3]).toBe(0);
  });

  it('draw the frame unkeyed, without a readback, when the frame has no mask', async () => {
    const none = { version: 3, getFinalMask: vi.fn(() => null) };
    const result = await composeOutputFrameRGBA(
      patternFrame(),
      null,
      editsOf({ method: 'ai' }),
      2,
      none,
    );
    expect(result.data).toEqual(pattern());
    expect(none.getFinalMask).toHaveBeenCalledWith(2);

    const ctx = createFakeContext();
    composeOutputFrame(ctx, patternFrame(), null, editsOf({ method: 'ai' }), 2);
    expect(ctx.names()).toEqual(['clearRect', 'drawImage']);
  });

  it('composeOutputFrame: removes inside the output canvas', () => {
    const ctx = createFakeContext();
    const crop = { x: 2, y: 0, width: 4, height: 2, aspectRatio: 'free' };
    composeOutputFrame(
      ctx,
      patternFrame(),
      crop,
      editsOf({ method: 'ai' }),
      0,
      halfResMaskSource(rows),
    );
    expect(alphaRows(ctx.getImageData(0, 0, 4, 2).data, 4)).toEqual(['####', '####']);
    const shifted = { ...crop, x: 4 };
    composeOutputFrame(
      ctx,
      patternFrame(),
      shifted,
      editsOf({ method: 'ai' }),
      0,
      halfResMaskSource(rows),
    );
    expect(alphaRows(ctx.getImageData(0, 0, 4, 2).data, 4)).toEqual(['##..', '##..']);
  });

  it('composeEditorFrame: removes only inside the crop region of the full frame', () => {
    const ctx = createFakeContext();
    const crop = { x: 0, y: 0, width: 4, height: 6, aspectRatio: 'free' };
    composeEditorFrame(
      ctx,
      patternFrame(),
      crop,
      editsOf({ method: 'ai' }),
      0,
      halfResMaskSource(rows),
    );
    expect(alphaRows(ctx.getImageData(0, 0, W, H).data, W)).toEqual([
      '..######',
      '..######',
      '..######',
      '..######',
      '....####',
      '....####',
    ]);
  });
});
