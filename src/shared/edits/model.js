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

import { COLOUR_TOLERANCE } from '../masks/colour-fill.js';

/** @typedef {'sans'|'serif'|'mono'|'impact'} TextFont */
/** @typedef {'left'|'center'|'right'} TextAlign */
/** @typedef {'connected'|'global'} BackgroundMode */
/** @typedef {'color'|'ai'} BackgroundMethod */

/**
 * AI cutout model id (see features/ai-cutout/model-registry.js; a unit test
 * keeps AI_MODELS equal to the registry's built-in ids), or the id of a
 * model the user added (`custom-…`, see CUSTOM_MODEL_ID_PATTERN)
 * @typedef {'anime'|'general'|'portrait'|'click'|'ben2'|'video-person'|'birefnet-general'|'birefnet-lite'|'birefnet-toonout'|`custom-${string}`} AiModel
 */
/**
 * The Background tab's AI subject card a cutout was chosen with (see
 * SUBJECT_CARDS in features/editor/panels/background-panel.js). A model
 * can belong to several cards (BiRefNet: Anime and Anything), so the card
 * is kept next to the model.
 * @typedef {'anime'|'portrait'|'general'|'click'} AiSubject
 */
/** @typedef {'keep'|'remove'} PickMode */
/**
 * Click to select: how much of what was clicked to keep — the whole thing
 * (the person whose face was clicked) or the part under the click
 * @typedef {'whole'|'part'} ClickScope
 */
/**
 * How a fix-up selects its region: tracked by the click-to-select model
 * (the whole clicked thing or the part under the click), or, for Remove
 * only, by colour (no model: see shared/masks/colour-fill)
 * @typedef {'whole'|'part'|'colour'} ObjectScope
 */
/** @typedef {'erase'|'restore'} TouchUpMode */
/**
 * What a tracked object does to the base model's mask: 'remove' subtracts
 * it on every frame, 'add' adds it
 * @typedef {'remove'|'add'} ObjectMode
 */

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
 * the AI mask) under it; the selection is followed through the clip. With
 * the click-to-select model ('click') the picks are its prompts instead:
 * keep / remove points on the frames they were made on, followed through
 * the clip by the model itself (the mask build then ignores them).
 * @typedef {Object} CutoutPick
 * @property {number} frame  - absolute clip frame index the pick was made on
 * @property {number} x      - fraction of the SOURCE frame width, 0..1
 * @property {number} y      - fraction of the SOURCE frame height, 0..1
 * @property {PickMode} mode - keep only picked characters, or remove them
 */

/**
 * A thing clicked on the preview that is tracked through the selection by
 * the click-to-select model (MobileSAM) and then subtracted from (or added
 * to) the base model's mask on every frame, so the base model keeps its
 * own edges. Works with any AI model, including click to select.
 * @typedef {Object} CutoutObject
 * @property {string} id
 * @property {ObjectMode} mode
 * @property {CutoutPick[]} clicks - at most EDIT_LIMITS.aiObjectClicks.max,
 *   in the order they were made: keep points (on the object) and remove
 *   points (not on it), on any frame. Without a box the first is a keep
 *   point (what selected the object).
 * @property {CutoutBox[]} boxes - at most EDIT_LIMITS.aiObjectBoxes.max:
 *   rough regions on a frame (each one SAM box prompt); with the keep
 *   points they add up to one region
 * @property {ObjectScope} scope - the whole clicked thing, the part under
 *   the click, or (Remove only) Colour: not tracked, its keep points sample
 *   the colours to remove and its remove points the colours to protect
 * @property {number} tolerance - Colour only: Euclidean RGB distance,
 *   COLOUR_TOLERANCE.min..max (kept when the scope changes)
 * @property {number[]} [gone] - Frames where the user confirmed the object is
 *   not there (it left the frame or is hidden): each one stands for the run
 *   of frames without its mask around it, which then count as done, not as
 *   lost (sorted, at most EDIT_LIMITS.aiObjectGone.max)
 * @property {boolean} [everywhere] - Colour only: remove the sampled colours
 *   wherever they are in the mask on every frame, not only where they
 *   touch its points (sparkles, flames scattered over the frame)
 * @property {boolean} [only] - Keep fix-ups only: "only this". On every
 *   frame where it has its mask the final mask keeps only what lies inside
 *   it (grown a little); frames without its mask keep the base mask. Absent:
 *   not decided yet (a Keep box decides from what it holds), or an Add
 *   fix-up.
 * @property {number} [candidate] - Which of the tracker's answers on its
 *   clicked frames is kept: their rank small to large, 0..OBJECT_CANDIDATES-1
 *   (the largest when a frame has fewer). Absent in edits made before the
 *   answers could be picked: Whole / Part (`scope`) chooses there.
 */

/**
 * A box dragged around a tracked object on one frame
 * @typedef {Object} CutoutBox
 * @property {number} frame - absolute clip frame index
 * @property {number} x0 - left, fraction of the SOURCE frame width, 0..1
 * @property {number} y0 - top, fraction of the SOURCE frame height
 * @property {number} x1 - right (> x0)
 * @property {number} y1 - bottom (> y0)
 */

/**
 * AI cutout parameters (used when BackgroundRemoval.method is 'ai')
 * @typedef {Object} AiCutout
 * @property {AiModel} model     - which segmentation model's masks to use.
 *   Edits saved before the general model existed have none and mean
 *   'anime'. Switching the model keeps the other parameters and the picks
 *   (a pick is a position: it selects whatever the new model finds there,
 *   and is ignored where that model finds nothing)
 * @property {number} threshold  - foreground probability cut-off, 0.05..0.95
 * @property {boolean} smoothing - average each frame's probability with its
 *   neighbours before thresholding (steadier edges between frames)
 * @property {number} edge       - integer SOURCE pixels, -8..8: positive grows
 *   the cutout, negative shrinks it
 * @property {CutoutPick[]} picks - at most 16, in the order they were made
 * @property {ClickScope} clickScope - click to select only: keep the whole
 *   clicked thing or the part under the click
 * @property {CutoutObject[]} objects - at most EDIT_LIMITS.aiObjects.max
 *   tracked objects removed from / added to the mask, applied in order
 * @property {CutoutCleanup} cleanup - whole-clip clean-up of the final masks
 * @property {AiSubject | null} subject - the subject card the model was
 *   chosen with; null (edits saved before cards could share a model) means
 *   the first card that lists the model
 */

/**
 * Whole-clip clean-up of the AI cutout, applied to every frame after the
 * picks and before the edge. Areas are fractions of the frame, 0 = off.
 * @typedef {Object} CutoutCleanup
 * @property {number} minIslandArea - separate pieces smaller than this go
 *   (the largest piece of a frame always stays)
 * @property {number} maxHoleArea - holes up to this size are filled (a hole
 *   touching the frame border is never filled)
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
 * A mask brush stroke painted on top of background removal (either
 * method): 'erase' removes the pixels under it, 'restore' brings the
 * original pixels back. Only applies while background removal is on.
 * @typedef {Object} TouchUp
 * @property {string} id
 * @property {TouchUpMode} mode
 * @property {number} radius - brush radius as a fraction of the SOURCE
 *   frame's shorter side (EDIT_LIMITS.touchUpRadius)
 * @property {{ x: number, y: number }[]} points - the stroke's path,
 *   fractions of the SOURCE frame (0..1), at least one point
 * @property {number} start - first clip frame index it applies to (inclusive, absolute)
 * @property {number} end   - last clip frame index (inclusive, absolute)
 */

/**
 * @typedef {Object} ClipEdits
 * @property {TextLayer[]} textLayers  - drawn in array order (last = on top)
 * @property {BackgroundRemoval} background
 * @property {TouchUp[]} touchUps      - applied in array order (later strokes win);
 *   kept outside `background` so painting never rebuilds the AI masks
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

/** @type {readonly ClickScope[]} */
export const CLICK_SCOPES = /** @type {const} */ (['whole', 'part']);

/** @type {readonly ObjectScope[]} */
export const OBJECT_SCOPES = /** @type {const} */ (['whole', 'part', 'colour']);

/**
 * The tracker's answers to a click or box on its frame (MobileSAM decodes
 * four): a fix-up's `candidate` is the rank of the one the user keeps,
 * small to large
 */
export const OBJECT_CANDIDATES = 4;

/**
 * The answer a new fix-up starts with (a Keep click or any box): the
 * largest. See getDefaultObjectCandidate.
 */
export const DEFAULT_OBJECT_CANDIDATE = OBJECT_CANDIDATES - 1;

/**
 * The answer a new Remove fix-up made by a click starts with: the second
 * smallest. A Remove click lands on a leftover attached to the subject,
 * and the larger answers hold the subject too.
 */
export const DEFAULT_REMOVE_CLICK_CANDIDATE = 1;

/**
 * The answer a new fix-up starts with, by how it was made. Measured on the
 * 94 reference frames of the owner's clips with the branch's ordering
 * (cutout-ux 2, mean J of the region):
 * - Remove click (42 frames): second smallest 0.47, Whole 0.44, Part 0.40,
 *   largest 0.29, best of the answers 0.59;
 * - Keep click (52): largest 0.63, Part 0.38, Whole 0.36, best 0.82;
 * - box: largest 0.67 (Remove) / 0.85 (Keep), as Whole, best 0.68 / 0.88.
 * @param {ObjectMode} mode
 * @param {{ box?: unknown }} selection
 * @returns {number}
 */
export function getDefaultObjectCandidate(mode, selection) {
  return mode === 'remove' && !selection.box
    ? DEFAULT_REMOVE_CLICK_CANDIDATE
    : DEFAULT_OBJECT_CANDIDATE;
}

/**
 * Whether a fix-up can be Colour: a Remove one with a point to sample the
 * colours under (a fix-up made by a box, or with only protect points, has
 * none and would remove nothing)
 * @param {{ mode: ObjectMode, clicks: { mode: PickMode }[] }} object
 * @returns {boolean}
 */
export function canBeColourObject(object) {
  return object.mode === 'remove' && object.clicks.some((click) => click.mode === 'keep');
}

/** @type {readonly AiModel[]} */
export const AI_MODELS = /** @type {const} */ ([
  'anime',
  'general',
  'portrait',
  'click',
  'ben2',
  'video-person',
  'birefnet-general',
  'birefnet-lite',
  'birefnet-toonout',
]);

/**
 * Id of a model the user added (features/ai-cutout/custom-models.js; a unit
 * test keeps the two patterns equal). Edits keep such an id even when the
 * model is not in this browser: analyzing then fails with a clear message
 * instead of silently using another model.
 */
export const CUSTOM_MODEL_ID_PATTERN = /^custom-[0-9a-f]{16}-[0-9a-f]{8}$/;

/**
 * @param {unknown} model
 * @returns {model is AiModel}
 */
function isAiModel(model) {
  return (
    AI_MODELS.includes(/** @type {AiModel} */ (model)) ||
    (typeof model === 'string' && CUSTOM_MODEL_ID_PATTERN.test(model))
  );
}

/** @type {readonly ObjectMode[]} */
export const OBJECT_MODES = /** @type {const} */ (['remove', 'add']);

/** @type {readonly AiSubject[]} */
export const AI_SUBJECTS = /** @type {const} */ (['anime', 'portrait', 'general', 'click']);

/** @type {readonly TouchUpMode[]} */
export const TOUCH_UP_MODES = /** @type {const} */ (['erase', 'restore']);

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
  // 8 fix-ups of a 300-frame clip fit the fix-ups' own mask budget
  // (OBJECT_MASK_CAP_BYTES, 128 MB: 11-16 MB each at 256 px long side)
  aiObjects: { max: 8 },
  aiObjectClicks: { max: 16 },
  aiObjectBoxes: { max: 8 },
  aiObjectGone: { max: 64 },
  aiCleanupArea: { min: 0, max: 0.01 },
  touchUpRadius: { min: 0.0025, max: 0.15 },
  touchUps: { max: 200 },
  touchUpPoints: { max: 500 },
});

/** Brush radius of a new stroke (fraction of the source frame's shorter side) */
export const DEFAULT_TOUCH_UP_RADIUS = 0.03;

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

/** Defaults for the AI cutout parameters (picks and objects default to none) */
const AI_DEFAULTS = /** @type {const} */ ({
  model: 'anime',
  threshold: 0.5,
  smoothing: true,
  edge: 0,
  clickScope: 'whole',
  subject: null,
});

/**
 * The model an AiCutout's masks come from: its `model` when it names one,
 * else the default (edits saved before the general model have none). The
 * AI cutout code (getAiModelId) and the final-mask cache key both use this.
 * @param {{ model?: unknown } | null | undefined} ai
 * @returns {AiModel}
 */
export function getAiModel(ai) {
  const model = ai?.model;
  return isAiModel(model) ? model : AI_DEFAULTS.model;
}

/**
 * Whether an AiCutout uses the click-to-select model (its picks are the
 * model's prompts, not selections of mask regions)
 * @param {{ model?: unknown } | null | undefined} ai
 * @returns {boolean}
 */
export function isClickModel(ai) {
  return getAiModel(ai) === 'click';
}

/**
 * The picks the final-mask build follows: none for the click-to-select
 * model (its masks already are what was clicked), else the picks
 * @param {{ model?: unknown, picks?: CutoutPick[] } | null | undefined} ai
 * @returns {CutoutPick[]}
 */
export function getRegionPicks(ai) {
  return isClickModel(ai) ? [] : (ai?.picks ?? []);
}

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
 * Unique id for a text layer or a touch-up stroke
 * @returns {string}
 */
export function createLayerId() {
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
  return {
    textLayers: [],
    background: { ...BACKGROUND_DEFAULTS, ai: createDefaultAiCutout() },
    touchUps: [],
  };
}

/**
 * Default AI cutout parameters (a fresh object with its own picks array)
 * @returns {AiCutout}
 */
export function createDefaultAiCutout() {
  return { ...AI_DEFAULTS, picks: [], objects: [], cleanup: createDefaultCleanup() };
}

/**
 * Clean-up off
 * @returns {CutoutCleanup}
 */
export function createDefaultCleanup() {
  return { minIslandArea: 0, maxHoleArea: 0 };
}

/**
 * Normalize the clean-up: each area clamped into EDIT_LIMITS.aiCleanupArea
 * (anything else is off)
 * @param {unknown} cleanup
 * @returns {CutoutCleanup}
 */
function normalizeCleanup(cleanup) {
  const c =
    cleanup && typeof cleanup === 'object' ? /** @type {Record<string, unknown>} */ (cleanup) : {};
  const { min, max } = EDIT_LIMITS.aiCleanupArea;
  return {
    minIslandArea: clampNumber(c.minIslandArea, min, max, 0),
    maxHoleArea: clampNumber(c.maxHoleArea, min, max, 0),
  };
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
 * Normalize one box; null when it has no usable frame or no area
 * @param {unknown} box
 * @param {number} frameCount
 * @returns {CutoutBox | null}
 */
function normalizeBox(box, frameCount) {
  if (!box || typeof box !== 'object' || Array.isArray(box)) return null;
  const b = /** @type {Record<string, unknown>} */ (box);
  if (
    ![b.frame, b.x0, b.y0, b.x1, b.y1].every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return null;
  }
  const at = (/** @type {unknown} */ v) => clampNumber(v, 0, 1, 0);
  const [x0, x1] = [at(b.x0), at(b.x1)].sort((p, q) => p - q);
  const [y0, y1] = [at(b.y0), at(b.y1)].sort((p, q) => p - q);
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    frame: Math.round(clampNumber(b.frame, 0, lastFrameIndex(frameCount), 0)),
    x0,
    y0,
    x1,
    y1,
  };
}

/**
 * Normalize one tracked object; null when nothing selects it (a box, or a
 * keep click: remove points alone select nothing). Clicks are normalized
 * like picks and limited to EDIT_LIMITS.aiObjectClicks.max; without a box,
 * clicks before the first keep click are dropped. Boxes: the last
 * EDIT_LIMITS.aiObjectBoxes.max made.
 * @param {unknown} object
 * @param {number} frameCount
 * @returns {CutoutObject | null}
 */
function normalizeObject(object, frameCount) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const o = /** @type {Record<string, unknown>} */ (object);
  const raw = Array.isArray(o.clicks) ? o.clicks : [];
  const clicks = raw
    .map((click) => normalizePick(click, frameCount))
    .filter((click) => click !== null);
  const boxes = (Array.isArray(o.boxes) ? o.boxes : [])
    .map((box) => normalizeBox(box, frameCount))
    .filter((box) => box !== null)
    .slice(-EDIT_LIMITS.aiObjectBoxes.max);
  const first = boxes.length > 0 ? 0 : clicks.findIndex((click) => click.mode === 'keep');
  if (first < 0) return null;
  const mode = normalizeEnum(o.mode, OBJECT_MODES, 'remove');
  const scope = normalizeEnum(o.scope, OBJECT_SCOPES, 'whole');
  const kept = clicks.slice(first, first + EDIT_LIMITS.aiObjectClicks.max);
  return {
    id: typeof o.id === 'string' && o.id ? o.id : createLayerId(),
    mode,
    clicks: kept,
    boxes,
    // Colour removes only and needs a point to sample: otherwise tracked
    scope: scope === 'colour' && !canBeColourObject({ mode, clicks: kept }) ? 'whole' : scope,
    ...(mode === 'add' && typeof o.only === 'boolean' ? { only: o.only } : {}),
    ...(mode === 'remove' && o.everywhere === true ? { everywhere: true } : {}),
    ...normalizeGone(o.gone, frameCount),
    ...(Number.isInteger(o.candidate) &&
    /** @type {number} */ (o.candidate) >= 0 &&
    /** @type {number} */ (o.candidate) < OBJECT_CANDIDATES
      ? { candidate: /** @type {number} */ (o.candidate) }
      : {}),
    tolerance: Math.round(
      clampNumber(
        o.tolerance,
        COLOUR_TOLERANCE.min,
        COLOUR_TOLERANCE.max,
        COLOUR_TOLERANCE.default,
      ),
    ),
  };
}

/**
 * A fix-up's gone frames: integers inside the clip, sorted, unique, at most
 * EDIT_LIMITS.aiObjectGone.max (none: no field)
 * @param {unknown} gone
 * @param {number} frameCount
 * @returns {{ gone?: number[] }}
 */
function normalizeGone(gone, frameCount) {
  if (!Array.isArray(gone)) return {};
  const frames = [
    ...new Set(gone.filter((f) => Number.isInteger(f) && f >= 0 && f < Math.max(1, frameCount))),
  ]
    .sort((a, b) => a - b)
    .slice(0, EDIT_LIMITS.aiObjectGone.max);
  return frames.length > 0 ? { gone: frames } : {};
}

/**
 * Normalize the tracked objects: unusable ones and repeated ids are
 * dropped, only the first EDIT_LIMITS.aiObjects.max are kept. Input without
 * the field (edits saved before objects existed) has none.
 * @param {unknown} objects
 * @param {number} frameCount
 * @returns {CutoutObject[]}
 */
function normalizeObjects(objects, frameCount) {
  if (!Array.isArray(objects)) return [];
  const seen = new Set();
  /** @type {CutoutObject[]} */
  const kept = [];
  for (const object of objects) {
    const normalized = normalizeObject(object, frameCount);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    kept.push(normalized);
    if (kept.length >= EDIT_LIMITS.aiObjects.max) break;
  }
  return kept;
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
    // Edits from before the general model have no model: they used the anime one
    model: isAiModel(a.model) ? a.model : AI_DEFAULTS.model,
    threshold: clampNumber(a.threshold, aiThreshold.min, aiThreshold.max, AI_DEFAULTS.threshold),
    smoothing: typeof a.smoothing === 'boolean' ? a.smoothing : AI_DEFAULTS.smoothing,
    edge: Math.round(clampNumber(a.edge, aiEdge.min, aiEdge.max, AI_DEFAULTS.edge)),
    picks: picks
      .map((pick) => normalizePick(pick, frameCount))
      .filter((pick) => pick !== null)
      .slice(0, aiPicks.max),
    clickScope: normalizeEnum(a.clickScope, CLICK_SCOPES, AI_DEFAULTS.clickScope),
    objects: normalizeObjects(a.objects, frameCount),
    cleanup: normalizeCleanup(a.cleanup),
    subject: normalizeEnum(a.subject, AI_SUBJECTS, AI_DEFAULTS.subject),
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
 * The one point-limit rule of a stroke path, used both while painting (see
 * extendStrokePath in ./touch-ups.js) and when edits are normalized, so a
 * stroke never changes between its live preview and its saved form: while
 * the path has more than `max` points, every other point is dropped
 * (indices 0, 2, 4, ...), always keeping the last. A path within the limit
 * is returned as is.
 * @template T
 * @param {T[]} points
 * @param {number} max - At least 2
 * @returns {T[]}
 */
export function limitStrokePoints(points, max) {
  let kept = points;
  while (kept.length > max) {
    const last = kept.length - 1;
    /** @type {T[]} */
    const halved = [];
    for (let i = 0; i < last; i += 2) halved.push(kept[i]);
    halved.push(kept[last]);
    kept = halved;
  }
  return kept;
}

/**
 * Strokes normalizeTouchUp produced, with the frame count they were
 * normalized for: such a stroke is valid as is and is kept by reference
 * (every edit normalizes the whole ClipEdits, and rebuilding every stroke's
 * points on each text drag or slider step would be wasted work and would
 * defeat identity-based caches). Strokes are never mutated once normalized.
 * @type {WeakMap<object, number>}
 */
const normalizedTouchUps = new WeakMap();

/**
 * Normalize one touch-up stroke; null when it has no usable point. Points
 * without finite x/y are dropped, the rest clamped into 0..1 and limited
 * to EDIT_LIMITS.touchUpPoints.max (limitStrokePoints); the radius is
 * clamped; the frame range is clamped into the clip like a text layer's.
 * A stroke this function already returned for the same frame count comes
 * back as is.
 * @param {unknown} stroke
 * @param {number} frameCount
 * @returns {TouchUp | null}
 */
function normalizeTouchUp(stroke, frameCount) {
  if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke)) return null;
  if (normalizedTouchUps.get(stroke) === frameCount) return /** @type {TouchUp} */ (stroke);
  const t = /** @type {Record<string, unknown>} */ (stroke);
  const { position, touchUpRadius, touchUpPoints } = EDIT_LIMITS;
  const raw = Array.isArray(t.points) ? t.points : [];
  /** @type {{ x: number, y: number }[]} */
  const points = [];
  for (const point of raw) {
    if (!point || typeof point !== 'object') continue;
    const { x, y } = /** @type {Record<string, unknown>} */ (point);
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({
      x: clampNumber(x, position.min, position.max, 0.5),
      y: clampNumber(y, position.min, position.max, 0.5),
    });
  }
  if (points.length === 0) return null;
  const last = lastFrameIndex(frameCount);
  const start = Math.round(clampNumber(t.start, 0, last, 0));
  const end = Math.max(start, Math.round(clampNumber(t.end, 0, last, start)));
  /** @type {TouchUp} */
  const normalized = {
    id: typeof t.id === 'string' && t.id ? t.id : createLayerId(),
    mode: normalizeEnum(t.mode, TOUCH_UP_MODES, 'erase'),
    radius: clampNumber(t.radius, touchUpRadius.min, touchUpRadius.max, DEFAULT_TOUCH_UP_RADIUS),
    points: limitStrokePoints(points, touchUpPoints.max),
    start,
    end,
  };
  normalizedTouchUps.set(normalized, frameCount);
  return normalized;
}

/**
 * Normalize the touch-up strokes: unusable ones are dropped and only the
 * first EDIT_LIMITS.touchUps.max are kept. Input without the field (edits
 * saved before touch-ups existed) has none. Already-normalized strokes, and
 * an array of nothing else, are returned by reference.
 * @param {unknown} touchUps
 * @param {number} frameCount
 * @returns {TouchUp[]}
 */
function normalizeTouchUps(touchUps, frameCount) {
  if (!Array.isArray(touchUps)) return [];
  const normalized = touchUps
    .map((stroke) => normalizeTouchUp(stroke, frameCount))
    .filter((stroke) => stroke !== null)
    .slice(0, EDIT_LIMITS.touchUps.max);
  // Nothing changed (every stroke kept by reference): keep the array too
  const unchanged =
    normalized.length === touchUps.length && normalized.every((s, i) => s === touchUps[i]);
  return unchanged ? /** @type {TouchUp[]} */ (touchUps) : normalized;
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
    touchUps: normalizeTouchUps(e.touchUps, frameCount),
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
 * Whether touch-ups apply: they refine a removal, so only while background
 * removal (either method) is on
 * @param {BackgroundRemoval | null | undefined} background
 * @returns {boolean}
 */
export function areTouchUpsActive(background) {
  return background?.enabled === true;
}

/**
 * Touch-up strokes that apply to `frameIndex`, in paint order: none while
 * background removal is off
 * @param {ClipEdits | null | undefined} edits
 * @param {number} frameIndex - Absolute clip frame index
 * @returns {TouchUp[]}
 */
export function getActiveTouchUps(edits, frameIndex) {
  const touchUps = edits?.touchUps;
  if (!touchUps || touchUps.length === 0 || !areTouchUpsActive(edits.background)) return [];
  return touchUps.filter((stroke) => stroke.start <= frameIndex && frameIndex <= stroke.end);
}

/**
 * True when the edits change nothing: background removal (either method)
 * is off and no layer has non-blank text (touch-ups only apply while
 * removal is on, so they never make edits non-empty on their own).
 * Tolerates null/undefined.
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
