/**
 * Color Key (background removal) - Pure Functions
 *
 * Clears pixels close to a key color in an RGBA buffer, either everywhere
 * ('global') or only where they connect to the buffer border ('connected',
 * a flood fill that leaves same-colored foreground details untouched).
 * No DOM access: callers pass ImageData.data or a VideoFrame copy.
 *
 * @module shared/edits/color-key
 */

/** Maximum Euclidean RGB distance: sqrt(3 * 255^2) */
export const MAX_RGB_DISTANCE = 441.673;

/** Pixels with alpha below this are treated as transparent (GIF is 1-bit alpha) */
export const ALPHA_THRESHOLD = 128;

/**
 * Snap every pixel's alpha to what a transparent GIF can store, in place:
 * below ALPHA_THRESHOLD becomes 0 (the transparent index), everything else
 * 255 (an opaque palette color). This is the same decision the gifenc
 * encoder makes, so a preview snapped this way shows what will be exported.
 * @param {Uint8Array|Uint8ClampedArray} rgba - 4 bytes per pixel, alpha last
 * @returns {boolean} Whether any pixel changed
 */
export function snapAlphaToBinary(rgba) {
  let changed = false;
  for (let p = 3; p < rgba.length; p += 4) {
    const a = rgba[p];
    if (a === 0 || a === 255) continue;
    rgba[p] = a < ALPHA_THRESHOLD ? 0 : 255;
    changed = true;
  }
  return changed;
}

/**
 * Parse '#rrggbb'
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number } | null}
 */
export function parseHexColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/**
 * Format an RGB triple as '#rrggbb' (channels clamped and rounded)
 * @param {{ r: number, g: number, b: number }} color
 * @returns {string}
 */
export function toHexColor({ r, g, b }) {
  const channel = (/** @type {number} */ v) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Clear pixels matching the key color. Mutates `rgba` in place: cleared
 * pixels become RGBA 0,0,0,0.
 *
 * A pixel matches when its Euclidean RGB distance to the key color is at
 * most (tolerance / 100) * MAX_RGB_DISTANCE (tolerance 0 = exact color).
 * - 'global': every matching pixel is cleared.
 * - 'connected': 4-neighbour flood fill seeded from every matching border
 *   pixel; only matching pixels connected to the border are cleared.
 *   Already-transparent pixels (alpha < 128) count as matching for
 *   connectivity, so transparency in the source joins regions, but they are
 *   not counted in the return value.
 *
 * Iterative (explicit Int32Array stack), O(width * height).
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba - RGBA buffer, width * height * 4 bytes
 * @param {number} width
 * @param {number} height
 * @param {import('./model.js').BackgroundRemoval | null | undefined} background
 * @returns {number} Number of opaque pixels cleared
 */
export function applyColorKey(rgba, width, height, background) {
  if (!background?.enabled || width <= 0 || height <= 0) return 0;
  const key = parseHexColor(background.color);
  if (!key) return 0;

  const tolerance = Math.min(100, Math.max(0, Number(background.tolerance) || 0));
  const limit = (tolerance / 100) * MAX_RGB_DISTANCE;
  const limitSq = limit * limit;
  const { r: kr, g: kg, b: kb } = key;
  const pixelCount = width * height;

  /**
   * @param {number} p - Pixel index
   * @returns {boolean}
   */
  const matchesKey = (p) => {
    const o = p * 4;
    const dr = rgba[o] - kr;
    const dg = rgba[o + 1] - kg;
    const db = rgba[o + 2] - kb;
    return dr * dr + dg * dg + db * db <= limitSq;
  };

  /**
   * Clear pixel p; returns 1 when it was opaque (counted), else 0
   * @param {number} p
   * @returns {number}
   */
  const clear = (p) => {
    const o = p * 4;
    const wasOpaque = rgba[o + 3] >= ALPHA_THRESHOLD ? 1 : 0;
    rgba[o] = 0;
    rgba[o + 1] = 0;
    rgba[o + 2] = 0;
    rgba[o + 3] = 0;
    return wasOpaque;
  };

  let cleared = 0;

  if (background.mode === 'global') {
    for (let p = 0; p < pixelCount; p++) {
      if (rgba[p * 4 + 3] >= ALPHA_THRESHOLD && matchesKey(p)) {
        cleared += clear(p);
      }
    }
    return cleared;
  }

  // Connected: flood fill from the border. `visited` marks pixels already
  // pushed, so each pixel enters the stack at most once and the stack never
  // exceeds pixelCount entries.
  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  let top = 0;

  /** @param {number} p */
  const isFillable = (p) => rgba[p * 4 + 3] < ALPHA_THRESHOLD || matchesKey(p);

  /** @param {number} p */
  const seed = (p) => {
    if (!visited[p] && isFillable(p)) {
      visited[p] = 1;
      stack[top++] = p;
    }
  };

  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (top > 0) {
    const p = stack[--top];
    cleared += clear(p);
    const x = p % width;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (p >= width) seed(p - width);
    if (p < pixelCount - width) seed(p + width);
  }

  return cleared;
}

/**
 * Most frequent border color, after quantizing each channel to 5 bits
 * (ties: the bucket seen first). Used as the default key color when the user
 * enables background removal. Transparent border pixels are ignored; a
 * buffer with no opaque border pixel yields '#000000'.
 *
 * Returns the exact color of the first pixel seen in the winning bucket, so
 * the key is a real border color rather than a bucket corner.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {string} '#rrggbb'
 */
export function detectEdgeColor(rgba, width, height) {
  return findOpaqueEdgeColor(rgba, width, height) ?? '#000000';
}

/**
 * detectEdgeColor without the fallback: null when no border pixel is
 * opaque. A border that is already transparent has no color to key out —
 * the '#000000' fallback would erase dark outlines touching it.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {string | null} '#rrggbb', or null without an opaque border pixel
 */
export function findOpaqueEdgeColor(rgba, width, height) {
  if (width <= 0 || height <= 0) return null;

  /** @type {Map<number, { count: number, r: number, g: number, b: number }>} */
  const buckets = new Map();

  /** @param {number} p */
  const visit = (p) => {
    const o = p * 4;
    if (rgba[o + 3] < ALPHA_THRESHOLD) return;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const bucketKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { count: 0, r, g, b };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;
  };

  for (let x = 0; x < width; x++) visit(x);
  if (height > 1) {
    for (let x = 0; x < width; x++) visit((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width);
    if (width > 1) visit(y * width + width - 1);
  }

  // Map iteration follows insertion order, so strictly-greater keeps the
  // first-seen bucket on ties
  /** @type {{ count: number, r: number, g: number, b: number } | null} */
  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  return best ? toHexColor(best) : null;
}
