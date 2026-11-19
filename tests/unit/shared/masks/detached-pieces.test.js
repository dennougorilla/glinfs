/**
 * Colour reach = Detached pieces (task 7 item 3, "pieces-palette"): small
 * detached pieces in the clicked piece's palette go; the largest piece and
 * pieces of other colours stay.
 */
import { describe, expect, it } from 'vitest';
import {
  createPiecePalette,
  removeDetachedPieces,
} from '../../../../src/shared/masks/detached-pieces.js';

const W = 40;
const H = 30;
const BODY = [200, 160, 120];
const FLAME = [250, 120, 20];

/** A scene: a body (rows 5-24, cols 2-21), three flames (2x2) and one body-coloured speck */
function scene() {
  const mask = new Uint8Array(W * H);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const paint = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        mask[y * W + x] = 1;
        rgba.set([...rgb, 255], (y * W + x) * 4);
      }
    }
  };
  paint(2, 5, 22, 25, BODY);
  paint(30, 3, 32, 5, FLAME);
  paint(34, 10, 36, 12, FLAME);
  paint(30, 20, 32, 22, [FLAME[0] - 10, FLAME[1] + 10, FLAME[2]]); // a near shade
  paint(36, 26, 38, 28, BODY);
  return { mask, rgba };
}

describe('detached pieces', () => {
  it('the palette is the clicked piece colours (4 bits per channel, one step either way)', () => {
    const { mask, rgba } = scene();
    const palette = createPiecePalette(rgba, mask, W, H, { x: 30.5 / W, y: 3.5 / H });
    expect(palette).not.toBeNull();
    const at = (r, g, b) => palette?.[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)];
    expect(at(...FLAME)).toBe(1);
    expect(at(FLAME[0] - 16, FLAME[1] + 16, FLAME[2])).toBe(1);
    expect(at(...BODY)).toBe(0);
    // A click off every piece: no palette
    expect(createPiecePalette(rgba, mask, W, H, { x: 0.99, y: 0.01 })).toBeNull();
  });

  it('removes small detached pieces in the palette, keeps the largest and other colours', () => {
    const { mask, rgba } = scene();
    const palette = /** @type {Uint8Array} */ (
      createPiecePalette(rgba, mask, W, H, { x: 30.5 / W, y: 3.5 / H })
    );
    const out = mask.slice();
    const removed = removeDetachedPieces(out, W, H, rgba, palette);
    expect(removed).toBe(12);
    for (const [x, y] of [
      [30, 3],
      [34, 10],
      [30, 20],
    ]) {
      expect(out[y * W + x]).toBe(0);
    }
    expect(out[10 * W + 10]).toBe(1); // the body
    expect(out[26 * W + 36]).toBe(1); // a body-coloured speck
  });

  it('a piece above 2 % of the frame stays, even in the palette', () => {
    const { mask, rgba } = scene();
    const palette = /** @type {Uint8Array} */ (
      createPiecePalette(rgba, mask, W, H, { x: 10 / W, y: 10 / H })
    );
    const out = mask.slice();
    // The palette is the body's: the speck goes; the body is the largest piece
    expect(removeDetachedPieces(out, W, H, rgba, palette)).toBe(4);
    expect(out[10 * W + 10]).toBe(1);
  });
});
