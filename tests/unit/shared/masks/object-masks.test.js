import { describe, expect, it } from 'vitest';
import {
  applyObjectMasks,
  createObjectScratch,
  getObjectMaskSize,
  getRemoveGrowRadius,
  OBJECT_MASK_LONG_SIDE,
  OBJECT_MASK_THRESHOLD,
  upsampleThreshold,
} from '../../../../src/shared/masks/object-masks.js';

/**
 * 0/1 mask with a rectangle set
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number, number]} rect - x, y, width, height
 */
function rectMask(w, h, [rx, ry, rw, rh]) {
  const out = new Uint8Array(w * h);
  for (let y = ry; y < ry + rh; y++) out.fill(1, y * w + rx, y * w + rx + rw);
  return out;
}

/** @param {Uint8Array} mask */
const count = (mask) => mask.reduce((sum, v) => sum + v, 0);

describe('getObjectMaskSize', () => {
  it('keeps the frame aspect with the long side at the object size', () => {
    expect(getObjectMaskSize(1920, 1080)).toEqual({ width: OBJECT_MASK_LONG_SIDE, height: 144 });
    expect(getObjectMaskSize(1080, 1920)).toEqual({ width: 144, height: OBJECT_MASK_LONG_SIDE });
  });

  it('never upsamples a small frame and survives an empty one', () => {
    expect(getObjectMaskSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(getObjectMaskSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe('getRemoveGrowRadius', () => {
  it('is 2 px at 1024 and at least 1 px', () => {
    expect(getRemoveGrowRadius(1024)).toBe(2);
    expect(getRemoveGrowRadius(2048)).toBe(4);
    expect(getRemoveGrowRadius(64)).toBe(1);
  });
});

describe('upsampleThreshold', () => {
  it('thresholds a mask of the same size as is, at 128 or the given threshold', () => {
    const prob = Uint8Array.from([0, 127, 128, 255]);
    expect([...upsampleThreshold(prob, 2, 2, 2, 2)]).toEqual([0, 0, 1, 1]);
    expect([...upsampleThreshold(prob, 2, 2, 2, 2, undefined, 200)]).toEqual([0, 0, 0, 1]);
  });

  it('upsamples a block with its edge at the scaled position', () => {
    // Left half of a 4×2 source is inside
    const prob = Uint8Array.from([255, 255, 0, 0, 255, 255, 0, 0]);
    const out = upsampleThreshold(prob, 4, 2, 16, 8);
    for (let y = 0; y < 8; y++) {
      const row = [...out.subarray(y * 16, y * 16 + 16)];
      expect(row.slice(0, 8).every((v) => v === 1)).toBe(true);
      expect(row.slice(8).every((v) => v === 0)).toBe(true);
    }
  });

  it('reuses the output buffer', () => {
    const out = new Uint8Array(4);
    expect(upsampleThreshold(new Uint8Array(1).fill(200), 1, 1, 2, 2, out)).toBe(out);
    expect([...out]).toEqual([1, 1, 1, 1]);
  });
});

describe('applyObjectMasks', () => {
  const W = 32;
  const H = 16;

  it('returns the mask itself when no layer has a mask on the frame', () => {
    const mask = rectMask(W, H, [0, 0, 10, 10]);
    const scratch = createObjectScratch(W * H);
    expect(applyObjectMasks(mask, W, H, [], scratch)).toBe(mask);
    expect(applyObjectMasks(mask, W, H, [{ mode: 'remove', mask: null }], scratch)).toBe(mask);
  });

  it('subtracts a removed object, grown so no fringe stays, and leaves the input alone', () => {
    // Character at x 0..15, a shelf merged with it at x 16..31
    const mask = rectMask(W, H, [0, 0, W, H]);
    const before = mask.slice();
    const shelf = { data: rectMask(W, H, [16, 0, 16, H]).map((v) => v * 255), width: W, height: H };
    const out = applyObjectMasks(
      mask,
      W,
      H,
      [{ mode: 'remove', mask: shelf }],
      createObjectScratch(W * H),
    );
    expect(mask).toEqual(before);
    for (let y = 0; y < H; y++) {
      // Kept up to the grow radius (1 px at this width) before the shelf
      expect(out[y * W + 14]).toBe(1);
      expect(out[y * W + 15]).toBe(0);
      expect(out[y * W + 20]).toBe(0);
    }
    expect(count(out)).toBe(15 * H);
  });

  it('adds an added object, read at any size', () => {
    const mask = rectMask(W, H, [0, 0, 8, 8]);
    // Half-resolution object over the right half
    const arm = { data: rectMask(16, 8, [8, 0, 8, 8]).map((v) => v * 255), width: 16, height: 8 };
    const out = applyObjectMasks(
      mask,
      W,
      H,
      [{ mode: 'add', mask: arm }],
      createObjectScratch(W * H),
    );
    // The half-way column of the upsampled edge is below the object threshold
    expect(count(out)).toBe(64 + 15 * H);
    expect(out[5 * W + 3]).toBe(1);
    expect(out[5 * W + 20]).toBe(1);
    expect(out[5 * W + 12]).toBe(0);
  });

  it('ignores the part of an object below the object threshold', () => {
    // A neighbour the decoder half-included (146 of 255) stays
    const mask = new Uint8Array(W * H).fill(1);
    const data = new Uint8Array(W * H).fill(146);
    data.fill(255, 0, W * 4);
    const out = applyObjectMasks(
      mask,
      W,
      H,
      [{ mode: 'remove', mask: { data, width: W, height: H } }],
      createObjectScratch(W * H),
    );
    expect(146).toBeLessThan(OBJECT_MASK_THRESHOLD);
    // Rows 0..3 plus the 1 px grow are removed, the rest stays
    expect(count(out)).toBe(W * (H - 5));
  });

  it('applies layers in order: a later one wins where they overlap', () => {
    const mask = new Uint8Array(W * H);
    const all = { data: new Uint8Array(W * H).fill(255), width: W, height: H };
    const scratch = createObjectScratch(W * H);
    const addThenRemove = applyObjectMasks(
      mask,
      W,
      H,
      [
        { mode: 'add', mask: all },
        { mode: 'remove', mask: all },
      ],
      scratch,
    );
    expect(count(addThenRemove)).toBe(0);
    const removeThenAdd = applyObjectMasks(
      mask,
      W,
      H,
      [
        { mode: 'remove', mask: all },
        { mode: 'add', mask: all },
      ],
      scratch,
    );
    expect(count(removeThenAdd)).toBe(W * H);
  });
});
