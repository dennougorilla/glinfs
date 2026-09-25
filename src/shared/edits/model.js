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
 * @typedef {Object} BackgroundRemoval
 * @property {boolean} enabled
 * @property {string} color          - key color '#rrggbb'
 * @property {number} tolerance      - 0..100
 * @property {BackgroundMode} mode   - connected = flood fill from the output border only
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

/** Numeric ranges enforced by normalizeEdits */
export const EDIT_LIMITS = /** @type {const} */ ({
  size: { min: 0.02, max: 0.5 },
  outlineWidth: { min: 0, max: 0.3 },
  boxOpacity: { min: 0, max: 1 },
  position: { min: 0, max: 1 },
  tolerance: { min: 0, max: 100 },
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

/** Defaults for background removal */
const BACKGROUND_DEFAULTS = /** @type {const} */ ({
  enabled: false,
  color: '#00ff00',
  tolerance: 20,
  mode: 'connected',
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
  return { textLayers: [], background: { ...BACKGROUND_DEFAULTS } };
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
 * Normalize background removal settings
 * @param {unknown} background
 * @returns {BackgroundRemoval}
 */
function normalizeBackground(background) {
  const b =
    background && typeof background === 'object'
      ? /** @type {Record<string, unknown>} */ (background)
      : {};
  const { tolerance } = EDIT_LIMITS;
  return {
    enabled: b.enabled === true,
    color: normalizeColor(b.color, BACKGROUND_DEFAULTS.color),
    tolerance: clampNumber(
      b.tolerance,
      tolerance.min,
      tolerance.max,
      BACKGROUND_DEFAULTS.tolerance,
    ),
    mode: normalizeEnum(b.mode, BACKGROUND_MODES, BACKGROUND_DEFAULTS.mode),
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
    background: normalizeBackground(e.background),
  };
}

/**
 * Whether a layer has visible text
 * @param {TextLayer} layer
 * @returns {boolean}
 */
function hasVisibleText(layer) {
  return typeof layer?.text === 'string' && layer.text.trim() !== '';
}

/**
 * True when the edits change nothing: background removal is off and no
 * layer has non-blank text. Tolerates null/undefined.
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
 * or background removal will clear pixels.
 * @param {{ edits?: ClipEdits | null, hasAlpha?: boolean }} params
 * @returns {boolean}
 */
export function requiresTransparency({ edits, hasAlpha }) {
  return Boolean(hasAlpha) || edits?.background?.enabled === true;
}
