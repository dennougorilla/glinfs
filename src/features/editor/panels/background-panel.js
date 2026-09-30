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
 * 3. Fix-ups as tools on the preview: Keep / Remove (AI picks), Brush (the
 *    Touch up mode) and Reset.
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
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import { getModelEntry } from '../../ai-cutout/model-registry.js';
import {
  describeAnalysisProgress,
  getAiModelId,
  getAnalysisCoverage,
  getAnalysisFraction,
  getModelSizeLabel,
  RUNTIME_SIZE_LABEL,
} from '../ai-cutout.js';

/** @typedef {import('../../../shared/edits/model.js').CutoutPick} CutoutPick */
/** @typedef {import('../../../shared/edits/model.js').AiCutout} AiCutout */
/** @typedef {'none' | 'anime' | 'portrait' | 'general' | 'click' | 'color'} Subject */

/**
 * The subject cards, in the order shown (two columns). `model` is the AI
 * model a card uses; the color card uses the color key. `name` is how the
 * download question names the model.
 * @type {readonly { value: Exclude<Subject, 'none'>, label: string, hint: string, model: string | null, name?: string, icon: string }[]}
 */
export const SUBJECT_CARDS = Object.freeze([
  {
    value: 'anime',
    label: 'Anime',
    hint: 'Characters, art',
    model: 'anime',
    icon: '<path d="M12 3l2.4 5.1 5.6.7-4.1 3.9 1 5.5L12 15.6 7.1 18.2l1-5.5L4 8.8l5.6-.7z"/>',
  },
  {
    value: 'portrait',
    label: 'Person',
    hint: 'Real people, fast',
    model: 'portrait',
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  },
  {
    value: 'general',
    label: 'Anything',
    hint: 'People, pets, objects',
    model: 'general',
    icon: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="3.5"/>',
  },
  {
    value: 'click',
    label: 'Something else',
    hint: 'Click it to select',
    model: 'click',
    name: 'Click to select',
    icon: '<circle cx="11" cy="11" r="7"/><path d="M11 2v3M11 17v3M2 11h3M17 11h3"/><path d="M13.5 13.5l6.5 2.5-2.7 1.3-1.3 2.7z" fill="currentColor"/>',
  },
  {
    value: 'color',
    label: 'Solid color',
    hint: 'Green screen, flat',
    model: null,
    icon: '<path d="M12 3.5c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0c0-3.1 2.5-6.3 6-10.5z"/>',
  },
]);

/** The AI subject card of a model */
const CARD_BY_MODEL = Object.fromEntries(
  SUBJECT_CARDS.filter((card) => card.model).map((card) => [card.model, card]),
);

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
 * The AI model of a subject, or null (Off, Solid color)
 * @param {Subject} subject
 * @returns {string | null}
 */
export function getSubjectModel(subject) {
  return SUBJECT_CARDS.find((card) => card.value === subject)?.model ?? null;
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
  `AI subjects run a model in this browser: it downloads once (plus ${RUNTIME_SIZE_LABEL} for the runtime the first time) and your frames never leave this device. Models: Anime is ISNet anime, Person is MODNet, Anything is ISNet, Something else is MobileSAM, all Apache-2.0. Manage them in Settings.`,
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

  const aiSection = createElement(
    'div',
    { className: 'editor-cutout-section', id: 'ai-section', hidden: 'true' },
    [statusSlot, warning, wasmNote, errorBox, notice, fit.row, smoothingRow],
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
      title: 'Reset the adjustments, picks and brush strokes',
    },
    [createElement('span', {}, [icon(TOOL_ICONS.reset, 16), 'Reset'])],
  );
  cleanups.push(on(reset, 'click', () => handlers.onResetBackground?.()));

  const pickList = createElement('ul', {
    id: 'ai-pick-list',
    className: 'editor-cutout-picks',
    'aria-label': 'Picks',
  });
  cleanups.push(
    on(pickList, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const item = target?.closest('[data-pick-index]');
      if (!(item instanceof HTMLElement)) return;
      const index = Number(item.dataset.pickIndex);
      if (target?.closest('.editor-cutout-pick-delete')) {
        handlers.onRemoveAiPick?.(index);
      } else if (target?.closest('.editor-cutout-pick-go')) {
        handlers.onFrameChange(Number(item.dataset.pickFrame));
      }
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
      clickScope,
      clickLost,
      createElement('div', { className: 'editor-cutout-tools' }, [
        keep.wrapper,
        remove.wrapper,
        brush.wrapper,
        reset,
      ]),
      createElement('p', { className: 'editor-cutout-note', id: 'background-tools-hint' }),
      pickList,
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
 * Rebuild the pick list (small: at most 16 items). Keeps focus inside the
 * list when the focused item goes away.
 * @param {HTMLElement} list
 * @param {CutoutPick[]} picks
 * @param {number} fps
 * @param {HTMLElement} fallbackFocus
 */
function updatePickList(list, picks, fps, fallbackFocus) {
  const signature = picks.map((p) => `${p.frame}:${p.x}:${p.y}:${p.mode}`).join('|');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const focused = document.activeElement;
  const hadFocus = focused instanceof HTMLElement && list.contains(focused);
  const focusedIndex = hadFocus
    ? Number(/** @type {HTMLElement} */ (focused.closest('[data-pick-index]'))?.dataset.pickIndex)
    : -1;
  list.replaceChildren(
    ...picks.map((pick, index) => {
      const label = getPickLabel(pick, fps);
      return createElement(
        'li',
        {
          className: `editor-cutout-pick editor-cutout-pick--${pick.mode}`,
          'data-pick-index': String(index),
          'data-pick-frame': String(pick.frame),
        },
        [
          createElement(
            'button',
            {
              type: 'button',
              className: 'editor-cutout-pick-go',
              'aria-label': `${label} (go to frame)`,
            },
            [label],
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'editor-cutout-pick-delete',
              'aria-label': `Remove pick: ${label}`,
            },
            ['×'],
          ),
        ],
      );
    }),
  );
  if (hadFocus) {
    const index = Math.min(focusedIndex, picks.length - 1);
    const target =
      index >= 0
        ? list.children[index]?.querySelector('.editor-cutout-pick-delete')
        : fallbackFocus;
    if (target instanceof HTMLElement) target.focus();
  }
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
      ai.clickScope !== defaults.clickScope ||
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

  // Subject radios (the card being asked about looks chosen while asked)
  for (const value of ['none', ...SUBJECT_CARDS.map((c) => c.value)]) {
    setChecked(q(root, `#subject-${value}`), value === shown);
  }
  for (const card of SUBJECT_CARDS) {
    if (!card.model) continue;
    const readiness = getModelReadiness(card.model, status?.models?.[card.model]);
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

  // Fix-up tools: Keep/Remove with the AI only
  const { ai } = background;
  const full = ai.picks.length >= EDIT_LIMITS.aiPicks.max;
  for (const mode of /** @type {const} */ (['keep', 'remove'])) {
    const input = /** @type {HTMLInputElement} */ (q(root, `#ai-pick-${mode}`));
    const label = /** @type {HTMLElement} */ (input.closest('.editor-cutout-tool'));
    setHidden(label, !isAi);
    setChecked(input, state.aiPickTool === mode);
    input.disabled = full && state.aiPickTool !== mode;
    label.classList.toggle('is-active', state.aiPickTool === mode);
  }
  const brushLabel = q(root, '#touchup-brush').closest('.editor-cutout-tool');
  brushLabel?.classList.toggle('is-active', state.brush?.on === true);
  /** @type {HTMLButtonElement} */ (q(root, '#background-reset')).disabled =
    !canResetBackground(state);

  const click = isAi && getAiModelId(ai) === 'click';
  let toolsHint = '';
  if (isAi && full) {
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
  const lostFrames = click && status ? (status.lostFrames ?? []) : [];
  const lostText = isAnalysisRunning(status?.phase ?? 'idle')
    ? ''
    : getLostFramesText(lostFrames, fps);
  setHidden(q(root, '#ai-click-lost'), lostText === '');
  setText(q(root, '#ai-click-lost-text'), lostText);

  const list = /** @type {HTMLElement} */ (q(root, '#ai-pick-list'));
  updatePickList(list, isAi ? ai.picks : [], fps, q(root, '#ai-pick-keep'));
  setHidden(list, !isAi || ai.picks.length === 0);

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
        status,
      })
    : describeAiStatus({
        running,
        pending: cover.pendingInSelection,
        analyzed: cover.analyzedInClip,
        total: cover.clipFrames,
        status,
      });
  const slot = q(root, '#ai-status');
  if (slot.getAttribute('data-kind') !== line.kind) slot.setAttribute('data-kind', line.kind);
  setText(q(root, '#ai-status-text'), line.text);
  const bar = /** @type {HTMLProgressElement} */ (q(root, '#ai-progress-bar'));
  setHidden(bar, !running);
  if (running) {
    if (status.phase === 'downloading' || status.phase === 'analyzing') {
      bar.value = getAnalysisFraction(status);
    } else {
      bar.removeAttribute('value'); // indeterminate
    }
  }
  setHidden(q(root, '#ai-cancel'), !running);
  const analyzeBtn = /** @type {HTMLButtonElement} */ (q(root, '#ai-analyze'));
  const pending = cover.pendingInSelection;
  // Click to select tracks only once something was clicked
  setHidden(analyzeBtn, running || pending === 0 || (click && line.kind === 'hint'));
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
