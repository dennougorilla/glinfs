/**
 * Editor "Text" and "Background" property panels.
 *
 * Built once per editor render; state changes are applied with
 * updateEditsPanel(), which patches control values and the layer list in
 * place (no rebuild per keystroke, and a focused textarea never has its
 * value — and caret — reset while the user types).
 *
 * Toggles are checkboxes/radios rather than aria-pressed buttons: the form
 * controls are "editable" to the hotkey dispatcher, so Space on a focused
 * toggle flips it instead of toggling playback.
 *
 * @module features/editor/panels/edits-panel
 */

import { EDIT_LIMITS } from '../../../shared/edits/model.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';

/** @typedef {import('../../../shared/edits/model.js').TextLayer} TextLayer */

/** @type {{ value: import('../../../shared/edits/model.js').TextFont, label: string }[]} */
const FONT_OPTIONS = [
  { value: 'sans', label: 'Sans-serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Monospace' },
  { value: 'impact', label: 'Impact' },
];

/** @type {{ value: import('../../../shared/edits/model.js').TextAlign, label: string }[]} */
const ALIGN_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

/** @type {{ value: import('../../../shared/edits/model.js').BackgroundMode, label: string }[]} */
const MODE_OPTIONS = [
  { value: 'connected', label: 'Edges only' },
  { value: 'global', label: 'All matching' },
];

/** Color used for a new box when the layer has none */
const DEFAULT_BOX_COLOR = '#000000';

/**
 * Label text of a layer in the list: its first line, or a placeholder
 * @param {TextLayer} layer
 * @returns {string}
 */
export function getTextLayerLabel(layer) {
  const firstLine = layer.text.split('\n').find((line) => line.trim() !== '');
  return firstLine ? firstLine.trim() : '(empty)';
}

/**
 * Labelled control row
 * @param {string} forId
 * @param {string} label
 * @param {(HTMLElement | string)[]} controls
 * @returns {HTMLElement}
 */
function fieldRow(forId, label, controls) {
  return createElement('div', { className: 'editor-text-field' }, [
    createElement('label', { className: 'editor-text-field-label', for: forId }, [label]),
    createElement('div', { className: 'editor-text-field-control' }, controls),
  ]);
}

/**
 * Checkbox with its label wrapped around it
 * @param {string} id
 * @param {string} label
 * @param {string} className
 * @returns {{ wrapper: HTMLElement, input: HTMLInputElement }}
 */
function checkbox(id, label, className) {
  const input = /** @type {HTMLInputElement} */ (createElement('input', { type: 'checkbox', id }));
  const wrapper = createElement('label', { className, for: id }, [input, label]);
  return { wrapper, input };
}

/**
 * Range input with a live value readout
 * @param {string} id
 * @param {number} min
 * @param {number} max
 * @returns {{ input: HTMLInputElement, output: HTMLOutputElement }}
 */
function range(id, min, max) {
  const input = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      id,
      min: String(min),
      max: String(max),
      step: '1',
    })
  );
  const output = /** @type {HTMLOutputElement} */ (
    createElement('output', { id: `${id}-value`, className: 'editor-text-value', for: id })
  );
  return { input, output };
}

/**
 * Set a form control's value only when it differs, so a focused control's
 * caret/selection is never reset by its own echo
 * @param {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} control
 * @param {string} value
 */
function setValue(control, value) {
  if (control.value !== value) control.value = value;
}

/**
 * @param {HTMLInputElement} control
 * @param {boolean} checked
 */
function setChecked(control, checked) {
  if (control.checked !== checked) control.checked = checked;
}

/**
 * Render the Text panel (goes inside the "Text" accordion)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderTextPanel(handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];
  const getState = () => handlers.getState?.() ?? null;
  const selectedId = () => getState()?.selectedTextId ?? null;

  /**
   * Patch the selected layer
   * @param {Partial<TextLayer>} patch
   */
  const patchSelected = (patch) => {
    const id = selectedId();
    if (id) handlers.onUpdateText?.(id, patch);
  };

  const addBtn = createElement(
    'button',
    { type: 'button', id: 'text-add', className: 'btn btn-secondary editor-text-add' },
    ['Add text'],
  );
  cleanups.push(on(addBtn, 'click', () => handlers.onAddText?.()));

  const list = createElement('ul', {
    id: 'text-layer-list',
    className: 'editor-text-list',
    'aria-label': 'Text layers',
  });
  const empty = createElement('p', { className: 'editor-text-empty' }, [
    'No text yet. Add a caption, then drag it on the preview.',
  ]);

  // Layer list: delegated so rebuilt items need no listeners of their own
  cleanups.push(
    on(list, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const item = target?.closest('[data-layer-id]');
      if (!(item instanceof HTMLElement)) return;
      const id = /** @type {string} */ (item.dataset.layerId);
      if (target?.closest('.editor-text-item-delete')) {
        handlers.onRemoveText?.(id);
      } else if (target?.closest('.editor-text-item-select')) {
        handlers.onSelectText?.(id);
      }
    }),
  );

  // --- Selected layer editor ---
  const textInput = /** @type {HTMLTextAreaElement} */ (
    createElement('textarea', {
      id: 'text-layer-text',
      className: 'editor-text-input',
      rows: '2',
      spellcheck: 'false',
    })
  );
  cleanups.push(on(textInput, 'input', () => patchSelected({ text: textInput.value })));

  const fontSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      { id: 'text-layer-font', className: 'editor-text-select' },
      FONT_OPTIONS.map((opt) => createElement('option', { value: opt.value }, [opt.label])),
    )
  );
  cleanups.push(
    on(fontSelect, 'change', () =>
      patchSelected({ font: /** @type {TextLayer['font']} */ (fontSelect.value) }),
    ),
  );

  const bold = checkbox('text-layer-bold', 'Bold', 'editor-text-check');
  cleanups.push(on(bold.input, 'change', () => patchSelected({ bold: bold.input.checked })));

  const size = range(
    'text-layer-size',
    Math.round(EDIT_LIMITS.size.min * 100),
    Math.round(EDIT_LIMITS.size.max * 100),
  );
  cleanups.push(
    on(size.input, 'input', () => patchSelected({ size: Number(size.input.value) / 100 })),
  );

  const colorInput = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'color',
      id: 'text-layer-color',
      className: 'editor-text-color',
    })
  );
  cleanups.push(on(colorInput, 'input', () => patchSelected({ color: colorInput.value })));

  const outlineColor = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'color',
      id: 'text-layer-outline-color',
      className: 'editor-text-color',
    })
  );
  cleanups.push(
    on(outlineColor, 'input', () => patchSelected({ outlineColor: outlineColor.value })),
  );

  const outlineWidth = range(
    'text-layer-outline-width',
    0,
    Math.round(EDIT_LIMITS.outlineWidth.max * 100),
  );
  cleanups.push(
    on(outlineWidth.input, 'input', () =>
      patchSelected({ outlineWidth: Number(outlineWidth.input.value) / 100 }),
    ),
  );

  const box = checkbox('text-layer-box', 'Background box', 'editor-text-check');
  const boxColor = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'color',
      id: 'text-layer-box-color',
      className: 'editor-text-color',
    })
  );
  cleanups.push(
    on(box.input, 'change', () =>
      patchSelected({ boxColor: box.input.checked ? boxColor.value || DEFAULT_BOX_COLOR : null }),
    ),
    on(boxColor, 'input', () => {
      // Picking a box color turns the box on
      patchSelected({ boxColor: boxColor.value });
    }),
  );
  const boxOpacity = range('text-layer-box-opacity', 0, 100);
  cleanups.push(
    on(boxOpacity.input, 'input', () =>
      patchSelected({ boxOpacity: Number(boxOpacity.input.value) / 100 }),
    ),
  );

  const alignInputs = ALIGN_OPTIONS.map((opt) => {
    const input = /** @type {HTMLInputElement} */ (
      createElement('input', {
        type: 'radio',
        name: 'text-layer-align',
        id: `text-layer-align-${opt.value}`,
        value: opt.value,
      })
    );
    cleanups.push(
      on(input, 'change', () => {
        if (input.checked) patchSelected({ align: opt.value });
      }),
    );
    return { input, label: opt.label, value: opt.value };
  });
  const alignGroup = createElement(
    'fieldset',
    { className: 'editor-text-fieldset editor-text-align' },
    [
      createElement('legend', { className: 'editor-text-field-label' }, ['Alignment']),
      createElement(
        'div',
        { className: 'editor-text-segmented' },
        alignInputs.map(({ input, label, value }) =>
          createElement(
            'label',
            { className: 'editor-text-segment', for: `text-layer-align-${value}` },
            [input, createElement('span', {}, [label])],
          ),
        ),
      ),
    ],
  );

  // Timing: absolute clip frames, shown as timecodes
  const startOut = createElement('output', {
    id: 'text-layer-start',
    className: 'editor-text-time',
  });
  const endOut = createElement('output', { id: 'text-layer-end', className: 'editor-text-time' });
  const startBtn = createElement(
    'button',
    {
      type: 'button',
      id: 'text-layer-start-playhead',
      className: 'btn btn-ghost editor-text-time-btn',
      'aria-label': 'Set start to playhead',
    },
    ['Set to playhead'],
  );
  const endBtn = createElement(
    'button',
    {
      type: 'button',
      id: 'text-layer-end-playhead',
      className: 'btn btn-ghost editor-text-time-btn',
      'aria-label': 'Set end to playhead',
    },
    ['Set to playhead'],
  );
  const wholeBtn = createElement(
    'button',
    {
      type: 'button',
      id: 'text-layer-whole-clip',
      className: 'btn btn-ghost editor-text-time-btn',
    },
    ['Whole clip'],
  );
  cleanups.push(
    on(startBtn, 'click', () => {
      const state = getState();
      if (state) patchSelected({ start: state.currentFrame });
    }),
    on(endBtn, 'click', () => {
      const state = getState();
      const layer = state?.edits.textLayers.find((l) => l.id === state.selectedTextId);
      if (!state || !layer) return;
      // An end before the start moves both, so the layer lands on the playhead
      patchSelected(
        state.currentFrame < layer.start
          ? { start: state.currentFrame, end: state.currentFrame }
          : { end: state.currentFrame },
      );
    }),
    on(wholeBtn, 'click', () => {
      const state = getState();
      if (state?.clip) patchSelected({ start: 0, end: state.clip.frames.length - 1 });
    }),
  );
  const timing = createElement(
    'fieldset',
    { className: 'editor-text-fieldset editor-text-timing' },
    [
      createElement('legend', { className: 'editor-text-field-label' }, ['Timing']),
      createElement('div', { className: 'editor-text-time-row' }, [
        createElement('span', { className: 'editor-text-time-label' }, ['Start']),
        startOut,
        startBtn,
      ]),
      createElement('div', { className: 'editor-text-time-row' }, [
        createElement('span', { className: 'editor-text-time-label' }, ['End']),
        endOut,
        endBtn,
      ]),
      wholeBtn,
    ],
  );

  const layerEditor = createElement(
    'div',
    { id: 'text-layer-editor', className: 'editor-text-editor', hidden: 'true' },
    [
      fieldRow('text-layer-text', 'Text', [textInput]),
      fieldRow('text-layer-font', 'Font', [fontSelect]),
      bold.wrapper,
      fieldRow('text-layer-size', 'Size', [size.input, size.output]),
      fieldRow('text-layer-color', 'Fill', [colorInput]),
      fieldRow('text-layer-outline-color', 'Outline', [outlineColor]),
      fieldRow('text-layer-outline-width', 'Outline width', [
        outlineWidth.input,
        outlineWidth.output,
      ]),
      box.wrapper,
      fieldRow('text-layer-box-color', 'Box color', [boxColor]),
      fieldRow('text-layer-box-opacity', 'Box opacity', [boxOpacity.input, boxOpacity.output]),
      alignGroup,
      timing,
    ],
  );

  const element = createElement(
    'div',
    { className: 'property-group editor-text-panel', 'data-edits-panel': 'text' },
    [
      createElement('div', { className: 'property-group-title' }, ['Text']),
      addBtn,
      list,
      empty,
      layerEditor,
    ],
  );

  return { element, cleanups };
}

/**
 * Render the Background panel (goes inside the "Background" accordion)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderBackgroundPanel(handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  const enabled = checkbox('background-enabled', 'Remove background', 'editor-bg-check');
  cleanups.push(
    on(enabled.input, 'change', () => handlers.onToggleBackground?.(enabled.input.checked)),
  );

  const colorInput = /** @type {HTMLInputElement} */ (
    createElement('input', { type: 'color', id: 'background-color', className: 'editor-bg-color' })
  );
  cleanups.push(
    on(colorInput, 'input', () => handlers.onSetBackground?.({ color: colorInput.value })),
  );

  // Eyedropper toggle: a checkbox styled as a button (see module doc)
  const pick = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'checkbox',
      id: 'background-pick',
      className: 'editor-bg-pick-input',
    })
  );
  const pickLabel = createElement(
    'label',
    { className: 'editor-bg-pick', for: 'background-pick' },
    [pick, createElement('span', {}, ['Pick from preview'])],
  );
  cleanups.push(on(pick, 'change', () => handlers.onSetPickingKeyColor?.(pick.checked)));

  const tolerance = range(
    'background-tolerance',
    EDIT_LIMITS.tolerance.min,
    EDIT_LIMITS.tolerance.max,
  );
  cleanups.push(
    on(tolerance.input, 'input', () =>
      handlers.onSetBackground?.({ tolerance: Number(tolerance.input.value) }),
    ),
  );

  const mode = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      { id: 'background-mode', className: 'editor-bg-select' },
      MODE_OPTIONS.map((opt) => createElement('option', { value: opt.value }, [opt.label])),
    )
  );
  cleanups.push(
    on(mode, 'change', () =>
      handlers.onSetBackground?.({
        mode: /** @type {import('../../../shared/edits/model.js').BackgroundMode} */ (mode.value),
      }),
    ),
  );

  const pickStatus = createElement('p', {
    className: 'editor-bg-status',
    id: 'background-pick-status',
    role: 'status',
  });

  const alphaNote = createElement(
    'p',
    { className: 'editor-bg-note', id: 'background-alpha-note', hidden: 'true' },
    ['This clip already has transparent areas. They stay transparent in the exported GIF.'],
  );

  const element = createElement(
    'div',
    { className: 'property-group editor-bg-panel', 'data-edits-panel': 'background' },
    [
      createElement('div', { className: 'property-group-title' }, ['Background']),
      enabled.wrapper,
      createElement('div', { className: 'editor-text-field' }, [
        createElement('label', { className: 'editor-text-field-label', for: 'background-color' }, [
          'Key color',
        ]),
        createElement('div', { className: 'editor-text-field-control' }, [colorInput, pickLabel]),
      ]),
      pickStatus,
      createElement('div', { className: 'editor-text-field' }, [
        createElement(
          'label',
          { className: 'editor-text-field-label', for: 'background-tolerance' },
          ['Tolerance'],
        ),
        createElement('div', { className: 'editor-text-field-control' }, [
          tolerance.input,
          tolerance.output,
        ]),
      ]),
      createElement('div', { className: 'editor-text-field' }, [
        createElement('label', { className: 'editor-text-field-label', for: 'background-mode' }, [
          'Remove',
        ]),
        createElement('div', { className: 'editor-text-field-control' }, [mode]),
      ]),
      createElement('p', { className: 'editor-bg-hint' }, [
        'GIF transparency is on or off per pixel: removed pixels become fully transparent, everything else stays opaque.',
      ]),
      alphaNote,
    ],
  );

  return { element, cleanups };
}

/**
 * Query a required element inside the panel root
 * @template {Element} T
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {T | null}
 */
function q(root, selector) {
  return /** @type {T | null} */ (root.querySelector(selector));
}

/**
 * Rebuild the layer list only when its layers changed order/membership;
 * otherwise patch labels and the selection in place
 * @param {HTMLElement} list
 * @param {TextLayer[]} layers
 * @param {string | null} selectedId
 */
function updateLayerList(list, layers, selectedId) {
  const items = Array.from(list.children);
  const sameIds =
    items.length === layers.length &&
    items.every((item, i) => /** @type {HTMLElement} */ (item).dataset.layerId === layers[i].id);

  if (!sameIds) {
    list.replaceChildren(
      ...layers.map((layer) =>
        createElement('li', { className: 'editor-text-item', 'data-layer-id': layer.id }, [
          createElement('button', { type: 'button', className: 'editor-text-item-select' }, ['']),
          createElement('button', { type: 'button', className: 'editor-text-item-delete' }, ['×']),
        ]),
      ),
    );
  }

  layers.forEach((layer, i) => {
    const item = /** @type {HTMLElement} */ (list.children[i]);
    const label = getTextLayerLabel(layer);
    const selectBtn = /** @type {HTMLElement} */ (item.querySelector('.editor-text-item-select'));
    const deleteBtn = /** @type {HTMLElement} */ (item.querySelector('.editor-text-item-delete'));
    if (selectBtn.textContent !== label) selectBtn.textContent = label;
    const selected = layer.id === selectedId;
    item.classList.toggle('editor-text-item--selected', selected);
    if (selected) {
      selectBtn.setAttribute('aria-current', 'true');
    } else {
      selectBtn.removeAttribute('aria-current');
    }
    deleteBtn.setAttribute('aria-label', `Delete text layer "${label}"`);
  });
}

/**
 * Apply editor state to the Text and Background panels in place
 * @param {ParentNode} container - Editor container (or any ancestor of the panels)
 * @param {import('../types.js').EditorState} state
 * @param {number} fps - Clip fps (timecodes)
 */
export function updateEditsPanel(container, state, fps) {
  updateTextPanel(container, state, fps);
  updateBackgroundPanel(container, state);
}

/**
 * @param {ParentNode} container
 * @param {import('../types.js').EditorState} state
 * @param {number} fps
 */
function updateTextPanel(container, state, fps) {
  const root = q(container, '[data-edits-panel="text"]');
  if (!root || !state.edits) return;

  const layers = state.edits.textLayers;
  const list = /** @type {HTMLElement} */ (q(root, '#text-layer-list'));
  updateLayerList(list, layers, state.selectedTextId);
  list.hidden = layers.length === 0;
  /** @type {HTMLElement} */ (q(root, '.editor-text-empty')).hidden = layers.length > 0;

  const editor = /** @type {HTMLElement} */ (q(root, '#text-layer-editor'));
  const layer = layers.find((l) => l.id === state.selectedTextId);
  editor.hidden = !layer;
  if (!layer) return;

  setValue(/** @type {HTMLTextAreaElement} */ (q(root, '#text-layer-text')), layer.text);
  setValue(/** @type {HTMLSelectElement} */ (q(root, '#text-layer-font')), layer.font);
  setChecked(/** @type {HTMLInputElement} */ (q(root, '#text-layer-bold')), layer.bold);

  const sizePct = String(Math.round(layer.size * 100));
  setValue(/** @type {HTMLInputElement} */ (q(root, '#text-layer-size')), sizePct);
  /** @type {HTMLElement} */ (q(root, '#text-layer-size-value')).textContent = `${sizePct}%`;

  setValue(/** @type {HTMLInputElement} */ (q(root, '#text-layer-color')), layer.color);
  setValue(
    /** @type {HTMLInputElement} */ (q(root, '#text-layer-outline-color')),
    layer.outlineColor,
  );
  const outlinePct = String(Math.round(layer.outlineWidth * 100));
  setValue(/** @type {HTMLInputElement} */ (q(root, '#text-layer-outline-width')), outlinePct);
  /** @type {HTMLElement} */ (q(root, '#text-layer-outline-width-value')).textContent =
    `${outlinePct}%`;

  setChecked(/** @type {HTMLInputElement} */ (q(root, '#text-layer-box')), layer.boxColor !== null);
  const boxColor = /** @type {HTMLInputElement} */ (q(root, '#text-layer-box-color'));
  setValue(boxColor, layer.boxColor ?? DEFAULT_BOX_COLOR);
  const boxOpacityPct = String(Math.round(layer.boxOpacity * 100));
  const boxOpacity = /** @type {HTMLInputElement} */ (q(root, '#text-layer-box-opacity'));
  setValue(boxOpacity, boxOpacityPct);
  /** @type {HTMLElement} */ (q(root, '#text-layer-box-opacity-value')).textContent =
    `${boxOpacityPct}%`;
  boxOpacity.disabled = layer.boxColor === null;

  for (const opt of ALIGN_OPTIONS) {
    setChecked(
      /** @type {HTMLInputElement} */ (q(root, `#text-layer-align-${opt.value}`)),
      layer.align === opt.value,
    );
  }

  const startOut = /** @type {HTMLElement} */ (q(root, '#text-layer-start'));
  const endOut = /** @type {HTMLElement} */ (q(root, '#text-layer-end'));
  startOut.textContent = frameToTimecode(layer.start, fps);
  startOut.dataset.frame = String(layer.start);
  endOut.textContent = frameToTimecode(layer.end, fps);
  endOut.dataset.frame = String(layer.end);
}

/**
 * @param {ParentNode} container
 * @param {import('../types.js').EditorState} state
 */
function updateBackgroundPanel(container, state) {
  const root = q(container, '[data-edits-panel="background"]');
  if (!root || !state.edits) return;
  const { background } = state.edits;

  setChecked(/** @type {HTMLInputElement} */ (q(root, '#background-enabled')), background.enabled);
  setValue(/** @type {HTMLInputElement} */ (q(root, '#background-color')), background.color);
  setChecked(/** @type {HTMLInputElement} */ (q(root, '#background-pick')), state.pickingKeyColor);
  q(root, '.editor-bg-pick')?.classList.toggle('editor-bg-pick--active', state.pickingKeyColor);
  const tolerance = String(Math.round(background.tolerance));
  setValue(/** @type {HTMLInputElement} */ (q(root, '#background-tolerance')), tolerance);
  /** @type {HTMLElement} */ (q(root, '#background-tolerance-value')).textContent = tolerance;
  setValue(/** @type {HTMLSelectElement} */ (q(root, '#background-mode')), background.mode);

  const status = /** @type {HTMLElement} */ (q(root, '#background-pick-status'));
  const message = state.pickingKeyColor
    ? 'Click the background in the preview. Press Escape to cancel.'
    : '';
  if (status.textContent !== message) status.textContent = message;

  /** @type {HTMLElement} */ (q(root, '#background-alpha-note')).hidden = !state.clip?.hasAlpha;
}
