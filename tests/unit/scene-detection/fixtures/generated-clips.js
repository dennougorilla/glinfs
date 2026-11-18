/**
 * Generated clips for scene detection accuracy tests (owner feedback
 * 2026-11-17, item 6). Frames are drawn at 256x144 and box-downscaled to
 * 64x36, the size the app analyses (manager.js DEFAULT_THUMBNAIL_SIZE).
 * Each clip lists its true cuts; a fade's cut may be found anywhere in it.
 */

const FW = 256;
const FH = 144;
const AW = 64;
const AH = 36;
/** Frames per shot */
const SHOT = 24;

/**
 * @typedef {{ data: Uint8ClampedArray, width: number, height: number }} SmallFrame
 * @typedef {Object} GeneratedClip
 * @property {string} name
 * @property {SmallFrame[]} frames - 64x36 RGBA
 * @property {number[]} cuts - Frame indices where a new shot starts
 * @property {[number, number][]} [fades] - Frame spans of gradual transitions
 */

/**
 * @param {number} seed
 * @returns {GeneratedClip[]}
 */
export function generateClips(seed) {
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  const frame = () => new Uint8ClampedArray(FW * FH * 4);
  /** @param {Uint8ClampedArray} img @param {number[]} c */
  const fill = (img, c) => {
    for (let i = 0; i < FW * FH; i++) {
      img[i * 4] = c[0];
      img[i * 4 + 1] = c[1];
      img[i * 4 + 2] = c[2];
      img[i * 4 + 3] = 255;
    }
  };
  /** @param {Uint8ClampedArray} img @param {number} x @param {number} y @param {number} w @param {number} h @param {number[]} c */
  const rect = (img, x, y, w, h, c) => {
    for (let yy = Math.max(0, y | 0); yy < Math.min(FH, (y + h) | 0); yy++) {
      for (let xx = Math.max(0, x | 0); xx < Math.min(FW, (x + w) | 0); xx++) {
        const i = (yy * FW + xx) * 4;
        img[i] = c[0];
        img[i + 1] = c[1];
        img[i + 2] = c[2];
      }
    }
  };
  /** @param {Uint8ClampedArray} img @param {number} cx @param {number} cy @param {number} r @param {number[]} c */
  const disc = (img, cx, cy, r, c) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x < FW && y < FH) {
          const i = ((y | 0) * FW + (x | 0)) * 4;
          img[i] = c[0];
          img[i + 1] = c[1];
          img[i + 2] = c[2];
        }
      }
    }
  };
  /** @param {Uint8ClampedArray} img @param {number[]} a @param {number[]} b */
  const gradient = (img, a, b) => {
    for (let y = 0; y < FH; y++) {
      const t = y / FH;
      rect(
        img,
        0,
        y,
        FW,
        1,
        a.map((v, k) => v + (b[k] - v) * t),
      );
    }
  };
  /** @param {Uint8ClampedArray} img @param {number} amp */
  const noise = (img, amp) => {
    for (let i = 0; i < img.length; i += 4) {
      const n = (rnd() - 0.5) * 2 * amp;
      img[i] += n;
      img[i + 1] += n;
      img[i + 2] += n;
    }
  };
  /** @param {Uint8ClampedArray} a @param {Uint8ClampedArray} b @param {number} t */
  const blend = (a, b, t) => {
    const o = frame();
    for (let i = 0; i < o.length; i++) o[i] = a[i] * (1 - t) + b[i] * t;
    return o;
  };
  const palette = () => Array.from({ length: 5 }, () => [rnd() * 255, rnd() * 255, rnd() * 255]);

  /**
   * A shot: background gradient and shapes; `shift` pans, `arm` / `mouth` animate a part
   * @param {number[][]} p
   * @param {number} [layout]
   */
  const makeScene = (p, layout = rnd() * 1e6) => {
    const saved = state;
    state = Math.floor(layout) || 1;
    const shapes = Array.from({ length: 6 }, () => ({
      x: rnd() * FW,
      y: rnd() * FH,
      w: 20 + rnd() * 70,
      h: 20 + rnd() * 60,
      c: p[1 + Math.floor(rnd() * 4)],
      round: rnd() < 0.4,
    }));
    state = saved;
    /** @param {{ shift?: number, mouth?: boolean, arm?: number }} [opts] */
    return (opts = {}) => {
      const img = frame();
      gradient(
        img,
        p[0],
        p[0].map((v) => v * 0.7),
      );
      const dx = opts.shift ?? 0;
      for (const s of shapes) {
        for (const k of [-1, 0, 1]) {
          const x = s.x - dx + k * (FW + 100);
          if (s.round) disc(img, x + s.w / 2, s.y + s.h / 2, Math.min(s.w, s.h) / 2, s.c);
          else rect(img, x, s.y, s.w, s.h, s.c);
        }
      }
      if (opts.mouth !== undefined) rect(img, 120, 80, 14, opts.mouth ? 8 : 2, [60, 20, 20]);
      if (opts.arm !== undefined) rect(img, 150 + opts.arm, 60, 40, 10, p[2]);
      noise(img, 3);
      return img;
    };
  };

  /**
   * A screen-recording page: white, text lines, a scroll offset
   * @param {number[][]} p
   * @param {number} layout
   */
  const makePage = (p, layout) => {
    const saved = state;
    state = layout;
    const lines = Array.from({ length: 60 }, (_, i) => ({
      y: i * 9,
      w: 60 + rnd() * 160,
      img: rnd() < 0.08,
      c: p[1 + Math.floor(rnd() * 4)],
    }));
    state = saved;
    return ({ scroll = 0 } = {}) => {
      const img = frame();
      fill(img, [250, 250, 250]);
      rect(img, 0, 0, FW, 14, p[0]);
      for (const l of lines) {
        const y = 20 + l.y - scroll;
        if (y < 14 || y > FH) continue;
        if (l.img) rect(img, 20, y, 90, 30, l.c);
        else rect(img, 20, y, l.w, 3, [40, 40, 40]);
      }
      noise(img, 1);
      return img;
    };
  };

  /** @param {Uint8ClampedArray} img @returns {SmallFrame} */
  const downscale = (img) => {
    const out = new Uint8ClampedArray(AW * AH * 4);
    const fx = FW / AW;
    const fy = FH / AH;
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        for (let k = 0; k < 4; k++) {
          let sum = 0;
          for (let yy = 0; yy < fy; yy++) {
            for (let xx = 0; xx < fx; xx++) sum += img[((y * fy + yy) * FW + x * fx + xx) * 4 + k];
          }
          out[(y * AW + x) * 4 + k] = sum / (fx * fy);
        }
      }
    }
    return { data: out, width: AW, height: AH };
  };

  /** @type {{ name: string, frames: Uint8ClampedArray[], cuts: number[], fades?: [number, number][] }[]} */
  const list = [];
  {
    const shots = Array.from({ length: 5 }, () => makeScene(palette()));
    const frames = [];
    const cuts = [];
    shots.forEach((s, k) => {
      if (k) cuts.push(frames.length);
      for (let f = 0; f < SHOT; f++) frames.push(s({ arm: (f * 2) % 30 }));
    });
    list.push({ name: 'hard cuts, different palettes', frames, cuts });
  }
  {
    const p = palette();
    const shots = Array.from({ length: 5 }, (_, k) => makeScene(p, 100 + k * 77));
    const frames = [];
    const cuts = [];
    shots.forEach((s, k) => {
      if (k) cuts.push(frames.length);
      for (let f = 0; f < SHOT; f++) frames.push(s({ arm: (f * 2) % 30 }));
    });
    list.push({ name: 'hard cuts, same palette', frames, cuts });
  }
  {
    const shots = Array.from({ length: 4 }, () => makeScene(palette()));
    const frames = [];
    const cuts = [];
    /** @type {[number, number][]} */
    const fades = [];
    shots.forEach((s, k) => {
      if (k) {
        const a = shots[k - 1]({});
        const b = s({});
        const st = frames.length;
        for (let f = 1; f <= 12; f++) frames.push(blend(a, b, f / 13));
        fades.push([st, frames.length]);
        cuts.push(st + 6);
      }
      for (let f = 0; f < SHOT; f++) frames.push(s({}));
    });
    list.push({ name: 'cross-fades (12 frames)', frames, cuts, fades });
  }
  {
    const a = makeScene(palette());
    const b = makeScene(palette());
    const frames = [];
    for (let f = 0; f < SHOT; f++) frames.push(a({}));
    const st = frames.length;
    const black = frame();
    fill(black, [0, 0, 0]);
    for (let f = 1; f <= 8; f++) frames.push(blend(a({}), black, f / 8));
    for (let f = 1; f <= 8; f++) frames.push(blend(black, b({}), f / 8));
    /** @type {[number, number][]} */
    const fades = [[st, frames.length]];
    for (let f = 0; f < SHOT; f++) frames.push(b({}));
    list.push({ name: 'fade through black', frames, cuts: [st + 8], fades });
  }
  {
    const a = makeScene(palette());
    const frames = [];
    const white = frame();
    fill(white, [255, 255, 255]);
    for (let f = 0; f < 90; f++) {
      frames.push(f % 30 === 15 || f % 30 === 16 ? blend(a({}), white, 0.85) : a({ arm: f % 20 }));
    }
    list.push({ name: 'white flashes (2 frames), no cut', frames, cuts: [] });
  }
  {
    const a = makeScene(palette());
    const frames = [];
    for (let f = 0; f < 96; f++) frames.push(a({ shift: f * 4 }));
    list.push({ name: 'fast pan, no cut', frames, cuts: [] });
  }
  {
    const a = makeScene(palette());
    const frames = [];
    for (let f = 0; f < 96; f++) frames.push(a({ mouth: Math.floor(f / 3) % 2 === 0 }));
    list.push({ name: 'static dialogue, mouth flaps', frames, cuts: [] });
  }
  {
    const shots = Array.from({ length: 3 }, () => makeScene(palette()));
    const frames = [];
    const cuts = [];
    shots.forEach((s, k) => {
      if (k) cuts.push(frames.length);
      for (let f = 0; f < 36; f++) {
        frames.push(
          s({
            arm: (Math.floor(f / (k === 1 ? 3 : 2)) * 12) % 60,
            shift: Math.floor(f / 3) * 10,
          }),
        );
      }
    });
    list.push({ name: 'anime on 2s/3s, held motion, cuts', frames, cuts });
  }
  {
    const pages = [101, 202, 303].map((l) => makePage(palette(), l));
    const frames = [];
    const cuts = [];
    pages.forEach((pg, k) => {
      if (k) cuts.push(frames.length);
      for (let f = 0; f < 30; f++) frames.push(pg({ scroll: f * 3 }));
    });
    list.push({ name: 'screen recording: scrolling pages, tab switches', frames, cuts });
  }
  {
    const pg = makePage(palette(), 404);
    const other = makeScene(palette());
    const frames = [];
    for (let f = 0; f < 30; f++) frames.push(pg({}));
    for (let f = 0; f < 30; f++) {
      const img = pg({});
      rect(img, 60, 30, 136, 84, [255, 255, 255]);
      rect(img, 60, 30, 136, 12, [30, 90, 200]);
      frames.push(img);
    }
    const cut = frames.length;
    for (let f = 0; f < 30; f++) frames.push(other({ arm: f }));
    list.push({
      name: 'screen recording: a dialog opens, then an app switch',
      frames,
      cuts: [cut],
    });
  }

  return list.map((clip) => ({ ...clip, frames: clip.frames.map(downscale) }));
}

/**
 * Match detected scene starts to a clip's true cuts (+-2 frames, or anywhere
 * in a fade). Extra detections are false positives.
 * @param {number[]} detected - Scene start frames (excluding 0)
 * @param {GeneratedClip} clip
 * @returns {{ tp: number, fp: number, fn: number }}
 */
export function scoreCuts(detected, clip) {
  const used = new Set();
  let tp = 0;
  for (const cut of clip.cuts) {
    const fade = clip.fades?.find(([a, b]) => cut >= a && cut <= b);
    const lo = fade ? fade[0] - 2 : cut - 2;
    const hi = fade ? fade[1] + 2 : cut + 2;
    const hit = detected.find((x) => x >= lo && x <= hi && !used.has(x));
    if (hit !== undefined) {
      tp++;
      used.add(hit);
    }
  }
  return { tp, fp: detected.length - used.size, fn: clip.cuts.length - tp };
}
