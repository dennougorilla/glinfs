import { describe, expect, it } from 'vitest';
import { blueNoise64 } from '../../../src/features/export/encoders/blue-noise.js';
import {
  createGifencEncoder,
  hardenEdges,
  thresholdMap,
} from '../../../src/features/export/encoders/gifenc-encoder.js';
import { renderGifFrames } from './gif-structure.js';

/**
 * Cutout edges in GIFs: soft alpha becomes 1-bit by a hard threshold, a
 * matte blend then threshold, or a blue-noise stipple.
 */

const W = 64;
const H = 16;

/** Red subject whose alpha ramps 0 -> 255 left to right */
function ramp() {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = 220;
      px[i + 1] = 40;
      px[i + 2] = 40;
      px[i + 3] = Math.round((x / (W - 1)) * 255);
    }
  }
  return px;
}

const out = () => new Uint8ClampedArray(W * H * 4);
const keptShare = (rgba, x) => {
  let kept = 0;
  for (let y = 0; y < H; y++) kept += rgba[(y * W + x) * 4 + 3] === 255 ? 1 : 0;
  return kept / H;
};

describe('blue noise threshold map', () => {
  it('holds every level 0-255 exactly 16 times', () => {
    const values = blueNoise64();
    expect(values.length).toBe(64 * 64);
    const counts = new Array(256).fill(0);
    for (const v of values) counts[v]++;
    expect(counts.every((c) => c === 16)).toBe(true);
  });

  it('spreads any one level evenly: no two of the darkest 1/16 are neighbours', () => {
    const values = blueNoise64();
    for (let p = 0; p < values.length; p++) {
      if (values[p] >= 16) continue;
      const x = p % 64;
      const y = (p / 64) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1],
      ]) {
        const q = ((y + dy + 64) % 64) * 64 + ((x + dx) % 64);
        expect(values[q]).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it('gives both maps levels in [0, 1) with mean 1/2', () => {
    for (const pattern of /** @type {const} */ (['bayer', 'blue-noise'])) {
      const { size, levels } = thresholdMap(pattern);
      expect(levels.length).toBe(size * size);
      const mean = levels.reduce((s, l) => s + l, 0) / levels.length;
      expect(mean).toBeCloseTo(0.5, 6);
      expect(Math.min(...levels)).toBeGreaterThan(0);
      expect(Math.max(...levels)).toBeLessThan(1);
    }
  });
});

describe('hardenEdges', () => {
  it('returns the frame itself when no alpha is soft', () => {
    const px = ramp();
    for (let p = 3; p < px.length; p += 4) px[p] = px[p] >= 128 ? 255 : 0;
    for (const mode of /** @type {const} */ (['threshold', 'matte', 'dither'])) {
      expect(hardenEdges(px, W, mode, [255, 255, 255], out())).toBe(px);
    }
  });

  it('threshold: keeps alpha >= 128 with colours unchanged', () => {
    const px = ramp();
    const hard = hardenEdges(px, W, 'threshold', [0, 0, 0], out());
    for (let p = 0; p < px.length; p += 4) {
      expect(hard[p + 3]).toBe(px[p + 3] >= 128 ? 255 : 0);
      expect([hard[p], hard[p + 1], hard[p + 2]]).toEqual([220, 40, 40]);
    }
  });

  it('matte: blends the soft edge into the matte colour, alpha as threshold', () => {
    const px = ramp();
    const hard = hardenEdges(px, W, 'matte', [255, 255, 255], out());
    const x = 40; // alpha 162
    const i = x * 4;
    const k = px[i + 3] / 255;
    expect(hard[i + 3]).toBe(255);
    expect(hard[i]).toBe(Math.round(220 * k + 255 * (1 - k)));
    expect(hard[i + 1]).toBe(Math.round(40 * k + 255 * (1 - k)));
    // Fully opaque pixels keep their colour
    expect(hard[(W - 1) * 4 + 1]).toBe(40);
  });

  it('dither: keeps a share of each column that follows alpha', () => {
    const hard = hardenEdges(ramp(), W, 'dither', [0, 0, 0], out());
    expect(keptShare(hard, 0)).toBe(0);
    expect(keptShare(hard, W - 1)).toBe(1);
    // A soft column is a stipple, not all or nothing
    const mid = keptShare(hard, W / 2);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    // Positional: the same frame gives the same stipple
    expect(hardenEdges(ramp(), W, 'dither', [0, 0, 0], out())).toEqual(hard);
  });
});

describe('gifenc cutout edge modes', () => {
  /** @param {Partial<import('../../../src/features/export/encoders/types.js').EncoderConfig>} config */
  const encode = (config) => {
    const encoder = createGifencEncoder();
    encoder.init({
      width: W,
      height: H,
      maxColors: 16,
      frameDelayMs: 100,
      loopCount: 0,
      quantizeFormat: 'rgb565',
      paletteInterval: 1,
      transparent: true,
      ...config,
    });
    encoder.addFrame({ rgba: ramp(), width: W, height: H }, 0);
    return renderGifFrames(encoder.finish())[0];
  };

  it('writes the matte-blended edge (lighter than the subject on a white matte)', () => {
    const plain = encode({});
    const matte = encode({ edge: 'matte', matteColor: [255, 255, 255] });
    const i = 40 * 4;
    expect(matte[i + 3]).toBe(255);
    expect(matte[i + 1]).toBeGreaterThan(plain[i + 1] + 40);
  });

  it('writes a stipple for the dithered edge', () => {
    const shown = encode({ edge: 'dither' });
    const mid = keptShare(shown, W / 2);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });

  it('ignores the edge mode for opaque exports', () => {
    const a = encode({ transparent: false });
    const b = encode({ transparent: false, edge: 'dither' });
    expect(b).toEqual(a);
  });
});
