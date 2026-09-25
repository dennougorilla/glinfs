/**
 * Editor preview of clip edits (text layers, background removal)
 *
 * The editor's base canvas shows the FULL source frame with the edits
 * applied inside the output region (crop rect, or the whole frame), exactly
 * like composeEditorFrame in shared/edits/compose.js — which is what the
 * renderer calls whenever background removal is off.
 *
 * Background removal is the expensive part (a readback plus a flood fill on
 * the main thread), so its result is cached per frame: the keyed output
 * region (ImageData) is stored under the frame's pixel identity and simply
 * written back on later draws. The cache holds one parameter set at a time
 * (key color, tolerance, mode, region) and is dropped whenever those change.
 * Text is drawn on top of the (cached) keyed region on every draw, so
 * text-only edits never read pixels back.
 *
 * @module features/editor/edits-preview
 */

import { applyColorKey, detectEdgeColor, toHexColor } from '../../shared/edits/color-key.js';
import { composeEditorFrame } from '../../shared/edits/compose.js';
import { getActiveTextLayers } from '../../shared/edits/model.js';
import {
  drawTextLayer,
  hitTestTextLayers,
  layoutTextLayer,
} from '../../shared/edits/text-render.js';
import { getDrawableSource, isFrameValid, syncCanvasSize } from '../../shared/utils/canvas.js';

/** @typedef {import('../capture/types.js').Frame} Frame */
/** @typedef {import('./types.js').CropArea} CropArea */
/** @typedef {import('../../shared/edits/model.js').ClipEdits} ClipEdits */
/** @typedef {import('../../shared/edits/model.js').BackgroundRemoval} BackgroundRemoval */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Context2D */

/**
 * Pixel budget of the keyed-region cache (~64 MB of RGBA). A 1280x720
 * region is ~3.7 MB, so ~17 such frames stay cached; smaller clips/crops
 * fit entirely and play from the cache after the first loop.
 */
export const KEYED_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Output region of a frame in frame pixels: the crop rect, else the frame
 * @param {Frame | null | undefined} frame
 * @param {CropArea | null | undefined} crop
 * @returns {Rect}
 */
export function getOutputRegion(frame, crop) {
  if (crop) return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
  return { x: 0, y: 0, width: frame?.width ?? 0, height: frame?.height ?? 0 };
}

/**
 * Cache identity of a frame's pixels. Imported holds are clones of one
 * decoded frame (same sharedKey) and key out identically.
 * @param {Frame} frame
 * @returns {unknown}
 */
function getFramePixelKey(frame) {
  return frame.sharedKey ?? frame.id ?? frame;
}

/**
 * Parameters a keyed region depends on (besides the frame)
 * @param {BackgroundRemoval} background
 * @param {Rect} region
 * @returns {string}
 */
function getKeyParamsKey(background, region) {
  const { color, tolerance, mode } = background;
  return `${color}|${tolerance}|${mode}|${region.x},${region.y},${region.width},${region.height}`;
}

/**
 * Bounded cache of keyed output regions for ONE parameter set.
 *
 * Admission stops at the byte budget instead of evicting: playback visits
 * frames cyclically, and evicting the oldest entry to admit the next one
 * would miss on every frame of a clip larger than the budget (LRU/FIFO
 * thrash). Capping admission keeps the first frames cached for every loop.
 * The most recent result is always kept on top of the budget, so redrawing
 * the current frame (text edits while paused) never reads pixels back.
 *
 * @param {number} [budgetBytes]
 */
export function createKeyedRegionCache(budgetBytes = KEYED_CACHE_BUDGET_BYTES) {
  /** @type {string | null} */
  let paramsKey = null;
  /** @type {Map<unknown, ImageData>} */
  const entries = new Map();
  let bytes = 0;
  /** @type {{ key: unknown, image: ImageData } | null} */
  let latest = null;

  function clear() {
    entries.clear();
    bytes = 0;
    latest = null;
    paramsKey = null;
  }

  return {
    /**
     * Switch to a parameter set; a different one drops every entry
     * @param {string} key
     */
    sync(key) {
      if (key !== paramsKey) {
        clear();
        paramsKey = key;
      }
    },
    /**
     * @param {unknown} key
     * @returns {ImageData | null}
     */
    get(key) {
      if (latest && latest.key === key) return latest.image;
      return entries.get(key) ?? null;
    },
    /**
     * @param {unknown} key
     * @param {ImageData} image
     */
    set(key, image) {
      latest = { key, image };
      if (entries.has(key)) return;
      const size = image.data.byteLength;
      if (bytes + size > budgetBytes) return;
      entries.set(key, image);
      bytes += size;
    },
    clear,
    /** @returns {{ entries: number, bytes: number }} */
    stats() {
      return { entries: entries.size, bytes };
    },
  };
}

/**
 * Draw the text layers active on a frame inside the output region, clipped
 * to it — same transform and clip as composeEditorFrame
 * @param {Context2D} ctx
 * @param {Rect} region
 * @param {import('../../shared/edits/model.js').TextLayer[]} layers
 */
function drawRegionText(ctx, region, layers) {
  if (layers.length === 0) return;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    ctx.translate(region.x, region.y);
    for (const layer of layers) {
      drawTextLayer(ctx, layer, region.width, region.height);
    }
  } finally {
    ctx.restore();
  }
}

/**
 * Create the editor's preview renderer (one per editor session)
 * @param {{ budgetBytes?: number }} [options]
 */
export function createEditorFrameRenderer(options = {}) {
  const cache = createKeyedRegionCache(options.budgetBytes);
  let readbacks = 0;

  return {
    /**
     * Draw a frame with its edits onto the editor's base canvas
     * @param {Context2D} ctx
     * @param {Frame | null | undefined} frame
     * @param {CropArea | null | undefined} crop
     * @param {ClipEdits | null | undefined} edits
     * @param {number} frameIndex - Absolute clip frame index (text ranges)
     * @param {{ skipKey?: boolean }} [options] - skipKey: draw without
     *   background removal and leave the cache alone (a crop drag in
     *   progress moves the region on every pointer move; keying each move
     *   would read back and flood-fill the whole region per tick and drop
     *   every cached frame — the drag's release keys once instead)
     */
    render(ctx, frame, crop, edits, frameIndex, options = {}) {
      if (options.skipKey && edits?.background?.enabled) {
        composeEditorFrame(
          ctx,
          frame,
          crop,
          { ...edits, background: { ...edits.background, enabled: false } },
          frameIndex,
        );
        return;
      }
      const background = edits?.background;
      const source =
        background?.enabled && isFrameValid(frame)
          ? getDrawableSource(/** @type {Frame} */ (frame))
          : null;
      if (!background?.enabled) {
        // Keyed pixels are useless without the key: free them
        cache.clear();
      }
      if (!source || !frame || !background) {
        composeEditorFrame(ctx, frame, crop, edits, frameIndex);
        return;
      }

      syncCanvasSize(ctx.canvas, frame.width, frame.height);
      ctx.clearRect(0, 0, frame.width, frame.height);
      ctx.drawImage(source, 0, 0);

      const region = getOutputRegion(frame, crop);
      if (region.width > 0 && region.height > 0) {
        cache.sync(getKeyParamsKey(background, region));
        const key = getFramePixelKey(frame);
        let keyed = cache.get(key);
        if (!keyed) {
          keyed = ctx.getImageData(region.x, region.y, region.width, region.height);
          readbacks++;
          // The ImageData's own size: a crop can carry fractional values
          // (centered aspect-ratio crops), which getImageData truncates
          applyColorKey(keyed.data, keyed.width, keyed.height, background);
          cache.set(key, keyed);
        }
        ctx.putImageData(keyed, region.x, region.y);
      }

      drawRegionText(ctx, region, getActiveTextLayers(edits, frameIndex));
    },

    /** Drop every cached keyed region */
    clear() {
      cache.clear();
    },

    /**
     * Readbacks so far and cache occupancy (tests, diagnostics)
     * @returns {{ readbacks: number, cachedFrames: number, cachedBytes: number }}
     */
    stats() {
      const { entries, bytes } = cache.stats();
      return { readbacks, cachedFrames: entries, cachedBytes: bytes };
    },
  };
}

/**
 * Bounds of the selected text layer on the overlay, in frame pixels
 * @param {Context2D} ctx - Any 2D context (used for text measurement only)
 * @param {import('./types.js').EditorState} state
 * @param {Frame | null | undefined} frame
 * @returns {(Rect & { active: boolean }) | null} null when nothing visible is selected
 */
export function getSelectedTextOverlay(ctx, state, frame) {
  if (!state.selectedTextId || !frame) return null;
  const layer = state.edits.textLayers.find((l) => l.id === state.selectedTextId);
  if (!layer || layer.text.trim() === '') return null;

  const region = getOutputRegion(frame, state.cropArea);
  ctx.save();
  let bounds;
  try {
    bounds = layoutTextLayer(ctx, layer, region.width, region.height).bounds;
  } finally {
    ctx.restore();
  }
  return {
    x: region.x + bounds.x,
    y: region.y + bounds.y,
    width: bounds.width,
    height: bounds.height,
    active: layer.start <= state.currentFrame && state.currentFrame <= layer.end,
  };
}

/**
 * Topmost text layer drawn on the current frame under a frame-pixel point
 * (text is clipped to the output region, so points outside it never hit)
 * @param {Context2D} ctx - Any 2D context (text measurement only)
 * @param {import('./types.js').EditorState} state
 * @param {Frame} frame
 * @param {{ x: number, y: number }} point - Frame pixel coordinates
 * @returns {string | null} Layer id
 */
export function hitTestEditorText(ctx, state, frame, point) {
  const layers = getActiveTextLayers(state.edits, state.currentFrame);
  if (layers.length === 0) return null;
  const region = getOutputRegion(frame, state.cropArea);
  if (
    point.x < region.x ||
    point.y < region.y ||
    point.x > region.x + region.width ||
    point.y > region.y + region.height
  ) {
    return null;
  }
  return hitTestTextLayers(
    ctx,
    layers,
    region.width,
    region.height,
    point.x - region.x,
    point.y - region.y,
  );
}

/**
 * A 2D context for reading source pixels, or null when the platform has no
 * canvas (jsdom)
 * @param {number} width
 * @param {number} height
 * @returns {Context2D | null}
 */
function createReadbackContext(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true });
}

/**
 * Read a region of the SOURCE frame (no edits applied)
 * @param {Frame} frame
 * @param {Rect} rect - Frame pixels; clamped to the frame
 * @returns {{ data: Uint8ClampedArray, width: number, height: number } | null}
 */
export function readSourceRegion(frame, rect) {
  const source = isFrameValid(frame) ? getDrawableSource(frame) : null;
  if (!source) return null;
  const x = Math.max(0, Math.min(frame.width - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(frame.height - 1, Math.floor(rect.y)));
  const width = Math.max(1, Math.min(frame.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(frame.height - y, Math.round(rect.height)));
  const ctx = createReadbackContext(width, height);
  if (!ctx) return null;
  ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return { data: image.data, width, height };
}

/**
 * Color of the source frame's pixel at a point (eyedropper)
 * @param {Frame} frame
 * @param {{ x: number, y: number }} point - Frame pixel coordinates
 * @returns {string | null} '#rrggbb', or null when the frame can't be read
 */
export function sampleSourceColor(frame, point) {
  const pixel = readSourceRegion(frame, { x: point.x, y: point.y, width: 1, height: 1 });
  if (!pixel) return null;
  return toHexColor({ r: pixel.data[0], g: pixel.data[1], b: pixel.data[2] });
}

/**
 * Most common border color of the frame's output region — the default key
 * color when background removal is enabled without a chosen color
 * @param {Frame} frame
 * @param {CropArea | null | undefined} crop
 * @returns {string | null} '#rrggbb', or null when the frame can't be read
 */
export function detectOutputEdgeColor(frame, crop) {
  const region = readSourceRegion(frame, getOutputRegion(frame, crop));
  if (!region) return null;
  return detectEdgeColor(region.data, region.width, region.height);
}
