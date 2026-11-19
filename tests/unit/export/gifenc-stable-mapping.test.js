import { describe, expect, it } from 'vitest';
import { createGifencEncoder } from '../../../src/features/export/encoders/gifenc-encoder.js';
import { renderGifFrames } from './gif-structure.js';

/**
 * A still pixel must keep its shown color from frame to frame. gifenc's
 * palette lookup let the first pixel of a 5-bit color key choose the index
 * for every pixel of that key, so a still pixel changed color whenever a
 * different pixel of its key came first (shimmer, and differencing lost).
 */

const W = 8;
const H = 2;

/** Row 0: one pixel of `first`, then gray 100; row 1: dark (palette anchors) */
function frame(first) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let x = 0; x < W; x++) {
    px.set(x === 0 ? [...first, 255] : [100, 100, 100, 255], x * 4);
    px.set([x < 4 ? 20 : 220, 20, 20, 255], (W + x) * 4);
  }
  return px;
}

describe('gifenc stable palette lookup', () => {
  it('shows a still pixel the same in every frame, whatever pixel of its key comes first', () => {
    // A clip-wide palette with gray 92 and 107 on either side of the key of
    // grays 96-103: 96 is nearest 92, 103 nearest 107
    const sample = new Uint8ClampedArray([
      ...[92, 92, 92, 255],
      ...[107, 107, 107, 255],
      ...[20, 20, 20, 255],
      ...[220, 20, 20, 255],
    ]);
    const encoder = createGifencEncoder();
    encoder.init({
      width: W,
      height: H,
      maxColors: 16,
      frameDelayMs: 100,
      loopCount: 0,
      quantizeFormat: 'rgb565',
      paletteInterval: 0,
      paletteSample: sample,
    });
    encoder.addFrame({ rgba: frame([96, 96, 96]), width: W, height: H }, 0);
    encoder.addFrame({ rgba: frame([103, 103, 103]), width: W, height: H }, 1);
    const [a, b] = renderGifFrames(encoder.finish());
    for (let x = 1; x < W; x++) {
      expect([...b.subarray(x * 4, x * 4 + 3)]).toEqual([...a.subarray(x * 4, x * 4 + 3)]);
    }
  });
});
