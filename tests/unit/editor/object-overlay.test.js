import { describe, expect, it } from 'vitest';
import { getObjectColor, OBJECT_COLORS } from '../../../src/features/editor/object-colors.js';
import { paintRegions } from '../../../src/features/editor/object-overlay.js';

/**
 * A 0..255 mask with a filled rectangle
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number, number]} r - x0, y0, x1, y1 (exclusive)
 */
function maskOf(w, h, [x0, y0, x1, y1]) {
  const data = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) data.fill(255, y * w + x0, y * w + x1);
  return { data, width: w, height: h };
}

/** @param {Uint8ClampedArray} out @param {number} w @param {number} x @param {number} y */
const px = (out, w, x, y) => [...out.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe('paintRegions', () => {
  const W = 20;
  const H = 20;

  it('fills a region in its colour with an opaque outline, nothing outside', () => {
    const out = new Uint8ClampedArray(W * H * 4);
    paintRegions(
      out,
      W,
      H,
      [{ mode: 'remove', color: '#3b82f6', mask: maskOf(W, H, [4, 4, 14, 14]) }],
      {
        line: 1,
      },
    );
    expect(px(out, W, 9, 9)).toEqual([59, 130, 246, 90]);
    expect(px(out, W, 4, 9)).toEqual([59, 130, 246, 255]);
    expect(px(out, W, 2, 9)).toEqual([0, 0, 0, 0]);
  });

  it("dashes a kept region's outline and emphasizes the highlighted region", () => {
    const out = new Uint8ClampedArray(W * H * 4);
    const regions = [
      { mode: /** @type {const} */ ('add'), color: '#10b981', mask: maskOf(W, H, [0, 0, 10, 20]) },
      {
        mode: /** @type {const} */ ('remove'),
        color: '#f59e0b',
        mask: maskOf(W, H, [12, 0, 20, 20]),
      },
    ];
    paintRegions(out, W, H, regions, { line: 1, highlight: 1 });
    // The kept region's left edge (x = 0): dashed, so some edge pixels are fill only
    const edge = Array.from({ length: H }, (_, y) => px(out, W, 0, y)[3]);
    expect(edge.some((a) => a === 120)).toBe(true);
    expect(edge.some((a) => a === 40)).toBe(true);
    // Faded fill on the other, stronger fill on the highlighted one
    expect(px(out, W, 5, 10)[3]).toBe(40);
    expect(px(out, W, 16, 10)[3]).toBe(140);
  });

  it('scales a mask of another size to the overlay', () => {
    const out = new Uint8ClampedArray(W * H * 4);
    paintRegions(
      out,
      W,
      H,
      [{ mode: 'remove', color: '#3b82f6', mask: maskOf(10, 10, [0, 0, 5, 10]) }],
      {
        line: 1,
      },
    );
    expect(px(out, W, 5, 10)[3]).toBe(90);
    expect(px(out, W, 15, 10)[3]).toBe(0);
  });
});

describe('getObjectColor', () => {
  it('gives each fix-up the colour of its place in the list', () => {
    const objects = [{ id: 'a' }, { id: 'b' }];
    expect(getObjectColor(objects, 'a')).toBe(OBJECT_COLORS[0]);
    expect(getObjectColor(objects, 'b')).toBe(OBJECT_COLORS[1]);
    expect(new Set(OBJECT_COLORS).size).toBe(OBJECT_COLORS.length);
  });
});
