/**
 * "Touch up" section of the Background panel (mask brush), for both
 * removal methods.
 * @module features/editor/panels/touch-up-panel
 *
 * Built once; updateTouchUpSection() patches it in place from the editor
 * state (the brush tool in state.brush, the strokes in edits.touchUps).
 * The whole section is a fieldset that is disabled while background
 * removal is off: touch-ups refine a removal and do nothing without one,
 * which the section's note says.
 *
 * Toggles are checkboxes/radios (see edits-panel.js): Space on a focused
 * toggle flips it instead of toggling playback.
 */

import { EDIT_LIMITS } from '../../../shared/edits/model.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { isCurrentFrameOutsideSelection } from '../state.js';

/** Brush size slider steps per unit of radius (value 1 = the minimum radius) */
export const BRUSH_SIZE_STEPS = 400;

/** @type {{ value: import('../../../shared/edits/model.js').TouchUpMode, label: string }[]} */
const MODE_OPTIONS = [
  { value: 'erase', label: 'Erase' },
  { value: 'restore', label: 'Restore' },
];

/** @type {{ value: import('../types.js').BrushScope, label: string }[]} */
const SCOPE_OPTIONS = [
  { value: 'frame', label: 'This frame' },
  { value: 'selection', label: 'Selection' },
];

/** Shown while background removal is off (the section is disabled then) */
export const TOUCH_UP_NEEDS_REMOVAL =
  'Touch-ups apply only while background removal is on. Turn on Remove background to use the brush.';

/**
 * Slider value of a brush radius
 * @param {number} radius - Fraction of the source frame's shorter side
 * @returns {number}
 */
export function brushRadiusToSlider(radius) {
  return Math.round(radius * BRUSH_SIZE_STEPS);
}

/**
 * Brush radius of a slider value
 * @param {number} value
 * @returns {number}
 */
export function sliderToBrushRadius(value) {
  return value / BRUSH_SIZE_STEPS;
}

/**
 * Brush diameter in source pixels, as shown next to the size slider
 * @param {number} radius - Fraction of the shorter side
 * @param {{ width: number, height: number } | null | undefined} frame
 * @returns {string}
 */
export function formatBrushSize(radius, frame) {
  const side = frame ? Math.min(frame.width, frame.height) : 0;
  if (!(side > 0)) return `${Math.round(radius * 200)}%`;
  return `${Math.max(1, Math.round(2 * radius * side))} px`;
}

/**
 * Summary of the strokes for the current frame and the clip
 * @param {number} onFrame - Strokes applying to the current frame
 * @param {number} total
 * @returns {string}
 */
export function describeTouchUps(onFrame, total) {
  if (total === 0) return 'No touch-ups yet.';
  const plural = (/** @type {number} */ n) => `${n} stroke${n === 1 ? '' : 's'}`;
  return `${plural(onFrame)} on this frame, ${plural(total)} in total.`;
}

/** Status line: a frame outside IN..OUT under the Selection scope */
export const TOUCH_UP_OUTSIDE_SELECTION =
  'This frame is outside the selection (IN to OUT), so strokes apply to this frame only.';

/**
 * Status line of the brush while it is on: what a stroke does and where
 * @param {import('../types.js').EditorState} state
 * @returns {string}
 */
export function describeBrushStatus(state) {
  const { brush } = state;
  const verb = brush.mode === 'erase' ? 'erase' : 'restore';
  const tail = 'Escape cancels a stroke in progress, then stops the brush.';
  if (brush.scope === 'selection' && isCurrentFrameOutsideSelection(state)) {
    return `${TOUCH_UP_OUTSIDE_SELECTION} Paint on the preview to ${verb} on this frame. ${tail}`;
  }
  const where = brush.scope === 'frame' ? 'on this frame' : 'across the selection';
  return `Paint on the preview to ${verb} ${where}. ${tail}`;
}

/**
 * Segmented radio group
 * @template {string} T
 * @param {string} name
 * @param {string} legend
 * @param {{ value: T, label: string }[]} options
 * @param {(value: T) => void} onChange
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function segmented(name, legend, options, onChange, cleanups) {
  return createElement('fieldset', { className: 'editor-text-fieldset editor-brush-group' }, [
    createElement('legend', { className: 'editor-text-field-label' }, [legend]),
    createElement(
      'div',
      { className: 'editor-text-segmented' },
      options.map(({ value, label }) => {
        const id = `${name}-${value}`;
        const input = /** @type {HTMLInputElement} */ (
          createElement('input', { type: 'radio', name, id, value })
        );
        cleanups.push(
          on(input, 'change', () => {
            if (input.checked) onChange(value);
          }),
        );
        return createElement('label', { className: 'editor-text-segment', for: id }, [
          input,
          createElement('span', {}, [label]),
        ]);
      }),
    ),
  ]);
}

/**
 * Render the Touch up section
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderTouchUpSection(handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  const note = createElement('p', { className: 'editor-brush-note', id: 'touchup-note' }, [
    'Paint on the preview to fix the removal: Erase removes pixels, Restore brings the original pixels back.',
  ]);
  const needsRemoval = createElement(
    'p',
    { className: 'editor-brush-note editor-brush-note--warning', id: 'touchup-needs-removal' },
    [TOUCH_UP_NEEDS_REMOVAL],
  );

  // Brush toggle: a checkbox styled as a button
  const brush = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'checkbox',
      id: 'touchup-brush',
      className: 'editor-brush-input',
    })
  );
  cleanups.push(on(brush, 'change', () => handlers.onSetBrush?.({ on: brush.checked })));
  const brushLabel = createElement(
    'label',
    { className: 'editor-brush-toggle', for: 'touchup-brush' },
    [brush, createElement('span', {}, ['Brush'])],
  );

  const mode = segmented(
    'touchup-mode',
    'Mode',
    MODE_OPTIONS,
    (value) => handlers.onSetBrush?.({ mode: value }),
    cleanups,
  );

  const size = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      id: 'touchup-size',
      min: String(brushRadiusToSlider(EDIT_LIMITS.touchUpRadius.min)),
      max: String(brushRadiusToSlider(EDIT_LIMITS.touchUpRadius.max)),
      step: '1',
    })
  );
  const sizeValue = createElement('output', {
    id: 'touchup-size-value',
    className: 'editor-text-value',
    for: 'touchup-size',
  });
  cleanups.push(
    on(size, 'input', () =>
      handlers.onSetBrush?.({ radius: sliderToBrushRadius(Number(size.value)) }),
    ),
  );
  const sizeRow = createElement('div', { className: 'editor-text-field' }, [
    createElement('label', { className: 'editor-text-field-label', for: 'touchup-size' }, ['Size']),
    createElement('div', { className: 'editor-text-field-control' }, [size, sizeValue]),
  ]);

  const scope = segmented(
    'touchup-scope',
    'Each stroke applies to',
    SCOPE_OPTIONS,
    (value) => handlers.onSetBrush?.({ scope: value }),
    cleanups,
  );

  const status = createElement('p', {
    className: 'editor-brush-status',
    id: 'touchup-status',
    role: 'status',
  });
  const summary = createElement('p', { className: 'editor-brush-note', id: 'touchup-summary' });

  const undo = createElement(
    'button',
    { type: 'button', id: 'touchup-undo', className: 'btn btn-secondary editor-brush-action' },
    ['Undo last stroke'],
  );
  const clearFrame = createElement(
    'button',
    { type: 'button', id: 'touchup-clear-frame', className: 'btn btn-ghost editor-brush-action' },
    ['Clear on this frame'],
  );
  const clearAll = createElement(
    'button',
    { type: 'button', id: 'touchup-clear-all', className: 'btn btn-ghost editor-brush-action' },
    ['Clear all'],
  );
  cleanups.push(
    on(undo, 'click', () => handlers.onUndoTouchUp?.()),
    on(clearFrame, 'click', () => handlers.onClearTouchUpsOnFrame?.()),
    on(clearAll, 'click', () => handlers.onClearAllTouchUps?.()),
  );

  const controls = createElement(
    'fieldset',
    { className: 'editor-brush-controls', id: 'touchup-controls' },
    [
      createElement('legend', { className: 'editor-brush-sr-only' }, ['Touch-up brush']),
      brushLabel,
      mode,
      sizeRow,
      scope,
      status,
      summary,
      createElement('div', { className: 'editor-brush-actions' }, [undo, clearFrame, clearAll]),
    ],
  );

  const element = createElement(
    'section',
    {
      className: 'editor-brush-section',
      id: 'touchup-section',
      'aria-labelledby': 'touchup-title',
    },
    [
      createElement(
        'h3',
        { className: 'editor-text-field-label editor-brush-title', id: 'touchup-title' },
        ['Touch up'],
      ),
      note,
      needsRemoval,
      controls,
    ],
  );

  return { element, cleanups };
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
 * @param {boolean} checked
 */
function setChecked(input, checked) {
  if (input.checked !== checked) input.checked = checked;
}

/**
 * Apply the editor state to the Touch up section
 * @param {ParentNode} root - Background panel root
 * @param {import('../types.js').EditorState} state
 */
export function updateTouchUpSection(root, state) {
  const section = /** @type {HTMLElement | null} */ (root.querySelector('#touchup-section'));
  if (!section || !state.edits || !state.brush) return;
  const focused = document.activeElement;
  const removalOn = state.edits.background.enabled === true;
  const { brush } = state;
  const touchUps = state.edits.touchUps ?? [];

  const controls = /** @type {HTMLFieldSetElement} */ (q(section, '#touchup-controls'));
  controls.disabled = !removalOn;
  q(section, '#touchup-needs-removal').toggleAttribute('hidden', removalOn);

  const brushInput = /** @type {HTMLInputElement} */ (q(section, '#touchup-brush'));
  setChecked(brushInput, brush.on);
  q(section, '.editor-brush-toggle')?.classList.toggle('editor-brush-toggle--active', brush.on);
  for (const opt of MODE_OPTIONS) {
    setChecked(q(section, `#touchup-mode-${opt.value}`), brush.mode === opt.value);
  }
  for (const opt of SCOPE_OPTIONS) {
    setChecked(q(section, `#touchup-scope-${opt.value}`), brush.scope === opt.value);
  }
  const size = /** @type {HTMLInputElement} */ (q(section, '#touchup-size'));
  const sizeValue = String(brushRadiusToSlider(brush.radius));
  if (size.value !== sizeValue) size.value = sizeValue;
  setText(q(section, '#touchup-size-value'), formatBrushSize(brush.radius, state.clip?.frames[0]));

  setText(q(section, '#touchup-status'), brush.on ? describeBrushStatus(state) : '');

  // Strokes covering the current frame (they show while removal is on)
  const frame = state.currentFrame;
  const onFrame = touchUps.filter((s) => s.start <= frame && frame <= s.end).length;
  const full = touchUps.length >= EDIT_LIMITS.touchUps.max;
  setText(
    q(section, '#touchup-summary'),
    full
      ? `${describeTouchUps(onFrame, touchUps.length)} The limit of ${EDIT_LIMITS.touchUps.max} strokes is reached: undo or clear strokes to paint more.`
      : describeTouchUps(onFrame, touchUps.length),
  );
  /** @type {HTMLButtonElement} */ (q(section, '#touchup-undo')).disabled = touchUps.length === 0;
  /** @type {HTMLButtonElement} */ (q(section, '#touchup-clear-frame')).disabled = onFrame === 0;
  /** @type {HTMLButtonElement} */ (q(section, '#touchup-clear-all')).disabled =
    touchUps.length === 0;

  // A button that disables itself when used (the last stroke undone or
  // cleared) would drop focus to <body>: keep it on the brush toggle
  if (
    focused instanceof HTMLButtonElement &&
    section.contains(focused) &&
    focused.disabled &&
    !brushInput.disabled
  ) {
    const active = document.activeElement;
    if (active === focused || active === null || active === document.body) brushInput.focus();
  }
}
