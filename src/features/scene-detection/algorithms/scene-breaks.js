/**
 * Scene break methods (Settings → Methods → Scenes)
 *
 * Every method reads the same per-frame signals, so the methods can be
 * compared on saved numbers as well as on pixels:
 * - histogram(a, b): main's histogram distance between frames a < b
 *   (64 bins per channel, chi-square / 2), at most MAX_LAG frames apart
 * - hash(a, b): Hamming distance of the frames' perceptual hashes (0..64)
 *
 * @module features/scene-detection/algorithms/scene-breaks
 */

/** The farthest two frames any method compares (positions) */
export const MAX_LAG = 12;

/**
 * @typedef {Object} FrameSignals
 * @property {number} length - Frames, in order
 * @property {(a: number, b: number) => number} histogram - a < b, b - a <= MAX_LAG
 * @property {(a: number, b: number) => number} hash - a < b, b - a <= MAX_LAG
 * @property {(i: number) => number} [frameAt] - Clip frame of position i
 *   (sampled clips); default i
 * @property {(i: number) => boolean} [flat] - The frame has no shapes (one
 *   colour), so its hash says nothing; default false
 */

/** Main's fixed threshold */
export const FIXED_THRESHOLD = 0.3;

/** PR #208's adaptive threshold with flash suppression */
export const ADAPTIVE = Object.freeze({
  /** Never below this distance (a static shot's noise is far lower) */
  floor: 0.12,
  /** ...and above this many times the median of the recent distances */
  medianScale: 5,
  /** ...plus this margin */
  medianOffset: 0.05,
  /** Recent distances considered for the median */
  window: 15,
  /** A flash: the picture comes back within this many frames */
  flashFrames: 3,
  /** "Comes back": the histogram distance to the frame before is below this */
  flashSimilarity: 0.12,
});

/**
 * Positions whose distance from the previous position is above the fixed
 * threshold (main's detector)
 * @param {FrameSignals} s
 * @returns {number[]}
 */
function fixedBreaks(s) {
  const breaks = [];
  for (let i = 1; i < s.length; i++) {
    if (s.histogram(i - 1, i) > FIXED_THRESHOLD) breaks.push(i);
  }
  return breaks;
}

/**
 * PR #208's detector: a distance above max(floor, medianScale x median of
 * the recent distances + medianOffset) starts a scene unless it is a flash
 * (the picture before it returns within flashFrames frames) or the return
 * from one (it matches the picture 2..flashFrames+1 frames back).
 * @param {FrameSignals} s
 * @returns {number[]}
 */
function adaptiveBreaks(s) {
  const { floor, medianScale, medianOffset, window, flashFrames, flashSimilarity } = ADAPTIVE;
  const frameAt = s.frameAt ?? ((i) => i);
  const distances = [0];
  for (let i = 1; i < s.length; i++) distances.push(s.histogram(i - 1, i));
  const similar = (/** @type {number} */ a, /** @type {number} */ b) =>
    s.histogram(a, b) < flashSimilarity;

  const breaks = [];
  for (let i = 1; i < s.length; i++) {
    const recent = distances.slice(Math.max(1, i - window), i).sort((a, b) => a - b);
    const median = recent.length > 0 ? recent[recent.length >> 1] : 0;
    if (distances[i] <= Math.max(floor, medianScale * median + medianOffset)) continue;

    const before = i - 1;
    let flash = false;
    for (let j = i + 1; j < s.length && frameAt(j) - frameAt(i) <= flashFrames && !flash; j++) {
      flash = similar(before, j);
    }
    for (let j = before - 1; j >= 0 && frameAt(i) - frameAt(j) <= flashFrames + 1 && !flash; j--) {
      flash = similar(j, i);
    }
    if (!flash) breaks.push(i);
  }
  return breaks;
}

/** "Did it come back?" on top of the fixed threshold */
export const COMEBACK = Object.freeze({
  /** Frames compared on each side of a candidate (lag at most 2k = MAX_LAG) */
  frames: 6,
  /** "Back": a histogram distance below this (PR #208's flash similarity) */
  similarity: 0.12,
});

/**
 * A candidate above the fixed threshold at t counts only if frames
 * t+1..t+k all stay far from frames t-k..t-1: a flash ends by returning to
 * the old picture, a cut does not.
 * @param {FrameSignals} s
 * @returns {number[]}
 */
function comebackBreaks(s) {
  const { frames: k, similarity } = COMEBACK;
  return fixedBreaks(s).filter((t) => {
    for (let a = t + 1; a <= Math.min(s.length - 1, t + k); a++) {
      for (let b = Math.max(0, t - k); b < t; b++) {
        if (s.histogram(b, a) < similarity) return false;
      }
    }
    return true;
  });
}

/** PySceneDetect's HashDetector default: 0.35 of the 64 bits */
export const HASH_THRESHOLD = Math.ceil(0.35 * 64);

/**
 * The perceptual hash alone: a scene starts where the hash of the frame
 * differs from the previous one by at least HASH_THRESHOLD bits
 * @param {FrameSignals} s
 * @returns {number[]}
 */
function hashBreaks(s) {
  const breaks = [];
  for (let i = 1; i < s.length; i++) {
    if (s.hash(i - 1, i) >= HASH_THRESHOLD) breaks.push(i);
  }
  return breaks;
}

/** Histogram and perceptual hash together */
export const COMBINED = Object.freeze({
  /** The colours change: lag-1 histogram distance above this */
  histogram: 0.2,
  /** ...and the picture's shapes change: pHash distance of at least this.
   * Midway between the largest distance at a histogram jump in the owner's
   * single-shot clips (12) and the smallest at a generated cut (18). */
  hash: 15,
  /** A gradual transition: compare the frames this far before and after */
  bracket: 3,
  /** ...whose histograms must differ by more than this too (else motion) */
  bracketHistogram: 0.3,
});

/**
 * A scene starts where the colours AND the shapes change. A flash or an
 * exposure step changes the colours but keeps the shapes (the hash is
 * median-thresholded, so a global brightness or palette step barely moves
 * it); motion changes the shapes but barely the colours. A hard cut changes
 * both between two frames; a fade changes both across the bracket around it.
 * Next to a frame of one colour the colours alone decide (fixed threshold).
 * @param {FrameSignals} s
 * @returns {number[]}
 */
function combinedBreaks(s) {
  const { histogram, hash, bracket, bracketHistogram } = COMBINED;
  const breaks = [];
  for (let t = 1; t < s.length; t++) {
    const d = s.histogram(t - 1, t);
    if (d <= histogram) continue;
    if (s.flat?.(t - 1) || s.flat?.(t)) {
      if (d > FIXED_THRESHOLD) breaks.push(t);
      continue;
    }
    const a = Math.max(0, t - 1 - bracket);
    const b = Math.min(s.length - 1, t + bracket);
    if (
      s.hash(t - 1, t) >= hash ||
      (s.histogram(a, b) > bracketHistogram && s.hash(a, b) >= hash)
    ) {
      breaks.push(t);
    }
  }
  return breaks;
}

/**
 * Break-finding methods by option id
 * @type {Record<string, (s: FrameSignals) => number[]>}
 */
export const SCENE_METHODS = {
  fixed: fixedBreaks,
  adaptive: adaptiveBreaks,
  comeback: comebackBreaks,
  hash: hashBreaks,
  combined: combinedBreaks,
};

/** The method used when nothing (valid) is chosen: best on both test sets */
export const SCENE_METHOD_DEFAULT = 'combined';

/**
 * Positions that start a new scene
 * @param {FrameSignals} signals
 * @param {string} method - A key of SCENE_METHODS
 * @returns {number[]}
 */
export function findBreaks(signals, method) {
  const run = SCENE_METHODS[method];
  if (!run) throw new Error(`Unknown scene method: ${method}`);
  return run(signals);
}

const HASH_SIDE = 32;
/**
 * A cosine pattern of amplitude A grey levels over the 32 x 32 plane gives a
 * coefficient of about 256 A: below this, no pattern reaches 1/8 grey level
 * (a frame of one colour; a near-white flash frame still has its shapes)
 */
export const FLAT_COEFFICIENT = 32;
const HASH_FREQS = 8;

/** cos(pi (x + 0.5) k / 32) for k = 1..8, x = 0..31 */
const COS = (() => {
  const t = new Float64Array(HASH_FREQS * HASH_SIDE);
  for (let k = 1; k <= HASH_FREQS; k++) {
    for (let x = 0; x < HASH_SIDE; x++) {
      t[(k - 1) * HASH_SIDE + x] = Math.cos((Math.PI * (x + 0.5) * k) / HASH_SIDE);
    }
  }
  return t;
})();

/**
 * Exact area average of a w x h plane onto n cells along one axis: the
 * weight of source index i in cell u is its overlap with [u*w/n, (u+1)*w/n)
 * @param {number} size - Source length
 * @param {number} n - Cells
 * @returns {{ start: number, weights: number[] }[]}
 */
function areaWeights(size, n) {
  const cells = [];
  for (let u = 0; u < n; u++) {
    const lo = (u * size) / n;
    const hi = ((u + 1) * size) / n;
    const start = Math.floor(lo);
    const weights = [];
    for (let i = start; i < hi; i++) weights.push(Math.min(hi, i + 1) - Math.max(lo, i));
    cells.push({ start, weights });
  }
  return cells;
}

/**
 * 64-bit perceptual hash of a thumbnail's luma: area-resampled to 32 x 32,
 * the unnormalized DCT-II coefficients for r, c = 1..8 (row-major), each bit
 * set when its coefficient is above the median (mean of the 32nd and 33rd).
 * Bit 0 is the most significant bit of word 0. Word 2 is 1 when the frame is
 * FLAT: no coefficient reaches FLAT_COEFFICIENT, so the bits are noise.
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} imageData
 * @returns {Uint32Array} Three words
 */
export function computePerceptualHash({ data, width, height }) {
  const xs = areaWeights(width, HASH_SIDE);
  const ys = areaWeights(height, HASH_SIDE);
  const luma = new Float64Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const img = new Float64Array(HASH_SIDE * HASH_SIDE);
  for (let v = 0; v < HASH_SIDE; v++) {
    const cy = ys[v];
    for (let u = 0; u < HASH_SIDE; u++) {
      const cx = xs[u];
      let sum = 0;
      let total = 0;
      for (let dy = 0; dy < cy.weights.length; dy++) {
        const row = (cy.start + dy) * width;
        for (let dx = 0; dx < cx.weights.length; dx++) {
          const w = cy.weights[dy] * cx.weights[dx];
          sum += luma[row + cx.start + dx] * w;
          total += w;
        }
      }
      img[v * HASH_SIDE + u] = sum / total;
    }
  }
  // Separable DCT: rows first (c), then columns (r)
  const rowsByC = new Float64Array(HASH_SIDE * HASH_FREQS);
  for (let y = 0; y < HASH_SIDE; y++) {
    for (let c = 0; c < HASH_FREQS; c++) {
      let sum = 0;
      for (let x = 0; x < HASH_SIDE; x++) sum += img[y * HASH_SIDE + x] * COS[c * HASH_SIDE + x];
      rowsByC[y * HASH_FREQS + c] = sum;
    }
  }
  const coeffs = new Float64Array(HASH_FREQS * HASH_FREQS);
  for (let r = 0; r < HASH_FREQS; r++) {
    for (let c = 0; c < HASH_FREQS; c++) {
      let sum = 0;
      for (let y = 0; y < HASH_SIDE; y++)
        sum += rowsByC[y * HASH_FREQS + c] * COS[r * HASH_SIDE + y];
      coeffs[r * HASH_FREQS + c] = sum;
    }
  }
  const sorted = Float64Array.from(coeffs).sort();
  const median = (sorted[31] + sorted[32]) / 2;
  const words = new Uint32Array(3);
  words[2] = coeffs.every((c) => Math.abs(c) < FLAT_COEFFICIENT) ? 1 : 0;
  for (let i = 0; i < 64; i++) {
    if (coeffs[i] > median) words[i >> 5] |= 1 << (31 - (i & 31));
  }
  return words;
}

/**
 * @param {number} x
 * @returns {number} Set bits of a 32-bit word
 */
function popcount(x) {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * @param {Uint32Array} hash
 * @returns {boolean} The frame has one colour (see computePerceptualHash)
 */
export function isFlatHash(hash) {
  return hash[2] === 1;
}

/**
 * @param {Uint32Array} a
 * @param {Uint32Array} b
 * @returns {number} Differing bits (0..64)
 */
export function hashDistance(a, b) {
  return popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);
}

/**
 * @param {string} hex - 16 hex digits, first digit most significant
 * @returns {Uint32Array}
 */
export function hashFromHex(hex) {
  return Uint32Array.of(
    Number.parseInt(hex.slice(0, 8), 16),
    Number.parseInt(hex.slice(8, 16), 16),
  );
}
