/**
 * Clip Edit Model - Pure Functions
 *
 * The edits a user applies on top of a clip's frames (text overlays and
 * background removal). Shared by the editor (authoring + preview) and the
 * export pipeline (burn-in), so both agree on defaults, ranges and which
 * layers are active on a given frame. No DOM access.
 *
 * @module shared/edits/model
 */

/** @typedef {'sans'|'serif'|'mono'|'impact'} TextFont */
/** @typedef {'left'|'center'|'right'} TextAlign */
/** @typedef {'connected'|'global'} BackgroundMode */
/** @typedef {'color'|'ai'} BackgroundMethod */
/** @typedef {'keep'|'remove'} PickMode */

/**
 * @typedef {Object} TextLayer
 * @property {string} id
 * @property {string} text          - may contain '\n' (multi-line)
 * @property {number} x             - center X as a fraction of OUTPUT width, 0..1
 * @property {number} y             - center Y as a fraction of OUTPUT height, 0..1
 * @property {number} size          - font size as a fraction of OUTPUT height, 0.02..0.5
 * @property {TextFont} font
 * @property {boolean} bold
 * @property {TextAlign} align
 * @property {string} color         - '#rrggbb'
 * @property {string} outlineColor  - '#rrggbb'
 * @property {number} outlineWidth  - fraction of the font px size, 0..0.3 (0 = no outline)
 * @property {string|null} boxColor - '#rrggbb' background box behind the text, or null for none
 * @property {number} boxOpacity    - 0..1
 * @property {number} start         - first clip frame index where the text shows (inclusive, absolute)
 * @property {number} end           - last clip frame index (inclusive, absolute)
 */

/**
 * A click on the preview that selects the character (connected region of
 * the AI mask) under it; the selection is followed through the clip.
 * @typedef {Object} CutoutPick
 * @property {number} frame  - absolute clip frame index the pick was made on
 * @property {number} x      - fraction of the SOURCE frame width, 0..1
 * @property {number} y      - fraction of the SOURCE frame height, 0..1
 * @property {PickMode} mode - keep only picked characters, or remove them
 */

/**
 * AI cutout parameters (used when BackgroundRemoval.method is 'ai')
 * @typedef {Object} AiCutout
 * @property {number} threshold  - foreground probability cut-off, 0.05..0.95
 * @property {boolean} smoothing - average each frame's probability with its
 *   neighbours before thresholding (steadier edges between frames)
 * @property {number} edge       - integer SOURCE pixels, -8..8: positive grows
 *   the cutout, negative shrinks it
 * @property {CutoutPick[]} picks - at most 16, in the order they were made
 */

/**
 * @typedef {Object} BackgroundRemoval
 * @property {boolean} enabled       - master switch for either method
 * @property {BackgroundMethod} method - 'color' keys out a color; 'ai' cuts
 *   characters out with the segmentation masks. Edits saved before the AI
 *   method existed have no method and mean 'color'.
 * @property {AiCutout} ai           - kept while the color method is active so
 *   switching back and forth loses nothing
 * @property {string} color          - key color '#rrggbb' (method 'color')
 * @property {number} tolerance      - 0..100
 * @property {BackgroundMode} mode   - connected = flood fill from the output border only
 * @property {boolean} colorChosen   - the key color was chosen (picked, typed or
 *   detected) rather than left at the default; enabling removal without one
 *   detects the edge color
 */

/**
 * @typedef {Object} ClipEdits
 * @property {TextLayer[]} textLayers  - drawn in array order (last = on top)
 * @property {BackgroundRemoval} background
 */

/** Valid '#rrggbb' color */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** @type {readonly TextFont[]} */
export const TEXT_FONTS = /** @type {const} */ (['sans', 'serif', 'mono', 'impact']);

/** @type {readonly TextAlign[]} */
export const TEXT_ALIGNS = /** @type {const} */ (['left', 'center', 'right']);

/** @type {readonly BackgroundMode[]} */
export const BACKGROUND_MODES = /** @type {const} */ (['connected', 'global']);

/** @type {readonly BackgroundMethod[]} */
export const BACKGROUND_METHODS = /** @type {const} */ (['color', 'ai']);

/** @type {readonly PickMode[]} */
export const PICK_MODES = /** @type {const} */ (['keep', 'remove']);

/** Numeric ranges enforced by normalizeEdits */
export const EDIT_LIMITS = /** @type {const} */ ({
  size: { min: 0.02, max: 0.5 },
  outlineWidth: { min: 0, max: 0.3 },
  boxOpacity: { min: 0, max: 1 },
  position: { min: 0, max: 1 },
  tolerance: { min: 0, max: 100 },
  aiThreshold: { min: 0.05, max: 0.95 },
  aiEdge: { min: -8, max: 8 },
  aiPicks: { max: 16 },
});

/** Defaults for a new text layer (start/end/id are derived per call) */
const TEXT_LAYER_DEFAULTS = /** @type {const} */ ({
  text: 'Your text',
  x: 0.5,
  y: 0.85,
  size: 0.1,
  font: 'sans',
  bold: true,
  align: 'center',
  color: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 0.12,
  boxColor: null,
  boxOpacity: 0.6,
});

/** Defaults for the AI cutout parameters (picks default to none) */
const AI_DEFAULTS = /** @type {const} */ ({
  threshold: 0.5,
  smoothing: true,
  edge: 0,
});

/** Defaults for background removal (the `ai` object is added per call) */
const BACKGROUND_DEFAULTS = /** @type {const} */ ({
  enabled: false,
  method: 'color',
  color: '#00ff00',
  tolerance: 20,
  mode: 'connected',
  colorChosen: false,
});

/** Fallback id counter for environments without crypto.randomUUID */
let idCounter = 0;

/**
 * Unique id for a text layer
 * @returns {string}
 */
function createLayerId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `text-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Clamp a value to [min, max]; non-finite input yields `fallback`
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * A valid '#rrggbb' color (lower-cased), or `fallback`
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeColor(value, fallback) {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

/**
 * `value` when it is one of `allowed`, else `fallback`
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;
}

/**
 * Last valid frame index for a clip (0 for an empty/invalid count)
 * @param {number} frameCount
 * @returns {number}
 */
function lastFrameIndex(frameCount) {
  return Number.isFinite(frameCount) && frameCount > 0 ? Math.floor(frameCount) - 1 : 0;
}

/**
 * Default edits: no text, background removal off
 * @returns {ClipEdits}
 */
export function createDefaultEdits() {
  return { textLayers: [], background: { ...BACKGROUND_DEFAULTS, ai: createDefaultAiCutout() } };
}

/**
 * Default AI cutout parameters (a fresh object with its own picks array)
 * @returns {AiCutout}
 */
export function createDefaultAiCutout() {
  return { ...AI_DEFAULTS, picks: [] };
}

/**
 * Create a text layer with defaults, spanning the whole clip unless the
 * partial says otherwise. The result is normalized.
 * @param {Partial<TextLayer>} [partial]
 * @param {number} frameCount - Clip frame count (for the default end frame)
 * @returns {TextLayer}
 */
export function createTextLayer(partial = {}, frameCount = 1) {
  const last = lastFrameIndex(frameCount);
  return normalizeTextLayer(
    {
      ...TEXT_LAYER_DEFAULTS,
      start: 0,
      end: last,
      ...partial,
      id: typeof partial.id === 'string' && partial.id ? partial.id : createLayerId(),
    },
    frameCount,
  );
}

/**
 * Normalize one text layer (object input assumed)
 * @param {Record<string, unknown>} layer
 * @param {number} frameCount
 * @returns {TextLayer}
 */
function normalizeTextLayer(layer, frameCount) {
  const last = lastFrameIndex(frameCount);
  const { size, outlineWidth, boxOpacity, position } = EDIT_LIMITS;

  const start = Math.round(clampNumber(layer.start, 0, last, 0));
  // An end before the start follows the start (the start is what the user
  // just moved in every UI path that can cross them)
  const end = Math.max(start, Math.round(clampNumber(layer.end, 0, last, last)));

  return {
    id: typeof layer.id === 'string' && layer.id ? layer.id : createLayerId(),
    text: typeof layer.text === 'string' ? layer.text : '',
    x: clampNumber(layer.x, position.min, position.max, TEXT_LAYER_DEFAULTS.x),
    y: clampNumber(layer.y, position.min, position.max, TEXT_LAYER_DEFAULTS.y),
    size: clampNumber(layer.size, size.min, size.max, TEXT_LAYER_DEFAULTS.size),
    font: normalizeEnum(layer.font, TEXT_FONTS, TEXT_LAYER_DEFAULTS.font),
    bold: typeof layer.bold === 'boolean' ? layer.bold : TEXT_LAYER_DEFAULTS.bold,
    align: normalizeEnum(layer.align, TEXT_ALIGNS, TEXT_LAYER_DEFAULTS.align),
    color: normalizeColor(layer.color, TEXT_LAYER_DEFAULTS.color),
    outlineColor: normalizeColor(layer.outlineColor, TEXT_LAYER_DEFAULTS.outlineColor),
    outlineWidth: clampNumber(
      layer.outlineWidth,
      outlineWidth.min,
      outlineWidth.max,
      TEXT_LAYER_DEFAULTS.outlineWidth,
    ),
    boxColor: layer.boxColor == null ? null : normalizeColor(layer.boxColor, '#000000'),
    boxOpacity: clampNumber(
      layer.boxOpacity,
      boxOpacity.min,
      boxOpacity.max,
      TEXT_LAYER_DEFAULTS.boxOpacity,
    ),
    start,
    end,
  };
}

/**
 * Normalize one pick; null when it has no usable position or frame
 * @param {unknown} pick
 * @param {number} frameCount
 * @returns {CutoutPick | null}
 */
function normalizePick(pick, frameCount) {
  if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return null;
  const p = /** @type {Record<string, unknown>} */ (pick);
  const { position } = EDIT_LIMITS;
  if (![p.frame, p.x, p.y].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return null;
  }
  return {
    frame: Math.round(clampNumber(p.frame, 0, lastFrameIndex(frameCount), 0)),
    x: clampNumber(p.x, position.min, position.max, 0.5),
    y: clampNumber(p.y, position.min, position.max, 0.5),
    mode: normalizeEnum(p.mode, PICK_MODES, 'keep'),
  };
}

/**
 * Normalize AI cutout parameters. Picks without a finite frame/x/y are
 * dropped, the rest are clamped (frame into the clip, x/y into 0..1) and
 * only the first EDIT_LIMITS.aiPicks.max are kept.
 * @param {unknown} ai
 * @param {number} frameCount
 * @returns {AiCutout}
 */
function normalizeAiCutout(ai, frameCount) {
  const a = ai && typeof ai === 'object' ? /** @type {Record<string, unknown>} */ (ai) : {};
  const { aiThreshold, aiEdge, aiPicks } = EDIT_LIMITS;
  const picks = Array.isArray(a.picks) ? a.picks : [];
  return {
    threshold: clampNumber(a.threshold, aiThreshold.min, aiThreshold.max, AI_DEFAULTS.threshold),
    smoothing: typeof a.smoothing === 'boolean' ? a.smoothing : AI_DEFAULTS.smoothing,
    edge: Math.round(clampNumber(a.edge, aiEdge.min, aiEdge.max, AI_DEFAULTS.edge)),
    picks: picks
      .map((pick) => normalizePick(pick, frameCount))
      .filter((pick) => pick !== null)
      .slice(0, aiPicks.max),
  };
}

/**
 * Normalize background removal settings
 * @param {unknown} background
 * @param {number} frameCount - Clip frame count (pick frames are clamped into it)
 * @returns {BackgroundRemoval}
 */
function normalizeBackground(background, frameCount) {
  const b =
    background && typeof background === 'object'
      ? /** @type {Record<string, unknown>} */ (background)
      : {};
  const { tolerance } = EDIT_LIMITS;
  const enabled = b.enabled === true;
  const color = normalizeColor(b.color, BACKGROUND_DEFAULTS.color);
  return {
    enabled,
    // v0.7.0 edits have no method: they were color keys
    method: normalizeEnum(b.method, BACKGROUND_METHODS, BACKGROUND_DEFAULTS.method),
    ai: normalizeAiCutout(b.ai, frameCount),
    color,
    tolerance: clampNumber(
      b.tolerance,
      tolerance.min,
      tolerance.max,
      BACKGROUND_DEFAULTS.tolerance,
    ),
    mode: normalizeEnum(b.mode, BACKGROUND_MODES, BACKGROUND_DEFAULTS.mode),
    // Input without the flag: a removal in use or a non-default color was
    // evidently chosen
    colorChosen:
      typeof b.colorChosen === 'boolean'
        ? b.colorChosen
        : enabled || color !== BACKGROUND_DEFAULTS.color,
  };
}

/**
 * Normalize edits from any (possibly undefined, partial or corrupt) input.
 *
 * Always returns a NEW object. Numbers are clamped to their ranges, colors
 * validated, enums coerced, frame ranges clamped into [0, frameCount-1]
 * with start <= end, and non-object layers dropped. Layers with empty text
 * are kept (the UI may be mid-edit); rendering skips blank text.
 *
 * @param {unknown} edits
 * @param {number} frameCount - Clip frame count
 * @returns {ClipEdits}
 */
export function normalizeEdits(edits, frameCount) {
  const e =
    edits && typeof edits === 'object' ? /** @type {Record<string, unknown>} */ (edits) : {};
  const layers = Array.isArray(e.textLayers) ? e.textLayers : [];
  return {
    textLayers: layers
      .filter((layer) => layer !== null && typeof layer === 'object' && !Array.isArray(layer))
      .map((layer) => normalizeTextLayer(layer, frameCount)),
    background: normalizeBackground(e.background, frameCount),
  };
}

/**
 * Whether a layer has visible text. The single rule every consumer (redraw
 * decisions, hit testing, drawing, export) uses to decide a layer counts.
 * @param {TextLayer | null | undefined} layer
 * @returns {boolean}
 */
export function hasVisibleText(layer) {
  return typeof layer?.text === 'string' && layer.text.trim() !== '';
}

/**
 * Whether the color key runs: removal on with the 'color' method (or no
 * method, as in edits saved before the AI method existed)
 * @param {BackgroundRemoval | null | undefined} background
 * @returns {boolean}
 */
export function isColorKeyActive(background) {
  return background?.enabled === true && background.method !== 'ai';
}

/**
 * Whether AI cutout masks replace the color key: removal on with the 'ai'
 * method
 * @param {BackgroundRemoval | null | undefined} background
 * @returns {boolean}
 */
export function isAiCutoutActive(background) {
  return background?.enabled === true && background.method === 'ai';
}

/**
 * True when the edits change nothing: background removal (either method)
 * is off and no layer has non-blank text. Tolerates null/undefined.
 * @param {ClipEdits | null | undefined} edits
 * @returns {boolean}
 */
export function isEditsEmpty(edits) {
  if (!edits) return true;
  if (edits.background?.enabled === true) return false;
  return !(edits.textLayers ?? []).some(hasVisibleText);
}

/**
 * Text layers with visible text whose range covers `frameIndex`, in draw order
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index
 * @returns {TextLayer[]}
 */
export function getActiveTextLayers(edits, frameIndex) {
  const layers = edits?.textLayers ?? [];
  return layers.filter(
    (layer) => hasVisibleText(layer) && layer.start <= frameIndex && frameIndex <= layer.end,
  );
}

/**
 * Whether an export needs GIF transparency: the source already has alpha,
 * or background removal (color key or AI cutout) will clear pixels.
 * @param {{ edits?: ClipEdits | null, hasAlpha?: boolean }} params
 * @returns {boolean}
 */
export function requiresTransparency({ edits, hasAlpha }) {
  return Boolean(hasAlpha) || edits?.background?.enabled === true;
}
