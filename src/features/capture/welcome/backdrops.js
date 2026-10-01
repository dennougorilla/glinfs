/**
 * Backdrops for the welcome video
 * @module features/capture/welcome/backdrops
 *
 * Both are pixel art at the video's own resolution. Everything that does
 * not move is painted once into a cached canvas; a frame only adds what
 * moves (stars, the scrolling skyline, the floor lines), so a backdrop costs
 * a few drawImage and fillRect calls per frame.
 */

import { GY, HY, LH, LW, makeCanvas, pixelLine } from './pixel.js';
import { mod, rng } from './timeline.js';

/**
 * @typedef {Object} Backdrop
 * @property {string} key
 * @property {(g: CanvasRenderingContext2D, t: number) => void} draw
 */

/**
 * Dithered vertical gradient over rows [y0, y1)
 * @param {CanvasRenderingContext2D} g
 * @param {string[]} bands - Colours from top to bottom
 */
function ditherSky(g, bands, y0, y1) {
  for (let y = y0; y < y1; y++) {
    const f = ((y - y0) / (y1 - y0)) * (bands.length - 1);
    const b = Math.floor(f);
    const fr = f - b;
    for (let x = 0; x < LW; x++) {
      const next = fr > 0.66 || (fr > 0.33 && (x + y) % 2 === 0);
      g.fillStyle = next && b + 1 < bands.length ? bands[b + 1] : bands[b];
      g.fillRect(x, y, 1, 1);
    }
  }
}

/**
 * Twinkling stars: a fixed field, a few off at any time
 * @param {CanvasRenderingContext2D} g
 */
function stars(g, t, maxY, seed, colors) {
  const random = rng(seed);
  const tick = Math.floor(t * 3);
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(random() * LW);
    const y = Math.floor(random() * maxY);
    if (mod(tick + i, 5) === 0) continue;
    g.fillStyle = i % 4 ? colors[0] : colors[1];
    g.fillRect(x, y, 1, 1);
  }
}

/* ---------------- synthwave ---------------- */

const SYNTH_SKY = ['#0b0620', '#120835', '#1d0c4a', '#2c105c', '#44166a', '#621c70', '#7e2272'];
const SUN = ['#ffe36e', '#ffc65a', '#ff9b52', '#ff6d5e', '#ff3f86'];
const synthCache = [];

function paintSynth(g, phase) {
  ditherSky(g, SYNTH_SKY, 0, HY);
  // a striped sun; the cuts in its lower half scroll (three cached phases)
  const scx = 101;
  const sr = 15;
  for (let y = HY - sr; y < HY; y++) {
    if (y > HY - 9 && (y + phase) % 3 === 0) continue;
    for (let x = scx - sr; x <= scx + sr; x++) {
      const dx = x + 0.5 - scx;
      const dy = y + 0.5 - HY;
      if (dx * dx + dy * dy > sr * sr) continue;
      g.fillStyle = SUN[Math.min(SUN.length - 1, Math.floor(((y - (HY - sr)) / sr) * SUN.length))];
      g.fillRect(x, y, 1, 1);
    }
  }
  const mountains = (pts) => {
    for (let x = 0; x < LW; x++) {
      let top = HY;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        if (x >= ax && x <= bx)
          top = Math.round(ay + ((by - ay) * (x - ax)) / Math.max(1, bx - ax));
      }
      if (top >= HY) continue;
      g.fillStyle = '#1c0a35';
      g.fillRect(x, top, 1, HY - top);
      g.fillStyle = '#ff4fb8';
      g.fillRect(x, top, 1, 1);
    }
  };
  mountains([
    [0, 31],
    [9, 26],
    [17, 30],
    [28, 22],
    [40, 31],
    [52, 27],
    [62, 40],
  ]);
  mountains([
    [118, 40],
    [126, 30],
    [134, 34],
    [142, 26],
    [149, 31],
  ]);
  for (let y = HY; y < LH; y++) {
    g.fillStyle = y < HY + 6 ? '#22073d' : y < HY + 16 ? '#18052e' : '#100320';
    g.fillRect(0, y, LW, 1);
  }
  g.fillStyle = '#ff6ad5';
  g.fillRect(0, HY, LW, 1);
  // floor lines start just under the horizon so they fan out instead of
  // piling up into a solid band where they converge
  const vx = 75;
  for (let k = -9; k <= 9; k++) {
    const x0 = vx + k * 5;
    const x1 = vx + k * 30;
    const y0 = HY + 3;
    const s0 = (y0 - HY) / (LH + 4 - HY);
    pixelLine(g, x0 + (x1 - x0) * s0, y0, x1, LH + 4, k === 0 ? '#c0309a' : '#9b2a8c');
  }
}

/** @type {Backdrop} */
export const SYNTHWAVE = {
  key: 'synthwave',
  draw(g, t) {
    const phase = mod(Math.floor(t * 4), 3);
    if (!synthCache[phase]) {
      const c = makeCanvas(LW, LH);
      const ctx = c.getContext('2d');
      if (ctx) paintSynth(ctx, phase);
      synthCache[phase] = c;
    }
    g.drawImage(synthCache[phase], 0, 0);
    stars(g, t, 20, 8, ['#c9b8ff', '#ffffff']);
    // the floor rows flow toward the viewer
    g.fillStyle = '#c0309a';
    for (let i = 0; i < 7; i++) {
      const z = (i + mod(t * 1.6, 1)) / 7;
      const y = Math.round(HY + z ** 2.3 * (LH - HY + 2));
      if (y > HY + 2) g.fillRect(0, y, LW, 1);
    }
  },
};

/* ---------------- night city ---------------- */

const NIGHT_SKY = ['#04050c', '#070918', '#0b0f24', '#111632', '#171d40', '#1e2448'];
const nightCache = {};

/** A seamless strip of buildings, `tile` px wide, drawn twice for wrapping */
function paintSkyline(tile, { seed, base, minH, maxH, body, roof, lit, chance }) {
  const c = makeCanvas(tile, LH);
  const g = c.getContext('2d');
  if (!g) return c;
  const random = rng(seed);
  let x = 0;
  while (x < tile) {
    const w = Math.min(tile - x, 5 + Math.floor(random() * 9));
    const h = minH + Math.floor(random() * (maxH - minH));
    const top = base - h;
    g.fillStyle = body;
    g.fillRect(x, top, w, h);
    g.fillStyle = roof;
    g.fillRect(x, top, w, 1);
    if (random() < 0.25 && w > 6) {
      g.fillStyle = body;
      g.fillRect(x + Math.floor(w / 2), top - 3, 1, 3);
    }
    if (lit) {
      for (let wy = top + 2; wy < base - 2; wy += 3) {
        for (let wx = x + 1; wx < x + w - 1; wx += 2) {
          const r = random();
          if (r > chance) continue;
          g.fillStyle = r < chance * 0.15 ? '#8fd8ff' : r < chance * 0.55 ? '#ffd27a' : '#ffb35c';
          g.fillRect(wx, wy, 1, 1);
        }
      }
    }
    x += w;
  }
  return c;
}

function nightLayers() {
  if (nightCache.sky) return nightCache;
  const sky = makeCanvas(LW, LH);
  const g = sky.getContext('2d');
  if (g) {
    ditherSky(g, NIGHT_SKY, 0, GY);
    // a crescent moon
    const moon = (cx, cy, r, color) => {
      g.fillStyle = color;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r * r) g.fillRect(x, y, 1, 1);
        }
      }
    };
    moon(118, 12, 5.5, '#f4f1e6');
    moon(120.5, 10.5, 5, NIGHT_SKY[1]);
  }
  nightCache.sky = sky;
  nightCache.far = paintSkyline(160, {
    seed: 21,
    base: GY,
    minH: 10,
    maxH: 24,
    body: '#121731',
    roof: '#1b2244',
    lit: true,
    chance: 0.08,
  });
  nightCache.near = paintSkyline(180, {
    seed: 33,
    base: GY,
    minH: 6,
    maxH: 18,
    body: '#1b2140',
    roof: '#2b3360',
    lit: true,
    chance: 0.3,
  });
  return nightCache;
}

/** @type {Backdrop} */
export const NIGHT_CITY = {
  key: 'night',
  draw(g, t) {
    const layers = nightLayers();
    g.drawImage(layers.sky, 0, 0);
    stars(g, t, 30, 13, ['#aab4ff', '#ffffff']);
    // two skylines scrolling at different speeds: the run's parallax
    const strip = (img, speed) => {
      const off = -Math.round(mod(t * speed, img.width));
      for (let x = off; x < LW; x += img.width) g.drawImage(img, x, 0);
    };
    strip(layers.far, 6);
    strip(layers.near, 14);
    // street: kerb, road, lane dashes moving at the run's speed
    g.fillStyle = '#2b3154';
    g.fillRect(0, GY, LW, 1);
    g.fillStyle = '#0b0d17';
    g.fillRect(0, GY + 1, LW, LH - GY - 1);
    g.fillStyle = '#4d536c';
    const dash = -Math.round(mod(t * 28, 10));
    for (let x = dash; x < LW; x += 10) g.fillRect(x, GY + 7, 5, 1);
  },
};

/** @type {Backdrop[]} */
export const BACKDROPS = [SYNTHWAVE, NIGHT_CITY];
