import { describe, expect, it } from 'vitest';
import {
  applyMaskToRegion,
  createPickTracker,
  findPickedComponent,
  labelComponents,
  maskBit,
  morphMask,
  PICK_SNAP_RADIUS_FRACTION,
  packedMaskBytes,
  packMask,
  resampleNearest,
  smoothTemporal,
  TRACK_JOIN_IOU,
  thresholdCutoff,
  thresholdMask,
  trackPicks,
  unpackMask,
} from '../../../../src/shared/masks/mask-ops.js';

/**
 * Binary mask from rows of '#' (1) and '.' (0)
 * @param {string[]} rows
 */
function fromRows(rows) {
  const width = rows[0].length;
  const height = rows.length;
  const binary = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      binary[y * width + x] = ch === '#' ? 1 : 0;
    });
  });
  return { binary, width, height };
}

/**
 * Rows of '#'/'.' from a 0/1 mask (labels print as digits)
 * @param {ArrayLike<number>} mask
 * @param {number} width
 */
function toRows(mask, width) {
  const rows = [];
  for (let i = 0; i < mask.length; i += width) {
    let row = '';
    for (let x = 0; x < width; x++) row += mask[i + x] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

/** @typedef {[number, number, number, number]} Rect x, y, w, h */

/**
 * Binary mask with filled rectangles
 * @param {number} width
 * @param {number} height
 * @param {Rect[]} rects
 */
function scene(width, height, rects) {
  const binary = new Uint8Array(width * height);
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = Math.max(0, ry); y < Math.min(height, ry + rh); y++) {
      for (let x = Math.max(0, rx); x < Math.min(width, rx + rw); x++) binary[y * width + x] = 1;
    }
  }
  return binary;
}

/**
 * Tracking fixture: frame f shows the rectangles rectsAt(f)
 * @param {number} frameCount
 * @param {number} width
 * @param {number} height
 * @param {(frame: number) => Rect[] | null} rectsAt
 * @param {import('../../../../src/shared/masks/mask-ops.js').Pick[]} picks
 */
function track(frameCount, width, height, rectsAt, picks) {
  const frames = Array.from({ length: frameCount }, (_, f) => {
    const rects = rectsAt(f);
    return rects ? scene(width, height, rects) : null;
  });
  const selections = trackPicks({
    frameCount,
    getBinary: (f) => frames[f],
    picks,
    width,
    height,
  });
  return { frames, selections };
}

/**
 * Pick at the center of a rectangle
 * @param {number} frame
 * @param {Rect} rect
 * @param {number} width
 * @param {number} height
 * @param {'keep'|'remove'} [mode]
 */
function pickAt(frame, [x, y, w, h], width, height, mode = 'keep') {
  return { frame, x: (x + w / 2) / width, y: (y + h / 2) / height, mode };
}

describe('thresholdMask', () => {
  it('uses probability >= round(t * 255)', () => {
    expect(thresholdCutoff(0.5)).toBe(128);
    const prob = Uint8Array.from([0, 127, 128, 255]);
    expect(Array.from(thresholdMask(prob, 0.5))).toEqual([0, 0, 1, 1]);
    expect(Array.from(thresholdMask(prob, 0.05))).toEqual([0, 1, 1, 1]);
    expect(Array.from(thresholdMask(prob, 0.95))).toEqual([0, 0, 0, 1]);
  });

  it('never counts a zero probability as foreground and tolerates a bad threshold', () => {
    expect(thresholdCutoff(0)).toBe(1);
    expect(thresholdCutoff(Number.NaN)).toBe(128);
    expect(thresholdCutoff(5)).toBe(255);
  });

  it('writes into a reused buffer', () => {
    const out = new Uint8Array(3).fill(9);
    expect(thresholdMask(Uint8Array.from([200, 10, 128]), 0.5, out)).toBe(out);
    expect(Array.from(out)).toEqual([1, 0, 1]);
  });
});

describe('smoothTemporal', () => {
  const cur = Uint8Array.from([0, 100, 255, 30]);

  it('averages the frame with both neighbours, rounding to the nearest byte', () => {
    const prev = Uint8Array.from([0, 101, 0, 30]);
    const next = Uint8Array.from([3, 101, 0, 31]);
    expect(Array.from(smoothTemporal(prev, cur, next))).toEqual([1, 101, 85, 30]);
  });

  it('averages with the neighbours that exist', () => {
    const next = Uint8Array.from([1, 0, 0, 0]);
    expect(Array.from(smoothTemporal(null, cur, next))).toEqual([1, 50, 128, 15]);
    expect(Array.from(smoothTemporal(undefined, cur, null))).toEqual(Array.from(cur));
    // A neighbour of another size is ignored rather than misread
    expect(Array.from(smoothTemporal(new Uint8Array(2), cur, null))).toEqual(Array.from(cur));
  });

  it('then thresholds like a single frame (a one-frame flicker is smoothed away)', () => {
    const flicker = Uint8Array.from([255]);
    const off = Uint8Array.from([0]);
    expect(thresholdMask(smoothTemporal(off, flicker, off), 0.5)[0]).toBe(0);
    expect(thresholdMask(smoothTemporal(flicker, off, flicker), 0.5)[0]).toBe(1);
  });
});

describe('resampleNearest', () => {
  it('samples the source pixel under each destination pixel center', () => {
    const src = Uint8Array.from([1, 2, 3, 4]); // 2x2
    expect(Array.from(resampleNearest(src, 2, 2, 4, 2))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(Array.from(resampleNearest(src, 2, 2, 1, 1))).toEqual([4]);
  });
});

describe('labelComponents', () => {
  it('labels 8-connected components in scan order with areas, bboxes and sums', () => {
    const { binary, width, height } = fromRows([
      '##...#', //
      '.#..#.',
      '....#.',
      '#.....',
    ]);
    const comps = labelComponents(binary, width, height);
    expect(comps.count).toBe(3);
    expect(toRows(comps.labels, width)).toEqual(toRows(binary, width));
    expect(Array.from(comps.labels.subarray(0, 6))).toEqual([1, 1, 0, 0, 0, 2]);
    // The diagonal step joins (5,0) with (4,1)
    expect(comps.labels[1 * width + 4]).toBe(2);
    expect(comps.labels[3 * width]).toBe(3);
    expect(Array.from(comps.areas)).toEqual([0, 3, 3, 1]);
    expect(Array.from(comps.bboxes.subarray(4, 16))).toEqual([0, 0, 1, 1, 4, 0, 5, 2, 0, 3, 0, 3]);
    expect(comps.sumX[1]).toBe(0 + 1 + 1);
    expect(comps.sumY[2]).toBe(0 + 1 + 2);
  });

  it('merges provisional labels that meet later (U and W shapes)', () => {
    const { binary, width, height } = fromRows([
      '#.#.#', //
      '#.#.#',
      '#####',
    ]);
    const comps = labelComponents(binary, width, height);
    expect(comps.count).toBe(1);
    expect(comps.areas[1]).toBe(11);
    expect(Array.from(comps.bboxes.subarray(4, 8))).toEqual([0, 0, 4, 2]);
  });

  it('merges through the NE neighbour', () => {
    const { binary, width, height } = fromRows([
      '..#', //
      '.#.',
      '#..',
      '.##',
    ]);
    expect(labelComponents(binary, width, height).count).toBe(1);
  });

  it('handles an empty mask and reuses a label buffer', () => {
    const labels = new Int32Array(16).fill(7);
    const comps = labelComponents(new Uint8Array(16), 4, 4, labels);
    expect(comps.count).toBe(0);
    expect(comps.labels).toBe(labels);
    expect(Array.from(labels)).toEqual(new Array(16).fill(0));
  });

  it('labels a long snake iteratively and many small components', () => {
    const width = 401;
    const height = 401;
    const binary = new Uint8Array(width * height);
    // Serpentine: full rows every other row, joined at alternating ends
    for (let y = 0; y < height; y += 2) {
      binary.fill(1, y * width, (y + 1) * width);
      if (y + 1 < height) binary[(y + 1) * width + ((y / 2) % 2 === 0 ? width - 1 : 0)] = 1;
    }
    const snake = labelComponents(binary, width, height);
    expect(snake.count).toBe(1);

    const dots = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) dots[y * width + x] = 1;
    const many = labelComponents(dots, width, height);
    expect(many.count).toBe(201 * 201);
    expect(many.areas[many.count]).toBe(1);
  });
});

describe('findPickedComponent', () => {
  const width = 100;
  const height = 50;
  const binary = scene(width, height, [
    [10, 10, 10, 10],
    [60, 10, 10, 10],
  ]);
  const comps = labelComponents(binary, width, height);

  it('returns the component under the pick', () => {
    expect(findPickedComponent(comps, width, height, { x: 0.15, y: 0.3 })).toBe(1);
    expect(findPickedComponent(comps, width, height, { x: 0.65, y: 0.3 })).toBe(2);
  });

  it('snaps to the nearest foreground within ~2% of the diagonal, else nothing', () => {
    const radius = Math.round(PICK_SNAP_RADIUS_FRACTION * Math.hypot(width, height));
    expect(radius).toBe(2);
    // Two pixels right of the first square's right edge (x = 19)
    expect(findPickedComponent(comps, width, height, { x: 21.5 / width, y: 0.3 })).toBe(1);
    expect(findPickedComponent(comps, width, height, { x: 22.5 / width, y: 0.3 })).toBe(0);
    expect(findPickedComponent(comps, width, height, { x: 0.4, y: 0.9 })).toBe(0);
  });

  it('clamps out-of-range positions and handles empty frames', () => {
    expect(findPickedComponent(comps, width, height, { x: 5, y: -1 })).toBe(0);
    const empty = labelComponents(new Uint8Array(4), 2, 2);
    expect(findPickedComponent(empty, 2, 2, { x: 0.5, y: 0.5 })).toBe(0);
  });
});

describe('trackPicks', () => {
  const W = 80;
  const H = 30;

  it('selects all foreground without picks and keeps frames without a mask null', () => {
    const { frames, selections } = track(3, W, H, (f) => (f === 1 ? null : [[5, 5, 6, 6]]), []);
    expect(selections[0]).toEqual(frames[0]);
    expect(selections[0]).not.toBe(frames[0]);
    expect(selections[1]).toBeNull();
  });

  it('follows a pick on a middle frame backward and forward', () => {
    // A moves right 3px per frame; B sits still far away
    /** @param {number} f @returns {Rect} */
    const a = (f) => [4 + 3 * f, 8, 8, 8];
    /** @type {Rect} */
    const b = [66, 8, 8, 8];
    const { selections } = track(10, W, H, (f) => [a(f), b], [pickAt(5, a(5), W, H)]);
    selections.forEach((sel, f) => {
      expect(sel, `frame ${f}`).toEqual(scene(W, H, [a(f)]));
    });
  });

  it('keeps following its own character when two characters cross paths', () => {
    // A runs right on the top band, B runs left on the bottom band; one
    // empty row between the bands keeps them separate components
    /** @param {number} f @returns {Rect} */
    const a = (f) => [2 + 5 * f, 2, 10, 10];
    /** @param {number} f @returns {Rect} */
    const b = (f) => [68 - 5 * f, 13, 10, 10];
    const { frames, selections } = track(12, W, H, (f) => [a(f), b(f)], [pickAt(0, a(0), W, H)]);
    // At frame 7 they overlap horizontally (they really cross), yet stay
    // two components
    expect(a(7)[0]).toBeLessThan(b(7)[0] + 10);
    expect(b(7)[0]).toBeLessThan(a(7)[0] + 10);
    expect(labelComponents(/** @type {Uint8Array} */ (frames[7]), W, H).count).toBe(2);
    selections.forEach((sel, f) => {
      expect(sel, `frame ${f}`).toEqual(scene(W, H, [a(f)]));
    });
  });

  it('picks a character up again when it reappears near where it vanished', () => {
    /** @type {Rect} */
    const b = [60, 5, 10, 10];
    /** @param {number} f @returns {Rect[]} */
    const rectsAt = (f) => {
      if (f >= 4 && f <= 6) return [b]; // A hidden
      return [[10 + f, 10, 10, 10], b];
    };
    const { selections } = track(10, W, H, rectsAt, [pickAt(0, [10, 10, 10, 10], W, H)]);
    for (let f = 4; f <= 6; f++) {
      expect(selections[f]?.some(Boolean), `frame ${f}`).toBe(false);
    }
    for (const f of [0, 3, 7, 9]) {
      expect(selections[f], `frame ${f}`).toEqual(scene(W, H, [[10 + f, 10, 10, 10]]));
    }
  });

  it('bridges frames without a mask the same way', () => {
    /** @type {Rect} */
    const a = [20, 10, 10, 10];
    const { selections } = track(
      6,
      W,
      H,
      (f) => (f === 2 || f === 3 ? null : [a, [60, 10, 10, 10]]),
      [pickAt(5, a, W, H)],
    );
    expect(selections[2]).toBeNull();
    expect(selections[0]).toEqual(scene(W, H, [a]));
    expect(selections[4]).toEqual(scene(W, H, [a]));
  });

  it('keeps both halves when a picked character splits', () => {
    /** @param {number} f @returns {Rect[]} */
    const rectsAt = (f) =>
      f < 5
        ? [[20, 5, 20, 12]]
        : [
            [20, 5, 9, 12],
            [31, 5, 9, 12],
          ];
    const other = /** @type {Rect} */ ([60, 20, 6, 6]);
    const { selections } = track(10, W, H, (f) => [...rectsAt(f), other], [
      pickAt(0, [20, 5, 20, 12], W, H),
    ]);
    selections.forEach((sel, f) => {
      expect(sel, `frame ${f}`).toEqual(scene(W, H, rectsAt(f)));
    });
  });

  it('follows one half of a split back to the whole character', () => {
    /** @param {number} f @returns {Rect[]} */
    const rectsAt = (f) =>
      f < 5
        ? [[20, 5, 20, 12]]
        : [
            [20, 5, 9, 12],
            [31, 5, 9, 12],
          ];
    const { selections } = track(10, W, H, rectsAt, [pickAt(9, [20, 5, 9, 12], W, H)]);
    expect(selections[9]).toEqual(scene(W, H, [[20, 5, 9, 12]]));
    // Frame 4: the whole character contains the half's centroid
    expect(selections[4]).toEqual(scene(W, H, [[20, 5, 20, 12]]));
    expect(selections[0]).toEqual(scene(W, H, [[20, 5, 20, 12]]));
  });

  it('keeps the merged shape when a picked character merges with another (documented)', () => {
    /** @param {number} f @returns {Rect[]} */
    const rectsAt = (f) =>
      f < 5
        ? [
            [10, 5, 10, 10],
            [30, 5, 10, 10],
          ]
        : [
            [10, 5, 10, 10],
            [20, 5, 20, 10],
          ];
    const { selections } = track(8, W, H, rectsAt, [pickAt(0, [10, 5, 10, 10], W, H)]);
    for (let f = 0; f < 5; f++) {
      expect(selections[f], `frame ${f}`).toEqual(scene(W, H, [[10, 5, 10, 10]]));
    }
    for (let f = 5; f < 8; f++) {
      expect(selections[f], `frame ${f}`).toEqual(scene(W, H, [[10, 5, 30, 10]]));
    }
  });

  it('joins a much larger component through the centroid rule when IoU is too low', () => {
    /** @param {number} f @returns {Rect[]} */
    const rectsAt = (f) => (f === 0 ? [[36, 11, 4, 4]] : [[20, 2, 36, 26]]);
    // 16 / (36 * 26) is far below the IoU threshold
    expect(16 / (36 * 26)).toBeLessThan(TRACK_JOIN_IOU);
    const { selections } = track(2, W, H, rectsAt, [pickAt(0, [36, 11, 4, 4], W, H)]);
    expect(selections[1]).toEqual(scene(W, H, [[20, 2, 36, 26]]));
  });

  it('drops a component that moved too far to overlap or hold the centroid', () => {
    /** @param {number} f @returns {Rect[]} */
    const rectsAt = (f) => [[5 + 20 * f, 10, 8, 8]];
    const { selections } = track(3, W, H, rectsAt, [pickAt(0, [5, 10, 8, 8], W, H)]);
    expect(selections[0]?.some(Boolean)).toBe(true);
    expect(selections[1]?.some(Boolean)).toBe(false);
    expect(selections[2]?.some(Boolean)).toBe(false);
  });

  it('removes a picked character from all foreground, and combines keep and remove', () => {
    /** @type {Rect[]} */
    const rects = [
      [5, 5, 8, 8],
      [30, 5, 8, 8],
      [55, 5, 8, 8],
    ];
    const remove = track(3, W, H, () => rects, [pickAt(1, rects[1], W, H, 'remove')]);
    for (const sel of remove.selections) expect(sel).toEqual(scene(W, H, [rects[0], rects[2]]));

    const both = track(3, W, H, () => rects, [
      pickAt(0, rects[0], W, H),
      pickAt(2, rects[2], W, H),
      pickAt(1, rects[2], W, H, 'remove'),
    ]);
    for (const sel of both.selections) expect(sel).toEqual(scene(W, H, [rects[0]]));
  });

  it('selects nothing for a keep pick that hit nothing', () => {
    const { selections } = track(2, W, H, () => [[5, 5, 8, 8]], [
      { frame: 0, x: 0.9, y: 0.9, mode: 'keep' },
    ]);
    for (const sel of selections) expect(sel?.some(Boolean)).toBe(false);
  });

  it('refuses a backward step once the forward pass has started', () => {
    const tracker = createPickTracker({
      picks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
      width: 2,
      height: 2,
    });
    tracker.skipForward(0);
    expect(() => tracker.trackBackward(0, null)).toThrow(/forward pass/);
  });
});

describe('morphMask', () => {
  /**
   * Brute-force reference: square window clipped to the mask
   * @param {Uint8Array} binary
   * @param {number} w
   * @param {number} h
   * @param {number} radius
   */
  function naive(binary, w, h, radius) {
    const r = Math.abs(radius);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let any = 0;
        let all = 1;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            any |= binary[yy * w + xx];
            all &= binary[yy * w + xx];
          }
        }
        out[y * w + x] = radius > 0 ? any : all;
      }
    }
    return out;
  }

  it('grows with a positive radius and shrinks with a negative one', () => {
    const dot = fromRows(['.....', '.....', '..#..', '.....', '.....']);
    expect(toRows(morphMask(dot.binary, 5, 5, 1), 5)).toEqual([
      '.....',
      '.###.',
      '.###.',
      '.###.',
      '.....',
    ]);
    expect(toRows(morphMask(dot.binary, 5, 5, 2), 5)).toEqual(new Array(5).fill('#####'));

    const block = fromRows(['.....', '.###.', '.###.', '.###.', '.....']);
    expect(toRows(morphMask(block.binary, 5, 5, -1), 5)).toEqual([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ]);
    expect(morphMask(block.binary, 5, 5, -2).some(Boolean)).toBe(false);
  });

  it('never shrinks from the frame border (the window is clipped)', () => {
    const edge = fromRows(['###..', '###..', '###..', '###..']);
    expect(toRows(morphMask(edge.binary, 5, 4, -1), 5)).toEqual([
      '##...',
      '##...',
      '##...',
      '##...',
    ]);
  });

  it('returns a copy for radius 0 and caps huge radii at the mask size', () => {
    const { binary } = fromRows(['#..', '...']);
    const copy = morphMask(binary, 3, 2, 0);
    expect(copy).not.toBe(binary);
    expect(copy).toEqual(binary);
    expect(Array.from(morphMask(binary, 3, 2, 1e9))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(Array.from(morphMask(binary, 3, 2, -1e9))).toEqual([0, 0, 0, 0, 0, 0]);
    const full = new Uint8Array(6).fill(1);
    expect(Array.from(morphMask(full, 3, 2, -1e9))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(Array.from(morphMask(binary, 3, 2, Number.NaN))).toEqual(Array.from(binary));
  });

  it('matches a brute-force square window for random masks and radii', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 20; trial++) {
      const w = 3 + Math.floor(random() * 20);
      const h = 3 + Math.floor(random() * 20);
      const binary = new Uint8Array(w * h);
      for (let i = 0; i < binary.length; i++) binary[i] = random() < 0.6 ? 1 : 0;
      for (const radius of [-4, -2, -1, 1, 3, 8]) {
        expect(morphMask(binary, w, h, radius), `trial ${trial} r=${radius}`).toEqual(
          naive(binary, w, h, radius),
        );
      }
    }
  });

  it('writes into a reused buffer', () => {
    const out = new Uint8Array(4).fill(5);
    const { binary } = fromRows(['#.', '..']);
    expect(morphMask(binary, 2, 2, 1, out)).toBe(out);
    expect(Array.from(out)).toEqual([1, 1, 1, 1]);
  });
});

describe('packed masks', () => {
  it('stores one bit per pixel, most significant bit first', () => {
    const { binary, width, height } = fromRows(['#..#.', '....#', '#....']);
    const packed = packMask(binary, width, height);
    expect(packed.bits.byteLength).toBe(packedMaskBytes(5, 3));
    expect(packedMaskBytes(5, 3)).toBe(2);
    expect(packed.bits[0]).toBe(0b10010000);
    expect(packed.bits[1]).toBe(0b01100000);
    expect(unpackMask(packed)).toEqual(binary);
    expect(maskBit(packed, 3, 0)).toBe(1);
    expect(maskBit(packed, 4, 0)).toBe(0);
    expect(maskBit(packed, 4, 1)).toBe(1);
    expect(maskBit(packed, -1, 0)).toBe(0);
    expect(maskBit(packed, 0, 3)).toBe(0);
  });

  it('is an eighth of the unpacked size', () => {
    expect(packedMaskBytes(1024, 576)).toBe((1024 * 576) / 8);
    const binary = new Uint8Array(1024 * 576).fill(1);
    expect(packMask(binary, 1024, 576).bits.byteLength).toBe(73728);
  });
});

describe('applyMaskToRegion', () => {
  /**
   * Opaque RGBA buffer, every pixel (10, 20, 30, 255)
   * @param {number} w
   * @param {number} h
   */
  function opaque(w, h) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < rgba.length; p += 4) rgba.set([10, 20, 30, 255], p);
    return rgba;
  }

  /** @param {Uint8ClampedArray} rgba @param {number} w */
  const alphaRows = (rgba, w) =>
    toRows(
      Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4 + 3]),
      w,
    );

  it('clears RGBA where the mask is 0 (same resolution, whole frame)', () => {
    const mask = fromRows(['#..', '.##']);
    const rgba = opaque(3, 2);
    const packed = packMask(mask.binary, 3, 2);
    const cleared = applyMaskToRegion(
      rgba,
      3,
      2,
      packed.bits,
      3,
      2,
      { x: 0, y: 0, width: 3, height: 2 },
      3,
      2,
    );
    expect(cleared).toBe(3);
    expect(alphaRows(rgba, 3)).toEqual(['#..', '.##']);
    expect(Array.from(rgba.subarray(4, 8))).toEqual([0, 0, 0, 0]);
    expect(Array.from(rgba.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('samples a lower-resolution mask for a cropped region (nearest neighbour)', () => {
    // Source 8x4, mask 4x2 (half resolution): left half of the mask kept
    const mask = fromRows(['##..', '##..']);
    const packed = packMask(mask.binary, 4, 2);
    // Crop x 2..5 (4 px wide), y 1..2
    const rgba = opaque(4, 2);
    applyMaskToRegion(rgba, 4, 2, packed.bits, 4, 2, { x: 2, y: 1, width: 4, height: 2 }, 8, 4);
    expect(alphaRows(rgba, 4)).toEqual(['##..', '##..']);
  });

  it('maps a fractional crop through its own width', () => {
    const mask = fromRows(['#.........']);
    const packed = packMask(mask.binary, 10, 1);
    // getImageData truncates a 2.5-wide crop to 2 columns; each column still
    // samples the source under its center (0.625 and 1.875)
    const rgba = opaque(2, 1);
    applyMaskToRegion(rgba, 2, 1, packed.bits, 10, 1, { x: 0, y: 0, width: 2.5, height: 1 }, 10, 1);
    expect(alphaRows(rgba, 2)).toEqual(['#.']);
  });

  it('does nothing for empty sizes', () => {
    const rgba = opaque(1, 1);
    const bits = new Uint8Array(1);
    const region = { x: 0, y: 0, width: 1, height: 1 };
    expect(applyMaskToRegion(rgba, 0, 1, bits, 1, 1, region, 1, 1)).toBe(0);
    expect(applyMaskToRegion(rgba, 1, 1, bits, 0, 1, region, 1, 1)).toBe(0);
    expect(applyMaskToRegion(rgba, 1, 1, bits, 1, 1, region, 0, 1)).toBe(0);
    expect(rgba[3]).toBe(255);
  });
});
