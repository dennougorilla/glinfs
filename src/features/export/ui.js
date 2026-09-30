/**
 * Export dialog UI: the dialog shell and its views (settings, AI
 * preparation, encoding, result, error). Pure DOM building; the controller
 * in ./index.js owns the state and decides which view is shown.
 *
 * Every class is prefixed `export-` and styled under the `.export-dialog`
 * root (src/styles/export.css), so nothing here can restyle another screen.
 *
 * @module features/export/ui
 */

import { createElement, on } from '../../shared/utils/dom.js';
import {
  formatDurationPrecise,
  formatPercent,
  formatRemaining,
} from '../../shared/utils/format.js';
import { describeAnalysisProgress, getAnalysisFraction } from '../editor/ai-cutout.js';
import {
  ENCODER_PRESETS,
  getEffectiveEncoderId,
  getScaledDimensions,
  OUTPUT_SCALES,
} from './core.js';
import { BYTES_PER_MB, formatFileSize } from './size-planner.js';

/**
 * Static encoder definitions for UI display
 * @type {ReadonlyArray<{id: import('./encoders/types.js').EncoderId, name: string, description: string, isWasm: boolean}>}
 */
const ENCODER_OPTIONS = [
  {
    id: 'gifenc-js',
    name: 'gifenc (JavaScript)',
    description: 'Fast encoding with quality controls',
    isWasm: false,
  },
  {
    id: 'gifsicle-wasm',
    name: 'libimagequant (WASM)',
    description: 'Blazing fast, best quality color quantization',
    isWasm: true,
  },
];

/** Note shown on the disabled WASM encoder card for transparent exports */
export const TRANSPARENT_ENCODER_NOTE = 'Transparent GIFs use the JavaScript encoder';

/** Note shown on the disabled WASM encoder card while a target size is set */
export const TARGET_SIZE_ENCODER_NOTE = 'A target size uses the JavaScript encoder';

/** @type {readonly [1, 2, 3, 4, 5]} */
const FRAME_SKIP_OPTIONS = /** @type {const} */ ([1, 2, 3, 4, 5]);

/** Loop choices (NETSCAPE loop count: 0 = forever, n = repeat n more times) */
const LOOP_OPTIONS = [0, 1, 2, 3, 5, 10];

/**
 * @typedef {Object} ExportUIHandlers
 * @property {(settings: Partial<import('./types.js').ExportSettings>) => void} onSettingsChange
 * @property {() => void} onExport
 * @property {() => void} onCancel
 * @property {() => void} onDownload
 * @property {() => void} onOpenInTab
 * @property {() => void} [onCopy] - Copy the GIF (only offered when supported)
 * @property {() => void} onBackToEditing - Close the dialog
 * @property {() => void} onExportAgain - Result → settings
 * @property {() => void} onBackToSettings - Error → settings
 * @property {() => void} [onAiAllowWasm] - Explicit "Run without WebGPU" choice, then export
 * @property {() => void} [onAiBack] - Leave the AI preparation view for the settings
 */

/**
 * Preparation of an AI cutout export (analysis of frames that still lack a
 * mask, then the final masks)
 * @typedef {Object} ExportAiPrep
 * @property {'starting'|'downloading'|'verifying'|'initializing'|'analyzing'|'building'|'needs-wasm'|'error'} phase
 * @property {number} [loadedBytes]
 * @property {number} [totalBytes]
 * @property {boolean} [fromCache]
 * @property {number} [framesDone]
 * @property {number} [framesTotal]
 * @property {number | null} [remainingMs]
 * @property {number} [buildDone] - Final-mask build steps done
 * @property {number} [buildTotal]
 * @property {string} [message] - Error copy (phase 'error')
 * @property {boolean} [modelFailed] - Phase 'needs-wasm': WebGPU exists but
 *   the model could not run on it (else the browser has no WebGPU)
 * @property {string} [modelLabel] - Phase 'needs-wasm': the model's name
 */

/**
 * Clip facts the dialog displays
 * @typedef {Object} ExportClipInfo
 * @property {number} frameCount - Frames in the editor's selection
 * @property {number} width - Output width before the output scale (crop)
 * @property {number} height - Output height before the output scale
 * @property {number} duration - Seconds at 1x
 * @property {number} fps
 * @property {number} speed - The editor's playback speed (the GIF speed)
 * @property {boolean} [transparent] - The GIF will have transparent pixels
 *   (source alpha or background removal); only the JavaScript encoder can
 *   write them
 * @property {boolean} [aiCutout] - The export uses the AI cutout
 */

/**
 * Derived facts for the settings view (computed by the controller)
 * @typedef {Object} ExportSettingsFacts
 * @property {{ width: number, height: number }} output - GIF size after the scale
 * @property {number} gifFrames - Frames the GIF will have (after skip/merge)
 * @property {number} durationSeconds - Playback length of the GIF
 * @property {{ limited: boolean, effectiveSpeed: number }} speedLimit
 * @property {boolean} sizeLimited - A target size is set
 */

/**
 * Settings a target-size export ended up using, shown on the result
 * @typedef {Object} ExportTargetReport
 * @property {number} targetMB
 * @property {boolean} fits
 * @property {string} settingsText - e.g. "64 colors · every 2nd frame · 75 %"
 */

/**
 * Facts of the finished GIF
 * @typedef {Object} ExportResultInfo
 * @property {number} size - Bytes
 * @property {number} width
 * @property {number} height
 * @property {number | null} frameCount - Null when the GIF could not be read
 * @property {ExportTargetReport | null} [target]
 * @property {boolean} [canCopy] - The browser can put a GIF on the clipboard
 */

/**
 * Progress of a target-size export: estimating rungs, or encoding one
 * @typedef {Object} ExportSizeStep
 * @property {'estimate' | 'encode'} phase
 * @property {number} index
 * @property {number} total
 * @property {number} targetMB
 * @property {number} [attempt]
 * @property {number} [previousBytes]
 */

/** "0.5×" style speed label */
export function formatSpeed(/** @type {number} */ speed) {
  return `${Number(speed.toFixed(2))}×`;
}

/** "640×480" */
function formatDims(/** @type {{ width: number, height: number }} */ dims) {
  return `${dims.width}×${dims.height}`;
}

// ============================================================
// Shell
// ============================================================

/**
 * Build the dialog shell: a full-screen backdrop holding the dialog with its
 * title and Close button. The body is filled per view by renderDialogView.
 * @param {{ onClose: () => void }} handlers
 * @returns {{ backdrop: HTMLElement, dialog: HTMLElement, title: HTMLElement, closeButton: HTMLButtonElement, body: HTMLElement, cleanup: () => void }}
 */
export function createExportDialogShell(handlers) {
  const title = createElement(
    'h2',
    { id: 'export-dialog-title', className: 'export-dialog-title', tabindex: '-1' },
    ['Export GIF'],
  );
  const closeButton = /** @type {HTMLButtonElement} */ (
    createElement(
      'button',
      {
        type: 'button',
        className: 'export-dialog-close',
        id: 'export-dialog-close',
        'aria-label': 'Close',
        title: 'Close (Esc)',
      },
      ['×'],
    )
  );
  const body = createElement('div', { className: 'export-dialog-content' });
  const dialog = createElement(
    'div',
    {
      className: 'export-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'export-dialog-title',
      'data-testid': 'export-dialog',
    },
    [createElement('header', { className: 'export-dialog-header' }, [title, closeButton]), body],
  );
  const backdrop = createElement('div', { className: 'export-dialog-backdrop' }, [dialog]);
  const cleanup = on(closeButton, 'click', () => handlers.onClose());
  return { backdrop, dialog, title, closeButton, body, cleanup };
}

// ============================================================
// Views
// ============================================================

/**
 * Which view the dialog shows for a state
 * @param {import('./types.js').ExportState} state
 * @param {ExportAiPrep | null} aiPrep
 * @returns {'settings' | 'ai-prep' | 'encoding' | 'result' | 'error'}
 */
export function getDialogView(state, aiPrep) {
  if (aiPrep) return 'ai-prep';
  if (state.job?.status === 'encoding') return 'encoding';
  if (state.job?.status === 'complete' && state.job.result) return 'result';
  if (state.job?.status === 'error') return 'error';
  return 'settings';
}

/**
 * Whether the dialog is busy: an AI preparation or an encode is running.
 * Close and Escape are disabled then; Cancel is the only way out.
 * @param {import('./types.js').ExportState} state
 * @param {ExportAiPrep | null} aiPrep
 * @returns {boolean}
 */
export function isDialogBusy(state, aiPrep) {
  if (aiPrep) return aiPrep.phase !== 'needs-wasm' && aiPrep.phase !== 'error';
  return state.job?.status === 'encoding';
}

/**
 * @typedef {Object} DialogViewParams
 * @property {import('./types.js').ExportState} state
 * @property {ExportUIHandlers} handlers
 * @property {ExportClipInfo} clipInfo
 * @property {ExportSettingsFacts} facts
 * @property {ExportAiPrep | null} aiPrep
 * @property {ExportSizeStep | null} sizeStep
 * @property {ExportResultInfo | null} resultInfo
 */

/**
 * Render the view for the current state into the dialog body
 * @param {HTMLElement} body
 * @param {DialogViewParams} params
 * @returns {{ cleanup: () => void, view: ReturnType<typeof getDialogView>, focusTarget: HTMLElement | null }}
 */
export function renderDialogView(body, params) {
  /** @type {(() => void)[]} */
  const cleanups = [];
  const view = getDialogView(params.state, params.aiPrep);
  /** @type {HTMLElement} */
  let element;
  if (view === 'ai-prep') {
    element = renderAiPreparation(/** @type {ExportAiPrep} */ (params.aiPrep), params, cleanups);
  } else if (view === 'encoding') {
    element = renderEncodingProgress(params, cleanups);
  } else if (view === 'result') {
    element = renderResult(params, cleanups);
  } else if (view === 'error') {
    element = renderError(params, cleanups);
  } else {
    element = renderSettings(params, cleanups);
  }
  body.replaceChildren(element);
  const focusTarget = /** @type {HTMLElement | null} */ (body.querySelector('[data-autofocus]'));
  return {
    cleanup: () => {
      for (const fn of cleanups) fn();
    },
    view,
    focusTarget,
  };
}

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------

/**
 * A labelled row: label on the left, control on the right
 * @param {string} id - Control id (the label's `for`)
 * @param {string} label
 * @param {HTMLElement} control
 * @param {HTMLElement[]} [extra] - Hints under the row
 */
function settingRow(id, label, control, extra = []) {
  return createElement('div', { className: 'export-field' }, [
    createElement('label', { className: 'export-field-label', for: id }, [label]),
    control,
    ...extra,
  ]);
}

/**
 * @param {string} id
 * @param {string} title
 * @param {HTMLElement[]} children
 */
function section(id, title, children) {
  return createElement('section', { className: 'export-section', 'aria-labelledby': id }, [
    createElement('h3', { className: 'export-section-title', id }, [title]),
    ...children,
  ]);
}

/**
 * @param {Array<{ value: string, label: string }>} options
 * @param {string} value
 * @param {string} id
 * @returns {HTMLSelectElement}
 */
function select(options, value, id) {
  const element = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      { id, className: 'export-select' },
      options.map((option) => createElement('option', { value: option.value }, [option.label])),
    )
  );
  element.value = value;
  return element;
}

/**
 * @param {DialogViewParams} params
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderSettings(params, cleanups) {
  const { state, handlers, clipInfo, facts } = params;
  const settings = state.settings;
  const root = createElement('div', {
    className: 'export-view export-settings',
    id: 'export-settings',
  });

  // Summary: what will be exported
  const summary = createElement('div', { className: 'export-summary' }, [
    createElement('p', { className: 'export-summary-line', id: 'export-summary' }, [
      `${formatDims(facts.output)} · ${facts.gifFrames} frames · ${formatDurationPrecise(
        facts.durationSeconds,
      )} at ${formatSpeed(clipInfo.speed)}`,
    ]),
    ...(clipInfo.transparent
      ? [
          createElement(
            'span',
            {
              className: 'export-badge',
              'data-testid': 'export-transparency-badge',
              title: 'Removed or transparent pixels stay transparent in the GIF',
            },
            ['Transparent background'],
          ),
        ]
      : []),
  ]);
  root.appendChild(summary);

  const columns = createElement('div', { className: 'export-columns' });
  const left = createElement('div', { className: 'export-column' });
  const right = createElement('div', { className: 'export-column' });

  left.appendChild(renderEncoderSection(state, handlers, clipInfo, facts, cleanups));
  if (getEffectiveEncoderId(settings, clipInfo.transparent, facts.sizeLimited) === 'gifenc-js') {
    left.appendChild(renderQualitySection(state, handlers, cleanups));
  } else {
    left.appendChild(
      section('export-quality-heading', 'Quality', [
        createElement('p', { className: 'export-hint' }, [
          'libimagequant picks the colors automatically for the best quality. No manual adjustment needed.',
        ]),
      ]),
    );
  }
  right.appendChild(renderPlaybackSection(state, handlers, clipInfo, facts, cleanups));
  right.appendChild(renderSizeSection(state, handlers, clipInfo, cleanups));
  columns.append(left, right);
  root.appendChild(columns);

  // AI cutout: frames without a mask are analyzed before encoding
  if (clipInfo.aiCutout) {
    root.appendChild(
      createElement('p', {
        className: 'export-note',
        id: 'export-ai-note',
        role: 'status',
        hidden: 'true',
      }),
    );
  }

  const exportButton = createElement(
    'button',
    {
      type: 'button',
      className: 'btn btn-primary export-start',
      id: 'export-start',
      'data-autofocus': 'true',
    },
    ['Export GIF'],
  );
  cleanups.push(on(exportButton, 'click', handlers.onExport));
  root.appendChild(
    createElement('footer', { className: 'export-footer' }, [
      createElement('p', { className: 'export-estimate', id: 'export-estimate' }, [
        facts.sizeLimited && settings.targetSizeMB
          ? `Target ≤ ${formatFileSize(settings.targetSizeMB * BYTES_PER_MB)} (estimated ${formatFileSize(
              state.estimatedSizeMB * BYTES_PER_MB,
            )} with these settings)`
          : `Estimated size ≈ ${formatFileSize(state.estimatedSizeMB * BYTES_PER_MB)}`,
      ]),
      exportButton,
    ]),
  );
  return root;
}

/**
 * Encoder cards as a radio group. Transparent exports and target sizes can
 * only use the JavaScript encoder: the WASM card is shown disabled with a
 * note and the JS card as selected, without touching the stored preference.
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {ExportClipInfo} clipInfo
 * @param {ExportSettingsFacts} facts
 * @param {(() => void)[]} cleanups
 */
function renderEncoderSection(state, handlers, clipInfo, facts, cleanups) {
  const effective = getEffectiveEncoderId(state.settings, clipInfo.transparent, facts.sizeLimited);
  const forced = Boolean(clipInfo.transparent) || facts.sizeLimited;
  const cards = createElement('div', {
    className: 'export-encoder-cards',
    role: 'radiogroup',
    'aria-labelledby': 'export-encoder-heading',
  });
  for (const encoder of ENCODER_OPTIONS) {
    const selected = effective === encoder.id;
    const disabled = forced && encoder.isWasm;
    const inputId = `export-encoder-${encoder.id}`;
    const input = /** @type {HTMLInputElement} */ (
      createElement('input', {
        type: 'radio',
        name: 'export-encoder',
        id: inputId,
        className: 'export-encoder-radio',
        value: encoder.id,
        disabled: disabled ? 'true' : undefined,
      })
    );
    input.checked = selected;
    if (!disabled) {
      cleanups.push(
        on(input, 'change', () => {
          if (input.checked) handlers.onSettingsChange({ encoderId: encoder.id });
        }),
      );
    }
    const note = clipInfo.transparent ? TRANSPARENT_ENCODER_NOTE : TARGET_SIZE_ENCODER_NOTE;
    cards.appendChild(
      createElement(
        'label',
        {
          className: [
            'export-encoder-card',
            selected && 'export-encoder-card--selected',
            disabled && 'export-encoder-card--disabled',
          ]
            .filter(Boolean)
            .join(' '),
          for: inputId,
          'data-encoder-id': encoder.id,
          'aria-disabled': disabled ? 'true' : undefined,
        },
        [
          input,
          createElement('span', { className: 'export-encoder-head' }, [
            createElement('span', { className: 'export-encoder-name' }, [encoder.name]),
            createElement(
              'span',
              {
                className: `export-encoder-badge export-encoder-badge--${encoder.isWasm ? 'wasm' : 'js'}`,
              },
              [encoder.isWasm ? 'WASM' : 'JS'],
            ),
          ]),
          createElement('span', { className: 'export-encoder-description' }, [encoder.description]),
          ...(disabled
            ? [
                createElement(
                  'span',
                  {
                    className: 'export-encoder-note',
                    'data-testid': clipInfo.transparent
                      ? 'export-transparency-encoder-note'
                      : 'export-target-encoder-note',
                  },
                  [note],
                ),
              ]
            : []),
        ],
      ),
    );
  }
  return section('export-encoder-heading', 'Encoder', [cards]);
}

/**
 * gifenc quality controls
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 */
function renderQualitySection(state, handlers, cleanups) {
  const settings = state.settings;
  const qualityValue = createElement(
    'output',
    {
      className: 'export-field-value',
      for: 'export-quality',
      id: 'export-quality-value',
    },
    [`${Math.round(settings.quality * 100)}%`],
  );
  const quality = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      id: 'export-quality',
      className: 'export-range',
      min: '0.1',
      max: '1.0',
      step: '0.1',
    })
  );
  quality.value = String(settings.quality);
  cleanups.push(
    on(quality, 'input', () => {
      qualityValue.textContent = `${Math.round(Number(quality.value) * 100)}%`;
    }),
    on(quality, 'change', () => handlers.onSettingsChange({ quality: Number(quality.value) })),
  );

  const preset = select(
    ENCODER_PRESETS.map((p) => ({ value: p.id, label: p.name })),
    settings.encoderPreset,
    'export-preset',
  );
  const presetHint = createElement('p', { className: 'export-hint', id: 'export-preset-hint' }, [
    ENCODER_PRESETS.find((p) => p.id === settings.encoderPreset)?.description ?? '',
  ]);
  cleanups.push(
    on(preset, 'change', () => {
      const chosen = ENCODER_PRESETS.find((p) => p.id === preset.value);
      if (chosen) presetHint.textContent = chosen.description;
      handlers.onSettingsChange({
        encoderPreset: /** @type {import('./types.js').EncoderPreset} */ (preset.value),
      });
    }),
  );

  const dither = /** @type {HTMLInputElement} */ (
    createElement('input', { type: 'checkbox', id: 'export-dither', className: 'export-checkbox' })
  );
  dither.checked = settings.dithering;
  cleanups.push(
    on(dither, 'change', () => handlers.onSettingsChange({ dithering: dither.checked })),
  );

  return section('export-quality-heading', 'Quality', [
    createElement('div', { className: 'export-field' }, [
      createElement('label', { className: 'export-field-label', for: 'export-quality' }, [
        'Quality',
      ]),
      qualityValue,
      quality,
    ]),
    settingRow('export-preset', 'Preset', preset, [presetHint]),
    createElement('div', { className: 'export-check' }, [
      dither,
      createElement('label', { for: 'export-dither' }, ['Dithering']),
      createElement('span', { className: 'export-hint' }, [
        'Smoother gradients, slightly larger files',
      ]),
    ]),
  ]);
}

/**
 * Frame rate (frame skip), loop count and the speed set in the editor
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {ExportClipInfo} clipInfo
 * @param {ExportSettingsFacts} facts
 * @param {(() => void)[]} cleanups
 */
function renderPlaybackSection(state, handlers, clipInfo, facts, cleanups) {
  const settings = state.settings;
  const frameRate = select(
    FRAME_SKIP_OPTIONS.map((skip) => {
      const fps = Math.round((clipInfo.fps / skip) * 10) / 10;
      const frames = Math.ceil(clipInfo.frameCount / skip);
      const which =
        skip === 1
          ? 'Every frame'
          : `Every ${skip === 2 ? '2nd' : skip === 3 ? '3rd' : `${skip}th`} frame`;
      return { value: String(skip), label: `${which} · ${fps} fps (${frames})` };
    }),
    String(settings.frameSkip),
    'export-frame-skip',
  );
  cleanups.push(
    on(frameRate, 'change', () =>
      handlers.onSettingsChange({
        frameSkip: /** @type {1|2|3|4|5} */ (Number(frameRate.value)),
      }),
    ),
  );

  const loopValues = LOOP_OPTIONS.includes(settings.loopCount)
    ? LOOP_OPTIONS
    : [...LOOP_OPTIONS, settings.loopCount].sort((a, b) => a - b);
  const loop = select(
    loopValues.map((count) => ({
      value: String(count),
      label: count === 0 ? 'Forever' : count === 1 ? 'Repeat once' : `Repeat ${count} times`,
    })),
    String(settings.loopCount),
    'export-loop',
  );
  cleanups.push(
    on(loop, 'change', () => handlers.onSettingsChange({ loopCount: Number(loop.value) })),
  );

  const speedNote = createElement(
    'p',
    {
      className: 'export-note export-note--warning',
      id: 'export-speed-note',
      role: 'status',
      hidden: facts.speedLimit.limited ? undefined : 'true',
    },
    facts.speedLimit.limited
      ? [
          `GIF frames can't be shorter than 0.02 s, so at ${formatSpeed(clipInfo.speed)} this GIF plays at about ${formatSpeed(
            facts.speedLimit.effectiveSpeed,
          )}. Skipping frames keeps it faster.`,
        ]
      : [],
  );

  return section('export-playback-heading', 'Playback', [
    settingRow('export-frame-skip', 'Frame rate', frameRate),
    settingRow('export-loop', 'Loop', loop),
    createElement('div', { className: 'export-field' }, [
      createElement('span', { className: 'export-field-label' }, ['Speed']),
      createElement('span', { className: 'export-field-value', id: 'export-speed' }, [
        formatSpeed(clipInfo.speed),
      ]),
      createElement('p', { className: 'export-hint' }, ['Set in the editor’s Playback panel']),
    ]),
    speedNote,
  ]);
}

/**
 * Output scale and target file size
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {ExportClipInfo} clipInfo
 * @param {(() => void)[]} cleanups
 */
function renderSizeSection(state, handlers, clipInfo, cleanups) {
  const settings = state.settings;
  const currentScale = settings.scale ?? 1;
  const scale = select(
    OUTPUT_SCALES.map((option) => ({
      value: String(option.value),
      label: `${option.label} (${formatDims(
        getScaledDimensions(clipInfo.width, clipInfo.height, option.value),
      )})`,
    })),
    String(currentScale),
    'export-scale',
  );
  cleanups.push(
    on(scale, 'change', () => handlers.onSettingsChange({ scale: Number(scale.value) })),
  );

  const targetOn = settings.targetSizeMB !== null && settings.targetSizeMB !== undefined;
  const enabled = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'checkbox',
      id: 'export-target-enabled',
      className: 'export-checkbox',
    })
  );
  enabled.checked = targetOn;
  const amount = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'number',
      id: 'export-target-mb',
      className: 'export-number',
      min: '0.1',
      step: '0.1',
      inputmode: 'decimal',
      'aria-label': 'Target size in MB',
      disabled: targetOn ? undefined : 'true',
    })
  );
  amount.value = String(targetOn ? settings.targetSizeMB : lastTargetSuggestion(state));
  const commitAmount = () => {
    const n = Number(amount.value);
    if (Number.isFinite(n) && n > 0) {
      handlers.onSettingsChange({ targetSizeMB: Math.round(n * 100) / 100 });
    } else {
      amount.value = String(settings.targetSizeMB ?? lastTargetSuggestion(state));
    }
  };
  cleanups.push(
    on(enabled, 'change', () => {
      if (enabled.checked) {
        const n = Number(amount.value);
        handlers.onSettingsChange({
          targetSizeMB: Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 1,
        });
      } else {
        handlers.onSettingsChange({ targetSizeMB: null });
      }
    }),
    on(amount, 'change', commitAmount),
  );

  return section('export-size-heading', 'Size', [
    settingRow('export-scale', 'Scale', scale),
    createElement('div', { className: 'export-field export-target' }, [
      createElement('div', { className: 'export-check' }, [
        enabled,
        createElement('label', { for: 'export-target-enabled' }, ['Target size']),
      ]),
      createElement('div', { className: 'export-target-amount' }, [
        amount,
        createElement('span', { className: 'export-unit', 'aria-hidden': 'true' }, ['MB']),
      ]),
    ]),
    createElement('p', { className: 'export-hint', id: 'export-target-note' }, [
      targetOn
        ? 'Colors, frames and then the scale are lowered as needed to fit. Uses the JavaScript encoder.'
        : 'Off. Turn on to fit the GIF under a file size (for chat apps with upload limits).',
    ]),
  ]);
}

/**
 * The number the target field starts with when it is off: half the
 * estimate, rounded to a friendly value (at least 0.5 MB)
 * @param {import('./types.js').ExportState} state
 * @returns {number}
 */
function lastTargetSuggestion(state) {
  const half = state.estimatedSizeMB / 2;
  if (!(half > 0)) return 2;
  if (half < 1) return Math.max(0.5, Math.round(half * 10) / 10);
  return Math.round(half);
}

/**
 * Show how many exported frames the AI cutout still has to analyze
 * @param {ParentNode} container
 * @param {number} missing - Exported frames without a mask
 * @param {number} total - Exported frames
 * @param {boolean} [click] - Click to select (frames are tracked, not analyzed)
 */
export function updateExportAiNote(container, missing, total, click = false) {
  const note = container.querySelector('#export-ai-note');
  if (!(note instanceof HTMLElement)) return;
  const [state, action] = click ? ['tracked', 'tracks'] : ['analyzed', 'analyzes'];
  const text =
    missing > 0
      ? `${missing} of ${total} frames are not ${state} yet. Export ${action} them first (the editor previews them without the cutout).`
      : '';
  if (note.textContent !== text) note.textContent = text;
  note.hidden = text === '';
}

// ------------------------------------------------------------
// AI preparation
// ------------------------------------------------------------

/**
 * One line describing the AI preparation
 * @param {ExportAiPrep} aiPrep
 * @returns {string}
 */
export function describeAiPreparation(aiPrep) {
  if (aiPrep.phase === 'building') {
    const total = aiPrep.buildTotal ?? 0;
    const pct = total > 0 ? Math.floor(((aiPrep.buildDone ?? 0) / total) * 100) : 0;
    return `Building the cutout: ${pct}%`;
  }
  return describeAnalysisProgress({
    phase: aiPrep.phase,
    loadedBytes: aiPrep.loadedBytes ?? 0,
    totalBytes: aiPrep.totalBytes ?? 0,
    fromCache: aiPrep.fromCache,
    framesDone: aiPrep.framesDone ?? 0,
    framesTotal: aiPrep.framesTotal ?? 0,
    remainingMs: aiPrep.remainingMs ?? null,
  });
}

/**
 * Progress bar value (0..1) of the AI preparation, or null for indeterminate
 * @param {ExportAiPrep} aiPrep
 * @returns {number | null}
 */
function getAiPreparationFraction(aiPrep) {
  if (aiPrep.phase === 'building') {
    const total = aiPrep.buildTotal ?? 0;
    return total > 0 ? (aiPrep.buildDone ?? 0) / total : null;
  }
  if (aiPrep.phase === 'downloading' || aiPrep.phase === 'analyzing') {
    return getAnalysisFraction({
      phase: aiPrep.phase,
      loadedBytes: aiPrep.loadedBytes ?? 0,
      totalBytes: aiPrep.totalBytes ?? 0,
      framesDone: aiPrep.framesDone ?? 0,
      framesTotal: aiPrep.framesTotal ?? 0,
    });
  }
  return null;
}

/**
 * The AI cutout preparation (progress, the no-WebGPU choice, or an error)
 * @param {ExportAiPrep} aiPrep
 * @param {DialogViewParams} params
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderAiPreparation(aiPrep, params, cleanups) {
  const { handlers } = params;
  const root = createElement('div', {
    className: 'export-view export-ai-prep',
    id: 'export-ai-prep',
  });

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} className
   * @param {(() => void) | undefined} onClick
   * @param {boolean} [autofocus]
   */
  const button = (id, label, className, onClick, autofocus = false) => {
    const btn = createElement(
      'button',
      { type: 'button', id, className, 'data-autofocus': autofocus ? 'true' : undefined },
      [label],
    );
    if (onClick) cleanups.push(on(btn, 'click', onClick));
    return btn;
  };
  const back = () =>
    button('export-ai-back', 'Back to settings', 'btn btn-ghost', handlers.onAiBack);

  if (aiPrep.phase === 'needs-wasm') {
    const slow =
      'It can run on the CPU instead, but that is very slow (about 14 seconds per frame).';
    const model = aiPrep.modelLabel ? `The ${aiPrep.modelLabel} model` : 'This model';
    root.append(
      createElement('h3', { className: 'export-view-title' }, [
        aiPrep.modelFailed ? `${model} could not run on WebGPU` : 'WebGPU is not available',
      ]),
      createElement('p', { className: 'export-text', role: 'alert' }, [
        aiPrep.modelFailed
          ? `Some frames still need the AI analysis. ${model} could not run on WebGPU in this browser. ${slow}`
          : `Some frames still need the AI analysis, which needs WebGPU in this browser. ${slow}`,
      ]),
      createElement('div', { className: 'export-actions' }, [
        button(
          'export-ai-run-wasm',
          'Run without WebGPU (very slow)',
          'btn btn-primary',
          handlers.onAiAllowWasm,
          true,
        ),
        back(),
      ]),
    );
    return root;
  }

  if (aiPrep.phase === 'error') {
    root.append(
      createElement('h3', { className: 'export-view-title' }, [
        'The AI cutout could not be prepared',
      ]),
      createElement('p', { className: 'export-text', role: 'alert' }, [
        aiPrep.message ?? 'The analysis failed.',
      ]),
      createElement('div', { className: 'export-actions' }, [
        button('export-ai-retry', 'Retry', 'btn btn-primary', handlers.onExport, true),
        back(),
      ]),
    );
    return root;
  }

  const bar = /** @type {HTMLProgressElement} */ (
    createElement('progress', {
      id: 'export-ai-progress-bar',
      className: 'export-progress-bar',
      max: '1',
      'aria-labelledby': 'export-ai-progress-text',
    })
  );
  const fraction = getAiPreparationFraction(aiPrep);
  if (fraction !== null) bar.value = fraction;
  root.append(
    createElement('h3', { className: 'export-view-title' }, ['Preparing the AI cutout']),
    createElement('p', { className: 'export-text' }, [
      'Frames that were not analyzed in the editor are analyzed now, on this device.',
    ]),
    createElement(
      'p',
      { className: 'export-progress-text', id: 'export-ai-progress-text', role: 'status' },
      [describeAiPreparation(aiPrep)],
    ),
    bar,
    createElement('div', { className: 'export-actions' }, [
      button('export-ai-cancel', 'Cancel', 'btn btn-secondary', handlers.onCancel, true),
    ]),
  );
  return root;
}

/**
 * Patch the AI preparation progress in place (same phase group)
 * @param {ParentNode} container
 * @param {ExportAiPrep} aiPrep
 */
export function updateAiPreparationUI(container, aiPrep) {
  const text = container.querySelector('#export-ai-progress-text');
  if (text) {
    const line = describeAiPreparation(aiPrep);
    if (text.textContent !== line) text.textContent = line;
  }
  const bar = container.querySelector('#export-ai-progress-bar');
  if (bar instanceof HTMLProgressElement) {
    const fraction = getAiPreparationFraction(aiPrep);
    if (fraction === null) {
      bar.removeAttribute('value');
    } else {
      bar.value = fraction;
    }
  }
}

// ------------------------------------------------------------
// Encoding
// ------------------------------------------------------------

/**
 * One line describing a target-size step, or '' without one
 * @param {ExportSizeStep | null} step
 * @returns {string}
 */
export function describeSizeStep(step) {
  if (!step) return '';
  const target = formatFileSize(step.targetMB * BYTES_PER_MB);
  if (step.phase === 'estimate') {
    return `Finding settings for ${target}: checking option ${step.index + 1} of ${step.total}`;
  }
  if ((step.attempt ?? 1) > 1 && step.previousBytes !== undefined) {
    return `${formatFileSize(step.previousBytes)} is still over ${target}. Trying smaller settings (attempt ${step.attempt})`;
  }
  return `Encoding to fit ${target}`;
}

/**
 * @param {DialogViewParams} params
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderEncodingProgress(params, cleanups) {
  const job = /** @type {import('./types.js').EncodingJob} */ (params.state.job);
  const bar = /** @type {HTMLProgressElement} */ (
    createElement('progress', {
      className: 'export-progress-bar',
      id: 'export-progress-bar',
      max: '100',
      'aria-labelledby': 'export-progress-title',
    })
  );
  const estimating = params.sizeStep?.phase === 'estimate';
  if (!estimating) bar.value = job.progress;

  const cancel = createElement(
    'button',
    {
      type: 'button',
      className: 'btn btn-secondary',
      id: 'export-cancel',
      'data-autofocus': 'true',
    },
    ['Cancel'],
  );
  cleanups.push(on(cancel, 'click', params.handlers.onCancel));

  return createElement('div', { className: 'export-view export-progress', id: 'export-progress' }, [
    createElement('h3', { className: 'export-view-title', id: 'export-progress-title' }, [
      'Creating your GIF…',
    ]),
    createElement(
      'p',
      {
        className: 'export-progress-text',
        id: 'export-progress-step',
        role: 'status',
        hidden: params.sizeStep ? undefined : 'true',
      },
      [describeSizeStep(params.sizeStep)],
    ),
    bar,
    createElement('div', { className: 'export-progress-info' }, [
      createElement('span', { id: 'export-progress-frames' }, [
        `${job.currentFrame} / ${job.totalFrames} frames`,
      ]),
      createElement(
        'span',
        { id: 'export-progress-percent', className: 'export-progress-percent' },
        [formatPercent(job.progress / 100)],
      ),
    ]),
    createElement('p', { className: 'export-hint', id: 'export-progress-time' }, [
      job.estimatedRemaining && job.estimatedRemaining > 0
        ? formatRemaining(job.estimatedRemaining)
        : '',
    ]),
    createElement('div', { className: 'export-actions' }, [cancel]),
  ]);
}

/**
 * Update the encoding progress in place
 * @param {ParentNode} container
 * @param {import('./types.js').EncodingJob} job
 */
export function updateProgressUI(container, job) {
  const bar = container.querySelector('#export-progress-bar');
  if (bar instanceof HTMLProgressElement) {
    bar.value = job.progress;
  }
  const frames = container.querySelector('#export-progress-frames');
  if (frames) frames.textContent = `${job.currentFrame} / ${job.totalFrames} frames`;
  const percent = container.querySelector('#export-progress-percent');
  if (percent) percent.textContent = formatPercent(job.progress / 100);
  const time = container.querySelector('#export-progress-time');
  if (time && job.estimatedRemaining) {
    time.textContent = formatRemaining(job.estimatedRemaining);
  }
}

/**
 * Update the target-size step line (and the bar: indeterminate while
 * estimating) in place
 * @param {ParentNode} container
 * @param {ExportSizeStep | null} step
 */
export function updateSizeStepUI(container, step) {
  const line = container.querySelector('#export-progress-step');
  if (line instanceof HTMLElement) {
    line.textContent = describeSizeStep(step);
    line.hidden = !step;
  }
  const bar = container.querySelector('#export-progress-bar');
  if (bar instanceof HTMLProgressElement && step?.phase === 'estimate') {
    bar.removeAttribute('value');
  }
}

// ------------------------------------------------------------
// Result
// ------------------------------------------------------------

/**
 * @param {DialogViewParams} params
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderResult(params, cleanups) {
  const { handlers } = params;
  const job = /** @type {import('./types.js').EncodingJob} */ (params.state.job);
  const blob = /** @type {Blob} */ (job.result);
  const info = params.resultInfo ?? {
    size: blob.size,
    width: 0,
    height: 0,
    frameCount: null,
  };

  const url = URL.createObjectURL(blob);
  cleanups.push(() => URL.revokeObjectURL(url));
  const img = createElement('img', {
    className: 'export-result-img',
    src: url,
    alt: 'The exported GIF',
  });

  /** @param {string} id @param {string} label @param {string} className @param {() => void} onClick @param {boolean} [autofocus] */
  const button = (id, label, className, onClick, autofocus = false) => {
    const btn = createElement(
      'button',
      { type: 'button', id, className, 'data-autofocus': autofocus ? 'true' : undefined },
      [label],
    );
    cleanups.push(on(btn, 'click', onClick));
    return btn;
  };

  /** @param {string} term @param {string} value @param {string} id */
  const fact = (term, value, id) =>
    createElement('div', { className: 'export-fact' }, [
      createElement('dt', {}, [term]),
      createElement('dd', { id }, [value]),
    ]);

  const target = info.target;
  return createElement('div', { className: 'export-view export-result', id: 'export-result' }, [
    createElement('div', { className: 'export-result-preview' }, [img]),
    createElement('div', { className: 'export-result-info' }, [
      createElement('h3', { className: 'export-view-title', id: 'export-result-title' }, [
        'Your GIF is ready',
      ]),
      createElement('dl', { className: 'export-facts' }, [
        fact('Size', formatFileSize(info.size), 'export-result-size'),
        fact('Dimensions', info.width > 0 ? formatDims(info) : '—', 'export-result-dimensions'),
        fact(
          'Frames',
          info.frameCount === null ? '—' : String(info.frameCount),
          'export-result-frames',
        ),
      ]),
      ...(target
        ? [
            createElement(
              'p',
              {
                className: `export-note${target.fits ? '' : ' export-note--warning'}`,
                id: 'export-result-target',
                role: 'status',
              },
              [
                target.fits
                  ? `Fits the ${formatFileSize(target.targetMB * BYTES_PER_MB)} target with ${target.settingsText}.`
                  : `Could not get under ${formatFileSize(target.targetMB * BYTES_PER_MB)}, even with ${target.settingsText}. This is the smallest version.`,
              ],
            ),
          ]
        : []),
      createElement('div', { className: 'export-actions' }, [
        button('export-download', 'Download GIF', 'btn btn-primary', handlers.onDownload, true),
        button('export-open-tab', 'Open in new tab', 'btn btn-secondary', handlers.onOpenInTab),
        ...(info.canCopy && handlers.onCopy
          ? [button('export-copy', 'Copy', 'btn btn-secondary', handlers.onCopy)]
          : []),
      ]),
      createElement('div', { className: 'export-actions export-actions--secondary' }, [
        button('export-again', 'Export again', 'btn btn-ghost', handlers.onExportAgain),
        button(
          'export-back-to-editing',
          'Back to editing',
          'btn btn-ghost',
          handlers.onBackToEditing,
        ),
      ]),
    ]),
  ]);
}

// ------------------------------------------------------------
// Error
// ------------------------------------------------------------

/**
 * @param {DialogViewParams} params
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderError(params, cleanups) {
  const job = /** @type {import('./types.js').EncodingJob} */ (params.state.job);
  const back = createElement(
    'button',
    {
      type: 'button',
      className: 'btn btn-primary',
      id: 'export-error-back',
      'data-autofocus': 'true',
    },
    ['Back to settings'],
  );
  cleanups.push(on(back, 'click', params.handlers.onBackToSettings));
  return createElement('div', { className: 'export-view export-error', id: 'export-error' }, [
    createElement('h3', { className: 'export-view-title' }, ['Export failed']),
    createElement('p', { className: 'export-text', role: 'alert', id: 'export-error-message' }, [
      job.error || 'Unknown error occurred',
    ]),
    createElement('div', { className: 'export-actions' }, [back]),
  ]);
}
