/**
 * Frame Composition
 *
 * Renders a source frame with the clip's edits applied (crop, background
 * removal, text). Three entry points share one order of operations so every
 * surface shows the same pixels:
 * - composeOutputFrame: output-sized canvas (export preview)
 * - composeOutputFrameRGBA: output-sized RGBA buffer (export encoder)
 * - composeEditorFrame: full source frame with the edits applied inside the
 *   output region (editor preview, which draws the crop as an overlay)
 *
 * Order: draw the (cropped) source → key out the background → draw the text
 * layers active on the frame. Text is drawn after keying so a caption that
 * happens to contain the key color is never removed.
 *
 * @module shared/edits/compose
 */

import {
  getDrawableSource,
  isFrameValid,
  renderFramePlaceholder,
  syncCanvasSize,
} from '../utils/canvas.js';
import { applyColorKey, snapAlphaToBinary } from './color-key.js';
import { getActiveTextLayers } from './model.js';
import { drawTextLayer } from './text-render.js';

/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Context2D */
/** @typedef {import('../../features/capture/types.js').Frame} Frame */
/** @typedef {import('../../features/editor/types.js').CropArea} CropArea */
/** @typedef {import('./model.js').ClipEdits} ClipEdits */

/**
 * Output size for a frame and crop
 * @param {Frame | null | undefined} frame
 * @param {CropArea | null | undefined} crop
 * @param {{ width: number, height: number }} fallback - Used when the frame has no size
 * @returns {{ width: number, height: number }}
 */
function getOutputSize(frame, crop, fallback) {
  if (crop) return { width: crop.width, height: crop.height };
  return {
    width: frame?.width || fallback.width,
    height: frame?.height || fallback.height,
  };
}

/**
 * Draw the source frame's output region at (0, 0) of an already-sized,
 * cleared canvas
 * @param {Context2D} ctx
 * @param {CanvasImageSource} source
 * @param {CropArea | null | undefined} crop
 */
function drawSourceRegion(ctx, source, crop) {
  if (crop) {
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  } else {
    ctx.drawImage(source, 0, 0);
  }
}

/**
 * Draw the text layers active on a frame, (0, 0) = output origin
 * @param {Context2D} ctx
 * @param {import('./model.js').TextLayer[]} layers
 * @param {number} outW
 * @param {number} outH
 */
function drawTextLayers(ctx, layers, outW, outH) {
  for (const layer of layers) {
    drawTextLayer(ctx, layer, outW, outH);
  }
}

/**
 * Key out the background of a canvas region in place (readback, key, write)
 * @param {Context2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {import('./model.js').BackgroundRemoval} background
 */
function keyCanvasRegion(ctx, x, y, width, height, background) {
  if (width <= 0 || height <= 0) return;
  const image = ctx.getImageData(x, y, width, height);
  applyColorKey(image.data, width, height, background);
  ctx.putImageData(image, x, y);
}

/**
 * Render the export output of one frame: resizes ctx.canvas to the output
 * size (crop, else frame), clears it, draws the cropped source, applies
 * background removal to the whole output, then draws the text layers
 * active on `frameIndex`. Closed/invalid frames draw the placeholder.
 *
 * @param {Context2D} ctx
 * @param {Frame | null | undefined} frame
 * @param {CropArea | null | undefined} crop
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index (for text ranges)
 */
export function composeOutputFrame(ctx, frame, crop, edits, frameIndex) {
  const { width, height } = getOutputSize(frame, crop, ctx.canvas);
  const source = isFrameValid(frame) ? getDrawableSource(/** @type {Frame} */ (frame)) : null;
  if (!source) {
    renderFramePlaceholder(ctx, width, height);
    return;
  }

  syncCanvasSize(ctx.canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  drawSourceRegion(ctx, source, crop);

  if (edits?.background?.enabled) {
    keyCanvasRegion(ctx, 0, 0, width, height, edits.background);
  }
  drawTextLayers(ctx, getActiveTextLayers(edits, frameIndex), width, height);
}

/**
 * Snap the canvas to GIF's 1-bit alpha (see snapAlphaToBinary), so a
 * transparent export's preview shows exactly what the encoder will write:
 * a half-transparent text box or soft edge over a removed/transparent
 * background becomes either fully opaque or fully transparent. One
 * readback; the canvas is only written back when a pixel changed.
 * @param {Context2D} ctx
 */
export function snapCanvasAlphaToBinary(ctx) {
  const { width, height } = ctx.canvas;
  if (width <= 0 || height <= 0) return;
  const image = ctx.getImageData(0, 0, width, height);
  if (snapAlphaToBinary(image.data)) {
    ctx.putImageData(image, 0, 0);
  }
}

/**
 * Cached OffscreenCanvas for composeOutputFrameRGBA. Only the export frame
 * loop uses it, strictly sequentially (one frame at a time), like
 * getFrameRGBA's extraction canvas in features/export/api.js.
 * @type {{ canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D } | null}
 */
let rgbaCanvasCache = null;

/**
 * Get the cached RGBA composition canvas, sized and cleared
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvasRenderingContext2D}
 */
function getRgbaContext(width, height) {
  if (!rgbaCanvasCache) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Failed to get OffscreenCanvas 2d context');
    }
    rgbaCanvasCache = { canvas, ctx };
    return ctx;
  }
  const { canvas, ctx } = rgbaCanvasCache;
  if (!syncCanvasSize(canvas, width, height)) {
    // Same-size reuse keeps the previous frame; a resize already cleared it
    ctx.clearRect(0, 0, width, height);
  }
  return ctx;
}

/**
 * Reset the cached composition canvas. Test-only, like
 * __resetFrameExtractionCacheForTests in features/export/api.js.
 */
export function __resetComposeCacheForTests() {
  rgbaCanvasCache = null;
}

/**
 * Export extraction path: the composed output of one frame as RGBA.
 *
 * Avoids redundant readbacks: without active text the (keyed) buffer from a
 * single getImageData is returned directly; with the key disabled the frame
 * and text are drawn and read back once. Only text over a keyed frame needs
 * the key written back before drawing the text.
 *
 * The returned buffer is fresh on every call (ImageData.data), so callers
 * may transfer it.
 *
 * @param {Frame} frame
 * @param {CropArea | null | undefined} crop
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index (for text ranges)
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number }>}
 * @throws {Error} When the frame's VideoFrame is missing or closed
 */
export async function composeOutputFrameRGBA(frame, crop, edits, frameIndex) {
  const source = isFrameValid(frame) ? getDrawableSource(frame) : null;
  if (!source) {
    throw new Error('Invalid frame: VideoFrame is missing or closed');
  }

  const { width, height } = getOutputSize(frame, crop, { width: 0, height: 0 });
  const ctx = getRgbaContext(width, height);
  drawSourceRegion(ctx, source, crop);

  const background = edits?.background;
  const keyEnabled = background?.enabled === true;
  const layers = getActiveTextLayers(edits, frameIndex);

  if (layers.length === 0) {
    const image = ctx.getImageData(0, 0, width, height);
    if (keyEnabled) {
      applyColorKey(image.data, width, height, background);
    }
    return { data: image.data, width, height };
  }

  if (keyEnabled) {
    keyCanvasRegion(ctx, 0, 0, width, height, background);
  }
  drawTextLayers(ctx, layers, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return { data: image.data, width, height };
}

/**
 * Editor preview: the canvas shows the FULL source frame (the editor draws
 * the crop as a separate overlay). Resizes to the frame size, clears, draws
 * the full frame, then inside the output region (crop rect, or the whole
 * frame) applies background removal and draws the active text layers with
 * the region as the output. The result inside the region is pixel-identical
 * to composeOutputFrame; text never paints outside the region.
 *
 * @param {Context2D} ctx
 * @param {Frame | null | undefined} frame
 * @param {CropArea | null | undefined} crop
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index (for text ranges)
 */
export function composeEditorFrame(ctx, frame, crop, edits, frameIndex) {
  const width = frame?.width || ctx.canvas.width;
  const height = frame?.height || ctx.canvas.height;
  const source = isFrameValid(frame) ? getDrawableSource(/** @type {Frame} */ (frame)) : null;
  if (!source) {
    renderFramePlaceholder(ctx, width, height);
    return;
  }

  syncCanvasSize(ctx.canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0);

  const region = crop ?? { x: 0, y: 0, width, height };

  if (edits?.background?.enabled) {
    keyCanvasRegion(ctx, region.x, region.y, region.width, region.height, edits.background);
  }

  const layers = getActiveTextLayers(edits, frameIndex);
  if (layers.length === 0) return;

  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    ctx.translate(region.x, region.y);
    drawTextLayers(ctx, layers, region.width, region.height);
  } finally {
    ctx.restore();
  }
}
