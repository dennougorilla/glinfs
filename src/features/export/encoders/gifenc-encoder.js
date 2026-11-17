/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF encoder
 * @module features/export/encoders/gifenc-encoder
 */

import { GIFEncoder, quantize } from 'gifenc';
import { ALPHA_THRESHOLD } from '../../../shared/edits/color-key.js';
import { applyPaletteFast as applyPalette } from './apply-palette.js';

/**
 * @typedef {import('./types.js').EncoderInterface} EncoderInterface
 * @typedef {import('./types.js').EncoderConfig} EncoderConfig
 * @typedef {import('./types.js').FrameData} FrameData
 * @typedef {import('./types.js').EncoderMetadata} EncoderMetadata
 */

/** @type {EncoderMetadata} */
const METADATA = {
  id: 'gifenc-js',
  name: 'gifenc (JavaScript)',
  description: 'Fast JavaScript encoder with quality controls',
  isWasm: false,
  version: '1.0.3',
  capabilities: {
    supportsMaxColors: true,
    supportsQuantizeFormat: true,
    supportsDithering: true,
    supportsTransparency: true,
  },
};

/**
 * Whether addFrame should rebuild the palette for this frame.
 *
 * interval semantics: 1 = every frame; N>1 = frames 0, N, 2N, ...;
 * 0 = only when no palette exists yet (i.e. never once init() built one
 * from a clip-wide paletteSample; otherwise from the first frame).
 * Exported for unit tests - the schedule IS the perf contract (#99).
 *
 * @param {number} frameIndex
 * @param {number} interval
 * @param {boolean} hasPalette
 * @returns {boolean}
 */
export function shouldQuantize(frameIndex, interval, hasPalette) {
  if (!hasPalette) return true;
  if (interval <= 0) return false;
  if (interval === 1) return true;
  return frameIndex % interval === 0;
}

/**
 * Palette staleness check for scheduled reuse (paletteInterval > 1, #99).
 *
 * Between scheduled rebuilds, a scene cut would otherwise be drawn with the
 * previous scene's palette until the next rebuild (up to interval-1 frames).
 * After mapping each frame, measurePalette reads the frame's own
 * applyPalette indices (no extra nearest-color search) and the result is
 * compared with that of the frame the palette was built from; a jump past
 * either threshold rebuilds the palette early:
 * - mean error: whole-scene changes (cuts, fades).
 * - tail (pixels mapped with a large error): small new content on an
 *   unchanged background, e.g. a cursor, tooltip or indicator. Its colors
 *   can be missing from the palette while the frame mean barely moves, so
 *   the mean alone drew it as background until the next scheduled rebuild.
 * The measure visits a fixed lattice of 1 in 4 pixels that has a pixel in
 * every row and every column, so any 8x8 element gets 16 samples at every
 * frame size (a fixed-count subsample misses small elements at capture
 * resolutions), at a quarter of the cost of a full pass.
 *
 * Thresholds, measured in Chromium at 640x360 with 16-128 colors: across
 * steady content (moving gradients, scrolling UI, noise) the mean rose at
 * most 2.1 above the palette frame's (ratio <= 1.95, only where that error
 * was ~2), a slow fade drifted up to ~9 over 9 frames, and hard cuts
 * jumped by 8.2 (light -> dark UI) to 170 (red -> blue). For the tail, a
 * per-pixel limit of 30-32 added early rebuilds to a drifting gradient
 * and a fade, 40 and above missed a 12-level gray region on black (error
 * 36); steady gradients, scrolling UI and noise never tripped it.
 */
export const PALETTE_STALENESS = /** @type {const} */ ({
  /** Stale when a measure > baseline * ratio (relative, for few-color palettes) ... */
  ratio: 2,
  /** ... and mean error > baseline + margin (mean per-channel error, 0-255) */
  margin: 4,
  /** A sample is in the tail when |dR|+|dG|+|dB| exceeds this */
  tailError: 35,
  /** ... and tail > baseline + tailSamples (a count: ~32 px, half an 8x8 element, at any frame size) */
  tailSamples: 8,
  /**
   * After this many consecutive early rebuilds (flashing or constantly
   * changing content), quantize up front instead: measuring first would
   * map those frames twice and be slower than quality.
   */
  perFrameAfter: 2,
});

/**
 * @typedef {Object} PaletteFit
 * @property {number} error - Mean per-channel absolute RGB error (0-255)
 * @property {number} tail - Samples whose |dR|+|dG|+|dB| exceeds PALETTE_STALENESS.tailError
 */

/**
 * How well a mapped frame fits its palette, at pixels (x, y) with
 * x % 4 === y % 4: 1 in 4 pixels, in every row and every column.
 * @param {Uint8ClampedArray} rgba - Source frame
 * @param {Uint8Array} index - applyPalette output for `rgba` (before any
 *   transparent-index override)
 * @param {number[][]} palette
 * @param {number} width
 * @param {boolean} [skipTransparent=false] - Ignore pixels with alpha < 128
 *   (transparent exports: they are written as the transparent index, so
 *   their RGB never needs a palette color)
 * @returns {PaletteFit}
 */
export function measurePalette(rgba, index, palette, width, skipTransparent = false) {
  const flat = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    flat[i * 3] = palette[i][0];
    flat[i * 3 + 1] = palette[i][1];
    flat[i * 3 + 2] = palette[i][2];
  }
  const { tailError } = PALETTE_STALENESS;
  const height = width > 0 ? index.length / width : 0;
  let sum = 0;
  let tail = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = y & 3; x < width; x += 4) {
      const i = row + x;
      const p = i * 4;
      if (skipTransparent && rgba[p + 3] < ALPHA_THRESHOLD) continue;
      const c = index[i] * 3;
      const e =
        Math.abs(rgba[p] - flat[c]) +
        Math.abs(rgba[p + 1] - flat[c + 1]) +
        Math.abs(rgba[p + 2] - flat[c + 2]);
      sum += e;
      if (e > tailError) tail++;
      count++;
    }
  }
  return { error: count === 0 ? 0 : sum / (count * 3), tail };
}

/**
 * Whether a reused palette has gone stale for the current frame.
 * @param {PaletteFit} fit - Current frame's measurePalette
 * @param {PaletteFit} baseline - measurePalette of the frame the palette was built from
 * @returns {boolean}
 */
export function isPaletteStale(fit, baseline) {
  const { ratio, margin, tailSamples } = PALETTE_STALENESS;
  return (
    (fit.error > baseline.error * ratio && fit.error > baseline.error + margin) ||
    (fit.tail > baseline.tail * ratio && fit.tail > baseline.tail + tailSamples)
  );
}

/**
 * The opaque pixels (alpha >= 128) of an RGBA buffer, compacted. Returns the
 * input itself when every pixel is opaque, so fully opaque frames of a
 * transparent export cost one scan and no copy.
 * @param {Uint8ClampedArray} rgba
 * @returns {Uint8ClampedArray}
 */
export function opaquePixels(rgba) {
  let opaque = 0;
  for (let p = 3; p < rgba.length; p += 4) {
    if (rgba[p] >= ALPHA_THRESHOLD) opaque++;
  }
  if (opaque * 4 === rgba.length) return rgba;

  const out = new Uint8ClampedArray(opaque * 4);
  let o = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] >= ALPHA_THRESHOLD) {
      out[o] = rgba[p];
      out[o + 1] = rgba[p + 1];
      out[o + 2] = rgba[p + 2];
      out[o + 3] = rgba[p + 3];
      o += 4;
    }
  }
  return out;
}

/**
 * Frame differencing (opaque exports): a pixel showing the same color as in
 * the previous frame is written as the transparent index and the previous
 * frame is kept (dispose 1), so the decoded frames are unchanged pixel for
 * pixel while long runs of one index compress well.
 *
 * It pays only when unchanged pixels come in long runs. Measured on 1024x576
 * with gifenc's LZW, as differenced / whole bytes per frame against the
 * transitions between changed and kept pixels (per pixel, in scan order):
 * - static background, moving subject: 0.01, ratio 0.13-0.20
 * - scrolling text page: < 0.01, ratio 0.97-0.99
 * - noisy band over 10-60 % of the frame: 0.05-0.15, ratio 0.55-0.90
 * - sparse noise everywhere: 0.17 -> 0.84, 0.24 -> 0.93, 0.32 -> 1.00,
 *   0.38 -> 1.04, 0.51 -> 1.10
 * - half the frame with sparse noise: 0.22-0.25, ratio 0.82-0.85
 * - video-like noise everywhere: 0.25-0.42, ratio 1.12-1.30
 * Few transitions do not guarantee a gain either: nearly every pixel can
 * change (noise, a fade), and flat colors compress so well whole that the
 * extra palette slot costs more (a black frame alternating with a white
 * third, 480x240: 23.1 KB differenced against 17.8 KB whole). So below
 * `neverAbove` the frame is encoded both ways and the smaller is written;
 * that choice then holds for the next `trialEvery - 1` frames, since content
 * rarely changes character between frames.
 */
export const FRAME_DIFFERENCING = /** @type {const} */ ({
  /** Written whole without a trial above this many transitions per pixel */
  neverAbove: 0.5,
  /** Frames between trials below that */
  trialEvery: 8,
  /**
   * After a frame written whole, the next 1, 2, 4 ... up to this many are
   * written whole without comparing them: content where differencing does
   * not pay (video) would otherwise spend a comparison pass on every frame
   */
  maxSkip: 16,
});

/**
 * The first palette index a mapped frame never uses, or -1
 * @param {Uint8Array} index
 * @param {number} paletteLength
 * @returns {number}
 */
export function findUnusedIndex(index, paletteLength) {
  const used = new Uint8Array(256);
  let count = 0;
  for (let i = 0; i < index.length && count < paletteLength; i++) {
    if (used[index[i]] === 0) {
      used[index[i]] = 1;
      count++;
    }
  }
  for (let i = 0; i < paletteLength; i++) {
    if (used[i] === 0) return i;
  }
  return -1;
}

/**
 * Pack a palette's colors into 24-bit integers, for per-pixel comparison
 * @param {number[][]} palette
 * @returns {Int32Array}
 */
function packPalette(palette) {
  const packed = new Int32Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    packed[i] = (palette[i][0] << 16) | (palette[i][1] << 8) | palette[i][2];
  }
  return packed;
}

/**
 * Difference a mapped frame against the colors shown before it.
 *
 * Writes the colors this frame shows into `shown` (for the next frame) and,
 * where a pixel shows the same color as before, the transparent index into
 * `out`. Counts the transitions between changed and kept pixels in scan
 * order and the kept pixels, which decide whether differencing pays.
 *
 * @param {Uint8Array} index - applyPalette output
 * @param {Int32Array} colors - packPalette of the frame's palette
 * @param {Int32Array} shown - Colors shown so far (updated in place)
 * @param {number} transparentIndex
 * @param {Uint8Array} out - Same length as index
 * @returns {{ transitions: number, kept: number }} Per pixel
 */
export function differenceFrame(index, colors, shown, transparentIndex, out) {
  let transitions = 0;
  let keptCount = 0;
  let lastKept = false;
  for (let i = 0; i < index.length; i++) {
    const color = colors[index[i]];
    const kept = color === shown[i];
    out[i] = kept ? transparentIndex : index[i];
    if (kept) keptCount++;
    if (kept !== lastKept) {
      transitions++;
      lastKept = kept;
    }
    shown[i] = color;
  }
  const n = index.length || 1;
  return { transitions: transitions / n, kept: keptCount / n };
}

/**
 * Ordered (Bayer 8x8) dithering, applied to the pixels before they are
 * mapped to the palette: each pixel's RGB moves by a fixed offset that
 * depends only on its position, within +-amplitude/2. Smooth gradients then
 * mix the two nearest palette colors instead of breaking into bands.
 * Being positional (not error diffusion), an unchanged pixel gets the same
 * offset in every frame, so frame differencing still finds it unchanged,
 * and alpha is never touched, so the transparent pixels of a cutout stay
 * exactly the ones the source has.
 */
export const DITHERING = {
  /**
   * Peak-to-peak offset per channel (0-255 levels), per quantize format.
   * Measured at 1024x576 on a smooth sky gradient with a shaded sphere,
   * banding as the mean error after a 9x9 box blur (what the eye averages):
   * balanced (102 colors) 2.43 undithered, 1.58 / 1.45 / 1.53 / 1.72 at
   * 8 / 16 / 24 / 32; quality (205 colors) 2.62 -> 1.47 at 16; fast
   * (rgb444, 51 colors) 5.52 -> 3.86 at 16, 3.56 at 24, 3.67 at 32. Larger
   * amplitudes add visible noise without removing more banding.
   */
  amplitude: { rgb565: 16, rgb444: 24 },
};

/** Bayer 8x8 threshold matrix, values 0-63 */
const BAYER_8 = Uint8Array.from([
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]);

/**
 * Ordered dithering of an RGBA frame into `out` (alpha copied unchanged)
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} amplitude - Peak-to-peak offset per channel
 * @param {Uint8ClampedArray} out - Same length as rgba
 * @returns {Uint8ClampedArray} out
 */
export function orderedDither(rgba, width, amplitude, out) {
  const offsets = new Int16Array(64);
  for (let i = 0; i < 64; i++) offsets[i] = Math.round(((BAYER_8[i] + 0.5) / 64 - 0.5) * amplitude);
  const height = width > 0 ? rgba.length / 4 / width : 0;
  for (let y = 0; y < height; y++) {
    const row = (y & 7) << 3;
    for (let x = 0, p = y * width * 4; x < width; x++, p += 4) {
      const o = offsets[row | (x & 7)];
      out[p] = rgba[p] + o;
      out[p + 1] = rgba[p + 1] + o;
      out[p + 2] = rgba[p + 2] + o;
      out[p + 3] = rgba[p + 3];
    }
  }
  return out;
}

/**
 * Placeholder palette for a frame without any opaque pixel. It is never
 * kept for reuse: the next frame quantizes a real palette (otherwise a
 * clip-wide schedule would map every later frame to black).
 * @type {number[][]}
 */
const NO_OPAQUE_PALETTE = [[0, 0, 0]];

/**
 * Palette size to quantize to. Transparent exports reserve one slot of the
 * (at most 256-entry) color table for the transparent index, which is
 * appended after the quantized colors.
 * @param {number} maxColors
 * @param {boolean} transparent
 * @returns {number}
 */
export function paletteColorCount(maxColors, transparent) {
  if (!transparent) return maxColors;
  return Math.max(2, Math.min(255, maxColors - 1));
}

/**
 * Create gifenc encoder
 * @returns {EncoderInterface}
 */
export function createGifencEncoder() {
  /** @type {ReturnType<typeof GIFEncoder> | null} */
  let encoder = null;

  /** @type {EncoderConfig | null} */
  let config = null;

  /** @type {ReturnType<typeof quantize> | null} Palette reused between scheduled rebuilds (#99) */
  let palette = null;

  /** @type {PaletteFit} measurePalette of the frame the current palette was built from */
  let baseline = { error: 0, tail: 0 };

  /** Consecutive early (staleness) rebuilds; >= perFrameAfter quantizes every frame */
  let earlyRebuilds = 0;

  /** Transparent export (config.transparent): pixels with alpha < 128 become the transparent index */
  let transparent = false;

  /** Ordered dithering before mapping (config.dithering) */
  let dithering = false;
  /** @type {Uint8ClampedArray | null} Reused buffer of the dithered frame */
  let dithered = null;

  /** Frame differencing (config.frameDifferencing, opaque exports only) */
  let differencing = false;
  /** @type {Int32Array | null} Colors the frames written so far show, per pixel */
  let shown = null;
  /** @type {{ index: Uint8Array, colors: Int32Array } | null} The last frame,
   * when it was written whole: `shown` is filled from it only when needed */
  let shownFrom = null;
  /** Pixels per frame of the frames written so far (0 before the first) */
  let shownLength = 0;
  /** Frames to write whole without checking, and the current back-off */
  let skip = 0;
  let backoff = 0;
  /** @type {Uint8Array | null} Reused output buffer of differenceFrame */
  let differenced = null;

  /**
   * Quantize a palette from RGBA pixels. In transparent mode only opaque
   * pixels vote (cleared pixels would otherwise take palette slots) and one
   * slot stays free for the transparent index; with no opaque pixel at all
   * the palette is a single black entry.
   * @param {Uint8ClampedArray} rgba
   * @param {EncoderConfig} cfg
   * @returns {number[][]}
   */
  const buildPalette = (rgba, cfg) => {
    const format = cfg.quantizeFormat || 'rgb565';
    if (!transparent) {
      return quantize(rgba, cfg.maxColors, { format });
    }
    const pixels = opaquePixels(rgba);
    if (pixels.length === 0) return NO_OPAQUE_PALETTE;
    return quantize(pixels, paletteColorCount(cfg.maxColors, true), { format });
  };

  /** Scratch encoders (no header) for the frames encoded both ways */
  /** @type {ReturnType<typeof GIFEncoder> | null} */
  let trialWhole = null;
  /** @type {ReturnType<typeof GIFEncoder> | null} */
  let trialDifferenced = null;
  /** @type {boolean | null} The last trial's choice: true = differenced */
  let trialChoice = null;
  /** Frames since the last trial, in the band between the limits */
  let sinceTrial = 0;

  /**
   * Write an opaque frame with frame differencing: whole (the first frame,
   * no free palette slot, or changes too scattered to pay), or with
   * unchanged pixels as the transparent index. Every frame keeps the
   * previous one (dispose 1), so either way the decoded frame is exactly
   * the mapped frame.
   * @param {Uint8Array} index
   * @param {number} width
   * @param {number} height
   * @param {number} delay
   */
  const writeDifferenced = (index, width, height, delay) => {
    if (!encoder || !config || !palette) return;
    const colors = packPalette(palette);
    const whole = { palette, delay, repeat: config.loopCount, dispose: 1 };
    /** Write the frame whole; what it shows is read from it only when needed */
    const writeWhole = () => {
      shownFrom = { index, colors };
      encoder?.writeFrame(index, width, height, whole);
    };
    /** A frame written whole: check the next 1, 2, 4 ... frames less often */
    const backOff = () => {
      backoff = Math.min(Math.max(1, backoff * 2), FRAME_DIFFERENCING.maxSkip);
      skip = backoff;
    };

    if (shownLength !== index.length) {
      shownLength = index.length;
      writeWhole();
      return;
    }
    if (skip > 0) {
      skip--;
      writeWhole();
      return;
    }
    // A slot appended to the palette while the color table (a power of two)
    // has room for it, else one the frame does not use
    const tableSize = (/** @type {number} */ n) => 2 ** Math.max(1, Math.ceil(Math.log2(n)));
    const roomInTable =
      palette.length < 256 && tableSize(palette.length + 1) === tableSize(palette.length);
    const unused = roomInTable ? -1 : findUnusedIndex(index, palette.length);
    const transparentIndex = unused >= 0 ? unused : palette.length;
    if (transparentIndex > 255) {
      writeWhole();
      backOff();
      return;
    }

    if (shownFrom) {
      if (shown?.length !== index.length) shown = new Int32Array(index.length);
      const from = shownFrom;
      for (let i = 0; i < index.length; i++) shown[i] = from.colors[from.index[i]];
      shownFrom = null;
    }
    if (differenced?.length !== index.length) differenced = new Uint8Array(index.length);
    const { transitions } = differenceFrame(
      index,
      colors,
      /** @type {Int32Array} */ (shown),
      transparentIndex,
      differenced,
    );
    const kept = {
      palette: unused >= 0 ? palette : [...palette, [0, 0, 0]],
      delay,
      repeat: config.loopCount,
      transparent: true,
      transparentIndex,
      dispose: 1,
    };

    const { neverAbove, trialEvery } = FRAME_DIFFERENCING;
    /** @type {boolean} */
    let useDifferenced;
    if (transitions > neverAbove) {
      useDifferenced = false;
      encoder.writeFrame(index, width, height, whole);
    } else if (trialChoice !== null && sinceTrial < trialEvery - 1) {
      sinceTrial++;
      useDifferenced = trialChoice;
      encoder.writeFrame(
        useDifferenced ? differenced : index,
        width,
        height,
        useDifferenced ? kept : whole,
      );
    } else {
      // Encode both ways (a frame after the first is written the same with
      // or without the header, so the scratch bytes go into the GIF as they are)
      trialWhole ??= GIFEncoder({ auto: false });
      trialDifferenced ??= GIFEncoder({ auto: false });
      trialWhole.reset();
      trialDifferenced.reset();
      trialWhole.writeFrame(index, width, height, whole);
      trialDifferenced.writeFrame(differenced, width, height, kept);
      const a = trialWhole.bytesView();
      const b = trialDifferenced.bytesView();
      useDifferenced = b.length < a.length;
      trialChoice = useDifferenced;
      sinceTrial = 0;
      encoder.stream.writeBytesView(useDifferenced ? b : a);
    }
    if (useDifferenced) backoff = 0;
    else backOff();
  };

  return {
    metadata: METADATA,

    /**
     * Initialize encoder
     * @param {EncoderConfig} encoderConfig
     */
    init(encoderConfig) {
      config = encoderConfig;
      encoder = GIFEncoder();
      baseline = { error: 0, tail: 0 };
      earlyRebuilds = 0;
      transparent = encoderConfig.transparent === true;
      dithering = encoderConfig.dithering === true;
      dithered = null;
      // A cutout clears pixels from one frame to the next, which only
      // disposal to the background can show: differencing keeps the
      // previous frame, so it is for opaque exports only
      differencing = encoderConfig.frameDifferencing === true && !transparent;
      shown = null;
      shownFrom = null;
      shownLength = 0;
      skip = 0;
      backoff = 0;
      differenced = null;
      trialChoice = null;
      sinceTrial = 0;
      // A clip-wide sample yields one global palette up front, so later
      // scenes are not forced onto frame 0's colors (#99). In transparent
      // mode only its opaque pixels count; a sample without any falls back
      // to the first frame's palette.
      const sample = encoderConfig.paletteSample?.length
        ? transparent
          ? opaquePixels(encoderConfig.paletteSample)
          : encoderConfig.paletteSample
        : null;
      palette = sample?.length ? buildPalette(sample, encoderConfig) : null;
    },

    /**
     * Add frame
     * @param {FrameData} frameData
     * @param {number} frameIndex
     */
    addFrame(frameData, frameIndex) {
      if (!encoder || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const { rgba, width, height } = frameData;
      const format = config.quantizeFormat || 'rgb565';

      // Palette rebuilding (quantize) dominates encode time (#99); the
      // preset's paletteInterval schedules how often it actually runs.
      // Consecutive frames share most of their colors, so reusing the
      // palette between rebuilds trades negligible fidelity for the bulk
      // of the encode cost on balanced/fast presets.
      const interval = config.paletteInterval ?? 1;
      const scheduled = shouldQuantize(frameIndex, interval, palette !== null);
      // Content that keeps going stale (flashing, video) is re-quantized up
      // front, like quality, without the staleness measurement.
      const perFrame = !scheduled && earlyRebuilds >= PALETTE_STALENESS.perFrameAfter;
      if (scheduled || perFrame) {
        palette = buildPalette(rgba, config);
      }

      // The pixels to map: dithered when asked (the palette and the alpha
      // threshold still come from the frame itself)
      let source = rgba;
      if (dithering) {
        if (dithered?.length !== rgba.length) dithered = new Uint8ClampedArray(rgba.length);
        source = orderedDither(rgba, width, DITHERING.amplitude[format], dithered);
      }

      // Map pixels to palette indices with same format
      let index = applyPalette(source, palette, format);

      // A scene cut or new content between scheduled rebuilds makes the
      // reused palette stale; rebuild early instead of waiting for the
      // schedule. Interval 0 keeps its clip-wide palette: rebuilding from
      // one frame would replace it with a worse, single-scene palette.
      if (interval > 1 && !perFrame) {
        const fit = measurePalette(source, index, palette, width, transparent);
        if (scheduled) {
          baseline = fit;
          // Per-frame mode ends at a scheduled rebuild, but one more stale
          // frame right after it resumes it.
          const { perFrameAfter } = PALETTE_STALENESS;
          earlyRebuilds = earlyRebuilds >= perFrameAfter ? perFrameAfter - 1 : 0;
        } else if (isPaletteStale(fit, baseline)) {
          palette = buildPalette(rgba, config);
          index = applyPalette(source, palette, format);
          baseline = measurePalette(source, index, palette, width, transparent);
          earlyRebuilds++;
        } else {
          earlyRebuilds = 0;
        }
      }

      const delay = frameData.delayMs ?? config.frameDelayMs;

      if (differencing) {
        writeDifferenced(index, width, height, delay);
        return;
      }

      if (!transparent) {
        encoder.writeFrame(index, width, height, {
          palette,
          delay,
          repeat: config.loopCount,
        });
        return;
      }

      // Transparent export: the reserved slot right after the quantized
      // colors is the transparent index. Every frame (even a fully opaque
      // one) is disposed to the background, so a later frame's transparent
      // pixels never reveal an earlier frame.
      const transparentIndex = palette.length;
      for (let i = 0, p = 3; i < index.length; i++, p += 4) {
        if (rgba[p] < ALPHA_THRESHOLD) index[i] = transparentIndex;
      }
      encoder.writeFrame(index, width, height, {
        palette: [...palette, [0, 0, 0]],
        delay,
        repeat: config.loopCount,
        transparent: true,
        transparentIndex,
        dispose: 2,
      });
      if (palette === NO_OPAQUE_PALETTE) {
        palette = null;
      }
    },

    /**
     * Complete encoding and get byte array
     * @returns {Uint8Array}
     */
    finish() {
      if (!encoder) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      encoder.finish();
      const bytes = encoder.bytes();

      return bytes;
    },

    /**
     * Release resources
     */
    dispose() {
      encoder = null;
      config = null;
      palette = null;
      transparent = false;
      differencing = false;
      dithering = false;
      dithered = null;
      shown = null;
      shownFrom = null;
      differenced = null;
      trialWhole = null;
      trialDifferenced = null;
    },
  };
}

/**
 * Get gifenc encoder metadata
 * @returns {EncoderMetadata}
 */
export function getGifencMetadata() {
  return METADATA;
}
