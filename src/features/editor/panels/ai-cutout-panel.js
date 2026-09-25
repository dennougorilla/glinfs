/**
 * AI cutout section of the Background panel
 * @module features/editor/panels/ai-cutout-panel
 *
 * Built once; updateAiCutoutSection() patches it in place from the editor
 * state (AI parameters and picks in the edits, runtime status in
 * state.aiCutout) and the clip's analysis coverage. What shows, in order:
 * what the analysis does (one-time download, frames stay on the device), a
 * WebGPU warning with the explicit slow option, "Analyze selection",
 * progress with Cancel, an error with Retry, and once any frame is
 * analyzed: threshold, smoothing, edge, the Keep/Remove pick tools and the
 * pick list.
 *
 * Toggles are checkboxes (see edits-panel.js): Space on a focused toggle
 * flips it instead of toggling playback.
 */

import { EDIT_LIMITS } from '../../../shared/edits/model.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import {
  DOWNLOAD_SIZE_LABEL,
  describeAnalysisProgress,
  getAnalysisCoverage,
  getAnalysisFraction,
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
 * Render the method switch and the AI section
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ methodSwitch: HTMLElement, section: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderAiCutoutSection(handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // --- Method switch ---
  const methods = /** @type {const} */ ([
    { value: 'color', id: 'ai-method-color', label: 'Color' },
    { value: 'ai', id: 'ai-method-ai', label: 'AI cutout (anime)' },
  ]);
  const methodSwitch = createElement(
    'fieldset',
    { className: 'editor-text-fieldset editor-ai-method' },
    [
      createElement('legend', { className: 'editor-text-field-label' }, ['Method']),
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

  // --- Explanation and WebGPU warning ---
  const intro = createElement('p', { className: 'editor-ai-intro', id: 'ai-intro' }, [
    `Finds the characters in every frame with an anime model that runs in this browser. The first analysis downloads ${DOWNLOAD_SIZE_LABEL} once; your frames never leave this device.`,
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
    on(keep.input, 'change', () => handlers.onSetAiPickTool?.(keep.input.checked ? 'keep' : null)),
    on(remove.input, 'change', () =>
      handlers.onSetAiPickTool?.(remove.input.checked ? 'remove' : null),
    ),
  );
  const tools = createElement('fieldset', { className: 'editor-text-fieldset editor-ai-tools' }, [
    createElement('legend', { className: 'editor-text-field-label' }, ['Pick a character']),
    createElement('div', { className: 'editor-ai-tool-row' }, [keep.wrapper, remove.wrapper]),
    createElement('p', { className: 'editor-ai-note' }, [
      'Click a character in the preview: Keep keeps only picked characters, Remove removes them. Each pick is followed through the clip.',
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
    [threshold.row, smoothingRow, edge.row, tools, pickStatus, pickList, clearBtn, buildStatus],
  );

  const section = createElement(
    'div',
    { className: 'editor-ai-section', id: 'ai-section', hidden: 'true' },
    [intro, warning, wasmNote, analyzeBtn, coverage, progress, errorBox, notice, controls],
  );

  return { methodSwitch, section, cleanups };
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

  setChecked(q(root, '#ai-method-color'), !isAi);
  setChecked(q(root, '#ai-method-ai'), isAi);
  /** @type {HTMLElement | null} */ (root.querySelector('#ai-color-fields'))?.toggleAttribute(
    'hidden',
    isAi,
  );
  section.hidden = !isAi;
  if (!isAi || !status) return;

  const running = isAnalysisRunning(status.phase);
  const frames = state.clip?.frames ?? [];
  const cover = getAnalysisCoverage(frames, state.selectedRange);

  // WebGPU warning: known missing adapter, or an analysis stopped on it
  const noWebgpu = status.webgpu === false || status.needsWasmChoice;
  q(section, '#ai-webgpu-warning').toggleAttribute('hidden', !noWebgpu || status.wasmAllowed);
  setText(
    q(section, '#ai-webgpu-warning-text'),
    status.needsWasmChoice
      ? 'The analysis needs WebGPU, which this browser does not provide. You can run it on the CPU instead, but it is very slow (about 14 seconds per frame).'
      : 'WebGPU is not available in this browser. Without it the model runs on the CPU, which is very slow (about 14 seconds per frame).',
  );
  /** @type {HTMLButtonElement} */ (q(section, '#ai-run-wasm')).disabled = running;
  q(section, '#ai-wasm-note').toggleAttribute('hidden', !(noWebgpu && status.wasmAllowed));

  const analyzeBtn = /** @type {HTMLButtonElement} */ (q(section, '#ai-analyze'));
  const pending = cover.pendingInSelection;
  setText(
    analyzeBtn,
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
    pickMessage = `Click a character in the preview to ${state.aiPickTool === 'keep' ? 'keep' : 'remove'} it. Press Escape to cancel.`;
  }
  setText(q(section, '#ai-pick-status'), pickMessage);

  const clearBtn = /** @type {HTMLButtonElement} */ (q(section, '#ai-picks-clear'));
  const list = /** @type {HTMLElement} */ (q(section, '#ai-pick-list'));
  updatePickList(list, ai.picks, fps, q(section, '#ai-pick-keep'));
  list.hidden = ai.picks.length === 0;
  clearBtn.hidden = ai.picks.length === 0;

  setText(q(section, '#ai-build-status'), status.building ? 'Updating the cutout…' : '');
}
