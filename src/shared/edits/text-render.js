/**
 * Text Layer Rendering
 *
 * Layout, drawing and hit testing of text layers on a 2D canvas context.
 * Coordinates are OUTPUT pixels: (0, 0) is the output origin (the crop's
 * top-left corner, or the frame's when there is no crop). Callers that draw
 * into a larger canvas translate the context first.
 *
 * @module shared/edits/text-render
 */

import { hasVisibleText } from './model.js';

/**
 * Font stacks per TextFont. CJK-capable families are listed so Japanese
 * captions render with a matching face instead of a fallback.
 * @type {Readonly<Record<import('./model.js').TextFont, string>>}
 */
export const FONT_STACKS = Object.freeze({
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif',
  serif: '"Hiragino Mincho ProN", "Noto Serif JP", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  impact: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
});

/** Line height as a multiple of the font px size */
const LINE_HEIGHT = 1.2;

/** Box padding around the text as a multiple of the font px size */
const BOX_PADDING = 0.25;

/**
 * @typedef {Object} TextBounds
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} TextLayout
 * @property {string[]} lines
 * @property {number} fontPx
 * @property {number} lineHeight
 * @property {TextBounds} bounds - Everything the layer paints (glyphs, outline, box)
 * @property {TextBounds} textRect - The glyph block alone (unpadded)
 * @property {number} anchorX - x passed to fillText (depends on align)
 */

/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Context2D */

/**
 * Font px size for a layer at an output height
 * @param {import('./model.js').TextLayer} layer
 * @param {number} outputHeight
 * @returns {number}
 */
function getFontPx(layer, outputHeight) {
  return Math.max(1, Math.round(layer.size * outputHeight));
}

/**
 * CSS font shorthand for a layer, e.g. `700 48px system-ui, ...`
 * @param {import('./model.js').TextLayer} layer
 * @param {number} outputHeight
 * @returns {string}
 */
export function getTextLayerFont(layer, outputHeight) {
  const weight = layer.bold ? 700 : 400;
  const stack = FONT_STACKS[layer.font] ?? FONT_STACKS.sans;
  return `${weight} ${getFontPx(layer, outputHeight)}px ${stack}`;
}

/**
 * Measure a layer and compute its bounding box in output pixels.
 *
 * The block of lines is vertically centered on y * outH. Horizontally the
 * anchor is x * outW: lines start there (left), end there (right) or are
 * centered on it (center). Bounds include the outline and, when the layer
 * has a box, the box padding. Sets ctx.font as a side effect.
 *
 * @param {Context2D} ctx
 * @param {import('./model.js').TextLayer} layer
 * @param {number} outW
 * @param {number} outH
 * @returns {TextLayout}
 */
export function layoutTextLayer(ctx, layer, outW, outH) {
  const fontPx = getFontPx(layer, outH);
  const lineHeight = LINE_HEIGHT * fontPx;
  const lines = String(layer.text ?? '').split('\n');

  ctx.font = getTextLayerFont(layer, outH);
  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
  }

  const anchorX = layer.x * outW;
  const blockHeight = lines.length * lineHeight;
  let left = anchorX - maxWidth / 2;
  if (layer.align === 'left') left = anchorX;
  if (layer.align === 'right') left = anchorX - maxWidth;
  const top = layer.y * outH - blockHeight / 2;

  const outlinePad = Math.max(0, layer.outlineWidth) * fontPx;
  const boxPad = layer.boxColor ? BOX_PADDING * fontPx : 0;
  const pad = Math.max(outlinePad, boxPad);

  return {
    lines,
    fontPx,
    lineHeight,
    anchorX,
    textRect: { x: left, y: top, width: maxWidth, height: blockHeight },
    bounds: {
      x: left - pad,
      y: top - pad,
      width: maxWidth + pad * 2,
      height: blockHeight + pad * 2,
    },
  };
}

/**
 * Draw a layer in the current transform, (0, 0) = output origin: optional
 * box, then per line an outline stroke (when outlineWidth > 0) and the fill.
 * Saves/restores the context state. Blank text draws nothing.
 *
 * @param {Context2D} ctx
 * @param {import('./model.js').TextLayer} layer
 * @param {number} outW
 * @param {number} outH
 */
export function drawTextLayer(ctx, layer, outW, outH) {
  if (!hasVisibleText(layer)) return;

  ctx.save();
  try {
    const layout = layoutTextLayer(ctx, layer, outW, outH);
    const { lines, fontPx, lineHeight, anchorX, textRect } = layout;

    if (layer.boxColor) {
      const boxPad = BOX_PADDING * fontPx;
      ctx.globalAlpha = Math.min(1, Math.max(0, layer.boxOpacity));
      ctx.fillStyle = layer.boxColor;
      ctx.fillRect(
        textRect.x - boxPad,
        textRect.y - boxPad,
        textRect.width + boxPad * 2,
        textRect.height + boxPad * 2,
      );
      ctx.globalAlpha = 1;
    }

    ctx.textAlign = layer.align;
    ctx.textBaseline = 'middle';

    const strokeWidth = 2 * layer.outlineWidth * fontPx;
    if (strokeWidth > 0) {
      ctx.strokeStyle = layer.outlineColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }
    ctx.fillStyle = layer.color;

    lines.forEach((line, i) => {
      const lineY = textRect.y + lineHeight * (i + 0.5);
      if (strokeWidth > 0) {
        ctx.strokeText(line, anchorX, lineY);
      }
      ctx.fillText(line, anchorX, lineY);
    });
  } finally {
    ctx.restore();
  }
}

/**
 * Id of the TOPMOST layer (last in draw order) whose layout bounds contain
 * the point, or null. Blank layers are ignored.
 *
 * @param {Context2D} ctx
 * @param {import('./model.js').TextLayer[]} layers - In draw order
 * @param {number} outW
 * @param {number} outH
 * @param {number} x - Output pixel x
 * @param {number} y - Output pixel y
 * @returns {string | null}
 */
export function hitTestTextLayers(ctx, layers, outW, outH, x, y) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!hasVisibleText(layer)) continue;
    ctx.save();
    const { bounds } = layoutTextLayer(ctx, layer, outW, outH);
    ctx.restore();
    if (
      x >= bounds.x &&
      x <= bounds.x + bounds.width &&
      y >= bounds.y &&
      y <= bounds.y + bounds.height
    ) {
      return layer.id;
    }
  }
  return null;
}
