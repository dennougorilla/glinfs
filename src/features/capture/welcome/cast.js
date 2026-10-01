/**
 * The welcome scene's cast
 * @module features/capture/welcome/cast
 *
 * Four pixel-art characters who play the same story on the same marks
 * (timeline.js): a hopping run, a crouch, a big jump at {@link JUMP0}, a
 * landing at {@link JUMP1}, then a punchline. Each draws itself into the
 * pixel video; with `{ bg: false }` the caller draws no backdrop, which is
 * how the GIF card shows the character cut out.
 *
 * Sprites are built per pose and cached (pixel.js `baked`), so the pose
 * parameters below double as cache keys.
 */

import { baked, drawBaked, drawPlain, GY, OUTLINE, PCX, pixelText, Sprite } from './pixel.js';
import { CROUCH, JUMP0, JUMP1, lerp, mod, rng, seg } from './timeline.js';

/**
 * @typedef {Object} CastDrawOptions
 * @property {boolean} [bg=true] - false: the character only (for the cut-out)
 * @property {{ cyan: string, magenta: string }} plates
 */

/**
 * @typedef {Object} CastMember
 * @property {string} key
 * @property {string} file - The GIF's file name in the card
 * @property {{ x: number, y: number, w: number, h: number, ratio: string }} crop - In video pixels
 * @property {number} m0 - Start of the moment the GIF loops (seconds)
 * @property {number} m1 - End of that moment
 * @property {(g: CanvasRenderingContext2D, t: number, opt: CastDrawOptions) => void} draw
 */

/** Plate offset: one pixel at rest, more the faster the character moves */
function plateOffset(t) {
  const big = seg(t, JUMP0, JUMP1);
  if (big > 0 && big < 1) return 1 + Math.round(Math.sin(Math.PI * big) * 1.6);
  return t > JUMP1 && t < JUMP1 + 0.2 ? 2 : 1;
}

/** Height of the big jump at time t */
function jumpHeight(t, h) {
  const big = seg(t, JUMP0, JUMP1);
  return big > 0 && big < 1 ? Math.round(h * 4 * big * (1 - big)) : 0;
}

/** A soft pixel shadow on the ground, shrinking as the character rises */
function shadow(g, x, w, lift) {
  const ww = Math.max(4, Math.round(w * (1 - lift / 40)));
  g.fillStyle = 'rgba(10, 0, 20, 0.55)';
  g.fillRect(Math.round(x - ww / 2), GY, ww, 1);
  g.fillRect(Math.round(x - ww / 2 + 2), GY + 1, ww - 4, 1);
}

/** Leg positions of a 4-step run cycle: [back far, back near] offsets */
const LEG_STEPS = [
  [-1, 1],
  [0, 0],
  [1, -1],
  [0, 0],
];

/* ================= cat ================= */

const CAT = { O: '#f39234', D: '#c45f26', L: '#ffc07a', W: '#fff4e6', P: '#ff9bb3', E: '#1b1025' };
const CAT_RUN = [
  { legs: [5, 7, 26, 28], bodyY: -1, tail: -1 },
  { legs: [9, 11, 21, 23], bodyY: 0, tail: 0 },
  { legs: [13, 15, 17, 19], bodyY: -1, tail: 1 },
  { legs: [9, 11, 21, 23], bodyY: 0, tail: 0 },
];

function buildCat(f) {
  const s = new Sprite(34, 24);
  const C = CAT;
  const by = 12 + f.bodyY;
  const st = f.stretch || 0;
  const foot = (i) => (f.footY ? f.footY[i] : 21);
  const leg = (topx, footx, footy, color) => {
    s.line(topx, by + 2, footx, footy - 1, color, 2);
    s.rect(footx - 1, footy - 1, 3, 1, color === C.O ? C.W : '#e6d6c0');
  };
  // far legs first, in shade
  leg(10, f.legs[0], foot(0), C.D);
  leg(20 + st, f.legs[2], foot(2), C.D);
  s.line(7, by - 1, 4, by - 3, C.O, 2);
  s.line(4, by - 3, 3 + f.tail, by - 8, C.O, 2);
  s.rect(2 + f.tail, by - 10, 2, 2, C.D);
  s.ell(15 + st / 2, by, 8 + st / 2, f.crouch ? 3.4 : 4, C.O);
  s.rect(11, by + 2, 9 + st, 1, C.L);
  s.rect(13, by + 3, 6 + st, 1, C.W);
  for (const [x, dy] of [
    [11, -3],
    [14, -4],
    [17, -3],
  ]) {
    s.set(x + st / 2, by + dy, C.D);
    s.set(x + st / 2, by + dy + 1, C.D);
  }
  leg(12, f.legs[1], foot(1), C.O);
  leg(22 + st, f.legs[3], foot(3), C.O);
  const hx = 25 + st;
  const hy = by - 5 + (f.crouch ? 2 : 0);
  s.poly(
    [
      [hx - 5, hy - 1],
      [hx - 4, hy - 8],
      [hx - 1, hy - 3],
    ],
    C.O,
  );
  s.poly(
    [
      [hx + 1, hy - 3],
      [hx + 4, hy - 8 + (f.ears || 0)],
      [hx + 5, hy - 1],
    ],
    C.O,
  );
  s.set(hx - 4, hy - 5, C.P);
  s.set(hx - 3, hy - 4, C.P);
  s.set(hx + 3, hy - 5 + (f.ears || 0), C.P);
  s.ell(hx, hy, 5, 4.2, C.O);
  s.set(hx - 1, hy - 4, C.D);
  s.set(hx + 1, hy - 4, C.D);
  s.set(hx, hy - 3, C.D);
  s.ell(hx + 1.5, hy + 2, 2.8, 1.6, C.W);
  s.set(hx + 2, hy + 1, C.P);
  if (f.blink) {
    s.rect(hx - 3, hy, 2, 1, C.E);
    s.rect(hx + 2, hy, 2, 1, C.E);
  } else {
    s.rect(hx - 3, hy - 1, 2, 2, C.E);
    s.rect(hx + 2, hy - 1, 2, 2, C.E);
    s.set(hx - 3, hy - 1, '#ffffff');
    s.set(hx + 2, hy - 1, '#ffffff');
  }
  s.set(hx - 4, hy + 1, C.P);
  s.set(hx + 5, hy + 1, C.P);
  return s.outline();
}

function buildShades() {
  const s = new Sprite(13, 4);
  s.rect(0, 0, 13, 1, '#0b0b0e');
  s.rect(1, 1, 5, 1, '#0b0b0e');
  s.rect(7, 1, 5, 1, '#0b0b0e');
  s.rect(2, 2, 3, 1, '#0b0b0e');
  s.rect(8, 2, 3, 1, '#0b0b0e');
  s.set(2, 1, '#ffffff');
  s.set(8, 1, '#ffffff');
  return s;
}

/** @type {CastMember} */
export const CAT_MEMBER = {
  key: 'cat',
  file: 'deal-with-it.gif',
  crop: { x: 28, y: 12, w: 64, h: 48, ratio: '4:3' },
  m0: 2.45,
  m1: 4.0,
  // An orange tabby runs, wiggles before the pounce, leaps, and lands as a
  // pair of pixel shades drops onto its face (Deal With It)
  draw(g, t, opt) {
    const big = seg(t, JUMP0, JUMP1);
    let f;
    if (t < CROUCH) f = { ...CAT_RUN[mod(Math.floor(t * 10), 4)], blink: mod(t * 0.6, 1) < 0.05 };
    else if (t < JUMP0)
      f = {
        legs: [8, 10, 22, 24],
        bodyY: 2,
        tail: mod(Math.floor(t * 16), 2) ? -2 : 1,
        crouch: true,
      };
    else if (big > 0 && big < 1) {
      f =
        big < 0.5
          ? { legs: [3, 5, 28, 30], footY: [19, 20, 17, 18], bodyY: -1, tail: -3, stretch: 2 }
          : { legs: [6, 8, 26, 28], footY: [20, 21, 21, 21], bodyY: 0, tail: -2, stretch: 1 };
    } else if (t < JUMP1 + 0.2) f = { legs: [7, 9, 23, 25], bodyY: 2, tail: 0, crouch: true };
    else f = { ...CAT_RUN[mod(Math.floor(t * 10), 4)], ears: t > 3.85 && t < 3.95 ? 1 : 0 };
    const lift = jumpHeight(t, 17);
    if (opt.bg !== false) shadow(g, PCX + 2, 22, lift);
    const sprite = baked(`cat:${JSON.stringify(f)}`, () => buildCat(f), opt.plates);
    drawBaked(g, sprite, PCX, GY + 2 - lift, plateOffset(t), t);
    if (t > 3.5) {
      const k = seg(t, 3.5, 3.85);
      // the head's place in the video (buildCat: hx = 25 + stretch, hy = by - 5)
      const hx = PCX - 17 + 25 + (f.stretch || 0);
      const hy = GY + 2 - 24 + 12 + f.bodyY - 5 + (f.crouch ? 2 : 0);
      const y = Math.round(lerp(-6, hy - 1, Math.min(1, k * k * 1.1)));
      const shades = baked('shades', buildShades, opt.plates);
      drawPlain(g, shades, hx - 6, y);
      if (k >= 1 && t < 4.3) {
        const gx = Math.round(lerp(hx - 6, hx + 6, seg(t, 3.9, 4.3)));
        g.fillStyle = '#ffffff';
        g.fillRect(gx, y - 1, 1, 3);
        g.fillRect(gx - 1, y, 3, 1);
      }
    }
  },
};

/* ================= CRT TV ================= */

const TVC = {
  B: '#d9cdb8',
  S: '#b3a68f',
  H: '#f1e8d6',
  SC: '#14283a',
  SL: '#1b3550',
  G: '#d6fbff',
  P: '#ff8fb3',
  K: '#3a3446',
};
const GIF_GLYPH = ['11101110111', '10000100100', '10100100110', '10100100100', '11101110100'];

function buildTv({ face, legs, ant, blink, noise }) {
  const s = new Sprite(28, 30);
  const C = TVC;
  const top = 7;
  s.line(11, top, 7 + ant, 1, C.K, 1);
  s.line(16, top, 20 - ant, 1, C.K, 1);
  s.rect(6 + ant, 0, 2, 2, '#ff5c8a');
  s.rect(19 - ant, 0, 2, 2, '#22d3ee');
  s.rect(3, top, 22, 17, C.B);
  for (const [x, y] of [
    [3, top],
    [24, top],
    [3, top + 16],
    [24, top + 16],
  ]) {
    s.set(x, y, null);
  }
  s.rect(4, top, 20, 1, C.H);
  s.rect(23, top + 1, 1, 15, C.S);
  s.rect(5, top + 2, 13, 11, C.SC);
  for (const [x, y] of [
    [5, top + 2],
    [17, top + 2],
    [5, top + 12],
    [17, top + 12],
  ]) {
    s.set(x, y, C.B);
  }
  for (let y = top + 3; y < top + 12; y += 2) s.rect(6, y, 11, 1, C.SL);
  s.ell(20.5, top + 4.5, 1.5, 1.5, C.K);
  s.ell(20.5, top + 8.5, 1.5, 1.5, C.K);
  s.set(20, top + 4, '#8f86a0');
  for (let i = 0; i < 3; i++) s.rect(19, top + 12 + i, 3, 1, i % 2 ? C.S : C.K);
  s.rect(7 + legs[0], top + 17, 2, 3, C.K);
  s.rect(18 + legs[1], top + 17, 2, 3, C.K);
  s.rect(6 + legs[0], top + 20, 4, 1, '#ff5c8a');
  s.rect(17 + legs[1], top + 20, 4, 1, '#ff5c8a');
  // the face on the screen
  const ox = 6;
  const oy = top + 3;
  const G = C.G;
  if (face === 'static') {
    const random = rng(noise + 1);
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 11; x++) {
        const v = random();
        s.set(ox + x, oy + y, v > 0.6 ? '#ffffff' : v > 0.3 ? '#8aa6b8' : '#26394a');
      }
    }
  } else if (face === 'gif') {
    GIF_GLYPH.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '1') s.set(ox + x, oy + 2 + y, G);
    });
  } else if (face === 'happy') {
    for (const [x, y] of [
      [1, 3],
      [2, 2],
      [3, 3],
      [7, 3],
      [8, 2],
      [9, 3],
      [3, 6],
      [4, 7],
      [5, 7],
      [6, 7],
      [7, 6],
    ]) {
      s.set(ox + x, oy + y, G);
    }
    s.set(ox, oy + 5, C.P);
    s.set(ox + 10, oy + 5, C.P);
  } else if (face === 'squint') {
    for (const [x, y] of [
      [1, 2],
      [2, 3],
      [1, 4],
      [9, 2],
      [8, 3],
      [9, 4],
    ]) {
      s.set(ox + x, oy + y, G);
    }
    s.rect(ox + 4, oy + 6, 3, 1, G);
  } else if (face === 'wow') {
    s.rect(ox + 2, oy + 2, 2, 2, G);
    s.rect(ox + 7, oy + 2, 2, 2, G);
    s.rect(ox + 4, oy + 5, 3, 1, G);
    s.rect(ox + 4, oy + 7, 3, 1, G);
    s.set(ox + 4, oy + 6, G);
    s.set(ox + 6, oy + 6, G);
  } else {
    if (blink) {
      s.rect(ox + 2, oy + 3, 2, 1, G);
      s.rect(ox + 7, oy + 3, 2, 1, G);
    } else {
      s.rect(ox + 2, oy + 2, 2, 2, G);
      s.rect(ox + 7, oy + 2, 2, 2, G);
    }
    s.rect(ox + 4, oy + 6, 3, 1, G);
    s.set(ox + 3, oy + 5, G);
    s.set(ox + 7, oy + 5, G);
  }
  return s.outline();
}

/** @type {CastMember} */
export const TV_MEMBER = {
  key: 'tv',
  file: 'tv.gif',
  crop: { x: 28, y: 11, w: 64, h: 48, ratio: '4:3' },
  m0: 2.45,
  m1: 4.3,
  // A CRT TV on stubby legs runs with a face on its screen; the landing
  // shakes it into static, which clears to "GIF"
  draw(g, t, opt) {
    const big = seg(t, JUMP0, JUMP1);
    const inBig = big > 0 && big < 1;
    const step = mod(Math.floor(t * 10), 4);
    let face = 'run';
    let legs = [0, 0];
    let dy = 0;
    if (t < CROUCH) {
      legs = LEG_STEPS[step];
      dy = step % 2 ? 0 : -1;
    } else if (t < JUMP0) {
      face = 'squint';
      dy = 1;
    } else if (inBig) {
      face = 'wow';
      legs = [-1, 1];
    } else if (t < JUMP1 + 0.4) {
      face = 'static';
      dy = t < JUMP1 + 0.15 ? 1 : 0;
    } else if (t < JUMP1 + 1.0) face = 'gif';
    else {
      face = 'happy';
      legs = LEG_STEPS[step];
      dy = step % 2 ? 0 : -1;
    }
    const pose = {
      face,
      legs,
      ant: Math.round(Math.sin(t * 14) * (inBig ? 2 : 1)),
      blink: face === 'run' && mod(t * 0.7, 1) < 0.06,
      noise: face === 'static' ? mod(Math.floor(t * 20), 6) : 0,
    };
    const lift = jumpHeight(t, 16);
    if (opt.bg !== false) shadow(g, PCX, 22, lift);
    const sprite = baked(`tv:${JSON.stringify(pose)}`, () => buildTv(pose), opt.plates);
    drawBaked(g, sprite, PCX, GY + 2 - lift + dy, plateOffset(t), t);
  },
};

/* ================= VHS ================= */

const VH = {
  B: '#2a2734',
  H: '#45414f',
  L: '#f1e9da',
  LT: '#9b8f7c',
  M: '#ff4fa3',
  C: '#3ee0f0',
  W: '#0e0d14',
  R: '#ece6da',
  T: '#5a3b2a',
};

function buildVhs({ legs, reel }) {
  const s = new Sprite(30, 20);
  const C = VH;
  s.rect(2, 1, 26, 13, C.B);
  s.rect(3, 1, 24, 1, C.H);
  s.rect(4, 3, 22, 4, C.L);
  s.rect(6, 4, 9, 1, C.LT);
  s.rect(17, 4, 5, 1, C.LT);
  s.rect(4, 6, 22, 1, C.M);
  s.rect(4, 7, 22, 1, C.C);
  s.rect(7, 9, 16, 4, C.W);
  s.rect(12, 11, 6, 1, C.T);
  // the two reels read as eyes; their spokes turn a notch per step
  for (const cx of [11, 19]) {
    s.ell(cx + 0.5, 11.5, 2.7, 2.7, C.R);
    s.set(cx, 11, C.W);
    const spokes = reel
      ? [
          [-1, -1],
          [1, 1],
          [-1, 1],
          [1, -1],
        ]
      : [
          [0, -2],
          [0, 2],
          [-2, 0],
          [2, 0],
        ];
    for (const [dx, dy] of spokes) s.set(cx + dx, 11 + dy, C.W);
  }
  s.rect(8 + legs[0], 14, 2, 3, C.B);
  s.rect(20 + legs[1], 14, 2, 3, C.B);
  s.rect(7 + legs[0], 17, 4, 1, C.M);
  s.rect(19 + legs[1], 17, 4, 1, C.M);
  return s.outline('#07060b');
}

/** @type {CastMember} */
export const VHS_MEMBER = {
  key: 'vhs',
  file: 'tracking.gif',
  crop: { x: 28, y: 12, w: 64, h: 48, ratio: '4:3' },
  m0: 2.45,
  m1: 4.2,
  // A video tape runs with its reels for eyes; the landing knocks its
  // tracking out (rows slip sideways, the plates tear apart), then ▶PLAY
  draw(g, t, opt) {
    const big = seg(t, JUMP0, JUMP1);
    const step = mod(Math.floor(t * 10), 4);
    let legs = [0, 0];
    let dy = 0;
    if (t < CROUCH || t > JUMP1 + 0.5) {
      legs = LEG_STEPS[step];
      dy = step % 2 ? 0 : -1;
    } else if (t < JUMP0) dy = 1;
    else if (big > 0 && big < 1) legs = [-1, 1];
    const reelTicks = t < JUMP1 ? Math.floor(t * 12) : Math.floor(JUMP1 * 12 + (t - JUMP1) * 4);
    const pose = { legs, reel: mod(reelTicks, 2) };
    const glitch = t > JUMP1 && t < JUMP1 + 0.5 ? 1 - seg(t, JUMP1, JUMP1 + 0.5) : 0;
    const lift = jumpHeight(t, 16);
    if (opt.bg !== false) shadow(g, PCX, 24, lift);
    let rowShift;
    let reg = plateOffset(t);
    if (glitch > 0) {
      const random = rng(Math.floor(t * 30));
      const shifts = Array.from({ length: 12 }, () => Math.round((random() - 0.5) * 8 * glitch));
      rowShift = (row) => shifts[Math.floor(row / 2)] ?? 0;
      reg = 2 + Math.round(glitch * 2);
    }
    const sprite = baked(`vhs:${JSON.stringify(pose)}`, () => buildVhs(pose), opt.plates);
    drawBaked(g, sprite, PCX, GY + 2 - lift + dy, reg, t, rowShift);
    // scan lines cross the whole picture: not part of the cut-out
    if (glitch > 0 && opt.bg !== false) {
      const random = rng(Math.floor(t * 25) + 3);
      g.fillStyle = 'rgba(255, 255, 255, 0.35)';
      for (let i = 0; i < 3; i++) g.fillRect(0, Math.floor(random() * 71), 149, 1);
    }
    // the punchline is: the transparent GIF keeps it
    if (t > JUMP1 + 0.4 && (t < 6 || mod(Math.floor(t * 2), 2) === 0)) {
      const x = PCX - 10;
      const y = GY - 30;
      pixelText(g, '>PLAY', x - 1, y, opt.plates.cyan);
      pixelText(g, '>PLAY', x + 1, y, opt.plates.magenta);
      pixelText(g, '>PLAY', x, y, '#ffffff');
    }
  },
};

/* ================= skater ================= */

const SK = {
  S: '#f2c29b',
  Sd: '#d9a07a',
  C: '#ff5c8a',
  Cd: '#d93d6b',
  H: '#3b2a26',
  T: '#ffd166',
  Td: '#e3a83a',
  P: '#3d5a9e',
  Pd: '#2c4278',
  W: '#f4f4f4',
  E: '#1b1025',
};

function buildSkater(p) {
  const s = new Sprite(22, 30);
  const C = SK;
  const hip = 19 + p.crouch;
  const foot = 27;
  if (p.tuck) {
    s.line(9, hip, 7, hip + 3, C.P, 2);
    s.line(7, hip + 3, 8, foot - p.tuck, C.P, 2);
    s.line(12, hip, 14, hip + 3, C.Pd, 2);
    s.line(14, hip + 3, 13, foot - p.tuck, C.Pd, 2);
  } else if (p.push) {
    s.line(10, hip, 11, foot - 1, C.P, 2);
    s.line(9, hip, 4 + (p.push > 0 ? 0 : 2), foot + 1, C.Pd, 2);
  } else {
    const deep = p.crouch > 1;
    s.line(9, hip, 7 - (deep ? 1 : 0), hip + 3 + (deep ? 0 : 1), C.P, 2);
    s.line(7 - (deep ? 1 : 0), hip + 3 + (deep ? 0 : 1), 8, foot - 1, C.P, 2);
    s.line(12, hip, 14 + (deep ? 1 : 0), hip + 3 + (deep ? 0 : 1), C.Pd, 2);
    s.line(14 + (deep ? 1 : 0), hip + 3 + (deep ? 0 : 1), 13, foot - 1, C.Pd, 2);
  }
  const shoeY = p.tuck ? foot - p.tuck : foot;
  if (!p.push) {
    s.rect(6, shoeY, 4, 2, C.W);
    s.rect(12, shoeY, 4, 2, C.W);
  } else {
    s.rect(10, foot, 4, 2, C.W);
    s.rect(3 + (p.push > 0 ? 0 : 2), foot + 1, 3, 1, C.W);
  }
  s.rect(8, hip - 7, 6, 7, C.T);
  s.rect(13, hip - 7, 1, 7, C.Td);
  s.rect(8, hip - 1, 6, 1, C.Pd);
  const sh = hip - 6;
  if (p.arms === 'up') {
    s.line(8, sh, 4, sh - 6, C.S, 2);
    s.line(13, sh, 17, sh - 6, C.S, 2);
    s.rect(8, sh, 2, 2, C.T);
    s.rect(12, sh, 2, 2, C.T);
  } else if (p.arms === 'out') {
    s.line(8, sh, 3, sh - 2, C.S, 2);
    s.line(13, sh, 18, sh + 1, C.S, 2);
    s.rect(7, sh, 2, 2, C.T);
    s.rect(13, sh, 2, 2, C.T);
  } else {
    s.line(8, sh, 6, sh + 5, C.S, 2);
    s.line(13, sh, 15, sh + 5, C.S, 2);
    s.rect(7, sh, 2, 2, C.T);
    s.rect(13, sh, 2, 2, C.T);
  }
  const hy = hip - 11;
  s.ell(11, hy, 3.4, 3.6, C.S);
  s.rect(8, hy + 1, 1, 2, C.H);
  s.rect(8, hy - 4, 7, 2, C.C);
  s.rect(9, hy - 5, 5, 1, C.C);
  s.rect(13, hy - 2, 4, 1, C.Cd);
  s.set(12, hy, C.E);
  s.set(14, hy + 2, C.Sd);
  if (p.arms === 'up') {
    s.set(11, hy + 2, C.E);
    s.set(12, hy + 2, C.E);
  }
  return s.outline();
}

function buildBoard(state) {
  const s = new Sprite(20, 6);
  if (state === 'edge') s.rect(2, 2, 16, 1, '#e9622c');
  else if (state === 'bottom') {
    s.rect(2, 1, 16, 2, '#7a3cff');
    s.rect(5, 1, 2, 2, '#ffd166');
    s.rect(13, 1, 2, 2, '#ffd166');
    s.rect(4, 0, 2, 1, '#f4f4f4');
    s.rect(14, 0, 2, 1, '#f4f4f4');
  } else {
    s.rect(3, 1, 14, 1, '#2b2b33');
    s.rect(2, 2, 16, 1, '#e9622c');
    s.set(1, 1, '#e9622c');
    s.set(18, 1, '#e9622c');
    s.rect(4, 3, 2, 2, '#f4f4f4');
    s.rect(14, 3, 2, 2, '#f4f4f4');
  }
  return s.outline(OUTLINE);
}

/** @type {CastMember} */
export const SKATER_MEMBER = {
  key: 'skater',
  file: 'kickflip.gif',
  // tall enough for the cap at the top of the ollie and the wheels on landing
  crop: { x: 24, y: 5, w: 72, h: 54, ratio: '4:3' },
  m0: 2.45,
  m1: 4.1,
  // A skater pushes in, crouches, ollies, kickflips the board mid-air,
  // lands it and throws both arms up
  draw(g, t, opt) {
    const big = seg(t, JUMP0, JUMP1);
    const inBig = big > 0 && big < 1;
    const p = { crouch: 0, push: 0, arms: 'down', tuck: 0 };
    let board = 'top';
    let boardLift = 0;
    const pushStep = mod(Math.floor(t * 5), 4);
    if (t < CROUCH || t >= JUMP1 + 1.0) p.push = pushStep === 1 ? 1 : pushStep === 2 ? -1 : 0;
    else if (t < JUMP0 || (!inBig && t < JUMP1 + 0.2)) {
      p.crouch = 3;
      p.arms = 'out';
    } else if (inBig) {
      p.tuck = 3;
      p.arms = 'out';
      const flip = mod(Math.floor((t - JUMP0) / 0.055), 4);
      board = big > 0.15 && big < 0.8 ? ['bottom', 'edge', 'top', 'edge'][flip] : 'top';
      boardLift = big < 0.5 ? 3 : 2;
    } else p.arms = 'up';
    const lift = jumpHeight(t, 18);
    if (opt.bg !== false) shadow(g, PCX, 20, lift);
    const reg = plateOffset(t);
    const boardSprite = baked(`board:${board}`, () => buildBoard(board), opt.plates);
    drawBaked(g, boardSprite, PCX, GY + 2 - lift + (inBig ? 3 - boardLift : 0), reg, t);
    const body = baked(`skater:${JSON.stringify(p)}`, () => buildSkater(p), opt.plates);
    drawBaked(g, body, PCX, GY - 3 - lift, reg, t);
    if (t > JUMP1 + 0.2 && t < JUMP1 + 1.0) {
      const k = seg(t, JUMP1 + 0.2, JUMP1 + 1.0);
      const sparkles = [
        [-12, -26],
        [11, -27],
        [-8, -32],
        [8, -33],
      ];
      sparkles.forEach(([dx, dy], i) => {
        if (mod(Math.floor(t * 10) + i, 2)) return;
        const x = PCX + dx;
        const y = GY + dy - Math.round(k * 3);
        g.fillStyle = i % 2 ? '#ffd166' : '#ffffff';
        g.fillRect(x, y - 1, 1, 3);
        g.fillRect(x - 1, y, 3, 1);
      });
    }
  },
};

/** @type {CastMember[]} */
export const CAST = [CAT_MEMBER, TV_MEMBER, VHS_MEMBER, SKATER_MEMBER];
