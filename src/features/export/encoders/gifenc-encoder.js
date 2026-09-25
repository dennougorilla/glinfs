/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF encoder
 * @module features/export/encoders/gifenc-encoder
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { ALPHA_THRESHOLD } from '../../../shared/edits/color-key.js';

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

      // Map pixels to palette indices with same format
      let index = applyPalette(rgba, palette, format);

      // A scene cut or new content between scheduled rebuilds makes the
      // reused palette stale; rebuild early instead of waiting for the
      // schedule. Interval 0 keeps its clip-wide palette: rebuilding from
      // one frame would replace it with a worse, single-scene palette.
      if (interval > 1 && !perFrame) {
        const fit = measurePalette(rgba, index, palette, width, transparent);
        if (scheduled) {
          baseline = fit;
          // Per-frame mode ends at a scheduled rebuild, but one more stale
          // frame right after it resumes it.
          const { perFrameAfter } = PALETTE_STALENESS;
          earlyRebuilds = earlyRebuilds >= perFrameAfter ? perFrameAfter - 1 : 0;
        } else if (isPaletteStale(fit, baseline)) {
          palette = buildPalette(rgba, config);
          index = applyPalette(rgba, palette, format);
          baseline = measurePalette(rgba, index, palette, width, transparent);
          earlyRebuilds++;
        } else {
          earlyRebuilds = 0;
        }
      }

      const delay = frameData.delayMs ?? config.frameDelayMs;

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
