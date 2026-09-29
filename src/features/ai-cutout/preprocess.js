/**
 * AI cutout pre/post-processing (pure, no DOM)
 * @module features/ai-cutout/preprocess
 *
 * Mirrors skytnt's `get_mask` (see PREPROCESS in model-config.js for the
 * upstream sources):
 *
 *   h, w = (s, int(s * w / h)) if h > w else (int(s * h / w), s)
 *   ph, pw = s - h, s - w
 *   img_input[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w] = cv2.resize(img / 255, (w, h))
 *   ...
 *   mask = mask[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w]
 *   mask = cv2.resize(mask, (w0, h0))
 *
 * The worker draws the frame into the letterbox rectangle of a black s×s
 * canvas (the zero padding), converts it with rgbaToChw, runs the model and
 * turns the output back into a mask with probabilityToMask.
 */

import { MASK_MAX_SIDE, MODEL_INPUT_SIZE } from './model-config.js';

/**
 * Where the source image sits inside the square model input.
 * @typedef {Object} Letterbox
 * @property {number} size - Model input side (s)
 * @property {number} width - Content width inside the input (w)
 * @property {number} height - Content height inside the input (h)
 * @property {number} padX - Left padding (pw // 2)
 * @property {number} padY - Top padding (ph // 2)
 */

/**
 * A probability mask: one byte per pixel, 0 = background, 255 = foreground.
 * @typedef {Object} ProbabilityMask
 * @property {Uint8Array} data - width × height bytes, row-major
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {number} value
 * @param {string} name
 */
function assertPositiveSize(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${value}`);
  }
}

/**
 * Letterbox geometry for a source of `sourceWidth` × `sourceHeight`, exactly
 * as upstream computes it: the long side becomes `size`, the short side is
 * truncated (`int()`), and the padding is split with the smaller half first.
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} [size]
 * @returns {Letterbox}
 */
export function computeLetterbox(sourceWidth, sourceHeight, size = MODEL_INPUT_SIZE) {
  assertPositiveSize(sourceWidth, 'sourceWidth');
  assertPositiveSize(sourceHeight, 'sourceHeight');
  const width =
    sourceHeight > sourceWidth
      ? Math.max(1, Math.floor((size * sourceWidth) / sourceHeight))
      : size;
  const height =
    sourceHeight > sourceWidth
      ? size
      : Math.max(1, Math.floor((size * sourceHeight) / sourceWidth));
  return {
    size,
    width,
    height,
    padX: Math.floor((size - width) / 2),
    padY: Math.floor((size - height) / 2),
  };
}

/**
 * Resolution a frame's probability mask is stored at: the source size scaled
 * down so the long side is at most `maxSide` (never scaled up).
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} [maxSide]
 * @returns {{ width: number, height: number }}
 */
export function computeMaskSize(sourceWidth, sourceHeight, maxSide = MASK_MAX_SIDE) {
  assertPositiveSize(sourceWidth, 'sourceWidth');
  assertPositiveSize(sourceHeight, 'sourceHeight');
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * Convert an RGBA image (the letterboxed s×s canvas) to the model's input:
 * float32 CHW planes R, G, B with values / 255. Alpha is ignored — the
 * caller composites onto black first, like the zero padding.
 * @param {Uint8ClampedArray | Uint8Array} rgba - width × height × 4 bytes
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} [out] - Reused output buffer (3 × width × height)
 * @returns {Float32Array}
 */
export function rgbaToChw(rgba, width, height, out) {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) {
    throw new RangeError(`Expected ${pixels * 4} RGBA bytes, got ${rgba.length}`);
  }
  const tensor = out ?? new Float32Array(pixels * 3);
  if (tensor.length !== pixels * 3) {
    throw new RangeError(`Output buffer must hold ${pixels * 3} floats, got ${tensor.length}`);
  }
  const scale = 1 / 255;
  const gOffset = pixels;
  const bOffset = pixels * 2;
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    tensor[i] = rgba[p] * scale;
    tensor[gOffset + i] = rgba[p + 1] * scale;
    tensor[bOffset + i] = rgba[p + 2] * scale;
  }
  return tensor;
}

/**
 * Crop the letterbox content out of the model's s×s probability output and
 * resize it to `maskWidth` × `maskHeight` with bilinear sampling on pixel
 * centres (cv2.resize INTER_LINEAR), mapping [0, 1] to 0..255.
 * @param {Float32Array} probability - size × size values in [0, 1]
 * @param {Letterbox} letterbox
 * @param {number} maskWidth
 * @param {number} maskHeight
 * @returns {ProbabilityMask}
 */
export function probabilityToMask(probability, letterbox, maskWidth, maskHeight) {
  const { size, width, height, padX, padY } = letterbox;
  if (probability.length !== size * size) {
    throw new RangeError(`Expected ${size * size} output values, got ${probability.length}`);
  }
  assertPositiveSize(maskWidth, 'maskWidth');
  assertPositiveSize(maskHeight, 'maskHeight');

  // Per-column source positions are the same for every row: precompute them
  const x0s = new Int32Array(maskWidth);
  const x1s = new Int32Array(maskWidth);
  const fxs = new Float32Array(maskWidth);
  const scaleX = width / maskWidth;
  for (let x = 0; x < maskWidth; x++) {
    const sx = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), width - 1);
    const x0 = Math.floor(sx);
    x0s[x] = padX + x0;
    x1s[x] = padX + Math.min(x0 + 1, width - 1);
    fxs[x] = sx - x0;
  }

  const data = new Uint8Array(maskWidth * maskHeight);
  const scaleY = height / maskHeight;
  for (let y = 0; y < maskHeight; y++) {
    const sy = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), height - 1);
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const row0 = (padY + y0) * size;
    const row1 = (padY + Math.min(y0 + 1, height - 1)) * size;
    const outRow = y * maskWidth;
    for (let x = 0; x < maskWidth; x++) {
      const fx = fxs[x];
      const top = probability[row0 + x0s[x]] * (1 - fx) + probability[row0 + x1s[x]] * fx;
      const bottom = probability[row1 + x0s[x]] * (1 - fx) + probability[row1 + x1s[x]] * fx;
      const value = top * (1 - fy) + bottom * fy;
      // Uint8Array stores truncate: round and clamp explicitly
      data[outRow + x] = value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
    }
  }
  return { data, width: maskWidth, height: maskHeight };
}
