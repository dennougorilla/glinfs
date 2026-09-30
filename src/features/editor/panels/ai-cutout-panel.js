/**
 * AI cutout section of the Background panel
 * @module features/editor/panels/ai-cutout-panel
 *
 * Built once; updateAiCutoutSection() patches it in place from the editor
 * state (AI parameters and picks in the edits, runtime status in
 * state.aiCutout) and the clip's analysis coverage. What shows, in order:
 * the model choice (General / Anime, each with the network's name and
 * whether it is ready or how much it downloads), a
 * WebGPU warning with the explicit slow option, "Analyze selection",
 * progress with Cancel, an error with Retry, and once any frame is
 * analyzed: the Keep/Remove pick tools, the pick list and a collapsed
 * Advanced disclosure (threshold, edge, smoothing). What the analysis does
 * (one-time download, frames stay on the device) sits in a collapsed
 * "About models" disclosure.
 *
 * Everything analysis-related (coverage, Analyze, controls) reflects the
 * chosen model's masks only; switching models keeps threshold, smoothing,
 * edge and picks (see handleSetAiModel in index.js).
 *
 * Toggles are checkboxes (see edits-panel.js): Space on a focused toggle
 * flips it instead of toggling playback.
 */

import { EDIT_LIMITS } from '../../../shared/edits/model.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import { getModelEntry, MODEL_REGISTRY } from '../../ai-cutout/model-registry.js';
import {
  describeAnalysisProgress,
  getAiModelId,
  getAnalysisCoverage,
  getAnalysisFraction,
  getModelSizeLabel,
  RUNTIME_SIZE_LABEL,
} from '../ai-cutout.js';

/** @typedef {import('../../../shared/edits/model.js').CutoutPick} CutoutPick */

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
 * Edge value as shown next to its slider
 * @param {number} edge
 * @returns {string}
 */
export function formatEdge(edge) {
  if (edge === 0) return '0 px';
  return `${edge > 0 ? '+' : '−'}${Math.abs(edge)} px`;
}

/**
 * What the analysis does with this model (the intro line)
 * @param {string} modelId
 * @returns {string}
 */
export function getAiIntro(modelId) {
  const { label, finds } = getModelEntry(modelId);
  return `Finds ${finds} in every frame with the ${label} model, which runs in this browser. The first analysis with it downloads ${getModelSizeLabel(modelId)} once (plus ${RUNTIME_SIZE_LABEL} for the runtime the first time); your frames never leave this device.`;
}

/**
 * The no-WebGPU warning: the chosen model failed on this browser's WebGPU,
 * an analysis stopped because the browser has none, or it has none
 * @param {{ needsWasmChoice: boolean, webgpuModelFailed: boolean }} status
 * @param {string} modelLabel
 * @returns {string}
 */
export function getWebgpuWarning(status, modelLabel) {
  const slow =
    'You can run it on the CPU instead, but it is very slow (about 14 seconds per frame).';
  if (status.webgpuModelFailed) {
    return `The ${modelLabel} model could not run on WebGPU in this browser. ${slow}`;
  }
  if (status.needsWasmChoice) {
    return `The analysis needs WebGPU, which this browser does not provide. ${slow}`;
  }
  return 'WebGPU is not available in this browser. Without it the model runs on the CPU, which is very slow (about 14 seconds per frame).';
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
 * Labelled slider row with a value readout
 * @param {string} id
 * @param {string} label
 * @param {number} min
 * @param {number} max
 * @returns {{ row: HTMLElement, input: HTMLInputElement, output: HTMLOutputElement }}
 */
function slider(id, label, min, max) {
  const input = /** @type {HTMLInputElement} */ (
    createElement('input', { type: 'range', id, min: String(min), max: String(max), step: '1' })
  );
  const output = /** @type {HTMLOutputElement} */ (
    createElement('output', { id: `${id}-value`, className: 'editor-text-value', for: id })
  );
  const row = createElement('div', { className: 'editor-text-field' }, [
    createElement('label', { className: 'editor-text-field-label', for: id }, [label]),
    createElement('div', { className: 'editor-text-field-control' }, [input, output]),
  ]);
  return { row, input, output };
}

/**
 * Checkbox styled as a button (pick tools)
 * @param {string} id
 * @param {string} label
 * @returns {{ wrapper: HTMLElement, input: HTMLInputElement }}
 */
function toggleButton(id, label) {
  const input = /** @type {HTMLInputElement} */ (
    createElement('input', { type: 'checkbox', id, className: 'editor-ai-tool-input' })
  );
  const wrapper = createElement('label', { className: 'editor-ai-tool', for: id }, [
    input,
    createElement('span', {}, [label]),
  ]);
  return { wrapper, input };
}

/**
 * Hint under a model's name on the switch: "Ready" once its session is
 * loaded (preloaded or used), "Downloaded" when only its file is cached,
 * else what the first analysis downloads
 * @param {string} modelId
 * @param {import('../types.js').ModelAvailability | undefined} availability
 * @returns {string}
 */
export function getModelHint(modelId, availability) {
  if (availability === 'ready') return 'Ready';
  if (availability === 'cached') return 'Downloaded';
  return `Download ${getModelSizeLabel(modelId)}`;
}

/**
 * Label of the Analyze button
 * @param {number} pending - Frames of the selection still to analyze
 * @returns {string}
 */
export function getAnalyzeLabel(pending) {
  if (pending === 0) return 'Selection analyzed';
  return `Analyze ${pending} frame${pending === 1 ? '' : 's'}`;
}

/**
 * Collapsed "Advanced" disclosure for settings most clips never need
 * (Background panel: the color key's Remove mode, the AI tuning sliders)
 * @param {string} id
 * @param {HTMLElement[]} children
 * @returns {HTMLElement}
 */
export function advancedDetails(id, children) {
  return createElement('details', { className: 'editor-bg-advanced', id }, [
    createElement('summary', { className: 'editor-bg-advanced-summary' }, ['Advanced']),
    createElement('div', { className: 'editor-bg-advanced-body' }, children),
  ]);
}

/**
 * Render the method switch and the AI section
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ methodSwitch: HTMLElement, section: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderAiCutoutSection(handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // --- Method switch: Off (no removal) | Color | AI ---
  const methods = /** @type {const} */ ([
    { value: 'off', id: 'background-method-off', label: 'Off' },
    { value: 'color', id: 'ai-method-color', label: 'Color' },
    { value: 'ai', id: 'ai-method-ai', label: 'AI' },
  ]);
  const methodSwitch = createElement(
    'fieldset',
    { className: 'editor-text-fieldset editor-ai-method', id: 'background-method' },
    [
      createElement('legend', { className: 'editor-bg-method-legend' }, ['Remove background']),
      createElement(
        'div',
        { className: 'editor-text-segmented' },
        methods.map(({ value, id, label }) => {
          const input = /** @type {HTMLInputElement} */ (
            createElement('input', { type: 'radio', name: 'background-method', id, value })
          );
          cleanups.push(
            on(input, 'change', () => {
              if (input.checked) handlers.onSetBackgroundMethod?.(value);
            }),
          );
          return createElement('label', { className: 'editor-text-segment', for: id }, [
            input,
            createElement('span', {}, [label]),
          ]);
        }),
      ),
    ],
  );

  // --- Model choice ---
  const modelSwitch = createElement(
    'fieldset',
    { className: 'editor-text-fieldset editor-ai-model', id: 'ai-model' },
    [
      createElement('legend', { className: 'editor-text-field-label' }, ['Model']),
      createElement(
        'div',
        { className: 'editor-text-segmented' },
        // Registry order (General left): the order shown, not the default model
        MODEL_REGISTRY.map((entry) => {
          const id = `ai-model-${entry.id}`;
          const input = /** @type {HTMLInputElement} */ (
            createElement('input', {
              type: 'radio',
              name: 'ai-model',
              id,
              value: entry.id,
              'aria-describedby': 'ai-model-note',
            })
          );
          cleanups.push(
            on(input, 'change', () => {
              if (input.checked) handlers.onSetAiModel?.(/** @type {any} */ (entry.id));
            }),
          );
          return createElement('label', { className: 'editor-text-segment', for: id }, [
            input,
            createElement('span', {}, [
              createElement('b', { className: 'editor-ai-model-purpose' }, [entry.label]),
              createElement('small', { className: 'editor-ai-model-name' }, [
                ` ${entry.shortModelName}`,
              ]),
              createElement(
                'small',
                { className: 'editor-ai-model-hint', id: `ai-model-hint-${entry.id}` },
                [` ${getModelHint(entry.id, undefined)}`],
              ),
            ]),
          ]);
        }),
      ),
    ],
  );

  // --- Explanation (collapsed: the model sizes are on the switch) and
  // the WebGPU warning (only when it applies) ---
  const intro = createElement('p', { className: 'editor-ai-intro', id: 'ai-intro' }, [
    getAiIntro('anime'),
  ]);
  const about = createElement('details', { className: 'editor-ai-about', id: 'ai-about' }, [
    createElement('summary', { className: 'editor-ai-about-summary' }, [
      createElement('span', { className: 'editor-ai-about-icon', 'aria-hidden': 'true' }, ['i']),
      'About models',
    ]),
    createElement('p', { className: 'editor-ai-note', id: 'ai-model-note' }),
    intro,
  ]);

  const wasmBtn = createElement(
    'button',
    { type: 'button', id: 'ai-run-wasm', className: 'btn btn-secondary editor-ai-wide' },
    ['Run without WebGPU (very slow)'],
  );
  cleanups.push(on(wasmBtn, 'click', () => handlers.onAiAllowWasm?.()));
  const warning = createElement(
    'div',
    { className: 'editor-ai-warning', id: 'ai-webgpu-warning', role: 'note', hidden: 'true' },
    [
      createElement('p', { className: 'editor-ai-warning-text', id: 'ai-webgpu-warning-text' }, [
        'WebGPU is not available in this browser. Without it the model runs on the CPU, which is very slow (about 14 seconds per frame).',
      ]),
      wasmBtn,
    ],
  );
  const wasmNote = createElement(
    'p',
    { className: 'editor-ai-note', id: 'ai-wasm-note', hidden: 'true' },
    ['Running without WebGPU: expect about 14 seconds per frame.'],
  );

  // --- Analyze / progress / error ---
  const analyzeBtn = createElement(
    'button',
    { type: 'button', id: 'ai-analyze', className: 'btn btn-primary editor-ai-wide' },
    ['Analyze selection'],
  );
  cleanups.push(on(analyzeBtn, 'click', () => handlers.onAiAnalyze?.()));

  // Not a live region: the progress line already announces each frame
  const coverage = createElement('p', { className: 'editor-ai-note', id: 'ai-coverage' });

  const progressBar = /** @type {HTMLProgressElement} */ (
    createElement('progress', {
      id: 'ai-progress-bar',
      className: 'editor-ai-progress-bar',
      max: '1',
      value: '0',
      'aria-labelledby': 'ai-progress-text',
    })
  );
  const progressText = createElement('p', {
    className: 'editor-ai-progress-text',
    id: 'ai-progress-text',
    role: 'status',
  });
  const cancelBtn = createElement(
    'button',
    { type: 'button', id: 'ai-cancel', className: 'btn btn-secondary editor-ai-wide' },
    ['Cancel analysis'],
  );
  cleanups.push(on(cancelBtn, 'click', () => handlers.onAiCancel?.()));
  const progress = createElement(
    'div',
    { className: 'editor-ai-progress', id: 'ai-progress', hidden: 'true' },
    [progressText, progressBar, cancelBtn],
  );

  const retryBtn = createElement(
    'button',
    { type: 'button', id: 'ai-retry', className: 'btn btn-secondary editor-ai-wide' },
    ['Retry'],
  );
  cleanups.push(on(retryBtn, 'click', () => handlers.onAiAnalyze?.()));
  const errorBox = createElement(
    'div',
    { className: 'editor-ai-error', id: 'ai-error', role: 'alert', hidden: 'true' },
    [createElement('p', { className: 'editor-ai-error-text', id: 'ai-error-text' }), retryBtn],
  );

  const notice = createElement('p', { className: 'editor-ai-note', id: 'ai-notice' });

  // --- Controls (once something is analyzed) ---
  const threshold = slider(
    'ai-threshold',
    'Threshold',
    Math.round(EDIT_LIMITS.aiThreshold.min * 100),
    Math.round(EDIT_LIMITS.aiThreshold.max * 100),
  );
  cleanups.push(
    on(threshold.input, 'input', () =>
      handlers.onSetAiParams?.({ threshold: Number(threshold.input.value) / 100 }),
    ),
  );

  const smoothing = /** @type {HTMLInputElement} */ (
    createElement('input', { type: 'checkbox', id: 'ai-smoothing' })
  );
  cleanups.push(
    on(smoothing, 'change', () => handlers.onSetAiParams?.({ smoothing: smoothing.checked })),
  );
  const smoothingRow = createElement(
    'label',
    { className: 'editor-bg-check', for: 'ai-smoothing' },
    [smoothing, 'Smooth between frames'],
  );

  const edge = slider('ai-edge', 'Edge', EDIT_LIMITS.aiEdge.min, EDIT_LIMITS.aiEdge.max);
  cleanups.push(
    on(edge.input, 'input', () => handlers.onSetAiParams?.({ edge: Number(edge.input.value) })),
  );

  const keep = toggleButton('ai-pick-keep', 'Keep');
  const remove = toggleButton('ai-pick-remove', 'Remove');
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
  const tools = createElement('fieldset', { className: 'editor-text-fieldset editor-ai-tools' }, [
    createElement('legend', { className: 'editor-text-field-label' }, ['Pick a character']),
    createElement('div', { className: 'editor-ai-tool-row' }, [keep.wrapper, remove.wrapper]),
    createElement('p', { className: 'editor-ai-note' }, [
      'Click a character in the preview. Each pick follows it through the clip.',
    ]),
  ]);
  const pickStatus = createElement('p', {
    className: 'editor-ai-status',
    id: 'ai-pick-status',
    role: 'status',
  });

  const pickList = createElement('ul', {
    id: 'ai-pick-list',
    className: 'editor-ai-pick-list',
    'aria-label': 'Picks',
  });
  cleanups.push(
    on(pickList, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const item = target?.closest('[data-pick-index]');
      if (!(item instanceof HTMLElement)) return;
      const index = Number(item.dataset.pickIndex);
      if (target?.closest('.editor-ai-pick-delete')) {
        handlers.onRemoveAiPick?.(index);
      } else if (target?.closest('.editor-ai-pick-go')) {
        const frame = Number(item.dataset.pickFrame);
        handlers.onFrameChange(frame);
      }
    }),
  );
  const clearBtn = createElement(
    'button',
    { type: 'button', id: 'ai-picks-clear', className: 'btn btn-ghost editor-ai-wide' },
    ['Clear picks'],
  );
  cleanups.push(on(clearBtn, 'click', () => handlers.onClearAiPicks?.()));

  const buildStatus = createElement('p', {
    className: 'editor-ai-note',
    id: 'ai-build-status',
    'aria-live': 'polite',
  });

  const controls = createElement(
    'div',
    { className: 'editor-ai-controls', id: 'ai-controls', hidden: 'true' },
    [
      tools,
      pickStatus,
      pickList,
      clearBtn,
      buildStatus,
      advancedDetails('ai-advanced', [threshold.row, edge.row, smoothingRow]),
    ],
  );

  const section = createElement(
    'div',
    { className: 'editor-ai-section', id: 'ai-section', hidden: 'true' },
    [
      modelSwitch,
      about,
      warning,
      wasmNote,
      analyzeBtn,
      coverage,
      progress,
      errorBox,
      notice,
      controls,
    ],
  );

  return { methodSwitch, section, cleanups };
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
 * @param {HTMLElement} el
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
          className: `editor-ai-pick editor-ai-pick--${pick.mode}`,
          'data-pick-index': String(index),
          'data-pick-frame': String(pick.frame),
        },
        [
          createElement(
            'button',
            {
              type: 'button',
              className: 'editor-ai-pick-go',
              'aria-label': `${label} (go to frame)`,
            },
            [label],
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'editor-ai-pick-delete',
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
      index >= 0 ? list.children[index]?.querySelector('.editor-ai-pick-delete') : fallbackFocus;
    if (target instanceof HTMLElement) target.focus();
  }
}

/**
 * Apply the editor state to the method switch and the AI section
 * @param {ParentNode} root - Background panel root
 * @param {import('../types.js').EditorState} state
 * @param {number} fps
 */
export function updateAiCutoutSection(root, state, fps) {
  const section = /** @type {HTMLElement | null} */ (root.querySelector('#ai-section'));
  if (!section || !state.edits) return;
  const { background } = state.edits;
  const isAi = background.method === 'ai';
  const status = state.aiCutout;
  const focused = document.activeElement;

  const on = background.enabled === true;
  setChecked(q(root, '#background-method-off'), !on);
  setChecked(q(root, '#ai-method-color'), on && !isAi);
  setChecked(q(root, '#ai-method-ai'), on && isAi);
  /** @type {HTMLElement | null} */ (root.querySelector('#ai-color-fields'))?.toggleAttribute(
    'hidden',
    isAi,
  );
  section.hidden = !isAi;
  if (!isAi || !status) return;

  const running = isAnalysisRunning(status.phase);
  const frames = state.clip?.frames ?? [];
  const modelId = getAiModelId(background.ai);
  const cover = getAnalysisCoverage(frames, state.selectedRange, { modelId });

  // Model: one analysis runs with the model it started with
  for (const entry of MODEL_REGISTRY) {
    const input = /** @type {HTMLInputElement} */ (q(section, `#ai-model-${entry.id}`));
    setChecked(input, entry.id === modelId);
    input.disabled = running;
    const availability = status.models?.[entry.id];
    const hint = /** @type {HTMLElement} */ (q(section, `#ai-model-hint-${entry.id}`));
    setText(hint, ` ${getModelHint(entry.id, availability)}`);
    if (hint.dataset.state !== (availability ?? 'unknown')) {
      hint.dataset.state = availability ?? 'unknown';
    }
  }
  const model = getModelEntry(modelId);
  setText(
    q(section, '#ai-model-note'),
    running
      ? 'The model can be changed when the analysis ends or is cancelled.'
      : `${model.description}. Each model keeps its own analysis; threshold, edge and picks stay when you switch.`,
  );
  setText(q(section, '#ai-intro'), getAiIntro(modelId));

  // WebGPU warning: known missing adapter, an analysis stopped on it, or
  // the chosen model could not run on the adapter
  const noWebgpu = status.webgpu === false || status.needsWasmChoice || status.webgpuModelFailed;
  q(section, '#ai-webgpu-warning').toggleAttribute('hidden', !noWebgpu || status.wasmAllowed);
  setText(q(section, '#ai-webgpu-warning-text'), getWebgpuWarning(status, model.label));
  /** @type {HTMLButtonElement} */ (q(section, '#ai-run-wasm')).disabled = running;
  q(section, '#ai-wasm-note').toggleAttribute('hidden', !(noWebgpu && status.wasmAllowed));

  const analyzeBtn = /** @type {HTMLButtonElement} */ (q(section, '#ai-analyze'));
  const pending = cover.pendingInSelection;
  setText(analyzeBtn, getAnalyzeLabel(pending));
  analyzeBtn.setAttribute(
    'aria-label',
    pending > 0
      ? `Analyze selection (${pending} frame${pending === 1 ? '' : 's'})`
      : 'Selection analyzed',
  );
  analyzeBtn.disabled = running || pending === 0;
  setText(
    q(section, '#ai-coverage'),
    `${cover.analyzedInClip} of ${cover.clipFrames} frames analyzed`,
  );

  const progress = q(section, '#ai-progress');
  progress.toggleAttribute('hidden', !running);
  if (running) {
    setText(q(section, '#ai-progress-text'), describeAnalysisProgress(status));
    const bar = /** @type {HTMLProgressElement} */ (q(section, '#ai-progress-bar'));
    const fraction = getAnalysisFraction(status);
    if (status.phase === 'downloading' || status.phase === 'analyzing') {
      bar.value = fraction;
    } else {
      bar.removeAttribute('value'); // indeterminate
    }
  }

  const error = status.phase === 'error' ? status.error : null;
  q(section, '#ai-error').toggleAttribute('hidden', !error);
  setText(q(section, '#ai-error-text'), error?.message ?? '');
  setText(q(section, '#ai-notice'), running || error ? '' : status.notice);

  // Controls once any frame of the clip is analyzed (or picks exist)
  const { ai } = background;
  const controls = q(section, '#ai-controls');
  controls.toggleAttribute('hidden', cover.analyzedInClip === 0 && ai.picks.length === 0);

  const thresholdPct = String(Math.round(ai.threshold * 100));
  setValue(q(section, '#ai-threshold'), thresholdPct);
  setText(q(section, '#ai-threshold-value'), `${thresholdPct}%`);
  setChecked(q(section, '#ai-smoothing'), ai.smoothing);
  setValue(q(section, '#ai-edge'), String(ai.edge));
  setText(q(section, '#ai-edge-value'), formatEdge(ai.edge));

  const full = ai.picks.length >= EDIT_LIMITS.aiPicks.max;
  for (const mode of /** @type {const} */ (['keep', 'remove'])) {
    const input = /** @type {HTMLInputElement} */ (q(section, `#ai-pick-${mode}`));
    setChecked(input, state.aiPickTool === mode);
    input.disabled = full && state.aiPickTool !== mode;
    input
      .closest('.editor-ai-tool')
      ?.classList.toggle('editor-ai-tool--active', state.aiPickTool === mode);
  }
  let pickMessage = '';
  if (full) {
    pickMessage = `The limit of ${EDIT_LIMITS.aiPicks.max} picks is reached. Remove one to add another.`;
  } else if (state.aiPickTool) {
    pickMessage = `Click a character in the preview to ${state.aiPickTool === 'keep' ? 'keep' : 'remove'} it, or move the marker there with the arrow keys and press Enter. Press Escape to cancel.`;
  }
  setText(q(section, '#ai-pick-status'), pickMessage);

  const clearBtn = /** @type {HTMLButtonElement} */ (q(section, '#ai-picks-clear'));
  const list = /** @type {HTMLElement} */ (q(section, '#ai-pick-list'));
  updatePickList(list, ai.picks, fps, q(section, '#ai-pick-keep'));
  list.hidden = ai.picks.length === 0;
  clearBtn.hidden = ai.picks.length === 0;

  setText(q(section, '#ai-build-status'), status.building ? 'Updating the cutout…' : '');

  keepFocusInSection(root, section, focused, running);
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
 * Several AI controls hide or disable themselves when used (Clear picks,
 * Cancel, Retry, Run without WebGPU, Analyze). Focus would then drop to
 * <body>, so a keyboard or screen reader user loses their place: move it to
 * the next control that still makes sense.
 * @param {ParentNode} root - Background panel root
 * @param {HTMLElement} section
 * @param {Element | null} focused - Focus before this update
 * @param {boolean} running - An analysis runs
 */
function keepFocusInSection(root, section, focused, running) {
  if (!(focused instanceof HTMLElement) || !section.contains(focused)) return;
  // Browsers may already have moved focus to <body> while this update ran
  // (focus fixup); focus moved anywhere else was moved on purpose
  const active = document.activeElement;
  if (active !== focused && active !== null && active !== document.body) return;
  if (canHoldFocus(focused, root)) return;
  const inControls = focused.closest('#ai-controls') !== null;
  const order = [
    ...(running ? ['#ai-cancel'] : []),
    ...(inControls ? ['#ai-pick-keep'] : []),
    '#ai-analyze',
    '#ai-pick-keep',
    '#ai-method-ai',
  ];
  for (const selector of order) {
    const target = root.querySelector(selector);
    if (target instanceof HTMLElement && canHoldFocus(target, root)) {
      target.focus();
      return;
    }
  }
}
