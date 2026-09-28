/**
 * Frame composition with touch-ups (mask brush): strokes change the color
 * key's or the AI mask's keep/remove decision before any pixel is cleared,
 * so erase removes kept pixels and restore brings back the original colors
 * of removed ones; only strokes whose range covers the frame apply, and
 * only while background removal is on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetComposeCacheForTests,
  composeEditorFrame,
  composeOutputFrame,
  composeOutputFrameRGBA,
} from '../../../../src/shared/edits/compose.js';
import { createDefaultEdits } from '../../../../src/shared/edits/model.js';
import { packMask } from '../../../../src/shared/masks/mask-ops.js';
import { createFakeContext } from './fake-context.js';

const W = 8;
const H = 6;
const GREEN = [0, 255, 0, 255];

/** Green on the left three columns, a unique color elsewhere */
function pattern() {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      rgba.set(x < 3 ? GREEN : [x * 20, y * 30, 200, 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

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
 * @param {{ method?: 'color' | 'ai', enabled?: boolean, touchUps?: object[] }} [opts]
 */
function editsOf({ method = 'color', enabled = true, touchUps = [] } = {}) {
  const edits = createDefaultEdits();
  edits.background = {
    ...edits.background,
    enabled,
    method,
    color: '#00ff00',
    tolerance: 5,
    mode: 'global',
  };
  edits.touchUps = /** @type {any} */ (touchUps);
  return edits;
}

/**
 * A one-point stroke on the pixel (px, py) of the 8x6 frame; radius 0.1 of
 * the shorter side (0.6 px) covers just that pixel
 * @param {'erase' | 'restore'} mode
 * @param {number} px
 * @param {number} py
 * @param {{ start?: number, end?: number, radius?: number }} [range]
 */
function dot(mode, px, py, { start = 0, end = 9, radius = 0.1 } = {}) {
  return {
    id: `${mode}-${px}-${py}`,
    mode,
    radius,
    points: [{ x: (px + 0.5) / W, y: (py + 0.5) / H }],
    start,
    end,
  };
}

/** @param {Uint8ClampedArray} rgba @param {number} width */
function alphaRows(rgba, width) {
  const rows = [];
  for (let i = 0; i < rgba.length / 4; i += width) {
    let row = '';
    for (let x = 0; x < width; x++) row += rgba[(i + x) * 4 + 3] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

/** @param {Uint8ClampedArray} rgba @param {number} width @param {number} x @param {number} y */
function pixel(rgba, width, x, y) {
  const o = (y * width + x) * 4;
  return Array.from(rgba.subarray(o, o + 4));
}

/** Mask over the whole frame at half resolution (4x3), '#' = kept */
function halfResMaskSource(/** @type {string[]} */ rows) {
  const binary = Uint8Array.from(rows.join(''), (ch) => (ch === '#' ? 1 : 0));
  const mask = packMask(binary, 4, 3);
  return { version: 1, getFinalMask: vi.fn(() => mask) };
}

beforeEach(() => {
  __resetComposeCacheForTests();
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      /** @param {number} w @param {number} h */
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }

      getContext() {
        return createFakeContext(0, 0, this);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetComposeCacheForTests();
});

describe('touch-ups over the color key', () => {
  it('erase removes a kept pixel; restore brings back a removed pixel with its original color', async () => {
    const edits = editsOf({ touchUps: [dot('erase', 5, 2), dot('restore', 1, 3)] });
    const result = await composeOutputFrameRGBA(patternFrame(), null, edits, 0);
    expect(alphaRows(result.data, W)).toEqual([
      '...#####',
      '...#####',
      '...##.##',
      '.#.#####',
      '...#####',
      '...#####',
    ]);
    expect(pixel(result.data, W, 1, 3)).toEqual(GREEN);
    expect(pixel(result.data, W, 5, 2)).toEqual([0, 0, 0, 0]);
  });

  it('applies only the strokes whose range covers the frame', async () => {
    const edits = editsOf({
      touchUps: [
        dot('restore', 0, 0, { start: 2, end: 2 }),
        dot('restore', 1, 0, { start: 0, end: 5 }),
      ],
    });
    const onFrame1 = await composeOutputFrameRGBA(patternFrame(), null, edits, 1);
    expect(alphaRows(onFrame1.data, W)[0]).toBe('.#.#####');
    const onFrame2 = await composeOutputFrameRGBA(patternFrame(), null, edits, 2);
    expect(alphaRows(onFrame2.data, W)[0]).toBe('##.#####');
    const onFrame6 = await composeOutputFrameRGBA(patternFrame(), null, edits, 6);
    expect(alphaRows(onFrame6.data, W)[0]).toBe('...#####');
  });

  it('does nothing while background removal is off (the frame stays untouched)', async () => {
    const edits = editsOf({ enabled: false, touchUps: [dot('erase', 5, 2)] });
    const result = await composeOutputFrameRGBA(patternFrame(), null, edits, 0);
    expect(result.data).toEqual(pattern());
  });

  it('maps the stroke from source coordinates into a crop', async () => {
    // Source pixel (1, 2) is region pixel (0, 1) of a crop at (1, 1)
    const crop = { x: 1, y: 1, width: 5, height: 4, aspectRatio: 'free' };
    const edits = editsOf({ touchUps: [dot('restore', 1, 2)] });
    const result = await composeOutputFrameRGBA(patternFrame(), crop, edits, 0);
    expect(alphaRows(result.data, 5)).toEqual(['..###', '#.###', '..###', '..###']);
    expect(pixel(result.data, 5, 0, 1)).toEqual(GREEN);
  });

  it('works at a smaller output scale', async () => {
    // 8x6 at 50%: 4x3; the restored source pixels (0..1, 0..1) are output pixel (0, 0)
    const edits = editsOf({ touchUps: [dot('restore', 1, 1, { radius: 0.2 })] });
    const result = await composeOutputFrameRGBA(patternFrame(), null, edits, 0, null, 0.5);
    expect(result.width).toBe(4);
    expect(result.data[3]).toBe(255);
    // A removed neighbour stays removed
    expect(result.data[(2 * 4 + 0) * 4 + 3]).toBe(0);
  });

  it('composeOutputFrame and composeEditorFrame render the same touched-up region', () => {
    const crop = { x: 1, y: 1, width: 5, height: 4, aspectRatio: 'free' };
    const edits = editsOf({ touchUps: [dot('restore', 1, 2), dot('erase', 4, 3)] });
    const out = createFakeContext();
    composeOutputFrame(out, patternFrame(), crop, edits, 0);
    const editor = createFakeContext();
    composeEditorFrame(editor, patternFrame(), crop, edits, 0);
    expect(editor.getImageData(1, 1, 5, 4).data).toEqual(out.getImageData(0, 0, 5, 4).data);
    expect(alphaRows(out.getImageData(0, 0, 5, 4).data, 5)).toEqual([
      '..###',
      '#.###',
      '..#.#',
      '..###',
    ]);
  });
});

describe('touch-ups over the AI mask', () => {
  const rows = ['.##.', '.##.', '....'];

  it('restore brings back pixels the mask removes, erase removes pixels it keeps', async () => {
    const maskSource = halfResMaskSource(rows);
    const edits = editsOf({
      method: 'ai',
      touchUps: [dot('restore', 0, 5), dot('erase', 3, 0)],
    });
    const result = await composeOutputFrameRGBA(patternFrame(), null, edits, 4, maskSource);
    expect(alphaRows(result.data, W)).toEqual([
      '..#.##..',
      '..####..',
      '..####..',
      '..####..',
      '........',
      '#.......',
    ]);
    // The restored pixel keeps its original (green) color: no color key runs
    expect(pixel(result.data, W, 0, 5)).toEqual(GREEN);
  });

  it('a frame without a mask keeps everything, and its touch-ups still apply', async () => {
    const none = { version: 2, getFinalMask: vi.fn(() => null) };
    const edits = editsOf({
      method: 'ai',
      touchUps: [dot('erase', 3, 0), dot('erase', 5, 2), dot('restore', 5, 2)],
    });
    const result = await composeOutputFrameRGBA(patternFrame(), null, edits, 0, none);
    // No mask = keep everything: erase removes its pixel, restore keeps its own
    expect(alphaRows(result.data, W)).toEqual([
      '###.####',
      '########',
      '########',
      '########',
      '########',
      '########',
    ]);
    expect(pixel(result.data, W, 5, 2)).toEqual(pixel(pattern(), W, 5, 2));

    // No mask source at all (the analysis never started): the same
    const noSource = await composeOutputFrameRGBA(patternFrame(), null, edits, 0, null);
    expect(noSource.data).toEqual(result.data);

    // Without touch-ups such a frame is drawn untouched
    const plain = await composeOutputFrameRGBA(
      patternFrame(),
      null,
      editsOf({ method: 'ai' }),
      0,
      none,
    );
    expect(plain.data).toEqual(pattern());
  });
});
