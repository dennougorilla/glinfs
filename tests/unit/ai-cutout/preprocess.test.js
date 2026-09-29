import { describe, expect, it } from 'vitest';
import {
  computeLetterbox,
  computeMaskSize,
  probabilityToMask,
  rgbaToChw,
} from '../../../src/features/ai-cutout/preprocess.js';

/**
 * Reference for upstream's geometry (Python):
 *   h, w = (s, int(s * w / h)) if h > w else (int(s * h / w), s)
 *   ph, pw = s - h, s - w  ->  offsets ph // 2, pw // 2
 */
function pythonLetterbox(w0, h0, s = 1024) {
  const [h, w] = h0 > w0 ? [s, Math.trunc((s * w0) / h0)] : [Math.trunc((s * h0) / w0), s];
  return { width: w, height: h, padX: Math.floor((s - w) / 2), padY: Math.floor((s - h) / 2) };
}

describe('computeLetterbox', () => {
  it('fits a landscape source to the width and pads top/bottom', () => {
    expect(computeLetterbox(1280, 720)).toEqual({
      size: 1024,
      width: 1024,
      height: 576,
      padX: 0,
      padY: 224,
    });
  });

  it('fits a portrait source to the height and pads left/right', () => {
    expect(computeLetterbox(480, 640)).toEqual({
      size: 1024,
      width: 768,
      height: 1024,
      padX: 128,
      padY: 0,
    });
  });

  it('treats a square source like upstream (else branch: full size)', () => {
    expect(computeLetterbox(300, 300)).toEqual({
      size: 1024,
      width: 1024,
      height: 1024,
      padX: 0,
      padY: 0,
    });
  });

  it('truncates the short side and floors the padding exactly like upstream', () => {
    const cases = [
      [1967, 1360],
      [512, 714],
      [512, 853],
      [1000, 3],
      [3, 1000],
      [641, 479],
      [1919, 1081],
    ];
    for (const [w, h] of cases) {
      const { size: _size, ...geometry } = computeLetterbox(w, h);
      expect(geometry).toEqual(pythonLetterbox(w, h));
    }
  });

  it('never produces an empty content rectangle', () => {
    const box = computeLetterbox(10000, 1);
    expect(box.height).toBe(1);
    expect(box.padY).toBe(511);
  });

  it('supports other model sizes', () => {
    expect(computeLetterbox(200, 100, 64)).toMatchObject({ width: 64, height: 32, padY: 16 });
  });

  it('rejects non-positive sizes', () => {
    expect(() => computeLetterbox(0, 10)).toThrow(RangeError);
    expect(() => computeLetterbox(10, Number.NaN)).toThrow(RangeError);
  });
});

describe('computeMaskSize', () => {
  it('scales the long side down to 1024', () => {
    expect(computeMaskSize(1920, 1080)).toEqual({ width: 1024, height: 576 });
    expect(computeMaskSize(1080, 1920)).toEqual({ width: 576, height: 1024 });
    expect(computeMaskSize(1967, 1360)).toEqual({ width: 1024, height: 708 });
  });

  it('never scales up', () => {
    expect(computeMaskSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(computeMaskSize(1024, 10)).toEqual({ width: 1024, height: 10 });
  });

  it('keeps at least one pixel per side', () => {
    expect(computeMaskSize(5000, 1)).toEqual({ width: 1024, height: 1 });
  });

  it('honours a custom limit', () => {
    expect(computeMaskSize(400, 200, 100)).toEqual({ width: 100, height: 50 });
  });

  it('rejects non-positive sizes', () => {
    expect(() => computeMaskSize(-1, 10)).toThrow(RangeError);
  });
});

describe('rgbaToChw', () => {
  it('writes R, G, B planes divided by 255 and ignores alpha', () => {
    // 2×1 image: red-ish pixel, then a white transparent one
    const rgba = new Uint8ClampedArray([255, 51, 0, 255, 255, 255, 255, 0]);
    const tensor = rgbaToChw(rgba, 2, 1);
    expect(Array.from(tensor)).toEqual([1, 1, Math.fround(0.2), 1, 0, 1]);
  });

  it('reuses the output buffer', () => {
    const out = new Float32Array(3);
    const result = rgbaToChw(new Uint8Array([0, 0, 255, 255]), 1, 1, out);
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([0, 0, 1]);
  });

  it('rejects mismatched buffers', () => {
    expect(() => rgbaToChw(new Uint8Array(3), 1, 1)).toThrow(RangeError);
    expect(() => rgbaToChw(new Uint8Array(4), 1, 1, new Float32Array(2))).toThrow(RangeError);
  });
});

describe('probabilityToMask', () => {
  /**
   * An s×s output whose content rectangle holds `fill(x, y)` (content
   * coordinates) and whose padding holds 0.5 (so leaks are visible).
   */
  function makeOutput(letterbox, fill) {
    const { size, width, height, padX, padY } = letterbox;
    const out = new Float32Array(size * size).fill(0.5);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        out[(padY + y) * size + padX + x] = fill(x, y);
      }
    }
    return out;
  }

  it('crops the padding and copies the content 1:1 at the same size', () => {
    const box = computeLetterbox(8, 4, 8); // content 8×4, padY 2
    const output = makeOutput(box, (x, y) => (x + y * 8) / 31);
    const mask = probabilityToMask(output, box, 8, 4);
    expect(mask.width).toBe(8);
    expect(mask.height).toBe(4);
    for (let i = 0; i < 32; i++) {
      expect(mask.data[i]).toBe(Math.round((i / 31) * 255));
    }
  });

  it('crops horizontal padding for portrait content', () => {
    const box = computeLetterbox(2, 4, 8); // content 4×8, padX 2
    const output = makeOutput(box, (x) => (x < 2 ? 1 : 0));
    const mask = probabilityToMask(output, box, 4, 8);
    for (let y = 0; y < 8; y++) {
      expect(Array.from(mask.data.slice(y * 4, y * 4 + 4))).toEqual([255, 255, 0, 0]);
    }
  });

  it('resamples bilinearly on pixel centres (cv2 INTER_LINEAR)', () => {
    const box = { size: 4, width: 4, height: 1, padX: 0, padY: 0 };
    // Row [0, 1, 0, 1] shrunk to 2 px: centres at 0.5 and 2.5 → 0.5 each
    const output = new Float32Array(16);
    output.set([0, 1, 0, 1]);
    const mask = probabilityToMask(output, box, 2, 1);
    expect(Array.from(mask.data)).toEqual([128, 128]);

    // Row [0, 1] grown to 4 px: 0, 0.25, 0.75, 1 (edges clamp)
    const small = { size: 2, width: 2, height: 1, padX: 0, padY: 0 };
    const grown = probabilityToMask(new Float32Array([0, 1, 0, 0]), small, 4, 1);
    expect(Array.from(grown.data)).toEqual([0, 64, 191, 255]);
  });

  it('clamps values outside [0, 1] and maps NaN to 0', () => {
    const box = { size: 2, width: 2, height: 1, padX: 0, padY: 0 };
    const mask = probabilityToMask(new Float32Array([-0.5, 1.5, 0, 0]), box, 2, 1);
    expect(Array.from(mask.data)).toEqual([0, 255]);
    const nan = probabilityToMask(new Float32Array([Number.NaN, 0.5, 0, 0]), box, 2, 1);
    expect(Array.from(nan.data)).toEqual([0, 128]);
  });

  it('rejects an output of the wrong size and empty masks', () => {
    const box = computeLetterbox(4, 4, 4);
    expect(() => probabilityToMask(new Float32Array(15), box, 4, 4)).toThrow(RangeError);
    expect(() => probabilityToMask(new Float32Array(16), box, 0, 4)).toThrow(RangeError);
  });
});
