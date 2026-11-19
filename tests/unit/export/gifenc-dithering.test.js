import { describe, expect, it } from 'vitest';
import {
  createGifencEncoder,
  orderedDither,
} from '../../../src/features/export/encoders/gifenc-encoder.js';
import { renderGifFrames } from './gif-structure.js';

/**
 * Dithering: ordered (Bayer) dithering before palette mapping breaks the
 * bands of a smooth gradient into a fine pattern; positional, so static
 * pixels stay unchanged between frames, and alpha is never touched.
 */

const W = 128;
const H = 64;

/** A smooth diagonal gradient; with `cutout`, a transparent left third */
function gradient(cutout = false) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = 40 + x;
      px[i + 1] = 60 + y;
      px[i + 2] = 200 - x / 2;
      px[i + 3] = cutout && x < W / 3 ? 0 : 255;
    }
  }
  return px;
}

/** @param {Partial<import('../../../src/features/export/encoders/types.js').EncoderConfig>} config */
function encode(frames, config) {
  const encoder = createGifencEncoder();
  encoder.init({
    width: W,
    height: H,
    maxColors: 16,
    frameDelayMs: 100,
    loopCount: 0,
    quantizeFormat: 'rgb565',
    paletteInterval: 1,
    ...config,
  });
  for (const [f, rgba] of frames.entries()) encoder.addFrame({ rgba, width: W, height: H }, f);
  return encoder.finish();
}

/** Mean RGB error after an 8x8 block average: the banding the eye sees */
function banding(source, shown) {
  let sum = 0;
  let n = 0;
  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      for (let c = 0; c < 3; c++) {
        let a = 0;
        let b = 0;
        for (let y = by; y < by + 8; y++) {
          for (let x = bx; x < bx + 8; x++) {
            a += source[(y * W + x) * 4 + c];
            b += shown[(y * W + x) * 4 + c];
          }
        }
        sum += Math.abs(a - b) / 64;
        n++;
      }
    }
  }
  return sum / n;
}

describe('gifenc dithering', () => {
  it('reduces the banding of a smooth gradient', () => {
    const source = gradient();
    const plain = renderGifFrames(encode([source], {}))[0];
    const dithered = renderGifFrames(encode([source], { dithering: true }))[0];

    expect(banding(source, dithered)).toBeLessThan(banding(source, plain) * 0.75);
  });

  it('keeps transparent pixels exactly where the source has them', () => {
    const source = gradient(true);
    const [shown] = renderGifFrames(encode([source], { dithering: true, transparent: true }));
    for (let p = 3; p < source.length; p += 4) {
      expect(shown[p] === 255).toBe(source[p] >= 128);
    }
  });

  it('dithers a pixel the same way in every frame, so differencing still applies', () => {
    const out1 = orderedDither(gradient(), W, 16, new Uint8ClampedArray(W * H * 4));
    const out2 = orderedDither(gradient(), W, 16, new Uint8ClampedArray(W * H * 4));
    expect(out2).toEqual(out1);

    const still = [gradient(), gradient(), gradient()];
    const bytes = encode(still, { dithering: true, frameDifferencing: true });
    const whole = encode(still, { dithering: true });
    expect(bytes.length).toBeLessThan(whole.length * 0.6);
  });

  it('dithers with blue noise too: less banding, and the same offsets in every frame', () => {
    const source = gradient();
    const plain = renderGifFrames(encode([source], {}))[0];
    const blue = renderGifFrames(
      encode([source], { dithering: true, ditherPattern: 'blue-noise' }),
    )[0];
    expect(banding(source, blue)).toBeLessThan(banding(source, plain) * 0.75);

    const a = orderedDither(gradient(), W, 16, new Uint8ClampedArray(W * H * 4), 'blue-noise');
    const b = orderedDither(gradient(), W, 16, new Uint8ClampedArray(W * H * 4), 'blue-noise');
    expect(b).toEqual(a);
    // Not the Bayer pattern
    expect(a).not.toEqual(orderedDither(gradient(), W, 16, new Uint8ClampedArray(W * H * 4)));
  });
});
