/**
 * Touch-ups (mask brush): stroke rasterization onto a removal decision,
 * stroke paths while painting, cache signatures, and the decide/clear split of the
 * color key and the AI mask that touch-ups rely on.
 */

import { describe, expect, it } from 'vitest';
import {
  applyColorKey,
  clearDecidedPixels,
  decideColorKey,
} from '../../../../src/shared/edits/color-key.js';
import { EDIT_LIMITS, normalizeEdits } from '../../../../src/shared/edits/model.js';
import {
  applyTouchUpsToDecision,
  extendStrokePath,
  getStrokePathPoints,
  getTouchUpsSignature,
  startStrokePath,
  touchUpRadiusPx,
} from '../../../../src/shared/edits/touch-ups.js';
import {
  applyMaskToRegion,
  decideMaskRemoval,
  packMask,
} from '../../../../src/shared/masks/mask-ops.js';

/**
 * @param {Partial<import('../../../../src/shared/edits/model.js').TouchUp>} partial
 * @returns {import('../../../../src/shared/edits/model.js').TouchUp}
 */
function stroke(partial) {
  return { id: 's', mode: 'erase', radius: 0.1, points: [], start: 0, end: 0, ...partial };
}

/**
 * Decision as rows of '1'/'0'
 * @param {Uint8Array} decision
 * @param {number} width
 * @param {number} height
 */
function rows(decision, width, height) {
  const out = [];
  for (let y = 0; y < height; y++) {
    out.push(Array.from(decision.subarray(y * width, y * width + width)).join(''));
  }
  return out;
}

/** Deterministic pseudo-random bytes */
function randomBytes(length, seed = 1) {
  const out = new Uint8ClampedArray(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (x >> 16) & 0xff;
  }
  return out;
}

describe('applyTouchUpsToDecision', () => {
  const full = { x: 0, y: 0, width: 10, height: 10 };

  it('erases a disc around a single point (radius from the shorter side)', () => {
    const decision = new Uint8Array(100);
    // radius 0.2 * 10 = 2 source px around the center of pixel (4, 4)
    applyTouchUpsToDecision(
      decision,
      10,
      10,
      [stroke({ radius: 0.2, points: [{ x: 0.45, y: 0.45 }] })],
      full,
      10,
      10,
    );
    expect(rows(decision, 10, 10)).toEqual([
      '0000000000',
      '0000000000',
      '0000100000',
      '0001110000',
      '0011111000',
      '0001110000',
      '0000100000',
      '0000000000',
      '0000000000',
      '0000000000',
    ]);
  });

  it('covers the whole path of a stroke, and restore keeps what erase removed', () => {
    const decision = new Uint8Array(100).fill(1);
    applyTouchUpsToDecision(
      decision,
      10,
      10,
      [
        stroke({
          mode: 'restore',
          radius: 0.05,
          points: [
            { x: 0.15, y: 0.55 },
            { x: 0.85, y: 0.55 },
          ],
        }),
      ],
      full,
      10,
      10,
    );
    expect(rows(decision, 10, 10)[5]).toBe('1000000001');
    expect(rows(decision, 10, 10)[4]).toBe('1111111111');
  });

  it('applies strokes in order: a later stroke wins where they overlap', () => {
    const point = [{ x: 0.55, y: 0.55 }];
    const eraseThenRestore = new Uint8Array(100);
    applyTouchUpsToDecision(
      eraseThenRestore,
      10,
      10,
      [
        stroke({ id: 'a', radius: 0.3, points: point }),
        stroke({ id: 'b', mode: 'restore', radius: 0.1, points: point }),
      ],
      full,
      10,
      10,
    );
    expect(eraseThenRestore[5 * 10 + 5]).toBe(0);
    expect(eraseThenRestore[5 * 10 + 2]).toBe(1);

    const restoreThenErase = new Uint8Array(100);
    applyTouchUpsToDecision(
      restoreThenErase,
      10,
      10,
      [
        stroke({ id: 'b', mode: 'restore', radius: 0.1, points: point }),
        stroke({ id: 'a', radius: 0.3, points: point }),
      ],
      full,
      10,
      10,
    );
    expect(restoreThenErase[5 * 10 + 5]).toBe(1);
  });

  it('maps source coordinates into a cropped region', () => {
    // Crop starting at (4, 4): the stroke at source pixel (5, 5) lands on region pixel (1, 1)
    const decision = new Uint8Array(16);
    applyTouchUpsToDecision(
      decision,
      4,
      4,
      [stroke({ radius: 0.05, points: [{ x: 0.55, y: 0.55 }] })],
      { x: 4, y: 4, width: 4, height: 4 },
      10,
      10,
    );
    expect(rows(decision, 4, 4)).toEqual(['0000', '0100', '0000', '0000']);
  });

  it('maps into a scaled-down output and never gets thinner than one output pixel', () => {
    // 10x10 source drawn at 5x5: output pixel (2, 2) shows source (4..6, 4..6)
    const decision = new Uint8Array(25);
    applyTouchUpsToDecision(
      decision,
      5,
      5,
      [stroke({ radius: 0.01, points: [{ x: 0.5, y: 0.5 }] })],
      full,
      10,
      10,
    );
    expect(rows(decision, 5, 5)).toEqual(['00000', '00000', '00100', '00000', '00000']);
  });

  it('ignores strokes without points and degenerate regions', () => {
    const decision = new Uint8Array(4);
    applyTouchUpsToDecision(decision, 2, 2, [stroke({ points: [] })], full, 10, 10);
    applyTouchUpsToDecision(decision, 0, 2, [stroke({ points: [{ x: 0, y: 0 }] })], full, 10, 10);
    applyTouchUpsToDecision(decision, 2, 2, [stroke({ points: [{ x: 0, y: 0 }] })], full, 0, 10);
    expect(Array.from(decision)).toEqual([0, 0, 0, 0]);
  });

  it('paints exactly the pixels whose centers lie within the radius of the path', () => {
    // Reference: test every pixel center against every segment
    /**
     * @param {Uint8Array} decision
     * @param {number} rw
     * @param {number} rh
     * @param {import('../../../../src/shared/edits/model.js').TouchUp} s
     * @param {{ x: number, y: number, width: number, height: number }} region
     * @param {number} sw
     * @param {number} sh
     */
    const reference = (decision, rw, rh, s, region, sw, sh) => {
      const scaleX = region.width / rw;
      const scaleY = region.height / rh;
      const r = Math.max(touchUpRadiusPx(s.radius, sw, sh), 0.5 * Math.max(scaleX, scaleY));
      const pts = s.points.map((p) => ({ x: p.x * sw, y: p.y * sh }));
      for (let y = 0; y < rh; y++) {
        const cy = region.y + (y + 0.5) * scaleY;
        for (let x = 0; x < rw; x++) {
          const cx = region.x + (x + 0.5) * scaleX;
          const inside = pts.some((a, i) => {
            const b = pts[Math.min(i + 1, pts.length - 1)];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            const t =
              lenSq > 0 ? Math.min(1, Math.max(0, ((cx - a.x) * dx + (cy - a.y) * dy) / lenSq)) : 0;
            return (cx - a.x - t * dx) ** 2 + (cy - a.y - t * dy) ** 2 <= r * r;
          });
          if (inside) decision[y * rw + x] = s.mode === 'restore' ? 0 : 1;
        }
      }
    };
    const rand = randomBytes(4000, 7);
    let k = 0;
    const next = () => rand[k++] / 255;
    for (let trial = 0; trial < 60; trial++) {
      const sw = 20 + Math.floor(next() * 40);
      const sh = 20 + Math.floor(next() * 40);
      const region = {
        x: Math.floor(next() * 6),
        y: Math.floor(next() * 6),
        width: sw - 8,
        height: sh - 8,
      };
      // Same size, scaled down, or a fractional crop
      const scale = [1, 0.5, 0.37][trial % 3];
      const rw = Math.max(1, Math.floor(region.width * scale));
      const rh = Math.max(1, Math.floor(region.height * scale));
      const count = 1 + Math.floor(next() * 6);
      const s = stroke({
        mode: trial % 2 ? 'restore' : 'erase',
        radius: 0.01 + next() * 0.15,
        // Some points on one axis, some repeated, some past the edges
        points: Array.from({ length: count }, (_, i) => ({
          x: i % 3 === 1 ? 0.5 : next() * 1.2 - 0.1,
          y: i % 4 === 2 ? 0.5 : next() * 1.2 - 0.1,
        })),
      });
      const fill = trial % 2 ? 1 : 0;
      const expected = new Uint8Array(rw * rh).fill(fill);
      reference(expected, rw, rh, s, region, sw, sh);
      const actual = new Uint8Array(rw * rh).fill(fill);
      applyTouchUpsToDecision(actual, rw, rh, [s], region, sw, sh);
      expect(rows(actual, rw, rh)).toEqual(rows(expected, rw, rh));
    }
  });

  it('touchUpRadiusPx scales by the shorter side', () => {
    expect(touchUpRadiusPx(0.1, 200, 100)).toBe(10);
    expect(touchUpRadiusPx(0.1, 100, 300)).toBe(10);
  });
});

describe('stroke paths (painting)', () => {
  it('thins points closer than a quarter radius to the last kept one; the tail is kept too', () => {
    // 100x100 source, radius 0.2 = 20 px: 5 px spacing
    const path = startStrokePath({ x: 0, y: 0 }, 0.2, 100, 100);
    expect(path.minDistancePx).toBe(5);
    expect(extendStrokePath(path, { x: 0.01, y: 0 })).toBe(true);
    expect(extendStrokePath(path, { x: 0.01, y: 0 })).toBe(false);
    expect(extendStrokePath(path, { x: 0.02, y: 0 })).toBe(true);
    expect(path.points).toEqual([{ x: 0, y: 0 }]);
    expect(getStrokePathPoints(path)).toEqual([
      { x: 0, y: 0 },
      { x: 0.02, y: 0 },
    ]);
    extendStrokePath(path, { x: 0.1, y: 0 });
    extendStrokePath(path, { x: 0.12, y: 0 });
    expect(getStrokePathPoints(path)).toEqual([
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.12, y: 0 },
    ]);
    // Back on the last kept point: no tail
    extendStrokePath(path, { x: 0.1, y: 0 });
    expect(getStrokePathPoints(path)).toEqual([
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
    ]);
  });

  it('measures in source pixels (aspect ratio matters), at least 1 px apart', () => {
    // 1000x10: radius 0.1 = 1 px, so the spacing is 1 px; 0.1 of 10 px tall = 1 px
    const path = startStrokePath({ x: 0, y: 0 }, 0.1, 1000, 10);
    expect(path.minDistancePx).toBe(1);
    extendStrokePath(path, { x: 0, y: 0.05 });
    extendStrokePath(path, { x: 0, y: 0.1 });
    expect(path.points).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0.1 },
    ]);
  });

  it('keeps a long stroke within the point limit with the save rule, so saving changes nothing', () => {
    const max = EDIT_LIMITS.touchUpPoints.max;
    const path = startStrokePath({ x: 0, y: 0.5 }, 0.01, 1000, 1000);
    /** @type {{ x: number, y: number }[]} */
    const all = [path.points[0]];
    for (let i = 1; i <= 3 * max; i++) {
      const p = { x: i / (3 * max), y: 0.5 + 0.1 * Math.sin(i / 7) };
      all.push(p);
      extendStrokePath(path, p);
      const points = getStrokePathPoints(path);
      expect(points.length).toBeLessThanOrEqual(max);
    }
    expect(path.minDistancePx).toBeGreaterThan(2.5);
    const painted = getStrokePathPoints(path);
    expect(painted[0]).toEqual(all[0]);
    expect(painted.at(-1)).toEqual(all.at(-1));
    // What normalizeEdits keeps is exactly the painted stroke
    const saved = normalizeEdits(
      {
        touchUps: [{ id: 'a', mode: 'erase', radius: 0.01, points: painted, start: 0, end: 0 }],
      },
      1,
    ).touchUps[0];
    expect(saved.points).toEqual(painted);
  });
});

describe('getTouchUpsSignature', () => {
  it('is empty without strokes and memoized per array', () => {
    expect(getTouchUpsSignature([])).toBe('');
    expect(getTouchUpsSignature(null)).toBe('');
    const strokes = [stroke({ id: 'a', points: [{ x: 0, y: 0 }] })];
    const first = getTouchUpsSignature(strokes);
    expect(getTouchUpsSignature(strokes)).toBe(first);
    expect(first).toContain('a:erase');
  });

  it('differs when a stroke, its range or its point count differs', () => {
    const base = stroke({ id: 'a', points: [{ x: 0, y: 0 }] });
    const sig = getTouchUpsSignature([base]);
    expect(getTouchUpsSignature([{ ...base, end: 3 }])).not.toBe(sig);
    expect(getTouchUpsSignature([{ ...base, points: [...base.points, { x: 1, y: 1 }] }])).not.toBe(
      sig,
    );
    expect(getTouchUpsSignature([{ ...base, id: 'b' }])).not.toBe(sig);
  });
});

describe('decide, then clear: same pixels as the one-step removal', () => {
  const background = (/** @type {'connected' | 'global'} */ mode) => ({
    enabled: true,
    method: /** @type {const} */ ('color'),
    color: '#808080',
    tolerance: 30,
    mode,
    colorChosen: true,
    ai: { threshold: 0.5, smoothing: true, edge: 0, picks: [] },
  });

  for (const mode of /** @type {const} */ (['connected', 'global'])) {
    it(`color key (${mode}) on noisy pixels with random alpha`, () => {
      const width = 37;
      const height = 23;
      const source = randomBytes(width * height * 4, mode === 'global' ? 7 : 11);
      const oneStep = source.slice();
      const cleared = applyColorKey(oneStep, width, height, background(mode));

      const twoStep = source.slice();
      const decision = decideColorKey(twoStep, width, height, background(mode));
      expect(decision).not.toBeNull();
      // Deciding never touches the pixels
      expect(twoStep).toEqual(source);
      const cleared2 = clearDecidedPixels(
        twoStep,
        /** @type {Uint8Array} */ (decision),
        width * height,
      );
      expect(twoStep).toEqual(oneStep);
      expect(cleared2).toBe(cleared);
      expect(cleared).toBeGreaterThan(0);
    });
  }

  it('decideColorKey returns null when the color key does not run', () => {
    const rgba = new Uint8ClampedArray(4);
    expect(decideColorKey(rgba, 1, 1, null)).toBeNull();
    expect(decideColorKey(rgba, 1, 1, { ...background('global'), enabled: false })).toBeNull();
    expect(decideColorKey(rgba, 1, 1, { ...background('global'), method: 'ai' })).toBeNull();
    expect(decideColorKey(rgba, 1, 1, { ...background('global'), color: 'x' })).toBeNull();
    expect(decideColorKey(rgba, 0, 1, background('global'))).toBeNull();
  });

  it('AI mask decision clears exactly what applyMaskToRegion clears', () => {
    const maskW = 7;
    const maskH = 5;
    const binary = Uint8Array.from(randomBytes(maskW * maskH, 3), (v) => v & 1);
    const packed = packMask(binary, maskW, maskH);
    const region = { x: 3, y: 2, width: 11, height: 9 };
    const regionW = 6;
    const regionH = 4;
    const source = randomBytes(regionW * regionH * 4, 5);

    const oneStep = source.slice();
    applyMaskToRegion(oneStep, regionW, regionH, packed.bits, maskW, maskH, region, 20, 14);

    const out = new Uint8Array(64).fill(9);
    const decision = decideMaskRemoval(
      regionW,
      regionH,
      packed.bits,
      maskW,
      maskH,
      region,
      20,
      14,
      out,
    );
    expect(decision).toBe(out);
    const twoStep = source.slice();
    clearDecidedPixels(twoStep, decision, regionW * regionH);
    expect(twoStep).toEqual(oneStep);
  });

  it('decideMaskRemoval keeps everything for degenerate sizes', () => {
    const bits = new Uint8Array([0]);
    const region = { x: 0, y: 0, width: 1, height: 1 };
    expect(Array.from(decideMaskRemoval(1, 1, bits, 0, 1, region, 1, 1))).toEqual([0]);
    expect(decideMaskRemoval(0, 1, bits, 1, 1, region, 1, 1).length).toBe(0);
    expect(Array.from(decideMaskRemoval(1, 1, bits, 1, 1, region, 1, 1))).toEqual([1]);
  });
});
