/**
 * Deterministic stratified pixel sampling (#99)
 *
 * Pure and dependency-free so both the main thread (palette sample pre-pass)
 * and the encoder worker (palette staleness check) can import it.
 * @module features/export/pixel-sampling
 */

/**
 * mulberry32: small seeded PRNG, so sampled output is reproducible.
 * @param {number} seed
 * @returns {() => number} Uniform floats in [0, 1)
 */
export function createPrng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pixel indices (y * width + x) of one jittered pixel per step x step cell,
 * row-major by cell. A fixed grid aliases with periodic content (e.g. rows
 * repeating every `step` pixels are sampled on one phase only); jittering
 * each cell's position removes that bias while keeping even coverage.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} step - Cell size (>= 1); step 1 returns every pixel
 * @param {number} seed - Same seed and size give the same indices
 * @returns {Uint32Array} Length ceil(width/step) * ceil(height/step)
 */
export function stratifiedPixelIndices(width, height, step, seed) {
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const out = new Uint32Array(cols * rows);
  const random = createPrng(seed);
  let i = 0;
  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * step;
    const cellH = Math.min(step, height - y0);
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * step;
      const cellW = Math.min(step, width - x0);
      const x = x0 + Math.floor(random() * cellW);
      const y = y0 + Math.floor(random() * cellH);
      out[i++] = y * width + x;
    }
  }
  return out;
}
