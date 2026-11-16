/**
 * Colour fix-ups: the pure fill, the guard, and how a build applies them
 * @see src/shared/masks/colour-fill.js
 */
import { describe, expect, it } from 'vitest';
import { createDefaultAiCutout } from '../../../../src/shared/edits/model.js';
import {
  COLOUR_GUARD_SHARE,
  COLOUR_PASS,
  COLOUR_REMOVE,
  COLOUR_REMOVE_FAR,
  COLOUR_STOP,
  createColourMatcher,
  fillColourRegion,
  getColourGuardShares,
  getDiscPixels,
  packRgb,
  samplePoint,
} from '../../../../src/shared/masks/colour-fill.js';
import {
  buildFinalMasks,
  createDraftMaskSource,
  getAiParamsKey,
  getColourRegion,
} from '../../../../src/shared/masks/final-masks.js';
import { unpackMask } from '../../../../src/shared/masks/mask-ops.js';

const W = 64;
const H = 32;
const FRAMES = 6;

/** @typedef {[number, number, number, number]} Rect x, y, w, h */
/** @typedef {{ rect: Rect, color: number[] | ((x: number, y: number) => number[]), inMask?: boolean }} Paint */

const BG = [30, 140, 60];
const SHIRT = [40, 80, 200];
const HAIR = [70, 45, 30];
/** The character: hair on top of a shirt, columns 20-31 */
const character = /** @type {Paint[]} */ ([
  { rect: [20, 4, 12, 6], color: HAIR },
  { rect: [20, 10, 12, 20], color: SHIRT },
]);

/**
 * A frame: RGBA pixels (with a little noise) and the base model's
 * probability (230 on everything painted with inMask, 10 elsewhere)
 * @param {Paint[]} paints
 * @param {number} seed
 * @param {number} [amount] - noise, +- RGB steps per channel
 */
function makeFrame(paints, seed, amount = 3) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const prob = new Uint8Array(W * H).fill(10);
  let s = seed >>> 0;
  const noise = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return Math.round((s / 2 ** 32) * 2 * amount - amount);
  };
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) rgba[i * 4 + k] = BG[k] + noise();
    rgba[i * 4 + 3] = 255;
  }
  for (const { rect, color, inMask = true } of paints) {
    const [rx, ry, rw, rh] = rect;
    for (let y = Math.max(0, ry); y < Math.min(H, ry + rh); y++) {
      for (let x = Math.max(0, rx); x < Math.min(W, rx + rw); x++) {
        const i = y * W + x;
        const c = typeof color === 'function' ? color(x, y) : color;
        for (let k = 0; k < 3; k++) rgba[i * 4 + k] = c[k] + noise();
        if (inMask) prob[i] = 230;
      }
    }
  }
  return { rgba, prob: { data: prob, width: W, height: H } };
}

/**
 * A clip of FRAMES frames
 * @param {(f: number) => Paint[]} patches - the leftovers on frame f
 */
function makeClip(patches) {
  const frames = Array.from({ length: FRAMES }, (_, f) =>
    makeFrame([...character, ...patches(f)], 7 + f),
  );
  return {
    getProb: (/** @type {number} */ f) => frames[f]?.prob ?? null,
    getPixels: (/** @type {number} */ f) => frames[f]?.rgba ?? null,
  };
}

const aiOf = (over = {}) => ({ ...createDefaultAiCutout(), smoothing: false, ...over });
const noYield = { now: () => 0, yieldToMain: async () => {} };

/**
 * @param {{ frame: number, x: number, y: number, mode?: 'keep' | 'remove' }[]} points - pixel positions
 * @param {number} [tolerance]
 */
function colourObject(points, tolerance = 32) {
  const clicks = points.map((p) => ({
    frame: p.frame,
    x: (p.x + 0.5) / W,
    y: (p.y + 0.5) / H,
    mode: p.mode ?? /** @type {const} */ ('keep'),
  }));
  return {
    edit: { id: 'c1', mode: 'remove', scope: 'colour', clicks, boxes: [], tolerance },
    input: {
      id: 'c1',
      mode: /** @type {const} */ ('remove'),
      getMask: () => null,
      colour: { clicks, tolerance },
    },
  };
}

/**
 * Build with one Colour fix-up
 * @param {ReturnType<typeof makeClip>} clip
 * @param {ReturnType<typeof colourObject>} object
 */
async function build(clip, object) {
  return buildFinalMasks({
    frameCount: FRAMES,
    getProb: clip.getProb,
    getPixels: clip.getPixels,
    ai: aiOf({ objects: [object.edit] }),
    objects: [object.input],
    ...noYield,
  });
}

/**
 * Share of a rectangle still in a final mask
 * @param {any} packed
 * @param {Rect} rect
 */
function keptIn(packed, [rx, ry, rw, rh]) {
  const mask = unpackMask(packed);
  let n = 0;
  let kept = 0;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      n++;
      kept += mask[y * W + x];
    }
  }
  return kept / n;
}

const FLAT = [200, 200, 190];
/** @type {Rect} */
const PATCH = [32, 14, 16, 14];
/** @type {Rect} */
const SHIRT_RECT = [20, 10, 12, 20];
/** @type {Rect} */
const HAIR_RECT = [20, 4, 12, 6];

describe('fillColourRegion', () => {
  it('takes the mask pixels connected to a seed through matching colours only', () => {
    const { rgba } = makeFrame([...character, { rect: PATCH, color: FLAT }], 1);
    const mask = new Uint8Array(W * H);
    for (const [rx, ry, rw, rh] of [PATCH, SHIRT_RECT, HAIR_RECT]) {
      for (let y = ry; y < ry + rh; y++) mask.fill(1, y * W + rx, y * W + rx + rw);
    }
    // A second patch of the same colour that does not touch the first
    const far = /** @type {Rect} */ ([52, 2, 6, 6]);
    for (let y = far[1]; y < far[1] + far[3]; y++) {
      for (let x = far[0]; x < far[0] + far[2]; x++) {
        const i = y * W + x;
        rgba.set([...FLAT, 255], i * 4);
        mask[i] = 1;
      }
    }
    const disc = getDiscPixels(W, H, { x: 40 / W, y: 20 / H }, 1);
    const { colours } = samplePoint(rgba, W, H, { x: 40 / W, y: 20 / H }, 1, 16);
    const matches = createColourMatcher(colours, [], 32);
    const { region, count } = fillColourRegion(mask, W, H, rgba, disc, matches);
    expect(count).toBe(PATCH[2] * PATCH[3]);
    expect(region[20 * W + 40]).toBe(1);
    // Not the character, not the unconnected patch
    expect(region[20 * W + 25]).toBe(0);
    expect(region[4 * W + 54]).toBe(0);
  });

  it('protects colours nearer to a protect colour than to every sampled one', () => {
    const near = packRgb(80, 50, 35);
    const hair = packRgb(70, 45, 30);
    const matches = createColourMatcher([near], [hair], 32);
    expect(matches(packRgb(82, 52, 36))).toBe(COLOUR_REMOVE);
    expect(matches(packRgb(70, 44, 31))).toBe(COLOUR_PASS);
    expect(matches(packRgb(200, 200, 200))).toBe(COLOUR_STOP);
    // Without the protect colour the hair goes too (12.3 RGB away: the guard counts it)
    expect(createColourMatcher([near], [], 32)(packRgb(70, 44, 31))).toBe(COLOUR_REMOVE_FAR);
  });

  it('passes through protected pixels without removing them', () => {
    // A row: seed | protected | removable, all in the mask
    const w = 6;
    const rgba = new Uint8ClampedArray(w * 4);
    const colours = [
      [82, 52, 36],
      [82, 52, 36],
      [70, 45, 30],
      [70, 45, 30],
      [82, 52, 36],
      [82, 52, 36],
    ];
    for (const [i, c] of colours.entries()) rgba.set([...c, 255], i * 4);
    const matches = createColourMatcher([packRgb(82, 52, 36)], [packRgb(70, 45, 30)], 32);
    const { region, count } = fillColourRegion(new Uint8Array(w).fill(1), w, 1, rgba, [0], matches);
    expect([...region]).toEqual([1, 1, 0, 0, 1, 1]);
    expect(count).toBe(4);
  });
});

describe('Colour fix-ups in a build', () => {
  it('removes a flat patch attached to the subject on every frame and nothing of the subject', async () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const result = await build(clip, colourObject([{ frame: 2, x: 40, y: 20 }]));
    for (const mask of result.masks) {
      expect(keptIn(mask, PATCH)).toBe(0);
      expect(keptIn(mask, SHIRT_RECT)).toBe(1);
      expect(keptIn(mask, HAIR_RECT)).toBe(1);
    }
    expect(Math.max(...result.colourShares.c1)).toBeLessThanOrEqual(COLOUR_GUARD_SHARE);
  });

  it('a protect point keeps the hair a pillar of nearly its colour shares', async () => {
    const pillar = [82, 52, 36];
    /** @type {Rect} */
    const PILLAR = [10, 0, 10, 30];
    const clip = makeClip(() => [{ rect: PILLAR, color: pillar }]);
    const onPillar = { frame: 1, x: 14, y: 20 };
    const without = await build(clip, colourObject([onPillar]));
    expect(keptIn(without.masks[3], PILLAR)).toBe(0);
    expect(keptIn(without.masks[3], HAIR_RECT)).toBe(0);
    const protectedHair = await build(
      clip,
      colourObject([onPillar, { frame: 1, x: 25, y: 6, mode: 'remove' }]),
    );
    for (const mask of protectedHair.masks) {
      expect(keptIn(mask, PILLAR)).toBe(0);
      expect(keptIn(mask, HAIR_RECT)).toBe(1);
      expect(keptIn(mask, SHIRT_RECT)).toBe(1);
    }
  });

  it('the tolerance decides how far from the sampled colours it reaches', async () => {
    // A gradient patch: 8 RGB steps per column
    const gradient = (/** @type {number} */ x) => [140 + (x - 32) * 5, 140 + (x - 32) * 5, 150];
    const clip = makeClip(() => [{ rect: PATCH, color: gradient }]);
    // The disc (radius 4) stays inside the patch: columns 32-40
    const at = { frame: 0, x: 36, y: 20 };
    const low = await build(clip, colourObject([at], 8));
    const high = await build(clip, colourObject([at], 96));
    expect(keptIn(low.masks[0], PATCH)).toBeGreaterThan(0.25);
    expect(keptIn(high.masks[0], PATCH)).toBe(0);
    expect(keptIn(high.masks[0], SHIRT_RECT)).toBe(1);
  });

  it('the guard flags a frame where the fill takes the subject beyond its reference frame', async () => {
    // Shelf rows: the lower row's colours are near the shirt's, so a large
    // tolerance runs from the shelf into the shirt
    const rows = (/** @type {number} */ x, /** @type {number} */ y) =>
      y < 20
        ? (x + y) % 2
          ? [150, 100, 60]
          : [205, 175, 120]
        : (x + y) % 2
          ? [60, 95, 185]
          : [95, 120, 210];
    const clip = makeClip(() => [{ rect: PATCH, color: rows }]);
    const point = { frame: 2, x: 40, y: 24 };
    const eats = await build(clip, colourObject([point], 64));
    expect(keptIn(eats.masks[2], SHIRT_RECT)).toBeLessThan(0.5);
    const shares = eats.colourShares.c1;
    expect(shares).toHaveLength(FRAMES);
    for (const share of shares) expect(share).toBeGreaterThan(COLOUR_GUARD_SHARE);
    // Lower: the shirt stays and the guard is quiet
    const fine = await build(clip, colourObject([point], 16));
    expect(keptIn(fine.masks[2], SHIRT_RECT)).toBe(1);
    for (const share of fine.colourShares.c1) expect(share).toBeLessThanOrEqual(COLOUR_GUARD_SHARE);
  });

  it('follows a panning patch with a second point placed where it went', async () => {
    const PAN = [100, 180, 225];
    // Moves 4 px right per frame; stays attached to the shirt by a bar
    const pan = (/** @type {number} */ f) =>
      /** @type {Paint[]} */ ([
        { rect: [32, 26, 2 + f * 4, 2], color: PAN },
        { rect: [34 + f * 4, 14, 8, 14], color: PAN },
      ]);
    const clip = makeClip(pan);
    const first = { frame: 0, x: 37, y: 18 };
    const one = await build(clip, colourObject([first]));
    // The patch has left the first point's position by frame 4
    expect(keptIn(one.masks[0], [34, 14, 8, 14])).toBe(0);
    expect(keptIn(one.masks[5], [54, 14, 8, 14])).toBeGreaterThan(0.9);
    // Placed on frame 3, where it had gone: its disc reaches frames 2-5
    const two = await build(clip, colourObject([first, { frame: 3, x: 50, y: 18 }]));
    for (let f = 0; f < FRAMES; f++) {
      expect(keptIn(two.masks[f], [34 + f * 4, 14, 8, 14])).toBe(0);
      expect(keptIn(two.masks[f], SHIRT_RECT)).toBe(1);
    }
  });

  it('applies in order with tracked fix-ups: a later Add wins over an earlier Colour', async () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const colour = colourObject([{ frame: 0, x: 40, y: 20 }]);
    const add = { data: new Uint8Array(W * H).fill(0), width: W, height: H };
    for (let y = 14; y < 20; y++) add.data.fill(255, y * W + 32, y * W + 48);
    const addInput = { id: 'a1', mode: /** @type {const} */ ('add'), getMask: () => add };
    const addEdit = { id: 'a1', mode: 'add', scope: 'whole', clicks: [], boxes: [], tolerance: 32 };
    const result = await buildFinalMasks({
      frameCount: FRAMES,
      getProb: clip.getProb,
      getPixels: clip.getPixels,
      ai: aiOf({ objects: [colour.edit, addEdit] }),
      objects: [colour.input, addInput],
      ...noYield,
    });
    expect(keptIn(result.masks[1], [32, 14, 16, 6])).toBe(1);
    expect(keptIn(result.masks[1], [32, 20, 16, 8])).toBe(0);
  });

  it('a draft frame equals the build', async () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const object = colourObject([{ frame: 2, x: 40, y: 20 }]);
    const built = await build(clip, object);
    const draft = createDraftMaskSource({
      frameCount: FRAMES,
      getProb: clip.getProb,
      getPixels: clip.getPixels,
      ai: aiOf({ objects: [object.edit] }),
      objects: [object.input],
    });
    for (let f = 0; f < FRAMES; f++) {
      expect(unpackMask(/** @type {any} */ (draft.getFinalMask(f)))).toEqual(
        unpackMask(/** @type {any} */ (built.masks[f])),
      );
    }
  });

  it('changes nothing where the pixels are not available', async () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const object = colourObject([{ frame: 2, x: 40, y: 20 }]);
    const result = await buildFinalMasks({
      frameCount: FRAMES,
      getProb: clip.getProb,
      getPixels: () => null,
      ai: aiOf({ objects: [object.edit] }),
      objects: [object.input],
      ...noYield,
    });
    expect(keptIn(result.masks[0], PATCH)).toBe(1);
  });

  it('shows its region on a frame for Show mask', () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const object = colourObject([{ frame: 2, x: 40, y: 20 }]);
    const region = getColourRegion(
      { frameCount: FRAMES, getProb: clip.getProb, getPixels: clip.getPixels, ai: aiOf() },
      object.input,
      4,
    );
    expect(region?.data[20 * W + 40]).toBe(255);
    expect(region?.data[20 * W + 25]).toBe(0);
  });
});

describe('getColourGuardShares', () => {
  it('is what a frame removes in colours not sampled, of what it leaves plus that', () => {
    const stats = new Map([
      [0, { mask: 1000, removed: 300, far: 0 }],
      [1, { mask: 2000, removed: 1600, far: 0 }],
      [2, { mask: 1000, removed: 500, far: 100 }],
      [3, { mask: 400, removed: 400, far: 0 }],
    ]);
    const shares = getColourGuardShares(stats);
    expect(shares.get(0)).toBe(0);
    // More removed than elsewhere, but all of sampled colours: nothing to say
    expect(shares.get(1)).toBe(0);
    expect(shares.get(2)).toBeCloseTo(100 / 600);
    // The whole cutout removed in sampled colours (the subject left): 0
    expect(shares.get(3)).toBe(0);
  });
});

describe('Review #197 round 1', () => {
  // A leftover attached to the subject: the shirt ends at x = 31, the patch starts at x = 32
  it('a point near the subject edge samples only the colour under it (finding 1)', async () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const result = await build(clip, colourObject([{ frame: 0, x: 33, y: 20 }]));
    for (const mask of result.masks) {
      expect(keptIn(mask, PATCH)).toBe(0);
      expect(keptIn(mask, SHIRT_RECT)).toBe(1);
    }
    const disc = getDiscPixels(W, H, { x: 33.5 / W, y: 20.5 / H }, 4);
    expect(disc.some((i) => i % W < 32)).toBe(true);
    const { colours, pixels } = samplePoint(
      makeFrame([...character, { rect: PATCH, color: FLAT }], 1).rgba,
      W,
      H,
      { x: 33.5 / W, y: 20.5 / H },
      4,
      16,
    );
    expect(pixels.every((i) => i % W >= 32)).toBe(true);
    expect(createColourMatcher(colours, [], 32)(packRgb(...SHIRT))).toBe(COLOUR_STOP);
  });

  it('the guard sees a subject that moves onto the leftover after the point frame (finding 2)', async () => {
    const WALL = [200, 170, 140];
    const SKIN = [210, 176, 146];
    /** @type {(f: number) => Rect} */
    const body = (f) => [f < 3 ? 2 : 50, 4, 8, 24];
    const frames = Array.from({ length: FRAMES }, (_, f) =>
      makeFrame(
        [
          { rect: [36, 4, 14, 24], color: WALL },
          { rect: body(f), color: SKIN },
        ],
        3 + f,
      ),
    );
    const clip = {
      getProb: (/** @type {number} */ f) => frames[f].prob,
      getPixels: (/** @type {number} */ f) => frames[f].rgba,
    };
    const result = await build(clip, colourObject([{ frame: 0, x: 42, y: 16 }]));
    for (let f = 0; f < FRAMES; f++) {
      const shares = result.colourShares.c1;
      if (f < 3) {
        expect(keptIn(result.masks[f], body(f))).toBe(1);
        expect(shares[f]).toBeLessThanOrEqual(COLOUR_GUARD_SHARE);
      } else {
        // Skin is 13 RGB from the wall: eaten, and the guard says so
        expect(keptIn(result.masks[f], body(f))).toBe(0);
        expect(shares[f]).toBeGreaterThan(COLOUR_GUARD_SHARE);
      }
    }
  });

  it('the guard measures every frame when the point frame has no mask (finding 3)', async () => {
    const WALL = [200, 170, 140];
    const SKIN = [230, 195, 160];
    const clip = makeClip(() => [
      { rect: [36, 4, 14, 24], color: WALL },
      { rect: [32, 4, 4, 24], color: SKIN },
    ]);
    const object = colourObject([{ frame: 0, x: 42, y: 16 }], 64);
    const result = await buildFinalMasks({
      frameCount: FRAMES,
      getProb: (f) => (f === 0 ? null : clip.getProb(f)),
      getPixels: clip.getPixels,
      ai: aiOf({ objects: [object.edit] }),
      objects: [object.input],
      ...noYield,
    });
    const shares = result.colourShares.c1;
    expect(shares[0]).toBe(-1);
    for (let f = 1; f < FRAMES; f++) expect(shares[f]).toBeGreaterThan(COLOUR_GUARD_SHARE);
  });

  it('a protect point on a thin strand does not protect the pillar beside it (finding 4)', async () => {
    const PILLAR = [90, 60, 40];
    const STRAND = [100, 70, 48];
    /** @type {Rect} */
    const PILLAR_RECT = [44, 0, 12, 32];
    /** @type {Rect} */
    const STRAND_RECT = [41, 4, 3, 24];
    const clip = makeClip(() => [
      { rect: STRAND_RECT, color: STRAND },
      { rect: PILLAR_RECT, color: PILLAR },
    ]);
    const result = await build(
      clip,
      colourObject([
        { frame: 0, x: 50, y: 16 },
        { frame: 0, x: 42, y: 16, mode: 'remove' },
      ]),
    );
    for (const mask of result.masks) {
      expect(keptIn(mask, PILLAR_RECT)).toBe(0);
      expect(keptIn(mask, STRAND_RECT)).toBe(1);
    }
  });

  it('Show mask samples the points once per frame content, not on every frame change (note)', () => {
    const clip = makeClip(() => [{ rect: PATCH, color: FLAT }]);
    const object = colourObject([
      { frame: 1, x: 40, y: 20 },
      { frame: 2, x: 40, y: 20 },
      { frame: 3, x: 40, y: 20 },
    ]);
    /** @type {number[]} */
    const reads = [];
    /** @type {import('../../../../src/shared/masks/final-masks.js').PixelSource} */
    const getPixels = (f) => {
      reads.push(f);
      return clip.getPixels(f);
    };
    getPixels.frameKey = (f) => `memo-test-${f}`;
    const options = { frameCount: FRAMES, getProb: clip.getProb, getPixels, ai: aiOf() };
    getColourRegion(options, object.input, 4);
    expect(reads).toEqual([1, 2, 3, 4]);
    reads.length = 0;
    const region = getColourRegion(options, object.input, 5);
    expect(reads).toEqual([5]);
    expect(region?.data[20 * W + 40]).toBe(255);
  });
});

describe('Review #197 round 2', () => {
  /**
   * A clip of explicit frames
   * @param {(f: number) => Paint[]} paints - everything on frame f
   * @param {number} [noise]
   */
  const clipOf = (paints, noise = 3) => {
    const frames = Array.from({ length: FRAMES }, (_, f) => makeFrame(paints(f), 11 + f, noise));
    return {
      getProb: (/** @type {number} */ f) => frames[f].prob,
      getPixels: (/** @type {number} */ f) => frames[f].rgba,
    };
  };
  const WALL = [200, 170, 140];
  /** @type {Rect} */
  const LEFTOVER = [32, 6, 14, 22];
  const withLeftover = (/** @type {Paint[]} */ extra) => () => [
    ...character,
    { rect: LEFTOVER, color: WALL },
    ...extra,
  ];

  // A: one subject-coloured pixel in the disc; the shirt ends at x = 31
  for (const [name, extra, at] of /** @type {[string, Paint[], [number, number]][]} */ ([
    ['a 1-pixel jag of the shirt edge', [{ rect: [32, 16, 1, 1], color: SHIRT }], [35, 16]],
    ['the tip of a 1-pixel shirt strand', [{ rect: [32, 16, 4, 1], color: SHIRT }], [38, 16]],
    ['an isolated shirt-coloured speck', [{ rect: [37, 14, 1, 1], color: SHIRT }], [39, 16]],
  ])) {
    it(`A: ${name} in the disc is not sampled; the shirt stays`, async () => {
      const result = await build(
        clipOf(withLeftover(extra)),
        colourObject([{ frame: 0, x: at[0], y: at[1] }]),
      );
      for (const mask of result.masks) {
        expect(keptIn(mask, SHIRT_RECT)).toBe(1);
        expect(keptIn(mask, [40, 8, 6, 18])).toBe(0);
      }
    });
  }

  it("A: a pillar-coloured speck inside the protected strand does not protect the pillar (round 1's 4)", async () => {
    const PILLAR = [90, 60, 40];
    /** @type {Rect} */
    const PILLAR_RECT = [44, 0, 12, 32];
    /** @type {Rect} */
    const STRAND_RECT = [41, 4, 3, 24];
    const clip = clipOf(() => [
      ...character,
      { rect: STRAND_RECT, color: [100, 70, 48] },
      { rect: [42, 14, 1, 1], color: PILLAR },
      { rect: PILLAR_RECT, color: PILLAR },
    ]);
    const result = await build(
      clip,
      colourObject([
        { frame: 0, x: 50, y: 16 },
        { frame: 0, x: 42, y: 16, mode: 'remove' },
      ]),
    );
    for (const mask of result.masks) expect(keptIn(mask, PILLAR_RECT)).toBe(0);
  });

  it('B: an arm that reaches the wall after the point frame is flagged, whatever the size change', async () => {
    // The reviewer's case: a small person far away on the point frame, close
    // with a skin-coloured arm (13 RGB from the wall) on frames 3-5
    const clip = clipOf(
      (f) =>
        /** @type {Paint[]} */ ([
          f < 3 ? { rect: [2, 20, 6, 10], color: SHIRT } : { rect: [4, 4, 24, 26], color: SHIRT },
          ...(f < 3 ? [] : [{ rect: [28, 12, 12, 8], color: [210, 176, 146] }]),
          { rect: [40, 4, 20, 24], color: WALL },
        ]),
      0,
    );
    const result = await build(clip, colourObject([{ frame: 0, x: 50, y: 16 }]));
    const shares = result.colourShares.c1;
    for (let f = 0; f < FRAMES; f++) {
      if (f < 3) expect(shares[f]).toBe(0);
      else {
        expect(keptIn(result.masks[f], [28, 12, 12, 8])).toBe(0);
        expect(shares[f]).toBeGreaterThan(COLOUR_GUARD_SHARE);
      }
    }
  });

  for (const [name, paints] of /** @type {[string, (f: number) => Paint[]][]} */ ([
    [
      'the subject leaves the frame',
      (f) => [
        { rect: [20 - 8 * f, 10, 12, 20], color: SHIRT },
        { rect: LEFTOVER, color: WALL },
      ],
    ],
    [
      'the subject shrinks',
      (f) => [
        { rect: [20, 10, 12 - 2 * f, 20], color: SHIRT },
        { rect: LEFTOVER, color: WALL },
      ],
    ],
    ['the leftover grows', (f) => [...character, { rect: [32, 6, 4 + 4 * f, 22], color: WALL }]],
  ])) {
    it(`B: no alarm when ${name} and nothing of it is eaten`, async () => {
      const result = await build(clipOf(paints), colourObject([{ frame: 0, x: 33, y: 16 }]));
      for (let f = 0; f < FRAMES; f++) {
        const shares = result.colourShares.c1;
        expect(shares[f]).toBeLessThanOrEqual(COLOUR_GUARD_SHARE);
      }
    });
  }

  it("B: most frames bad with the point frame unanalysed are all flagged (round 1's 3)", async () => {
    const SKIN = [230, 195, 160];
    const clip = clipOf((f) => [
      { rect: [f < 2 ? 2 : 32, 4, 12, 24], color: SKIN },
      { rect: [44, 4, 14, 24], color: WALL },
    ]);
    const object = colourObject([{ frame: 0, x: 50, y: 16 }], 64);
    const result = await buildFinalMasks({
      frameCount: FRAMES,
      getProb: (f) => (f === 0 ? null : clip.getProb(f)),
      getPixels: clip.getPixels,
      ai: aiOf({ objects: [object.edit] }),
      objects: [object.input],
      ...noYield,
    });
    const shares = result.colourShares.c1;
    expect(shares[0]).toBe(-1);
    expect(shares[1]).toBe(0);
    for (let f = 2; f < FRAMES; f++) {
      expect(keptIn(result.masks[f], [32, 4, 12, 24])).toBe(0);
      expect(shares[f]).toBeGreaterThan(COLOUR_GUARD_SHARE);
    }
  });

  it('limit: a subject of nearly the leftover colour looks exactly like more leftover', async () => {
    // Pixel for pixel the same clip: one reads as a person (8 RGB from the
    // wall) walking onto it, the other as the wall growing. No guard by
    // colour can flag the first without flagging the second.
    const NEAR_WALL = [205, 174, 143];
    const person = await build(
      clipOf(withLeftover([]), 3),
      colourObject([{ frame: 0, x: 40, y: 16 }]),
    );
    const walksOn = await build(
      clipOf((f) => [
        ...character,
        { rect: LEFTOVER, color: WALL },
        ...(f >= 3 ? [{ rect: /** @type {Rect} */ ([46, 6, 8, 22]), color: NEAR_WALL }] : []),
      ]),
      colourObject([{ frame: 0, x: 40, y: 16 }]),
    );
    expect(Math.max(...person.colourShares.c1)).toBeLessThanOrEqual(COLOUR_GUARD_SHARE);
    expect(keptIn(walksOn.masks[4], [46, 6, 8, 22])).toBe(0);
    expect(Math.max(...walksOn.colourShares.c1)).toBeLessThanOrEqual(COLOUR_GUARD_SHARE);
  });
});

describe('getAiParamsKey and Colour fix-ups', () => {
  const object = colourObject([{ frame: 0, x: 40, y: 20 }]).edit;
  const key = (/** @type {any} */ o) => getAiParamsKey(aiOf({ objects: [o] }));

  it('changes with the points and the tolerance of a Colour fix-up', () => {
    expect(key({ ...object, tolerance: 40 })).not.toBe(key(object));
    expect(
      key({ ...object, clicks: [...object.clicks, { ...object.clicks[0], frame: 3 }] }),
    ).not.toBe(key(object));
    expect(key({ ...object, scope: 'part' })).not.toBe(key(object));
  });

  it('not with the clicks of a tracked one (they change its masks, not the build)', () => {
    const tracked = { ...object, scope: 'whole' };
    expect(key({ ...tracked, clicks: [{ ...tracked.clicks[0], x: 0.1 }] })).toBe(key(tracked));
    expect(key({ ...tracked, tolerance: 60 })).toBe(key(tracked));
  });
});
