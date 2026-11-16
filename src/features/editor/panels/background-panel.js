/**
 * The editor's Background tab: "What do you want to keep?"
 * @module features/editor/panels/background-panel
 *
 * Built for people who cut a character or a person out of a clip, not for
 * compositing experts, so the panel asks one question and shows the answer
 * right away:
 *
 * 1. Subject: a radio group of cards (Anime, Person, Anything, Something
 *    else, Solid color) plus Off. An AI card says whether its model is ready or how much it
 *    downloads; choosing one that still has to download asks first, inline
 *    (never a silent download). Choosing a ready one starts at once with
 *    the frame on screen (see handleChooseSubject in index.js).
 * 2. One or two plain adjustments, always visible: AI "Fit" (Tighter …
 *    Looser, which sets the threshold and the edge together, see
 *    aiFromFit) and "Reduce flicker between frames"; color: the key color
 *    with an eyedropper, "Similar colors" (tolerance) and Edges only /
 *    Everywhere.
 * 3. Fix-ups as tools on the preview: Keep / Remove, Brush (the Touch up
 *    mode) and Reset. A Keep / Remove click becomes a pick (a piece of the
 *    mask) or a tracked fix-up (MobileSAM through the selection: something
 *    on the subject to remove, something the mask missed to keep, or any
 *    dragged box); see classifyFixUp. Every fix-up is one chip with go-to
 *    and delete; a tracked one carries its Show mask colour, is selected for
 *    corrections by its chip, and gets Whole / Part. Frames where tracking
 *    lost one are listed with a way to go there and click it again.
 *
 * "Something else — click it" (click to select, MobileSAM) works by
 * clicking: the preview asks for a click on the thing to keep, the frame on
 * screen shows its mask right away, a Whole / Part choice picks how much of
 * it, Keep / Remove add points that fix the selection, and the selection
 * is tracked through the clip in the background. Frames where tracking lost
 * it are listed with a way to go there and click it again.
 *
 * Status never moves the controls: the AI status sits in a slot of fixed
 * height (progress, "N frames not analyzed", done), so nothing pops in or
 * out above a slider while it is dragged.
 *
 * Built once; updateBackgroundPanel() patches it in place from the editor
 * state. Toggles are checkboxes/radios, not aria-pressed buttons: the form
 * controls are "editable" to the hotkey dispatcher, so Space on a focused
 * toggle flips it instead of toggling playback.
 */

import {
  createDefaultAiCutout,
  createDefaultEdits,
  EDIT_LIMITS,
} from '../../../shared/edits/model.js';
import { MAX_SUGGESTIONS } from '../../../shared/masks/cleanup-suggestions.js';
import { loadSettings } from '../../../shared/user-settings.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import { pickPreferredModel } from '../../ai-cutout/model-preference.js';
import { getModelEntry } from '../../ai-cutout/model-registry.js';
import {
  describeAnalysisProgress,
  getAiModelId,
  getAnalysisCoverage,
  getAnalysisFraction,
  getModelSizeLabel,
  RUNTIME_SIZE_LABEL,
} from '../ai-cutout.js';
import { getObjectColor } from '../object-colors.js';
import { getActiveAiObject } from '../state.js';

/** @typedef {import('../../../shared/edits/model.js').CutoutPick} CutoutPick */
/** @typedef {import('../../../shared/edits/model.js').CutoutObject} CutoutObject */
/** @typedef {import('../../../shared/edits/model.js').AiCutout} AiCutout */
/** @typedef {import('../../../shared/masks/cleanup-suggestions.js').CleanupSuggestion} CleanupSuggestion */
/** @typedef {'none' | 'anime' | 'portrait' | 'general' | 'click' | 'color'} Subject */

/**
 * The subject cards, in the order shown (two columns). `model` is the AI
 * model a card uses by default and `models` every model it can use (the
 * default first; the AI settings show a Model choice when there are
 * several); the color card uses the color key. `name` is how the
 * download question names the model.
 * @type {readonly { value: Exclude<Subject, 'none'>, label: string, hint: string, model: string | null, models: readonly string[], name?: string, icon: string }[]}
 */
export const SUBJECT_CARDS = Object.freeze([
  {
    value: 'anime',
    label: 'Anime',
    hint: 'Characters, art',
    model: 'anime',
    models: Object.freeze(['anime']),
    icon: '<path d="M12 3l2.4 5.1 5.6.7-4.1 3.9 1 5.5L12 15.6 7.1 18.2l1-5.5L4 8.8l5.6-.7z"/>',
  },
  {
    value: 'portrait',
    label: 'Person',
    hint: 'Real people, fast',
    model: 'portrait',
    models: Object.freeze(['portrait', 'video-person']),
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  },
  {
    value: 'general',
    label: 'Anything',
    hint: 'People, pets, objects',
    model: 'general',
    models: Object.freeze(['general', 'ben2']),
    icon: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="3.5"/>',
  },
  {
    value: 'click',
    label: 'Something else',
    hint: 'Click it to select',
    model: 'click',
    models: Object.freeze(['click']),
    name: 'Click to select',
    icon: '<circle cx="11" cy="11" r="7"/><path d="M11 2v3M11 17v3M2 11h3M17 11h3"/><path d="M13.5 13.5l6.5 2.5-2.7 1.3-1.3 2.7z" fill="currentColor"/>',
  },
  {
    value: 'color',
    label: 'Solid color',
    hint: 'Green screen, flat',
    model: null,
    models: Object.freeze([]),
    icon: '<path d="M12 3.5c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0c0-3.1 2.5-6.3 6-10.5z"/>',
  },
]);

/** The AI subject card of a model */
const CARD_BY_MODEL = Object.fromEntries(
  SUBJECT_CARDS.flatMap((card) => card.models.map((model) => [model, card])),
);

/**
 * The subject card that uses a model, or null for an unknown id
 * @param {string} modelId
 * @returns {Exclude<Subject, 'none' | 'color'> | null}
 */
export function getModelSubject(modelId) {
  return /** @type {any} */ (CARD_BY_MODEL[modelId]?.value ?? null);
}

/**
 * The subject the background settings amount to
 * @param {import('../../../shared/edits/model.js').BackgroundRemoval} background
 * @returns {Subject}
 */
export function getSubject(background) {
  if (!background.enabled) return 'none';
  if (background.method !== 'ai') return 'color';
  return /** @type {Subject} */ (CARD_BY_MODEL[getAiModelId(background.ai)]?.value ?? 'anime');
}

/**
 * What getSubjectModel weighs besides the clip's own model (#187)
 * @typedef {Object} SubjectModelPrefs
 * @property {import('../../ai-cutout/model-preference.js').RememberedModels | null} [remembered]
 *   - The models the user chose last (user settings)
 * @property {Readonly<Record<string, string>> | null} [availability] - Per
 *   model: downloaded or not (the editor's `aiCutout.models`)
 */

/**
 * The AI model of a subject, or null (Off, Solid color): the model of
 * `ai` when the subject can use it (the clip's choice stays; edits that
 * name no model mean the anime one), else the model the user chose last for the
 * subject, else one of its models that is downloaded already, else the
 * first-run default (see model-preference.js)
 * @param {Subject} subject
 * @param {{ model?: unknown } | null} [ai]
 * @param {SubjectModelPrefs} [prefs]
 * @returns {string | null}
 */
export function getSubjectModel(subject, ai = null, prefs = {}) {
  const card = SUBJECT_CARDS.find((c) => c.value === subject);
  if (!card?.model) return null;
  const current = ai ? getAiModelId(ai) : null;
  if (current && card.models.includes(current)) return current;
  return pickPreferredModel(card.models, {
    subject: card.value,
    remembered: prefs.remembered,
    availability: prefs.availability,
    fallback: card.model,
  });
}

/**
 * The models the user chose last, from user settings (#187)
 * @returns {import('../../ai-cutout/model-preference.js').RememberedModels}
 */
export function getRememberedModels() {
  const { lastModel, lastModelBySubject } = loadSettings().aiCutout;
  return { last: lastModel, bySubject: lastModelBySubject };
}

/**
 * The models a subject can use (empty for Off and Solid color)
 * @param {Subject} subject
 * @returns {readonly string[]}
 */
export function getSubjectModels(subject) {
  return SUBJECT_CARDS.find((c) => c.value === subject)?.models ?? [];
}

/**
 * Text of a model in the Model choice: purpose, network and size
 * @param {string} modelId
 * @returns {string}
 */
export function getModelOptionLabel(modelId) {
  const entry = getModelEntry(modelId);
  return `${entry.label} · ${entry.shortModelName} · ${getModelSizeLabel(modelId)}`;
}

// ------------------------------------------------------------------
// Fit: one slider for the threshold and the edge
// ------------------------------------------------------------------

/** Fit slider range: -FIT_STEPS (tighter) .. +FIT_STEPS (looser), 0 = default */
export const FIT_STEPS = 10;

/** Threshold change per Fit step */
const FIT_THRESHOLD_STEP = 0.04;

/**
 * AI parameters of a Fit value. Looser lowers the threshold (more of what
 * the model is unsure about stays) and grows the edge; tighter does the
 * opposite. Both move together, so one slider covers "the outline is too
 * big / too small":
 *   fit  -10 … 0 … +10
 *   threshold 0.90 … 0.50 … 0.10
 *   edge (px)   -5 … 0 … +5   (sign(fit) × round(|fit| / 2))
 * @param {number} fit - Integer -FIT_STEPS..FIT_STEPS
 * @returns {{ threshold: number, edge: number }}
 */
export function aiFromFit(fit) {
  const f = Math.max(-FIT_STEPS, Math.min(FIT_STEPS, Math.round(fit) || 0));
  const { aiThreshold, aiEdge } = EDIT_LIMITS;
  const threshold = Math.round((0.5 - FIT_THRESHOLD_STEP * f) * 100) / 100;
  const edge = Math.sign(f) * Math.round(Math.abs(f) / 2);
  return {
    threshold: Math.max(aiThreshold.min, Math.min(aiThreshold.max, threshold)),
    edge: Math.max(aiEdge.min, Math.min(aiEdge.max, edge)) || 0,
  };
}

/**
 * The Fit value closest to stored AI parameters (edits from before the Fit
 * slider may hold any threshold/edge pair: the threshold decides, since it
 * changes the cutout most; the slider then sets both on the next move)
 * @param {{ threshold: number, edge: number }} ai
 * @returns {number}
 */
export function fitFromAi(ai) {
  const f = Math.round((0.5 - ai.threshold) / FIT_THRESHOLD_STEP);
  return Math.max(-FIT_STEPS, Math.min(FIT_STEPS, f)) || 0;
}

/**
 * Spoken/hover value of the Fit slider
 * @param {number} fit
 * @returns {string}
 */
export function describeFit(fit) {
  if (fit === 0) return 'Default';
  return `${fit < 0 ? 'Tighter' : 'Looser'} ${Math.abs(fit)}`;
}

// ------------------------------------------------------------------
// Copy helpers
// ------------------------------------------------------------------

/** Phases in which an analysis is running */
const RUNNING_PHASES = new Set([
  'starting',
  'downloading',
  'verifying',
  'initializing',
  'analyzing',
]);

/**
 * @param {string} phase
 * @returns {boolean}
 */
export function isAnalysisRunning(phase) {
  return RUNNING_PHASES.has(phase);
}

/**
 * Readiness of a model on its card: ready to run (downloaded or loaded),
 * or what choosing it downloads
 * @param {string} modelId
 * @param {import('../types.js').ModelAvailability | undefined} availability
 * @returns {{ ready: boolean, text: string, label: string }} text: shown;
 *   label: read by screen readers
 */
export function getModelReadiness(modelId, availability) {
  if (availability === 'ready' || availability === 'cached') {
    return { ready: true, text: 'Ready', label: 'Ready' };
  }
  const size = getModelSizeLabel(modelId);
  return { ready: false, text: `↓ ${size}`, label: `Download ${size}` };
}

/**
 * Tooltip of an AI card: the network, its size and license
 * @param {string} modelId
 * @returns {string}
 */
export function getModelTooltip(modelId) {
  const entry = getModelEntry(modelId);
  return `${entry.modelName} · ${getModelSizeLabel(modelId)} · ${entry.license.name}. ${entry.description}.`;
}

/**
 * The inline download question of a model
 * @param {string} modelId
 * @returns {{ title: string, detail: string }}
 */
export function getDownloadPrompt(modelId) {
  const entry = getModelEntry(modelId);
  return {
    title: `Download ${getModelSizeLabel(modelId)}?`,
    detail: `The ${CARD_BY_MODEL[modelId]?.name ?? CARD_BY_MODEL[modelId]?.label ?? entry.label} model (${entry.shortModelName}) runs in this browser. It downloads once and stays on this device; your frames never leave it.`,
  };
}

/**
 * The no-WebGPU warning: the chosen model failed on this browser's WebGPU,
 * an analysis stopped because the browser has none, or it has none
 * @param {{ needsWasmChoice: boolean, webgpuModelFailed: boolean }} status
 * @param {string} modelLabel
 * @returns {string}
 */
export function getWebgpuWarning(status, modelLabel) {
  const slow = 'It can run on the CPU instead, but very slowly (about 14 seconds per frame).';
  if (status.webgpuModelFailed) {
    return `The ${modelLabel} model could not run on WebGPU in this browser. ${slow}`;
  }
  if (status.needsWasmChoice) {
    return `This needs WebGPU, which this browser does not provide. ${slow}`;
  }
  return `WebGPU is not available in this browser. ${slow}`;
}

/**
 * Label of a pick in the list
 * @param {CutoutPick} pick
 * @param {number} fps
 * @returns {string}
 */
export function getPickLabel(pick, fps) {
  return `${pick.mode === 'keep' ? 'Keep' : 'Remove'} at ${frameToTimecode(pick.frame, fps)}`;
}

/**
 * Label of a tracked object in the list
 * @param {CutoutObject} object
 * @param {number} fps
 * @returns {string}
 */
export function getObjectLabel(object, fps) {
  const verb = object.mode === 'remove' ? 'Remove' : 'Keep';
  const frame = object.boxes?.[0]?.frame ?? object.clicks[0]?.frame ?? 0;
  return `${verb} at ${frameToTimecode(frame, fps)}`;
}

/**
 * The status line while a tracked object is being tracked
 * @param {import('../types.js').ObjectTrackingStatus} tracking
 * @returns {string}
 */
export function describeObjectTracking(tracking) {
  if (tracking.phase === 'analyzing') {
    return `Tracking the object: ${tracking.framesDone} of ${tracking.framesTotal} frames`;
  }
  if (
    tracking.phase === 'downloading' ||
    tracking.phase === 'verifying' ||
    tracking.phase === 'initializing'
  ) {
    return describeAnalysisProgress({
      phase: tracking.phase,
      loadedBytes: tracking.loadedBytes ?? 0,
      totalBytes: tracking.totalBytes ?? 0,
      fromCache: tracking.fromCache,
      framesDone: 0,
      framesTotal: 0,
      remainingMs: null,
    });
  }
  return 'Finding the object…';
}

/**
 * The first tracked object with lost frames in the selection (the active
 * one first), with those frames
 * @param {CutoutObject[]} objects
 * @param {Record<string, number[]> | undefined} lost
 * @param {{ start: number, end: number }} range
 * @param {string | null} [activeId]
 * @returns {{ object: CutoutObject, frames: number[] } | null}
 */
export function getLostObject(objects, lost, range, activeId = null) {
  const ordered = [
    ...objects.filter((o) => o.id === activeId),
    ...objects.filter((o) => o.id !== activeId),
  ];
  for (const object of ordered) {
    const frames = (lost?.[object.id] ?? []).filter((f) => f >= range.start && f <= range.end);
    if (frames.length > 0) return { object, frames };
  }
  return null;
}

/**
 * The note about frames where tracking lost a tracked object
 * @param {CutoutObject} object
 * @param {number[]} frames - Sorted, at least one
 * @param {number} fps
 * @returns {string}
 */
export function getObjectLostText(object, frames, fps) {
  const what = object.mode === 'remove' ? 'What you removed' : 'What you kept';
  const first = frameToTimecode(frames[0], fps);
  if (frames.length === 1) return `${what} was lost at ${first}. Click it there to keep going.`;
  return `${what} was lost at ${frames.length} places, first at ${first}. Click it there to keep going.`;
}

/**
 * The AI status line of click to select (the fixed slot above the adjustments)
 * @param {{ running: boolean, pending: number, tracked: number, selection: number, clicks: number, status: import('../types.js').AiCutoutStatus }} info
 *   pending: selection frames without a mask; tracked: selection frames with one;
 *   clicks: picks inside the selection
 * @returns {{ kind: 'running' | 'pending' | 'done' | 'empty' | 'hint', text: string }}
 */
export function describeClickStatus({ running, pending, tracked, selection, clicks, status }) {
  if (running) {
    if (status.phase === 'analyzing') {
      return {
        kind: 'running',
        text: `Tracking ${status.framesDone} of ${status.framesTotal} frames`,
      };
    }
    return { kind: 'running', text: describeAnalysisProgress(status) };
  }
  if (clicks === 0) return { kind: 'hint', text: 'Click the thing you want to keep' };
  const lost = status.lostFrames?.length ?? 0;
  if (lost > 0) {
    return { kind: 'pending', text: `${tracked} of ${selection} frames tracked` };
  }
  if (pending > 0) {
    return { kind: 'pending', text: `${pending} frame${pending === 1 ? '' : 's'} not tracked` };
  }
  return { kind: 'done', text: `Tracked through ${selection} frame${selection === 1 ? '' : 's'}` };
}

/**
 * Frames where the last tracking lost the object that lie in the selection
 * (the selection may have changed since that tracking ran)
 * @param {import('../types.js').AiCutoutStatus | null | undefined} status
 * @param {{ start: number, end: number }} range
 * @returns {number[]}
 */
export function getLostFramesInSelection(status, range) {
  return (status?.lostFrames ?? []).filter((f) => f >= range.start && f <= range.end);
}

/**
 * The note about frames where tracking lost the object
 * @param {number[]} lostFrames
 * @param {number} fps
 * @returns {string} '' when none
 */
export function getLostFramesText(lostFrames, fps) {
  if (lostFrames.length === 0) return '';
  const first = frameToTimecode(lostFrames[0], fps);
  if (lostFrames.length === 1) return `Lost track at ${first}. Click it there to keep going.`;
  return `Lost track at ${lostFrames.length} places, first at ${first}. Click it there to keep going.`;
}

/**
 * The AI status line (the fixed slot above the adjustments)
 * @param {{ running: boolean, pending: number, analyzed: number, total: number, status: import('../types.js').AiCutoutStatus }} info
 * @returns {{ kind: 'running' | 'pending' | 'done' | 'empty', text: string }}
 */
export function describeAiStatus({ running, pending, analyzed, total, status }) {
  if (running) {
    if (status.phase === 'analyzing') {
      return {
        kind: 'running',
        text: `Analyzing ${status.framesDone} of ${status.framesTotal} frames`,
      };
    }
    return { kind: 'running', text: describeAnalysisProgress(status) };
  }
  if (pending > 0) {
    return {
      kind: 'pending',
      text: `${pending} frame${pending === 1 ? '' : 's'} not analyzed`,
    };
  }
  if (total > 0 && analyzed > 0) {
    return { kind: 'done', text: `${analyzed} of ${total} frames analyzed` };
  }
  return { kind: 'empty', text: '' };
}

/** What the About (i) disclosure says */
const ABOUT_TEXT = [
  'Pick what to keep and the rest turns transparent in the GIF.',
  `AI subjects run a model in this browser: it downloads once (plus ${RUNTIME_SIZE_LABEL} for the runtime the first time) and your frames never leave this device. Models: Anime is ISNet anime, Person is MODNet, or RVM (steadier in video, GPL-3.0); Anything is ISNet, or BEN2 (finer hair and edges, a larger download, MIT); Something else is MobileSAM. The others are Apache-2.0. Manage them in Settings.`,
  'Something else: click the thing you want to keep. It is followed through the clip; Keep and Remove add points to fix it.',
  'Solid color removes one backdrop color, such as a green screen.',
  'Hold \\ (or Hold to compare) to see the original; Show mask tints what is removed.',
];

// ------------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------------

/**
 * Inline stroke icon
 * @param {string} paths - SVG children
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
function icon(paths, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(name, value);
  }
  svg.innerHTML = paths;
  return svg;
}

/** Icons of the tool row */
const TOOL_ICONS = {
  keep: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
  remove: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  brush: '<path d="M14.5 4.5l5 5L10 19H5v-5z"/><path d="M12.5 6.5l5 5"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>',
  eyedropper:
    '<path d="M15 4.5a2.1 2.1 0 0 1 3 3L16 9.5l1 1-1.5 1.5-5-5L12 5.5l1 1z"/><path d="M11 8l-6 6v3h3l6-6"/>',
};

/**
 * Checkbox styled as a tool button (label wraps it)
 * @param {string} id
 * @param {string} label
 * @param {keyof typeof TOOL_ICONS} iconName
 * @param {Record<string, string>} [attrs]
 * @returns {{ wrapper: HTMLElement, input: HTMLInputElement }}
 */
function toolToggle(id, label, iconName, attrs = {}) {
  const input = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'checkbox',
      id,
      className: 'editor-cutout-tool-input',
      ...attrs,
    })
  );
  const wrapper = createElement(
    'label',
    { className: 'editor-cutout-tool', for: id, 'data-tool': iconName },
    [input, createElement('span', {}, [icon(TOOL_ICONS[iconName], 16), label])],
  );
  return { wrapper, input };
}

/**
 * Range slider with end labels (Tighter … Looser)
 * @param {{ id: string, label: string, min: number, max: number, left: string, right: string }} options
 * @returns {{ row: HTMLElement, input: HTMLInputElement }}
 */
function endLabelSlider({ id, label, min, max, left, right }) {
  const input = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      id,
      min: String(min),
      max: String(max),
      step: '1',
      className: 'editor-cutout-range',
    })
  );
  const row = createElement('div', { className: 'editor-cutout-slider' }, [
    createElement('label', { className: 'editor-cutout-label', for: id }, [label]),
    input,
    createElement('div', { className: 'editor-cutout-ends', 'aria-hidden': 'true' }, [
      createElement('span', {}, [left]),
      createElement('span', {}, [right]),
    ]),
  ]);
  return { row, input };
}

/**
 * Whether a control was reached or used with the keyboard (it matches
 * :focus-visible; a mouse click on a checkbox does not)
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isKeyboardFocused(el) {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Render
// ------------------------------------------------------------------

/**
 * Render the Background panel (the sidebar's Background tab)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderBackgroundPanel(handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // --- Heading with the About (i) disclosure ---
  const about = createElement(
    'details',
    { className: 'editor-cutout-about', id: 'background-about' },
    [
      createElement(
        'summary',
        { className: 'editor-cutout-about-summary', 'aria-label': 'About background removal' },
        ['i'],
      ),
      createElement(
        'div',
        { className: 'editor-cutout-about-body' },
        ABOUT_TEXT.map((text) => createElement('p', {}, [text])),
      ),
    ],
  );
  const heading = createElement('div', { className: 'editor-cutout-head' }, [
    createElement('h2', { className: 'editor-cutout-title', id: 'background-subject-title' }, [
      'What do you want to keep?',
    ]),
    about,
  ]);

  // --- Subject: Off + four cards, one radio group ---
  /**
   * @param {Subject} value
   * @param {HTMLElement[]} content
   * @param {string} className
   * @param {Record<string, string>} [attrs]
   */
  const subjectOption = (value, content, className, attrs = {}) => {
    const id = `subject-${value}`;
    const input = /** @type {HTMLInputElement} */ (
      createElement('input', {
        type: 'radio',
        name: 'background-subject',
        id,
        value,
        className: 'editor-cutout-radio',
        ...attrs,
      })
    );
    cleanups.push(
      on(input, 'change', () => {
        if (input.checked) handlers.onChooseSubject?.(value);
      }),
    );
    return createElement('label', { className, for: id, 'data-subject': value }, [
      input,
      createElement('span', { className: 'editor-cutout-option-body' }, content),
    ]);
  };

  const offOption = subjectOption(
    'none',
    [
      createElement('span', { className: 'editor-cutout-off-label' }, ['Off']),
      createElement('span', { className: 'editor-cutout-off-hint' }, ['Keep the whole frame']),
    ],
    'editor-cutout-off',
  );

  const cards = SUBJECT_CARDS.map((card) => {
    const statusId = `subject-status-${card.value}`;
    const content = [
      createElement('span', { className: 'editor-cutout-card-icon' }, [icon(card.icon, 17)]),
      createElement('span', { className: 'editor-cutout-card-label' }, [card.label]),
      createElement('span', { className: 'editor-cutout-card-hint' }, [card.hint]),
    ];
    if (card.model) {
      content.push(
        createElement('span', { className: 'editor-cutout-card-status', id: statusId }, [
          createElement('span', { className: 'editor-cutout-card-status-text' }),
          createElement('span', { className: 'sr-only editor-cutout-card-status-label' }),
        ]),
      );
    }
    const option = subjectOption(
      card.value,
      content,
      'editor-cutout-card',
      card.model ? { 'aria-describedby': statusId } : {},
    );
    if (card.model) option.title = getModelTooltip(card.model);
    return option;
  });

  const subject = createElement(
    'fieldset',
    {
      className: 'editor-cutout-subject',
      id: 'background-subject',
      'aria-labelledby': 'background-subject-title',
    },
    [offOption, createElement('div', { className: 'editor-cutout-cards' }, cards)],
  );

  // --- Inline download question ---
  const downloadConfirm = createElement(
    'button',
    { type: 'button', id: 'background-download-confirm', className: 'btn btn-primary' },
    ['Download'],
  );
  const downloadCancel = createElement(
    'button',
    { type: 'button', id: 'background-download-cancel', className: 'btn btn-ghost' },
    ['Cancel'],
  );
  cleanups.push(
    on(downloadConfirm, 'click', () => handlers.onConfirmModelDownload?.()),
    on(downloadCancel, 'click', () => handlers.onCancelModelDownload?.()),
  );
  const download = createElement(
    'div',
    {
      className: 'editor-cutout-download',
      id: 'background-download',
      role: 'group',
      'aria-labelledby': 'background-download-title',
      hidden: 'true',
    },
    [
      createElement('p', {
        className: 'editor-cutout-download-title',
        id: 'background-download-title',
      }),
      createElement('p', {
        className: 'editor-cutout-download-detail',
        id: 'background-download-detail',
      }),
      createElement('div', { className: 'editor-cutout-download-actions' }, [
        downloadConfirm,
        downloadCancel,
      ]),
    ],
  );

  // --- AI settings ---
  const statusText = createElement('span', {
    className: 'editor-cutout-status-text',
    id: 'ai-status-text',
  });
  const progressBar = /** @type {HTMLProgressElement} */ (
    createElement('progress', {
      id: 'ai-progress-bar',
      className: 'editor-cutout-progress',
      max: '1',
      value: '0',
      'aria-labelledby': 'ai-status-text',
      hidden: 'true',
    })
  );
  const cancelBtn = createElement(
    'button',
    {
      type: 'button',
      id: 'ai-cancel',
      className: 'editor-cutout-status-btn',
      'aria-label': 'Cancel analysis',
      hidden: 'true',
    },
    ['Cancel'],
  );
  cleanups.push(on(cancelBtn, 'click', () => handlers.onAiCancel?.()));
  const analyzeBtn = createElement(
    'button',
    { type: 'button', id: 'ai-analyze', className: 'editor-cutout-status-btn', hidden: 'true' },
    ['Analyze'],
  );
  cleanups.push(on(analyzeBtn, 'click', () => handlers.onAiAnalyze?.()));
  // Fixed height: its content changes, its size never does (no layout
  // shift under a slider being dragged). A live region for the outcome
  // lines; progress is announced by the tab badge and the bar.
  const statusSlot = createElement(
    'div',
    { className: 'editor-cutout-status', id: 'ai-status', 'data-kind': 'empty' },
    [
      createElement('div', { className: 'editor-cutout-status-row' }, [
        createElement('span', { className: 'editor-cutout-status-dot', 'aria-hidden': 'true' }),
        statusText,
        analyzeBtn,
        cancelBtn,
      ]),
      progressBar,
    ],
  );

  const notice = createElement('p', {
    className: 'editor-cutout-note',
    id: 'ai-notice',
    role: 'status',
  });

  const wasmBtn = createElement(
    'button',
    { type: 'button', id: 'ai-run-wasm', className: 'btn btn-secondary editor-cutout-block-btn' },
    ['Run on the CPU (very slow)'],
  );
  cleanups.push(on(wasmBtn, 'click', () => handlers.onAiAllowWasm?.()));
  const warning = createElement(
    'div',
    {
      className: 'editor-cutout-alert editor-cutout-alert--warn',
      id: 'ai-webgpu-warning',
      role: 'note',
      hidden: 'true',
    },
    [createElement('p', { id: 'ai-webgpu-warning-text' }), wasmBtn],
  );

  const wasmNote = createElement(
    'p',
    { className: 'editor-cutout-note', id: 'ai-wasm-note', hidden: 'true' },
    ['Running on the CPU: about 14 seconds per frame.'],
  );

  const retryBtn = createElement(
    'button',
    { type: 'button', id: 'ai-retry', className: 'btn btn-secondary editor-cutout-block-btn' },
    ['Try again'],
  );
  cleanups.push(on(retryBtn, 'click', () => handlers.onAiAnalyze?.()));
  const errorBox = createElement(
    'div',
    {
      className: 'editor-cutout-alert editor-cutout-alert--error',
      id: 'ai-error',
      role: 'alert',
      hidden: 'true',
    },
    [createElement('p', { id: 'ai-error-text' }), retryBtn],
  );

  const fit = endLabelSlider({
    id: 'ai-fit',
    label: 'Fit',
    min: -FIT_STEPS,
    max: FIT_STEPS,
    left: 'Tighter',
    right: 'Looser',
  });
  // input: live (per-frame drafts while dragging); change: the release
  const fitParams = () => aiFromFit(Number(fit.input.value));
  cleanups.push(
    on(fit.input, 'input', () => handlers.onSetAiParams?.(fitParams(), { live: true })),
    on(fit.input, 'change', () => handlers.onSetAiParams?.(fitParams())),
  );

  const smoothing = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'checkbox',
      id: 'ai-smoothing',
      className: 'editor-cutout-switch',
    })
  );
  cleanups.push(
    on(smoothing, 'change', () => handlers.onSetAiParams?.({ smoothing: smoothing.checked })),
  );
  const smoothingRow = createElement(
    'label',
    { className: 'editor-cutout-check', for: 'ai-smoothing' },
    [smoothing, createElement('span', {}, ['Reduce flicker between frames'])],
  );

  // --- Clean up: one-tap fixes found in the last build (at most 4 chips) ---
  const cleanupList = createElement('ul', {
    id: 'ai-cleanup-list',
    className: 'editor-cutout-picks',
    'aria-labelledby': 'ai-cleanup-title',
  });
  const cleanupGroup = createElement('div', { id: 'ai-cleanup', hidden: 'true' }, [
    createElement('h3', { className: 'editor-cutout-label', id: 'ai-cleanup-title' }, ['Clean up']),
    cleanupList,
  ]);
  cleanups.push(
    on(cleanupList, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const item = target?.closest('[data-cleanup]');
      if (!(item instanceof HTMLElement) || !target?.closest('button')) return;
      const chip = cleanupChips.get(cleanupList)?.[Number(item.dataset.index)];
      if (!chip) return;
      if (chip.applied) handlers.onClearCleanup?.(/** @type {'specks' | 'holes'} */ (chip.kind));
      else if (chip.suggestion) handlers.onApplyCleanup?.(chip.suggestion);
    }),
  );

  // --- Click to select: Whole / Part and the frames that need a click ---
  const scopes = /** @type {const} */ ([
    { value: 'whole', label: 'Whole', title: 'The whole thing you clicked' },
    { value: 'part', label: 'Part', title: 'Only the part under the click' },
  ]);
  const clickScope = createElement(
    'fieldset',
    {
      className: 'editor-cutout-segmented-group click-select-scope',
      id: 'ai-click-scope',
      hidden: 'true',
    },
    [
      createElement('legend', { className: 'editor-cutout-label' }, ['Select']),
      createElement(
        'div',
        { className: 'editor-cutout-segmented' },
        scopes.map(({ value, label, title }) => {
          const id = `ai-click-scope-${value}`;
          const input = /** @type {HTMLInputElement} */ (
            createElement('input', { type: 'radio', name: 'ai-click-scope', id, value })
          );
          cleanups.push(
            on(input, 'change', () => {
              if (input.checked) handlers.onSetAiParams?.({ clickScope: value });
            }),
          );
          return createElement('label', { className: 'editor-cutout-segment', for: id, title }, [
            input,
            createElement('span', {}, [label]),
          ]);
        }),
      ),
    ],
  );
  const lostGo = createElement(
    'button',
    { type: 'button', id: 'ai-click-lost-go', className: 'editor-cutout-status-btn' },
    ['Go there'],
  );
  cleanups.push(on(lostGo, 'click', () => handlers.onGoToLostFrame?.()));
  const clickLost = createElement(
    'div',
    {
      className: 'editor-cutout-alert editor-cutout-alert--warn click-select-lost',
      id: 'ai-click-lost',
      role: 'status',
      hidden: 'true',
    },
    [createElement('p', { id: 'ai-click-lost-text' }), lostGo],
  );
  // Model: shown when the subject can use several (Person, Anything)
  const modelSelect = /** @type {HTMLSelectElement} */ (
    createElement('select', { id: 'ai-model', className: 'editor-cutout-select' })
  );
  cleanups.push(on(modelSelect, 'change', () => handlers.onChooseModel?.(modelSelect.value)));
  const modelRow = createElement(
    'div',
    { className: 'editor-cutout-model', id: 'ai-model-row', hidden: 'true' },
    [
      createElement('label', { className: 'editor-cutout-label', for: 'ai-model' }, ['Model']),
      modelSelect,
      createElement('p', { className: 'editor-cutout-model-hint', id: 'ai-model-hint' }),
    ],
  );

  const aiSection = createElement(
    'div',
    { className: 'editor-cutout-section', id: 'ai-section', hidden: 'true' },
    [
      modelRow,
      statusSlot,
      clickScope,
      clickLost,
      warning,
      wasmNote,
      errorBox,
      notice,
      fit.row,
      smoothingRow,
      cleanupGroup,
    ],
  );

  // --- Color settings ---
  const colorInput = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'color',
      id: 'background-color',
      className: 'editor-cutout-swatch',
    })
  );
  cleanups.push(
    on(colorInput, 'input', () => handlers.onSetBackground?.({ color: colorInput.value })),
  );
  const colorHex = createElement('output', {
    className: 'editor-cutout-hex',
    id: 'background-color-hex',
    for: 'background-color',
  });
  const pick = toolToggle('background-pick', 'Pick', 'eyedropper', {
    'aria-label': 'Pick the color from the preview',
  });
  cleanups.push(
    on(pick.input, 'change', () => handlers.onSetPickingKeyColor?.(pick.input.checked)),
  );
  const colorRow = createElement('div', { className: 'editor-cutout-color' }, [
    createElement('label', { className: 'editor-cutout-label', for: 'background-color' }, [
      'Color to remove',
    ]),
    createElement('div', { className: 'editor-cutout-color-row' }, [
      colorInput,
      colorHex,
      pick.wrapper,
    ]),
  ]);

  const tolerance = endLabelSlider({
    id: 'background-tolerance',
    label: 'Similar colors',
    min: EDIT_LIMITS.tolerance.min,
    max: EDIT_LIMITS.tolerance.max,
    left: 'Fewer',
    right: 'More',
  });
  cleanups.push(
    on(tolerance.input, 'input', () =>
      handlers.onSetBackground?.({ tolerance: Number(tolerance.input.value) }),
    ),
  );

  const modes = /** @type {const} */ ([
    {
      value: 'connected',
      label: 'Edges only',
      title: 'Only the backdrop touching the frame edges',
    },
    {
      value: 'global',
      label: 'Everywhere',
      title: 'Every matching pixel, also inside the subject',
    },
  ]);
  const modeGroup = createElement(
    'fieldset',
    { className: 'editor-cutout-segmented-group', id: 'background-mode' },
    [
      createElement('legend', { className: 'editor-cutout-label' }, ['Remove']),
      createElement(
        'div',
        { className: 'editor-cutout-segmented' },
        modes.map(({ value, label, title }) => {
          const id = `background-mode-${value}`;
          const input = /** @type {HTMLInputElement} */ (
            createElement('input', { type: 'radio', name: 'background-mode', id, value })
          );
          cleanups.push(
            on(input, 'change', () => {
              if (input.checked) handlers.onSetBackground?.({ mode: value });
            }),
          );
          return createElement('label', { className: 'editor-cutout-segment', for: id, title }, [
            input,
            createElement('span', {}, [label]),
          ]);
        }),
      ),
    ],
  );

  const colorSection = createElement(
    'div',
    { className: 'editor-cutout-section', id: 'color-section', hidden: 'true' },
    [colorRow, tolerance.row, modeGroup],
  );

  // --- Fix-ups: tools on the preview ---
  const keep = toolToggle('ai-pick-keep', 'Keep', 'keep', {
    'aria-describedby': 'background-tools-hint',
  });
  const remove = toolToggle('ai-pick-remove', 'Remove', 'remove', {
    'aria-describedby': 'background-tools-hint',
  });
  cleanups.push(
    on(keep.input, 'change', () =>
      handlers.onSetAiPickTool?.(keep.input.checked ? 'keep' : null, {
        fromKeyboard: isKeyboardFocused(keep.input),
      }),
    ),
    on(remove.input, 'change', () =>
      handlers.onSetAiPickTool?.(remove.input.checked ? 'remove' : null, {
        fromKeyboard: isKeyboardFocused(remove.input),
      }),
    ),
  );
  const objectScope = createElement(
    'fieldset',
    { className: 'editor-cutout-segmented-group', id: 'ai-object-scope', hidden: 'true' },
    [
      createElement('legend', { className: 'editor-cutout-label' }, ['Object']),
      createElement(
        'div',
        { className: 'editor-cutout-segmented' },
        scopes.map(({ value, label, title }) => {
          const id = `ai-object-scope-${value}`;
          const input = /** @type {HTMLInputElement} */ (
            createElement('input', { type: 'radio', name: 'ai-object-scope', id, value })
          );
          cleanups.push(
            on(input, 'change', () => {
              if (input.checked) handlers.onSetAiObjectScope?.(value);
            }),
          );
          return createElement('label', { className: 'editor-cutout-segment', for: id, title }, [
            input,
            createElement('span', {}, [label]),
          ]);
        }),
      ),
    ],
  );
  const objectLostGo = createElement(
    'button',
    { type: 'button', id: 'ai-object-lost-go', className: 'editor-cutout-status-btn' },
    ['Go there'],
  );
  cleanups.push(
    on(objectLostGo, 'click', () => {
      const id = objectLostGo.dataset.objectId;
      if (id) handlers.onGoToObjectLost?.(id);
    }),
  );
  const objectLost = createElement(
    'div',
    {
      className: 'editor-cutout-alert editor-cutout-alert--warn',
      id: 'ai-object-lost',
      role: 'status',
      hidden: 'true',
    },
    [createElement('p', { id: 'ai-object-lost-text' }), objectLostGo],
  );

  const brush = toolToggle('touchup-brush', 'Brush', 'brush', {
    'aria-describedby': 'touchup-entry-summary',
  });
  cleanups.push(
    on(brush.input, 'change', () => handlers.onSetBrush?.({ on: brush.input.checked })),
  );
  const reset = createElement(
    'button',
    {
      type: 'button',
      id: 'background-reset',
      className: 'editor-cutout-tool editor-cutout-tool--button',
      title: 'Reset the adjustments, picks, objects and brush strokes',
    },
    [createElement('span', {}, [icon(TOOL_ICONS.reset, 16), 'Reset'])],
  );
  cleanups.push(on(reset, 'click', () => handlers.onResetBackground?.()));

  const pickList = createElement('ul', {
    id: 'ai-pick-list',
    className: 'editor-cutout-picks',
    'aria-label': 'Fix-ups',
  });
  /** @param {EventTarget | null} node */
  const objectIdOf = (node) => {
    const item = node instanceof Element ? node.closest('[data-object-id]') : null;
    return item instanceof HTMLElement ? (item.dataset.objectId ?? null) : null;
  };
  /** @type {string | null} */
  let highlighted = null;
  /** @param {string | null} id */
  const highlight = (id) => {
    if (id === highlighted) return;
    highlighted = id;
    handlers.onHighlightAiObject?.(id);
  };
  cleanups.push(
    on(pickList, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const objectId = objectIdOf(target);
      if (objectId) {
        if (target?.closest('.editor-cutout-pick-delete')) {
          handlers.onRemoveAiObject?.(objectId);
        } else if (target?.closest('.editor-cutout-pick-go')) {
          handlers.onGoToObject?.(objectId);
        }
        return;
      }
      const item = target?.closest('[data-pick-index]');
      if (!(item instanceof HTMLElement)) return;
      const index = Number(item.dataset.pickIndex);
      if (target?.closest('.editor-cutout-pick-delete')) {
        handlers.onRemoveAiPick?.(index);
      } else if (target?.closest('.editor-cutout-pick-go')) {
        handlers.onFrameChange(Number(item.dataset.pickFrame));
      }
    }),
    // Hovering or focusing a tracked fix-up's chip shows its region on the frame
    on(pickList, 'mouseover', (e) => highlight(objectIdOf(e.target))),
    on(pickList, 'mouseleave', () =>
      highlight(
        objectIdOf(pickList.contains(document.activeElement) ? document.activeElement : null),
      ),
    ),
    on(pickList, 'focusin', (e) => highlight(objectIdOf(e.target))),
    on(pickList, 'focusout', (e) =>
      highlight(
        objectIdOf(
          pickList.contains(/** @type {Node | null} */ (e.relatedTarget)) ? e.relatedTarget : null,
        ),
      ),
    ),
  );

  const tools = createElement(
    'div',
    {
      className: 'editor-cutout-fixes',
      id: 'background-tools',
      role: 'group',
      'aria-labelledby': 'background-tools-title',
    },
    [
      createElement('h3', { className: 'editor-cutout-label', id: 'background-tools-title' }, [
        'Fix-ups',
      ]),
      createElement('div', { className: 'editor-cutout-tools' }, [
        keep.wrapper,
        remove.wrapper,
        brush.wrapper,
        reset,
      ]),
      createElement('p', { className: 'editor-cutout-note', id: 'background-tools-hint' }),
      pickList,
      objectScope,
      objectLost,
      createElement('p', { className: 'editor-cutout-note', id: 'touchup-entry-summary' }),
    ],
  );

  const alphaNote = createElement(
    'p',
    { className: 'editor-cutout-note', id: 'background-alpha-note', hidden: 'true' },
    ['This clip already has transparent areas. They stay transparent in the GIF.'],
  );

  const settings = createElement(
    'div',
    { className: 'editor-cutout-settings', id: 'background-settings', hidden: 'true' },
    [aiSection, colorSection, tools],
  );

  const element = createElement(
    'div',
    { className: 'property-group editor-cutout-panel', 'data-edits-panel': 'background' },
    [heading, subject, download, settings, alphaNote],
  );

  return { element, cleanups };
}

// ------------------------------------------------------------------
// Update
// ------------------------------------------------------------------

/**
 * @template {Element} T
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {T}
 */
function q(root, selector) {
  return /** @type {T} */ (root.querySelector(selector));
}

/**
 * @param {Element} el
 * @param {string} text
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * @param {HTMLInputElement} input
 * @param {string} value
 */
function setValue(input, value) {
  if (input.value !== value) input.value = value;
}

/**
 * @param {HTMLInputElement} input
 * @param {boolean} checked
 */
function setChecked(input, checked) {
  if (input.checked !== checked) input.checked = checked;
}

/**
 * @param {Element} el
 * @param {boolean} hidden
 */
function setHidden(el, hidden) {
  const node = /** @type {HTMLElement} */ (el);
  if (node.hidden !== hidden) node.hidden = hidden;
}

/**
 * Rebuild the fix-up list: the picks, then the tracked fix-ups with their
 * colour (small: at most 16 + 4 items). Keeps focus inside the list when
 * the focused item goes away.
 * @param {HTMLElement} list
 * @param {CutoutPick[]} picks
 * @param {CutoutObject[]} objects
 * @param {string | null} selectedId - The tracked fix-up being corrected
 * @param {number} fps
 * @param {HTMLElement} fallbackFocus
 */
function updatePickList(list, picks, objects, selectedId, fps, fallbackFocus) {
  const signature = [
    selectedId,
    ...picks.map((p) => `${p.frame}:${p.x}:${p.y}:${p.mode}`),
    ...objects.map((o) => `${o.id}:${o.mode}:${getObjectLabel(o, fps)}`),
  ].join('|');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const focused = document.activeElement;
  const hadFocus = focused instanceof HTMLElement && list.contains(focused);
  const focusedItem = hadFocus ? /** @type {HTMLElement | null} */ (focused.closest('li')) : null;
  const focusedKey = focusedItem?.dataset.objectId ?? focusedItem?.dataset.pickIndex;
  const focusedIndex = focusedItem ? [...list.children].indexOf(focusedItem) : -1;
  const focusedGo = hadFocus && Boolean(focused.closest('.editor-cutout-pick-go'));
  /**
   * @param {string} className
   * @param {Record<string, string>} data
   * @param {string} label
   * @param {string} deleteLabel
   * @param {{ color: string, active: boolean } | null} tracked
   */
  const chip = (className, data, label, deleteLabel, tracked) =>
    createElement(
      'li',
      { className: `${className}${tracked?.active ? ' is-active' : ''}`, ...data },
      [
        createElement(
          'button',
          {
            type: 'button',
            className: 'editor-cutout-pick-go',
            'aria-label': `${label} (go to frame)`,
            ...(tracked ? { 'aria-pressed': tracked.active ? 'true' : 'false' } : {}),
          },
          tracked
            ? [
                createElement('span', {
                  className: 'editor-cutout-pick-swatch',
                  style: `--swatch: ${tracked.color}`,
                  'aria-hidden': 'true',
                }),
                label,
              ]
            : [label],
        ),
        createElement(
          'button',
          { type: 'button', className: 'editor-cutout-pick-delete', 'aria-label': deleteLabel },
          ['×'],
        ),
      ],
    );
  list.replaceChildren(
    ...picks.map((pick, index) => {
      const label = getPickLabel(pick, fps);
      return chip(
        `editor-cutout-pick editor-cutout-pick--${pick.mode}`,
        { 'data-pick-index': String(index), 'data-pick-frame': String(pick.frame) },
        label,
        `Delete: ${label}`,
        null,
      );
    }),
    ...objects.map((object) => {
      const label = getObjectLabel(object, fps);
      return chip(
        `editor-cutout-pick editor-cutout-pick--${object.mode === 'remove' ? 'remove' : 'keep'}`,
        { 'data-object-id': object.id },
        label,
        `Delete: ${label}`,
        { color: getObjectColor(objects, object.id), active: object.id === selectedId },
      );
    }),
  );
  if (hadFocus) {
    const items = [...list.children];
    const same = items.find((li) => {
      const d = /** @type {HTMLElement} */ (li).dataset;
      return (d.objectId ?? d.pickIndex) === focusedKey;
    });
    const item = same ?? items[Math.min(focusedIndex, items.length - 1)];
    const target =
      item?.querySelector(
        same && focusedGo ? '.editor-cutout-pick-go' : '.editor-cutout-pick-delete',
      ) ?? fallbackFocus;
    if (target instanceof HTMLElement) target.focus();
  }
}

/**
 * @typedef {Object} CleanupChip
 * @property {CleanupSuggestion['kind']} kind
 * @property {string} label
 * @property {boolean} applied - A clean-up that is on (tapping turns it off)
 * @property {CleanupSuggestion | null} suggestion - What tapping applies
 */

/**
 * The chips of each Clean up list's most recent update (its click handler
 * reads them)
 * @type {WeakMap<HTMLElement, CleanupChip[]>}
 */
const cleanupChips = new WeakMap();

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The Clean up chips: the clean-ups that are on (checked), then the
 * suggestions for what is off (a blob suggestion only where picks select
 * pieces, not with click to select), at most MAX_SUGGESTIONS
 * @param {AiCutout} ai
 * @param {CleanupSuggestion[]} suggestions
 * @returns {CleanupChip[]}
 */
export function getCleanupChips(ai, suggestions) {
  /** @type {CleanupChip[]} */
  const chips = [];
  const cleanup = ai.cleanup ?? { minIslandArea: 0, maxHoleArea: 0 };
  if (cleanup.minIslandArea > 0) {
    chips.push({
      kind: 'specks',
      label: 'Specks removed · every frame',
      applied: true,
      suggestion: null,
    });
  }
  if (cleanup.maxHoleArea > 0) {
    chips.push({
      kind: 'holes',
      label: 'Small holes filled · every frame',
      applied: true,
      suggestion: null,
    });
  }
  for (const s of suggestions) {
    if (s.kind === 'specks' && cleanup.minIslandArea > 0) continue;
    if (s.kind === 'holes' && cleanup.maxHoleArea > 0) continue;
    if (s.kind === 'blob' && ai.model === 'click') continue;
    const label =
      s.kind === 'specks'
        ? `Remove ${plural(s.count, 'speck', 'specks')} · every frame`
        : s.kind === 'holes'
          ? `Fill ${plural(s.count, 'small hole', 'small holes')} · every frame`
          : s.kind === 'blob'
            ? `Remove blob near ${s.where} · on ${plural(s.frames, 'frame', 'frames')}`
            : `Check ${plural(s.frames, 'frame', 'frames')} where the character shrinks`;
    chips.push({ kind: s.kind, label, applied: false, suggestion: s });
  }
  return chips.slice(0, MAX_SUGGESTIONS);
}

/**
 * @param {HTMLElement} list
 * @param {CleanupChip[]} chips
 */
function updateCleanupList(list, chips) {
  cleanupChips.set(list, chips);
  const signature = chips.map((c) => `${c.applied ? 1 : 0}:${c.label}`).join('|');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.replaceChildren(
    ...chips.map((chip, index) =>
      createElement(
        'li',
        {
          className: `editor-cutout-pick editor-cutout-pick--${chip.kind === 'shrink' ? 'keep' : 'remove'}${chip.applied ? ' is-active' : ''}`,
          'data-cleanup': chip.kind,
          'data-index': String(index),
        },
        [
          createElement(
            'button',
            {
              type: 'button',
              className: 'editor-cutout-pick-go',
              ...(chip.kind === 'specks' || chip.kind === 'holes'
                ? { 'aria-pressed': chip.applied ? 'true' : 'false' }
                : {}),
            },
            [chip.label],
          ),
        ],
      ),
    ),
  );
}

/**
 * Whether Reset has anything to do for the current method
 * @param {import('../types.js').EditorState} state
 * @returns {boolean}
 */
export function canResetBackground(state) {
  const { background, touchUps } = state.edits;
  if (touchUps.length > 0) return true;
  if (background.method === 'ai') {
    const { ai } = background;
    const defaults = createDefaultAiCutout();
    return (
      ai.picks.length > 0 ||
      (ai.objects?.length ?? 0) > 0 ||
      // Whole / Part only shows (and counts) with click to select
      (getAiModelId(ai) === 'click' && ai.clickScope !== defaults.clickScope) ||
      ai.threshold !== defaults.threshold ||
      ai.edge !== defaults.edge ||
      ai.smoothing !== defaults.smoothing
    );
  }
  const defaults = createDefaultEdits().background;
  return (
    background.tolerance !== defaults.tolerance ||
    background.mode !== defaults.mode ||
    background.colorChosen
  );
}

/**
 * Apply the editor state to the Background panel in place
 * @param {ParentNode} container - The panel root or an ancestor of it
 * @param {import('../types.js').EditorState} state
 * @param {number} fps
 */
export function updateBackgroundPanel(container, state, fps) {
  const root = /** @type {HTMLElement | null} */ (
    container.querySelector('[data-edits-panel="background"]')
  );
  if (!root || !state.edits) return;
  const focused = document.activeElement;
  const { background } = state.edits;
  const status = state.aiCutout;
  const subject = getSubject(background);
  const prompt = state.downloadPrompt ?? null;
  const promptCard = prompt ? CARD_BY_MODEL[prompt]?.value : null;
  const shown = /** @type {Subject} */ (promptCard ?? subject);
  /** @type {SubjectModelPrefs} */
  const modelPrefs = { remembered: getRememberedModels(), availability: status?.models ?? null };

  // Subject radios (the card being asked about looks chosen while asked)
  for (const value of ['none', ...SUBJECT_CARDS.map((c) => c.value)]) {
    setChecked(q(root, `#subject-${value}`), value === shown);
  }
  for (const card of SUBJECT_CARDS) {
    if (!card.model) continue;
    // The model the card would use (the prompt's while it is asked about)
    const model =
      promptCard === card.value && prompt
        ? prompt
        : /** @type {string} */ (getSubjectModel(card.value, background.ai, modelPrefs));
    const readiness = getModelReadiness(model, status?.models?.[model]);
    const option = q(root, `label[data-subject="${card.value}"]`);
    const tooltip = getModelTooltip(model);
    if (option.title !== tooltip) option.title = tooltip;
    const el = q(root, `#subject-status-${card.value}`);
    el.setAttribute('data-ready', String(readiness.ready));
    setText(q(el, '.editor-cutout-card-status-text'), readiness.text);
    setText(q(el, '.editor-cutout-card-status-label'), `, ${readiness.label}`);
  }

  // Download question
  const download = q(root, '#background-download');
  setHidden(download, !prompt);
  if (prompt) {
    const copy = getDownloadPrompt(prompt);
    setText(q(root, '#background-download-title'), copy.title);
    setText(q(root, '#background-download-detail'), copy.detail);
  }

  const on = background.enabled === true && !prompt;
  setHidden(q(root, '#background-settings'), !on);
  const isAi = background.method === 'ai';
  setHidden(q(root, '#ai-section'), !isAi);
  setHidden(q(root, '#color-section'), isAi);

  // Color key
  setValue(q(root, '#background-color'), background.color);
  setText(q(root, '#background-color-hex'), background.color.toUpperCase());
  const pick = /** @type {HTMLInputElement} */ (q(root, '#background-pick'));
  setChecked(pick, state.pickingKeyColor);
  pick.closest('.editor-cutout-tool')?.classList.toggle('is-active', state.pickingKeyColor);
  const tolerance = /** @type {HTMLInputElement} */ (q(root, '#background-tolerance'));
  setValue(tolerance, String(Math.round(background.tolerance)));
  tolerance.setAttribute('aria-valuetext', String(Math.round(background.tolerance)));
  setChecked(q(root, '#background-mode-connected'), background.mode !== 'global');
  setChecked(q(root, '#background-mode-global'), background.mode === 'global');

  // AI
  if (isAi && status) updateAiSettings(root, state, fps);

  // Fix-up tools: Keep/Remove with the AI only; they make picks and tracked
  // fix-ups, so only both lists full (and nothing selected to correct)
  // turns them off
  const { ai } = background;
  const objects = ai.objects ?? [];
  const full = ai.picks.length >= EDIT_LIMITS.aiPicks.max;
  const objectsFull = objects.length >= EDIT_LIMITS.aiObjects.max;
  const correcting = Boolean(state.aiActiveObjectId && state.aiPickTool);
  for (const mode of /** @type {const} */ (['keep', 'remove'])) {
    const input = /** @type {HTMLInputElement} */ (q(root, `#ai-pick-${mode}`));
    const label = /** @type {HTMLElement} */ (input.closest('.editor-cutout-tool'));
    setHidden(label, !isAi);
    setChecked(input, state.aiPickTool === mode);
    input.disabled = full && objectsFull && !correcting && state.aiPickTool !== mode;
    label.classList.toggle('is-active', state.aiPickTool === mode);
  }

  const brushLabel = q(root, '#touchup-brush').closest('.editor-cutout-tool');
  brushLabel?.classList.toggle('is-active', state.brush?.on === true);
  /** @type {HTMLButtonElement} */ (q(root, '#background-reset')).disabled =
    !canResetBackground(state);

  const click = isAi && getAiModelId(ai) === 'click';
  const samReady = getModelReadiness('click', status?.models?.click).ready;
  let toolsHint = '';
  if (isAi && !click && state.aiPickTool && !samReady) {
    toolsHint = `Fix-ups on the subject and boxes are tracked with MobileSAM: the first one downloads ${getModelSizeLabel('click')}.`;
  } else if (isAi && objectsFull && !correcting) {
    toolsHint = `The limit of ${EDIT_LIMITS.aiObjects.max} tracked fix-ups is reached. Delete one to add another.`;
  } else if (isAi && full) {
    toolsHint = `The limit of ${EDIT_LIMITS.aiPicks.max} picks is reached. Remove one to add another.`;
  } else if (click && ai.picks.length === 0) {
    toolsHint = 'Click the thing you want to keep in the preview.';
  } else if (click) {
    toolsHint = 'Keep or Remove adds a point to fix the selection.';
  } else if (isAi && ai.picks.length === 0 && state.aiPickTool === null) {
    toolsHint = 'Keep or Remove, then click a character in the preview.';
  }
  setText(q(root, '#background-tools-hint'), toolsHint);

  // Click to select: Whole / Part once something is selected, lost frames
  const scope = q(root, '#ai-click-scope');
  setHidden(scope, !(click && ai.picks.length > 0));
  setChecked(q(root, '#ai-click-scope-whole'), ai.clickScope !== 'part');
  setChecked(q(root, '#ai-click-scope-part'), ai.clickScope === 'part');
  const lostFrames = click ? getLostFramesInSelection(status, state.selectedRange) : [];
  const lostText = isAnalysisRunning(status?.phase ?? 'idle')
    ? ''
    : getLostFramesText(lostFrames, fps);
  setHidden(q(root, '#ai-click-lost'), lostText === '');
  setText(q(root, '#ai-click-lost-text'), lostText);

  // Every fix-up, pick or tracked, in one list; the selected one is marked
  const list = /** @type {HTMLElement} */ (q(root, '#ai-pick-list'));
  const selectedId = state.aiPickTool ? state.aiActiveObjectId : null;
  updatePickList(
    list,
    isAi ? ai.picks : [],
    isAi ? objects : [],
    selectedId,
    fps,
    q(root, '#ai-pick-keep'),
  );
  setHidden(list, !isAi || (ai.picks.length === 0 && objects.length === 0));

  // Clean up chips
  const chips = isAi ? getCleanupChips(ai, status?.cleanupSuggestions ?? []) : [];
  updateCleanupList(/** @type {HTMLElement} */ (q(root, '#ai-cleanup-list')), chips);
  setHidden(q(root, '#ai-cleanup'), chips.length === 0);

  // Tracked fix-ups: Whole / Part of the active one, lost frames
  const active = isAi ? getActiveAiObject(state) : null;
  setHidden(q(root, '#ai-object-scope'), !active);
  setChecked(q(root, '#ai-object-scope-whole'), active?.scope !== 'part');
  setChecked(q(root, '#ai-object-scope-part'), active?.scope === 'part');
  const lostObject =
    isAi && !status?.objectTracking
      ? getLostObject(objects, status?.objectLost, state.selectedRange, active?.id ?? null)
      : null;
  setHidden(q(root, '#ai-object-lost'), !lostObject);
  setText(
    q(root, '#ai-object-lost-text'),
    lostObject ? getObjectLostText(lostObject.object, lostObject.frames, fps) : '',
  );
  /** @type {HTMLElement} */ (q(root, '#ai-object-lost-go')).dataset.objectId =
    lostObject?.object.id ?? '';

  setHidden(q(root, '#background-alpha-note'), !state.clip?.hasAlpha);

  keepFocusInPanel(root, focused, state);
}

/**
 * The AI part: status slot, warnings, adjustments
 * @param {HTMLElement} root
 * @param {import('../types.js').EditorState} state
 * @param {number} _fps
 */
function updateAiSettings(root, state, _fps) {
  const { background } = state.edits;
  const status = state.aiCutout;
  const running = isAnalysisRunning(status.phase);
  const frames = state.clip?.frames ?? [];
  const modelId = getAiModelId(background.ai);
  // Model choice (rebuilt only when the subject's list changes)
  const choices = getSubjectModels(getSubject(background));
  const select = /** @type {HTMLSelectElement} */ (q(root, '#ai-model'));
  setHidden(q(root, '#ai-model-row'), choices.length < 2);
  if (select.dataset.models !== choices.join(',')) {
    select.dataset.models = choices.join(',');
    select.replaceChildren(
      ...choices.map((id) => createElement('option', { value: id }, [getModelOptionLabel(id)])),
    );
  }
  for (const option of select.options) {
    const { ready } = getModelReadiness(option.value, status.models?.[option.value]);
    const text = `${getModelOptionLabel(option.value)}${ready ? '' : ' (download)'}`;
    if (option.textContent !== text) option.textContent = text;
  }
  setValue(select, modelId);
  select.disabled = running;
  const entry = getModelEntry(modelId);
  setText(q(root, '#ai-model-hint'), `${entry.description}. ${entry.license.name}.`);

  const click = modelId === 'click';
  const cover = getAnalysisCoverage(frames, state.selectedRange, { modelId });
  const { start, end } = state.selectedRange;
  const selection = cover.selectionFrames.length;
  const line = click
    ? describeClickStatus({
        running,
        pending: cover.pendingInSelection,
        tracked: Math.max(0, selection - cover.pendingInSelection),
        selection,
        clicks: background.ai.picks.filter((p) => p.frame >= start && p.frame <= end).length,
        status: { ...status, lostFrames: getLostFramesInSelection(status, state.selectedRange) },
      })
    : describeAiStatus({
        running,
        pending: cover.pendingInSelection,
        analyzed: cover.analyzedInClip,
        total: cover.clipFrames,
        status,
      });
  // A tracked object being tracked shows in the slot once the model's own
  // analysis is done
  const tracking = running ? null : (status.objectTracking ?? null);
  const shown = tracking ? { kind: 'running', text: describeObjectTracking(tracking) } : line;
  const slot = q(root, '#ai-status');
  if (slot.getAttribute('data-kind') !== shown.kind) slot.setAttribute('data-kind', shown.kind);
  setText(q(root, '#ai-status-text'), shown.text);
  const bar = /** @type {HTMLProgressElement} */ (q(root, '#ai-progress-bar'));
  setHidden(bar, !running && !tracking);
  if (running) {
    if (status.phase === 'downloading' || status.phase === 'analyzing') {
      bar.value = getAnalysisFraction(status);
    } else {
      bar.removeAttribute('value'); // indeterminate
    }
  } else if (tracking) {
    if (tracking.phase === 'analyzing' || tracking.phase === 'downloading') {
      bar.value = getAnalysisFraction({
        phase: tracking.phase,
        loadedBytes: tracking.loadedBytes ?? 0,
        totalBytes: tracking.totalBytes ?? 0,
        framesDone: tracking.framesDone,
        framesTotal: tracking.framesTotal,
      });
    } else {
      bar.removeAttribute('value');
    }
  }
  setHidden(q(root, '#ai-cancel'), !running && !tracking);
  const analyzeBtn = /** @type {HTMLButtonElement} */ (q(root, '#ai-analyze'));
  const pending = cover.pendingInSelection;
  // Click to select tracks only once something was clicked
  setHidden(
    analyzeBtn,
    running || Boolean(tracking) || pending === 0 || (click && line.kind === 'hint'),
  );
  const ready = getModelReadiness(modelId, status.models?.[modelId]).ready;
  const verb = click ? 'Track' : 'Analyze';
  setText(analyzeBtn, ready ? verb : `${verb} (↓ ${getModelSizeLabel(modelId)})`);
  analyzeBtn.setAttribute(
    'aria-label',
    `${click ? 'Track through' : 'Analyze'} ${pending} frame${pending === 1 ? '' : 's'}${ready ? '' : ` (downloads ${getModelSizeLabel(modelId)})`}`,
  );

  // WebGPU warning: known missing adapter, an analysis stopped on it, or
  // the chosen model could not run on the adapter
  const noWebgpu = status.webgpu === false || status.needsWasmChoice || status.webgpuModelFailed;
  setHidden(q(root, '#ai-webgpu-warning'), !noWebgpu || status.wasmAllowed);
  setText(
    q(root, '#ai-webgpu-warning-text'),
    getWebgpuWarning(status, getModelEntry(modelId).label),
  );
  /** @type {HTMLButtonElement} */ (q(root, '#ai-run-wasm')).disabled = running;
  setHidden(q(root, '#ai-wasm-note'), !(noWebgpu && status.wasmAllowed));

  const error = status.phase === 'error' ? status.error : null;
  setHidden(q(root, '#ai-error'), !error);
  setText(q(root, '#ai-error-text'), error?.message ?? '');
  // Only refused picks and cancellations: the outcome of an analysis is the
  // status line
  const notice =
    running || error || /^Analyzed \d|^Tracked \d|already analyzed/.test(status.notice)
      ? ''
      : status.notice;
  setText(q(root, '#ai-notice'), notice);

  const fit = /** @type {HTMLInputElement} */ (q(root, '#ai-fit'));
  const fitValue = fitFromAi(background.ai);
  setValue(fit, String(fitValue));
  fit.setAttribute(
    'aria-valuetext',
    `${describeFit(fitValue)} (threshold ${Math.round(background.ai.threshold * 100)}%, edge ${background.ai.edge} px)`,
  );
  setChecked(q(root, '#ai-smoothing'), background.ai.smoothing);
}

/**
 * Whether a control can keep keyboard focus: enabled and not inside a
 * hidden element (up to `root`)
 * @param {HTMLElement} el
 * @param {ParentNode} root
 * @returns {boolean}
 */
function canHoldFocus(el, root) {
  if (/** @type {HTMLButtonElement} */ (el).disabled) return false;
  for (let node = /** @type {HTMLElement | null} */ (el); node; node = node.parentElement) {
    if (node.hidden) return false;
    if (node === root) break;
  }
  return true;
}

/**
 * Several controls hide or disable themselves when used (Cancel, Analyze,
 * Try again, Download, Reset, a pick's ×). Focus would then drop to <body>
 * and a keyboard or screen reader user would lose their place: move it to
 * the next control that makes sense.
 * @param {HTMLElement} root
 * @param {Element | null} focused - Focus before this update
 * @param {import('../types.js').EditorState} state
 */
function keepFocusInPanel(root, focused, state) {
  if (!(focused instanceof HTMLElement) || !root.contains(focused)) return;
  const active = document.activeElement;
  if (active !== focused && active !== null && active !== document.body) return;
  if (canHoldFocus(focused, root)) return;
  const subject = getSubject(state.edits.background);
  const order = ['#ai-cancel', '#ai-fit', '#background-tolerance', `#subject-${subject}`];
  for (const selector of order) {
    const target = root.querySelector(selector);
    if (target instanceof HTMLElement && canHoldFocus(target, root)) {
      target.focus();
      return;
    }
  }
}
