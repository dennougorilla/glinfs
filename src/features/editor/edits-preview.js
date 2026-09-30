/**
 * Editor preview of clip edits (text layers, background removal)
 *
 * The editor's base canvas shows the FULL source frame with the edits
 * applied inside the output region (crop rect, or the whole frame), exactly
 * like composeEditorFrame in shared/edits/compose.js — which is what the
 * renderer calls whenever background removal is off.
 *
 * Background removal is the expensive part (a readback plus a flood fill,
 * or a mask lookup, on the main thread), so its result is cached per frame:
 * the keyed output region (ImageData) is stored under the frame's pixel
 * identity and simply written back on later draws. The cache holds one
 * parameter set at a time (key color, tolerance, mode — or, for the AI
 * cutout, the mask source's version — and the region) and is dropped
 * whenever those change. Touch-ups apply per frame range, so they are part
 * of each frame's entry instead: a frame with strokes on it is cached per
 * frame index together with the signature of those strokes, and painting or
 * undoing a stroke re-keys only the frames it covers (a frame without
 * strokes keeps sharing its keyed pixels with its holds).
 *
 * AI cutout masks come from the optional `maskSource` render option (see
 * shared/masks/final-masks.js). A frame it has no mask for previews without
 * removal (its touch-ups still apply); its version changes whenever its
 * masks do, which drops the cache.
 * Text is drawn on top of the (cached) keyed region on every draw, so
 * text-only edits never read pixels back.
 *
 * When the export will be transparent (removal on, or a source with alpha)
 * the cached region's alpha is also snapped to GIF's 1 bit, so soft source
 * edges preview as they export. Text drawn over transparent pixels (a
 * see-through caption box, anti-aliased glyph edges) is NOT snapped here —
 * that would take a readback on every text edit; the export preview shows
 * the exact 1-bit result.
 *
 * @module features/editor/edits-preview
 */

import {
  ALPHA_THRESHOLD,
  findOpaqueEdgeColor,
  snapAlphaToBinary,
  toHexColor,
} from '../../shared/edits/color-key.js';
import {
  composeEditorFrame,
  drawTextLayersInRegion,
  getRemovalStep,
} from '../../shared/edits/compose.js';
import {
  getActiveTextLayers,
  getActiveTouchUps,
  hasVisibleText,
  isAiCutoutActive,
  isEditsEmpty,
  requiresTransparency,
} from '../../shared/edits/model.js';
import { hitTestTextLayers, layoutTextLayer } from '../../shared/edits/text-render.js';
import { getTouchUpsSignature } from '../../shared/edits/touch-ups.js';
import { getDrawableSource, isFrameValid, syncCanvasSize } from '../../shared/utils/canvas.js';

/** @typedef {import('../capture/types.js').Frame} Frame */
/** @typedef {import('./types.js').CropArea} CropArea */
/** @typedef {import('../../shared/edits/model.js').ClipEdits} ClipEdits */
/** @typedef {import('../../shared/edits/model.js').BackgroundRemoval} BackgroundRemoval */
/** @typedef {import('../../shared/masks/final-masks.js').MaskSource} MaskSource */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Context2D */

/**
 * Pixel budget of the keyed-region cache (~64 MB of RGBA). A 1280x720
 * region is ~3.7 MB, so ~17 such frames stay cached; smaller clips/crops
 * fit entirely and play from the cache after the first loop.
 */
export const KEYED_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Whether the composed editor preview depends on the crop, so a crop change
 * must redraw it: edits are applied inside the crop (output) region, and a
 * transparent export's 1-bit alpha snap is too — even with no edits, for a
 * clip whose source already has alpha.
 * @param {import('../../shared/edits/model.js').ClipEdits | null | undefined} edits
 * @param {boolean | undefined} hasAlpha
 * @returns {boolean}
 */
export function previewDependsOnCrop(edits, hasAlpha) {
  return !isEditsEmpty(edits) || requiresTransparency({ edits, hasAlpha });
}

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
 * Cache identity of a frame's keyed region. Imported holds are clones of
 * one decoded frame (same sharedKey) and key out identically with the color
 * key. An AI mask belongs to a clip frame index (tracking can select
 * differently on two holds), and so do touch-ups (a "this frame" stroke
 * differs between two holds), so the index is part of the identity there.
 * @param {Frame} frame
 * @param {number} frameIndex
 * @param {boolean} perIndex - The removal depends on the frame index
 * @returns {unknown}
 */
function getFramePixelKey(frame, frameIndex, perIndex) {
  const pixels = frame.sharedKey ?? frame.id ?? frame;
  if (!perIndex || (typeof pixels !== 'string' && typeof pixels !== 'number')) return pixels;
  return `${pixels}#${frameIndex}`;
}

/**
 * Parameters a keyed region depends on (besides the frame)
 * @param {BackgroundRemoval | null} background - null when removal is off
 * @param {Rect} region
 * @param {boolean} snap - Alpha snapped to 1 bit
 * @param {MaskSource | null} maskSource - AI cutout masks
 * @returns {string}
 */
function getKeyParamsKey(background, region, snap, maskSource) {
  let key = 'no-key';
  if (isAiCutoutActive(background)) {
    key = `ai|${maskSource ? maskSource.version : 'no-masks'}`;
  } else if (background) {
    key = `${background.color}|${background.tolerance}|${background.mode}`;
  }
  return `${key}|${snap ? 'snap' : 'alpha'}|${region.x},${region.y},${region.width},${region.height}`;
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
 * Each key holds one variant (the touch-up strokes on that frame): a new
 * variant replaces the key's entry, so painting on a frame never piles up
 * stale results of that frame.
 *
 * @param {number} [budgetBytes]
 */
export function createKeyedRegionCache(budgetBytes = KEYED_CACHE_BUDGET_BYTES) {
  /** @type {string | null} */
  let paramsKey = null;
  /** @type {Map<unknown, { variant: string, image: ImageData }>} */
  const entries = new Map();
  let bytes = 0;
  /** @type {{ key: unknown, variant: string, image: ImageData } | null} */
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
     * @param {string} [variant]
     * @returns {ImageData | null}
     */
    get(key, variant = '') {
      if (latest && latest.key === key && latest.variant === variant) return latest.image;
      const entry = entries.get(key);
      return entry && entry.variant === variant ? entry.image : null;
    },
    /**
     * @param {unknown} key
     * @param {ImageData} image
     * @param {string} [variant]
     */
    set(key, image, variant = '') {
      latest = { key, variant, image };
      const existing = entries.get(key);
      if (existing) {
        if (existing.variant === variant) return;
        entries.delete(key);
        bytes -= existing.image.data.byteLength;
      }
      const size = image.data.byteLength;
      if (bytes + size > budgetBytes) return;
      entries.set(key, { variant, image });
      bytes += size;
    },
    clear,
    /** @returns {{ entries: number, bytes: number }} */
    stats() {
      return { entries: entries.size, bytes };
    },
  };
}

/** Tint of removed pixels in the Mask view (RGB) and its opacity */
const MASK_TINT = { r: 255, g: 40, b: 60, alpha: 0.65 };

/**
 * Mask view: tint the pixels the removal takes away (transparent in the
 * keyed result) red over a dimmed gray of the original frame, so they read
 * the same on any background color, and show every pixel opaque
 * @param {Uint8ClampedArray} original - Source pixels of the region (tinted in place)
 * @param {Uint8ClampedArray} keyed - The keyed (result) pixels of the same region
 */
export function tintRemovedPixels(original, keyed) {
  const { r, g, b, alpha } = MASK_TINT;
  const keep = 1 - alpha;
  for (let i = 0; i < original.length; i += 4) {
    if (keyed[i + 3] < ALPHA_THRESHOLD) {
      // An already transparent source pixel has no color of its own
      const gray =
        (0.299 * original[i] + 0.587 * original[i + 1] + 0.114 * original[i + 2]) *
        (original[i + 3] / 255) *
        keep;
      original[i] = gray + r * alpha;
      original[i + 1] = gray + g * alpha;
      original[i + 2] = gray + b * alpha;
      original[i + 3] = 255;
    }
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
     * @param {number} frameIndex - Absolute clip frame index (text ranges, masks)
     * @param {{ skipKey?: boolean, transparent?: boolean, maskSource?: MaskSource | null, view?: import('./types.js').PreviewView }} [options]
     *   - skipKey: draw without background removal (or alpha snapping) and
     *     leave the cache alone (a crop drag in progress moves the region on
     *     every pointer move; keying each move would read back and
     *     flood-fill the whole region per tick and drop every cached frame
     *     — the drag's release keys once instead)
     *   - transparent: the export is a transparent GIF (removal on, or a
     *     source with alpha): the output region's alpha is snapped to 1 bit
     *     like the encoder does, in the same cached pass as the key, so a
     *     soft source edge previews as it will export. Opaque clips never
     *     read back for this.
     *   - maskSource: final AI cutout masks, used when the background
     *     method is 'ai' (frames without a mask preview unkeyed)
     *   - view: what to show while background removal is on (view only):
     *     'result' (default), 'original' (the frame without the removal)
     *     or 'mask' (removed pixels tinted red over the frame, no text)
     */
    render(ctx, frame, crop, edits, frameIndex, options = {}) {
      const background = edits?.background;
      const keyOn = background?.enabled === true;
      const snap = options.transparent === true;
      const maskSource = options.maskSource ?? null;
      const view = keyOn ? (options.view ?? 'result') : 'result';
      if ((options.skipKey && (keyOn || snap)) || view === 'original') {
        composeEditorFrame(
          ctx,
          frame,
          crop,
          keyOn ? { ...edits, background: { ...background, enabled: false } } : edits,
          frameIndex,
        );
        return;
      }
      const source =
        (keyOn || snap) && isFrameValid(frame)
          ? getDrawableSource(/** @type {Frame} */ (frame))
          : null;
      if (!keyOn && !snap) {
        // Keyed pixels are useless without the key: free them
        cache.clear();
      }
      if (!source || !frame) {
        composeEditorFrame(ctx, frame, crop, edits, frameIndex);
        return;
      }

      syncCanvasSize(ctx.canvas, frame.width, frame.height);
      ctx.clearRect(0, 0, frame.width, frame.height);
      ctx.drawImage(source, 0, 0);

      const region = getOutputRegion(frame, crop);
      if (region.width > 0 && region.height > 0) {
        const ai = keyOn && isAiCutoutActive(background);
        cache.sync(getKeyParamsKey(keyOn ? background : null, region, snap, maskSource));
        // Only the strokes on this frame (none while removal is off)
        const touchUps = getActiveTouchUps(edits, frameIndex);
        const variant = getTouchUpsSignature(touchUps);
        const key = getFramePixelKey(frame, frameIndex, ai || touchUps.length > 0);
        let keyed = cache.get(key, variant);
        if (!keyed) {
          keyed = ctx.getImageData(region.x, region.y, region.width, region.height);
          readbacks++;
          // The ImageData's own size: a crop can carry fractional values
          // (centered aspect-ratio crops), which getImageData truncates
          const remove = keyOn
            ? getRemovalStep(frame, region, edits, frameIndex, maskSource)
            : null;
          remove?.(keyed.data, keyed.width, keyed.height);
          if (snap) {
            snapAlphaToBinary(keyed.data);
          }
          cache.set(key, keyed, variant);
        }
        if (view === 'mask') {
          // The source is on the canvas: tint what the removal takes away
          const original = ctx.getImageData(region.x, region.y, keyed.width, keyed.height);
          tintRemovedPixels(original.data, keyed.data);
          ctx.putImageData(original, region.x, region.y);
          return;
        }
        ctx.putImageData(keyed, region.x, region.y);
      }

      drawTextLayersInRegion(ctx, region, getActiveTextLayers(edits, frameIndex));
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
  if (!hasVisibleText(layer)) return null;

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
 * The source frame's pixel at a point (eyedropper)
 * @param {Frame} frame
 * @param {{ x: number, y: number }} point - Frame pixel coordinates
 * @returns {{ color: string, transparent: boolean } | null} '#rrggbb' and
 *   whether the pixel is already transparent (alpha below the GIF
 *   threshold, where its RGB means nothing), or null when the frame can't
 *   be read
 */
export function sampleSourcePixel(frame, point) {
  const pixel = readSourceRegion(frame, { x: point.x, y: point.y, width: 1, height: 1 });
  if (!pixel) return null;
  return {
    color: toHexColor({ r: pixel.data[0], g: pixel.data[1], b: pixel.data[2] }),
    transparent: pixel.data[3] < ALPHA_THRESHOLD,
  };
}

/**
 * Color of the source frame's pixel at a point (eyedropper)
 * @param {Frame} frame
 * @param {{ x: number, y: number }} point - Frame pixel coordinates
 * @returns {string | null} '#rrggbb', or null when the frame can't be read
 *   or the pixel is already transparent (no color to key out)
 */
export function sampleSourceColor(frame, point) {
  const pixel = sampleSourcePixel(frame, point);
  return pixel && !pixel.transparent ? pixel.color : null;
}

/**
 * Most common opaque border color of the frame's output region — the
 * default key color when background removal is enabled without a chosen
 * color
 * @param {Frame} frame
 * @param {CropArea | null | undefined} crop
 * @returns {string | null} '#rrggbb', or null when the frame can't be read
 *   or its border is already transparent
 */
export function detectOutputEdgeColor(frame, crop) {
  const region = readSourceRegion(frame, getOutputRegion(frame, crop));
  if (!region) return null;
  return findOpaqueEdgeColor(region.data, region.width, region.height);
}
