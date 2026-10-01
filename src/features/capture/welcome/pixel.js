/**
 * Pixel-art toolkit for the welcome scene
 * @module features/capture/welcome/pixel
 *
 * The welcome video is drawn at {@link LW}x{@link LH} real pixels and shown
 * at exactly 2x, so every pixel stays a crisp square. Sprites are built from
 * simple shapes on a pixel grid, outlined, then baked into small canvases
 * (with their cyan and magenta plates) and cached by pose, so a frame costs a
 * handful of drawImage calls rather than thousands of fillRects.
 */

/** The video's size in pixels, and its landmarks */
export const LW = 149;
export const LH = 71;
/** Horizon (synthwave) */
export const HY = 40;
/** Ground line the cast stands on */
export const GY = 57;
/** The cast's x position */
export const PCX = 60;

/** Outline colour shared by the cast */
export const OUTLINE = '#170f20';

/**
 * @param {string} hex - '#rrggbb'
 * @returns {[number, number, number]}
 */
function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Margin stored around every sprite's box. Shapes may reach one pixel past
 * the box (a tail tip, an ear) and the outline around them still fits.
 */
const MARGIN = 2;

/**
 * @typedef {Object} BakedSprite
 * @property {number} w - The sprite's box
 * @property {number} h
 * @property {number} margin - Extra pixels around the box in each canvas
 * @property {HTMLCanvasElement} image
 * @property {HTMLCanvasElement} cyan - Silhouette in the cyan plate
 * @property {HTMLCanvasElement} magenta - Silhouette in the magenta plate
 */

/**
 * A sprite under construction: a grid of '#rrggbb' colours (or null) in a
 * w x h box, coordinates relative to the box
 */
export class Sprite {
  /**
   * @param {number} w
   * @param {number} h
   */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    /** Stored size, margin included */
    this.sw = w + MARGIN * 2;
    this.sh = h + MARGIN * 2;
    /** @type {(string|null)[]} */
    this.d = new Array(this.sw * this.sh).fill(null);
  }

  /** Paint a pixel; anything further than a pixel outside the box is dropped */
  set(x, y, c) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 1 - MARGIN || py < 1 - MARGIN || px > this.w || py > this.h) return;
    this.d[(py + MARGIN) * this.sw + px + MARGIN] = c;
  }

  get(x, y) {
    const px = x + MARGIN;
    const py = y + MARGIN;
    if (px < 0 || py < 0 || px >= this.sw || py >= this.sh) return null;
    return this.d[py * this.sw + px];
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /** Filled ellipse, sampled at pixel centres */
  ell(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, c);
      }
    }
  }

  /** A line `w` pixels thick */
  line(x0, y0, x1, y1, c, w = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    const off = Math.floor((w - 1) / 2);
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n);
      const y = Math.round(y0 + ((y1 - y0) * i) / n);
      this.rect(x - off, y - off, w, w, c);
    }
  }

  /** Filled polygon, sampled at pixel centres (even-odd) */
  poly(pts, c) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
            inside = !inside;
        }
        if (inside) this.set(x, y, c);
      }
    }
  }

  /** A 1px outline around the filled shape: what makes it read as pixel art */
  outline(c = OUTLINE) {
    const add = [];
    for (let y = -MARGIN; y < this.h + MARGIN; y++) {
      for (let x = -MARGIN; x < this.w + MARGIN; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) {
          add.push([x, y]);
        }
      }
    }
    // straight into the margin: the outline may go where shapes may not
    for (const [x, y] of add) this.d[(y + MARGIN) * this.sw + x + MARGIN] = c;
    return this;
  }

  /**
   * Bake into canvases: the sprite, plus its silhouette in each plate
   * @param {{ cyan: string, magenta: string }} plates
   * @returns {BakedSprite}
   */
  bake(plates) {
    const make = (tint) => {
      const canvas = document.createElement('canvas');
      canvas.width = this.sw;
      canvas.height = this.sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) return canvas;
      const img = ctx.createImageData(this.sw, this.sh);
      const t = tint ? rgb(tint) : null;
      for (let i = 0; i < this.d.length; i++) {
        const c = this.d[i];
        if (!c) continue;
        const [r, g, b] = t ?? rgb(c);
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    };
    return {
      w: this.w,
      h: this.h,
      margin: MARGIN,
      image: make(null),
      cyan: make(plates.cyan),
      magenta: make(plates.magenta),
    };
  }
}

/** Baked sprites by pose key; poses are few, so the cache stays small */
const bakedCache = new Map();

/**
 * A baked sprite for a pose, built once
 * @param {string} key - Unique per pose (include every parameter)
 * @param {() => Sprite} build
 * @param {{ cyan: string, magenta: string }} plates
 * @returns {BakedSprite}
 */
export function baked(key, build, plates) {
  const full = `${key}|${plates.cyan}|${plates.magenta}`;
  let entry = bakedCache.get(full);
  if (!entry) {
    entry = build().bake(plates);
    bakedCache.set(full, entry);
  }
  return entry;
}

/**
 * Draw a baked sprite with its two plates set off register behind it, the
 * logo's look: the plates jitter in steps and separate further when `reg`
 * (the cast's speed) grows. Anchored at the bottom centre.
 * @param {CanvasRenderingContext2D} g
 * @param {BakedSprite} s
 * @param {number} x - Centre x
 * @param {number} bottom - Bottom y
 * @param {number} reg - Plate offset in pixels
 * @param {number} t - Seconds (drives the jitter)
 * @param {(row: number) => number} [rowShift] - Per-row x offset (glitch),
 *   by row of the baked canvas (0 = its top)
 */
export function drawBaked(g, s, x, bottom, reg, t, rowShift) {
  const ox = Math.round(x - s.w / 2) - s.margin;
  const oy = Math.round(bottom - s.h) - s.margin;
  const step = ((Math.floor(t * 5) % 3) + 3) % 3;
  const r = Math.round(reg);
  const jx = r ? [0, -1, 1][step] : 0;
  const jy = r ? [0, 1, 0][step] : 0;
  const blit = (img, dx, dy) => {
    if (!rowShift) {
      g.drawImage(img, dx, dy);
      return;
    }
    for (let row = 0; row < img.height; row++)
      g.drawImage(img, 0, row, img.width, 1, dx + rowShift(row), dy + row, img.width, 1);
  };
  blit(s.cyan, ox - r + jx, oy + jy);
  blit(s.magenta, ox + r - jx, oy - jy);
  blit(s.image, ox, oy);
}

/**
 * Draw a baked sprite as it is, no plates, its box's top left at (x, y)
 * @param {CanvasRenderingContext2D} g
 * @param {BakedSprite} s
 */
export function drawPlain(g, s, x, y) {
  g.drawImage(s.image, Math.round(x) - s.margin, Math.round(y) - s.margin);
}

/** 3x5 pixel font for the few words the cast says */
const FONT = {
  P: '110101110100100',
  L: '100100100100111',
  A: '010101111101101',
  Y: '101101010010010',
  '>': '100110111110100',
};

/**
 * @param {CanvasRenderingContext2D} g
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {string} color
 */
export function pixelText(g, text, x, y, color) {
  g.fillStyle = color;
  [...text].forEach((ch, n) => {
    const glyph = FONT[ch];
    if (!glyph) return;
    for (let i = 0; i < 15; i++) {
      if (glyph[i] === '1')
        g.fillRect(Math.round(x) + n * 4 + (i % 3), Math.round(y) + Math.floor(i / 3), 1, 1);
    }
  });
}

/**
 * A 1px Bresenham line
 * @param {CanvasRenderingContext2D} g
 */
export function pixelLine(g, ax, ay, bx, by, color) {
  g.fillStyle = color;
  let x0 = Math.round(ax);
  let y0 = Math.round(ay);
  const x1 = Math.round(bx);
  const y1 = Math.round(by);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 512; n++) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * A small offscreen canvas
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
export function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}
