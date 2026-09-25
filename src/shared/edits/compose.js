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
 * Order: draw the (cropped) source → remove the background → draw the text
 * layers active on the frame. Text is drawn after the removal so a caption
 * that happens to contain the key color is never removed.
 *
 * Background removal is the color key, or — with the 'ai' method — the
 * frame's final AI cutout mask from an optional `maskSource` (same place in
 * the pipeline). A frame the mask source has no mask for is drawn without
 * removal (it has not been analyzed yet); the export refuses such frames
 * before it starts (see encodeGif).
 *
 * @module shared/edits/compose
 */

import { applyMaskToRegion } from '../masks/mask-ops.js';
import {
  getDrawableSource,
  isFrameValid,
  renderFramePlaceholder,
  syncCanvasSize,
} from '../utils/canvas.js';
import { applyColorKey, snapAlphaToBinary } from './color-key.js';
import { getActiveTextLayers, isAiCutoutActive, isColorKeyActive } from './model.js';
import { drawTextLayer } from './text-render.js';

/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Context2D */
/** @typedef {import('../../features/capture/types.js').Frame} Frame */
/** @typedef {import('../../features/editor/types.js').CropArea} CropArea */
/** @typedef {import('./model.js').ClipEdits} ClipEdits */
/** @typedef {import('../masks/final-masks.js').MaskSource} MaskSource */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * Removes the background from the RGBA pixels of an output region, in place
 * @callback RemovalStep
 * @param {Uint8ClampedArray} data - RGBA of the region
 * @param {number} width - Region width as the caller measured it
 * @param {number} height - Region height as the caller measured it
 * @returns {void}
 */

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
 * Draw text layers into an output region of a larger canvas (the editor
 * shows the full frame; the region is the crop), clipped to that region and
 * translated so (0, 0) is its top-left corner. The single implementation of
 * this transform: composeEditorFrame and the editor's cached preview both
 * use it, so their text placement stays pixel-identical.
 * @param {Context2D} ctx
 * @param {{ x: number, y: number, width: number, height: number }} region
 * @param {import('./model.js').TextLayer[]} layers - Already filtered to the frame
 */
export function drawTextLayersInRegion(ctx, region, layers) {
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

/**
 * The background removal a frame needs, or null when it needs none (removal
 * off, or the AI method without a final mask for this frame).
 *
 * The color key receives the region size exactly as callers always passed
 * it; the AI mask is applied to the pixel grid the readback really returned
 * (getImageData truncates a fractional crop size).
 *
 * @param {Frame} frame
 * @param {Rect} sourceRegion - Output region in SOURCE pixels (crop, or the whole frame)
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index
 * @param {MaskSource | null | undefined} maskSource
 * @returns {RemovalStep | null}
 */
export function getRemovalStep(frame, sourceRegion, edits, frameIndex, maskSource) {
  const background = edits?.background;
  if (isColorKeyActive(background)) {
    return (data, width, height) => {
      applyColorKey(data, width, height, background);
    };
  }
  if (!isAiCutoutActive(background)) return null;
  const mask = maskSource?.getFinalMask(frameIndex) ?? null;
  if (!mask) return null;
  return (data, width, height) => {
    applyMaskToRegion(
      data,
      Math.floor(width),
      Math.floor(height),
      mask.bits,
      mask.width,
      mask.height,
      sourceRegion,
      frame.width,
      frame.height,
    );
  };
}

/**
 * Output region in source pixels: the crop, else the whole frame
 * @param {Frame} frame
 * @param {CropArea | null | undefined} crop
 * @returns {Rect}
 */
function getSourceRegion(frame, crop) {
  if (crop) return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}

/**
 * Remove the background of a canvas region in place (readback, remove, write)
 * @param {Context2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {RemovalStep} remove
 */
function removeInCanvasRegion(ctx, x, y, width, height, remove) {
  if (width <= 0 || height <= 0) return;
  const image = ctx.getImageData(x, y, width, height);
  remove(image.data, width, height);
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
 * @param {number} frameIndex - Absolute clip frame index (for text ranges and masks)
 * @param {MaskSource | null} [maskSource] - Final AI masks (method 'ai')
 */
export function composeOutputFrame(ctx, frame, crop, edits, frameIndex, maskSource = null) {
  const { width, height } = getOutputSize(frame, crop, ctx.canvas);
  const source = isFrameValid(frame) ? getDrawableSource(/** @type {Frame} */ (frame)) : null;
  if (!source) {
    renderFramePlaceholder(ctx, width, height);
    return;
  }

  syncCanvasSize(ctx.canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  drawSourceRegion(ctx, source, crop);

  const validFrame = /** @type {Frame} */ (frame);
  const remove = getRemovalStep(
    validFrame,
    getSourceRegion(validFrame, crop),
    edits,
    frameIndex,
    maskSource,
  );
  if (remove) {
    removeInCanvasRegion(ctx, 0, 0, width, height, remove);
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
 * @returns {ImageData | null} The snapped canvas pixels (callers may keep
 *   them to redraw the frame without another readback), or null for an
 *   empty canvas
 */
export function snapCanvasAlphaToBinary(ctx) {
  const { width, height } = ctx.canvas;
  if (width <= 0 || height <= 0) return null;
  const image = ctx.getImageData(0, 0, width, height);
  if (snapAlphaToBinary(image.data)) {
    ctx.putImageData(image, 0, 0);
  }
  return image;
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
 * single getImageData is returned directly; without removal the frame and
 * text are drawn and read back once. Only text over a keyed frame needs
 * the removal written back before drawing the text.
 *
 * The returned buffer is fresh on every call (ImageData.data), so callers
 * may transfer it.
 *
 * @param {Frame} frame
 * @param {CropArea | null | undefined} crop
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index (for text ranges and masks)
 * @param {MaskSource | null} [maskSource] - Final AI masks (method 'ai')
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number }>}
 * @throws {Error} When the frame's VideoFrame is missing or closed
 */
export async function composeOutputFrameRGBA(frame, crop, edits, frameIndex, maskSource = null) {
  const source = isFrameValid(frame) ? getDrawableSource(frame) : null;
  if (!source) {
    throw new Error('Invalid frame: VideoFrame is missing or closed');
  }

  const { width, height } = getOutputSize(frame, crop, { width: 0, height: 0 });
  const ctx = getRgbaContext(width, height);
  drawSourceRegion(ctx, source, crop);

  const remove = getRemovalStep(frame, getSourceRegion(frame, crop), edits, frameIndex, maskSource);
  const layers = getActiveTextLayers(edits, frameIndex);

  if (layers.length === 0) {
    const image = ctx.getImageData(0, 0, width, height);
    if (remove) {
      remove(image.data, width, height);
    }
    return { data: image.data, width, height };
  }

  if (remove) {
    removeInCanvasRegion(ctx, 0, 0, width, height, remove);
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
 * @param {number} frameIndex - Absolute clip frame index (for text ranges and masks)
 * @param {MaskSource | null} [maskSource] - Final AI masks (method 'ai')
 */
export function composeEditorFrame(ctx, frame, crop, edits, frameIndex, maskSource = null) {
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

  const remove = getRemovalStep(
    /** @type {Frame} */ (frame),
    region,
    edits,
    frameIndex,
    maskSource,
  );
  if (remove) {
    removeInCanvasRegion(ctx, region.x, region.y, region.width, region.height, remove);
  }

  drawTextLayersInRegion(ctx, region, getActiveTextLayers(edits, frameIndex));
}
