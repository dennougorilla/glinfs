/**
 * gifenc Encoder Implementation
 * Pure JavaScript GIF encoder
 * @module features/export/encoders/gifenc-encoder
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';

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
 * @param {Uint8Array} index - applyPalette output for `rgba`
 * @param {number[][]} palette
 * @param {number} width
 * @returns {PaletteFit}
 */
export function measurePalette(rgba, index, palette, width) {
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
      // A clip-wide sample yields one global palette up front, so later
      // scenes are not forced onto frame 0's colors (#99).
      palette = encoderConfig.paletteSample?.length
        ? quantize(encoderConfig.paletteSample, encoderConfig.maxColors, {
            format: encoderConfig.quantizeFormat || 'rgb565',
          })
        : null;
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
        palette = quantize(rgba, config.maxColors, { format });
      }

      // Map pixels to palette indices with same format
      let index = applyPalette(rgba, palette, format);

      // A scene cut or new content between scheduled rebuilds makes the
      // reused palette stale; rebuild early instead of waiting for the
      // schedule. Interval 0 keeps its clip-wide palette: rebuilding from
      // one frame would replace it with a worse, single-scene palette.
      if (interval > 1 && !perFrame) {
        const fit = measurePalette(rgba, index, palette, width);
        if (scheduled) {
          baseline = fit;
          // Per-frame mode ends at a scheduled rebuild, but one more stale
          // frame right after it resumes it.
          const { perFrameAfter } = PALETTE_STALENESS;
          earlyRebuilds = earlyRebuilds >= perFrameAfter ? perFrameAfter - 1 : 0;
        } else if (isPaletteStale(fit, baseline)) {
          palette = quantize(rgba, config.maxColors, { format });
          index = applyPalette(rgba, palette, format);
          baseline = measurePalette(rgba, index, palette, width);
          earlyRebuilds++;
        } else {
          earlyRebuilds = 0;
        }
      }

      // Write frame
      encoder.writeFrame(index, width, height, {
        palette,
        delay: config.frameDelayMs,
        repeat: config.loopCount,
      });
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
