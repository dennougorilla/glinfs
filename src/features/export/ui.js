/**
 * Export UI Components - Professional Layout
 * @module features/export/ui
 */

import { createElement, on, createErrorScreen } from '../../shared/utils/dom.js';
import { formatBytes, formatRemaining, formatPercent, formatDuration } from '../../shared/utils/format.js';
import { navigate } from '../../shared/router.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';
import { ENCODER_PRESETS } from './core.js';

/**
 * Static encoder definitions for UI display
 * More reliable than dynamic fetching which can fail
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

/**
 * Create SVG export icon
 * @returns {SVGElement}
 */
function createExportIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = `
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  `;
  return svg;
}

/**
 * @typedef {Object} ExportUIHandlers
 * @property {(settings: Partial<import('./types.js').ExportSettings>) => void} onSettingsChange
 * @property {() => void} onExport
 * @property {() => void} onCancel
 * @property {() => void} onDownload
 * @property {() => void} onOpenInTab
 * @property {() => void} onBackToEditor
 * @property {() => void} onTogglePlay - Toggle preview playback
 * @property {() => void} onAdjustSettings - Return to settings after export complete
 * @property {() => void} onCreateNew - Start new capture, releasing current frames
 */

/** @type {readonly [1, 2, 3, 4, 5]} */
const FRAME_SKIP_OPTIONS = /** @type {const} */ ([1, 2, 3, 4, 5]);

/** @type {readonly number[]} */
const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * Render the export screen
 * @param {HTMLElement} container
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {{ frameCount: number, width: number, height: number, duration: number }} clipInfo
 * @returns {{ cleanup: () => void, canvas: HTMLCanvasElement | null }} Cleanup function and canvas element
 */
export function renderExportScreen(container, state, handlers, clipInfo) {
  const cleanups = [];

  // Update step indicator
  updateStepIndicator('export');

  // Main layout
  const screen = createElement('div', { className: 'export-screen screen' });

  // Toolbar
  const toolbar = createElement('div', { className: 'export-toolbar' });
  const toolbarLeft = createElement('div', { className: 'export-toolbar-left' });

  const backBtn = createElement(
    'button',
    {
      className: 'btn btn-ghost',
      type: 'button',
      'aria-label': 'Back to editor',
    },
    ['\u2190 Editor']
  );
  cleanups.push(on(backBtn, 'click', handlers.onBackToEditor));
  toolbarLeft.appendChild(backBtn);

  const title = createElement('span', { className: 'export-title' }, ['Export GIF']);
  toolbarLeft.appendChild(title);

  toolbar.appendChild(toolbarLeft);
  toolbar.appendChild(createElement('div', { className: 'export-toolbar-right' }));
  screen.appendChild(toolbar);

  // Content area
  const content = createElement('div', { className: 'export-content' });

  // Preview Panel
  const previewPanel = createElement('div', { className: 'export-preview-panel' });
  const previewWrapper = createElement('div', { className: 'export-preview-wrapper' });

  /** @type {HTMLCanvasElement | null} */
  let previewCanvas = null;

  // Show different content based on state
  if (state.job?.status === 'encoding') {
    previewWrapper.appendChild(renderEncodingProgress(state.job, handlers, cleanups));
  } else if (state.job?.status === 'complete' && state.job.result) {
    previewWrapper.appendChild(renderComplete(state.job, handlers, cleanups));
  } else if (state.job?.status === 'error') {
    previewWrapper.appendChild(renderError(state.job, handlers, cleanups));
  } else {
    // Show Canvas-based preview
    const { element, canvas } = renderCanvasPreview(state.preview, handlers, clipInfo, cleanups);
    previewWrapper.appendChild(element);
    previewCanvas = canvas;
  }

  previewPanel.appendChild(previewWrapper);
  content.appendChild(previewPanel);

  // Settings Panel (only show when not encoding/complete/error)
  if (!state.job || state.job.status === 'idle') {
    content.appendChild(renderSettingsPanel(state, handlers, clipInfo, cleanups));
  }

  screen.appendChild(content);

  // Status bar
  screen.appendChild(
    createElement('div', { className: 'export-status-bar' }, [
      createElement('div', { className: 'export-status-section' }, [
        createElement('div', { className: 'status-item' }, [
          'Frames: ',
          createElement('span', { className: 'value' }, [String(clipInfo.frameCount)]),
        ]),
        createElement('div', { className: 'status-item' }, [
          'Duration: ',
          createElement('span', { className: 'value' }, [formatDuration(clipInfo.duration * 1000)]),
        ]),
      ]),
      createElement('div', { className: 'export-status-section' }, [
        createElement('div', { className: 'status-item' }, [
          'Size: ',
          createElement('span', { className: 'value' }, [
            `${clipInfo.width}\u00D7${clipInfo.height}`,
          ]),
        ]),
      ]),
    ])
  );

  container.innerHTML = '';
  container.appendChild(screen);

  return {
    cleanup: () => cleanups.forEach((fn) => fn()),
    canvas: previewCanvas,
  };
}


/**
 * Render Canvas-based preview for real-time playback
 * Uses the same pattern as Editor's canvas container
 * @param {import('./types.js').PreviewState} previewState
 * @param {ExportUIHandlers} handlers
 * @param {{ width: number, height: number }} clipInfo
 * @param {(() => void)[]} cleanups
 * @returns {{ element: HTMLElement, canvas: HTMLCanvasElement }}
 */
function renderCanvasPreview(previewState, handlers, clipInfo, cleanups) {
  // Canvas container - matches editor-canvas-container pattern
  const canvasContainer = createElement('div', { className: 'export-canvas-container' });

  // Create preview canvas
  const canvas = /** @type {HTMLCanvasElement} */ (
    createElement('canvas', {
      className: 'export-canvas',
      'aria-label': 'GIF Preview',
    })
  );

  // Set initial canvas size to match clip dimensions
  canvas.width = clipInfo.width;
  canvas.height = clipInfo.height;

  canvasContainer.appendChild(canvas);

  // Play/Pause overlay button
  const playPauseBtn = createElement(
    'button',
    {
      className: `export-preview-play-btn ${previewState.isPlaying ? 'playing' : ''}`,
      type: 'button',
      'aria-label': previewState.isPlaying ? 'Pause preview' : 'Play preview',
      title: previewState.isPlaying ? 'Pause (Space)' : 'Play (Space)',
    },
    [previewState.isPlaying ? '\u23F8' : '\u25B6']
  );
  cleanups.push(on(playPauseBtn, 'click', handlers.onTogglePlay));
  canvasContainer.appendChild(playPauseBtn);

  // Size indicator
  const sizeIndicator = createElement('div', { className: 'export-preview-size' }, [
    `${clipInfo.width}\u00D7${clipInfo.height}`,
  ]);
  canvasContainer.appendChild(sizeIndicator);

  return { element: canvasContainer, canvas };
}

/**
 * Render encoder selection cards
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderEncoderSelection(state, handlers, cleanups) {
  const group = createElement('div', { className: 'settings-group encoder-selection-group' }, [
    createElement('div', { className: 'settings-group-title' }, ['Select Encoder']),
  ]);

  const cardsContainer = createElement('div', { className: 'encoder-cards' });

  for (const encoder of ENCODER_OPTIONS) {
    const isSelected = state.settings.encoderId === encoder.id;
    const card = createElement(
      'div',
      {
        className: `encoder-card ${isSelected ? 'selected' : ''}`,
        'data-encoder-id': encoder.id,
      },
      [
        createElement('div', { className: 'encoder-card-header' }, [
          createElement('div', { className: 'encoder-card-radio' }, [
            isSelected ? '\u25C9' : '\u25CB',
          ]),
          createElement('div', { className: 'encoder-card-info' }, [
            createElement('div', { className: 'encoder-card-name' }, [encoder.name]),
            createElement('span', {
              className: `encoder-card-badge ${encoder.isWasm ? 'wasm' : 'js'}`,
            }, [encoder.isWasm ? 'WASM' : 'JS']),
          ]),
        ]),
        createElement('div', { className: 'encoder-card-description' }, [
          encoder.description,
        ]),
      ]
    );

    cleanups.push(
      on(card, 'click', () => {
        handlers.onSettingsChange({
          encoderId: /** @type {import('./encoders/types.js').EncoderId} */ (encoder.id),
        });
      })
    );

    cardsContainer.appendChild(card);
  }

  group.appendChild(cardsContainer);
  return group;
}

/**
 * Render gifenc-specific settings (quality controls)
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderGifencSettings(state, handlers, cleanups) {
  const group = createElement('div', { className: 'settings-group encoder-settings-section' }, [
    createElement('div', { className: 'settings-group-title' }, ['Quality Settings']),
  ]);

  // Quality slider
  const qualityRow = createElement('div', { className: 'setting-row' }, [
    createElement('div', { className: 'setting-header' }, [
      createElement('span', { className: 'setting-label' }, ['Quality']),
      createElement('span', { className: 'setting-value' }, [
        `${Math.round(state.settings.quality * 100)}%`,
      ]),
    ]),
  ]);

  const qualityInput = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      min: '0.1',
      max: '1.0',
      step: '0.1',
    })
  );
  qualityInput.value = String(state.settings.quality);

  cleanups.push(
    on(qualityInput, 'input', () => {
      const valueEl = qualityRow.querySelector('.setting-value');
      if (valueEl) {
        valueEl.textContent = `${Math.round(Number(qualityInput.value) * 100)}%`;
      }
    })
  );
  cleanups.push(
    on(qualityInput, 'change', () => {
      handlers.onSettingsChange({ quality: Number(qualityInput.value) });
    })
  );

  qualityRow.appendChild(qualityInput);
  group.appendChild(qualityRow);

  // Preset dropdown
  const presetRow = createElement('div', { className: 'setting-row' }, [
    createElement('div', { className: 'setting-header' }, [
      createElement('span', { className: 'setting-label' }, ['Preset']),
    ]),
  ]);

  const presetSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      {},
      ENCODER_PRESETS.map((preset) =>
        createElement('option', { value: preset.id }, [preset.name])
      )
    )
  );
  presetSelect.value = state.settings.encoderPreset;

  const currentPreset = ENCODER_PRESETS.find((p) => p.id === state.settings.encoderPreset);
  const presetDesc = createElement('div', { className: 'setting-description' }, [
    currentPreset?.description || '',
  ]);

  cleanups.push(
    on(presetSelect, 'change', () => {
      const preset = ENCODER_PRESETS.find((p) => p.id === presetSelect.value);
      if (preset) {
        presetDesc.textContent = preset.description;
      }
      handlers.onSettingsChange({
        encoderPreset: /** @type {import('./types.js').EncoderPreset} */ (presetSelect.value),
      });
    })
  );

  presetRow.appendChild(presetSelect);
  group.appendChild(presetRow);
  group.appendChild(presetDesc);

  // Dithering checkbox
  const ditherRow = createElement('div', { className: 'checkbox-row' });
  const ditherCheckbox = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'checkbox',
      id: 'dither-check',
    })
  );
  ditherCheckbox.checked = state.settings.dithering;

  cleanups.push(
    on(ditherCheckbox, 'change', () => {
      handlers.onSettingsChange({ dithering: ditherCheckbox.checked });
    })
  );

  ditherRow.appendChild(ditherCheckbox);
  ditherRow.appendChild(
    createElement('label', { for: 'dither-check' }, ['Enable dithering'])
  );

  const ditherHint = createElement('div', { className: 'setting-hint' }, [
    'Smoother gradients, slightly larger files',
  ]);

  group.appendChild(ditherRow);
  group.appendChild(ditherHint);

  return group;
}

/**
 * Render gifsicle-specific settings (info message)
 * @returns {HTMLElement}
 */
function renderGifsicleSettings() {
  const group = createElement('div', { className: 'settings-group encoder-settings-section' }, [
    createElement('div', { className: 'settings-group-title' }, ['Quality Settings']),
  ]);

  const infoBox = createElement('div', { className: 'encoder-info-box' }, [
    createElement('div', { className: 'encoder-info-icon' }, ['\u2139\uFE0F']),
    createElement('div', { className: 'encoder-info-content' }, [
      createElement('p', { className: 'encoder-info-title' }, [
        'Automatic optimization',
      ]),
      createElement('p', { className: 'encoder-info-description' }, [
        'Gifsicle uses libimagequant to automatically optimize colors for the best possible quality. No manual adjustment needed.',
      ]),
    ]),
  ]);

  group.appendChild(infoBox);
  return group;
}

/**
 * Render common playback settings
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {{ frameCount: number }} clipInfo
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderPlaybackSettings(state, handlers, clipInfo, cleanups) {
  const group = createElement('div', { className: 'settings-group' }, [
    createElement('div', { className: 'settings-group-title' }, ['Playback']),
  ]);

  // Frame skip
  const skipRow = createElement('div', { className: 'setting-row' }, [
    createElement('div', { className: 'setting-header' }, [
      createElement('span', { className: 'setting-label' }, ['Frame Skip']),
    ]),
  ]);

  const skipSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      {},
      FRAME_SKIP_OPTIONS.map((skip) => {
        const effectiveFrames = Math.ceil(clipInfo.frameCount / skip);
        return createElement('option', { value: String(skip) }, [
          `Every ${skip === 1 ? 'frame' : `${skip} frames`} (${effectiveFrames})`,
        ]);
      })
    )
  );
  skipSelect.value = String(state.settings.frameSkip);

  cleanups.push(
    on(skipSelect, 'change', () => {
      handlers.onSettingsChange({
        frameSkip: /** @type {1|2|3|4|5} */ (Number(skipSelect.value)),
      });
    })
  );

  skipRow.appendChild(skipSelect);
  group.appendChild(skipRow);

  // Speed
  const speedRow = createElement('div', { className: 'setting-row' }, [
    createElement('div', { className: 'setting-header' }, [
      createElement('span', { className: 'setting-label' }, ['Speed']),
    ]),
  ]);

  const speedSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      {},
      SPEED_OPTIONS.map((speed) =>
        createElement('option', { value: String(speed) }, [`${speed}x`])
      )
    )
  );
  speedSelect.value = String(state.settings.playbackSpeed);

  cleanups.push(
    on(speedSelect, 'change', () => {
      handlers.onSettingsChange({ playbackSpeed: Number(speedSelect.value) });
    })
  );

  speedRow.appendChild(speedSelect);
  group.appendChild(speedRow);

  return group;
}

/**
 * Render settings panel
 * @param {import('./types.js').ExportState} state
 * @param {ExportUIHandlers} handlers
 * @param {{ frameCount: number }} clipInfo
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderSettingsPanel(state, handlers, clipInfo, cleanups) {
  const panel = createElement('div', { className: 'export-settings-panel' });

  // Header
  panel.appendChild(
    createElement('div', { className: 'settings-header' }, [
      createElement('span', { className: 'settings-title' }, ['Export Settings']),
    ])
  );

  // Settings content
  const content = createElement('div', { className: 'settings-content' });

  // 1. Encoder selection (always visible)
  content.appendChild(renderEncoderSelection(state, handlers, cleanups));

  // 2. Encoder-specific settings (dynamic based on selected encoder)
  if (state.settings.encoderId === 'gifenc-js') {
    content.appendChild(renderGifencSettings(state, handlers, cleanups));
  } else {
    content.appendChild(renderGifsicleSettings());
  }

  // 3. Common playback settings (always visible)
  content.appendChild(renderPlaybackSettings(state, handlers, clipInfo, cleanups));

  panel.appendChild(content);

  // Actions
  const actions = createElement('div', { className: 'settings-actions' });
  const exportBtn = createElement(
    'button',
    { className: 'btn btn-export-main', type: 'button' },
    ['Export GIF']
  );
  cleanups.push(on(exportBtn, 'click', handlers.onExport));
  actions.appendChild(exportBtn);
  panel.appendChild(actions);

  return panel;
}

/**
 * Render encoding progress
 * @param {import('./types.js').EncodingJob} job
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderEncodingProgress(job, handlers, cleanups) {
  const progress = createElement('div', { className: 'export-progress' }, [
    createElement('div', { className: 'progress-icon' }, ['\u2699\uFE0F']),
    createElement('h2', { className: 'progress-title' }, ['Creating your GIF...']),
    createElement('div', { className: 'progress-bar-container' }, [
      createElement('div', { className: 'progress-bar' }, [
        createElement('div', {
          className: 'progress-bar-fill',
          style: `width: ${job.progress}%`,
        }),
      ]),
      createElement('div', { className: 'progress-info' }, [
        createElement('span', {}, [`${job.currentFrame} / ${job.totalFrames} frames`]),
        createElement('span', { className: 'percent' }, [formatPercent(job.progress / 100)]),
      ]),
    ]),
  ]);

  if (job.estimatedRemaining && job.estimatedRemaining > 0) {
    progress.appendChild(
      createElement('p', { className: 'progress-time' }, [
        formatRemaining(job.estimatedRemaining),
      ])
    );
  }

  const cancelBtn = createElement(
    'button',
    { className: 'btn btn-secondary', type: 'button' },
    ['Cancel']
  );
  cleanups.push(on(cancelBtn, 'click', handlers.onCancel));
  progress.appendChild(cancelBtn);

  return progress;
}

/**
 * Render complete state
 * @param {import('./types.js').EncodingJob} job
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderComplete(job, handlers, cleanups) {
  const size = job.result?.size || 0;

  // Create the main container with two-column layout
  const complete = createElement('div', { className: 'export-complete-v2' });

  // Left: GIF Preview
  const previewSection = createElement('div', { className: 'complete-preview-section' });

  if (job.result) {
    const blobUrl = URL.createObjectURL(job.result);
    const previewImg = createElement('img', {
      className: 'complete-preview-img',
      src: blobUrl,
      alt: 'Exported GIF preview',
    });
    previewSection.appendChild(previewImg);

    // Cleanup blob URL when done
    cleanups.push(() => URL.revokeObjectURL(blobUrl));
  }

  complete.appendChild(previewSection);

  // Right: Info and Actions
  const infoSection = createElement('div', { className: 'complete-info-section' });

  // Success header with animated checkmark
  const header = createElement('div', { className: 'complete-header' }, [
    createElement('div', { className: 'complete-icon-ring' }, [
      createElement('div', { className: 'complete-icon-check' }, [
        createCheckmarkSVG(),
      ]),
    ]),
    createElement('div', { className: 'complete-header-text' }, [
      createElement('h2', { className: 'complete-title' }, ['Ready to share']),
      createElement('p', { className: 'complete-subtitle' }, ['Your GIF has been created successfully']),
    ]),
  ]);
  infoSection.appendChild(header);

  // File info cards
  const fileStats = createElement('div', { className: 'complete-stats' }, [
    createElement('div', { className: 'complete-stat-card complete-stat-primary' }, [
      createElement('div', { className: 'stat-value' }, [formatBytes(size)]),
      createElement('div', { className: 'stat-label' }, ['File Size']),
    ]),
  ]);
  infoSection.appendChild(fileStats);

  // Primary action: Download
  const primaryActions = createElement('div', { className: 'complete-primary-actions' });

  const downloadBtn = createElement(
    'button',
    { className: 'btn-download-large', type: 'button' },
    [
      createDownloadSVG(),
      createElement('span', {}, ['Download GIF']),
    ]
  );
  cleanups.push(on(downloadBtn, 'click', handlers.onDownload));
  primaryActions.appendChild(downloadBtn);
  infoSection.appendChild(primaryActions);

  // Secondary actions
  const secondaryActions = createElement('div', { className: 'complete-secondary-actions' });

  const openBtn = createElement(
    'button',
    { className: 'btn-action-secondary', type: 'button' },
    [
      createExternalLinkSVG(),
      createElement('span', {}, ['Open in New Tab']),
    ]
  );
  cleanups.push(on(openBtn, 'click', handlers.onOpenInTab));
  secondaryActions.appendChild(openBtn);

  const adjustBtn = createElement(
    'button',
    { className: 'btn-action-secondary', type: 'button' },
    [
      createSettingsSVG(),
      createElement('span', {}, ['Adjust & Re-export']),
    ]
  );
  cleanups.push(on(adjustBtn, 'click', handlers.onAdjustSettings));
  secondaryActions.appendChild(adjustBtn);

  const createNewBtn = createElement(
    'button',
    { className: 'btn-action-secondary btn-create-new', type: 'button' },
    [
      createPlusSVG(),
      createElement('span', {}, ['Create New GIF']),
    ]
  );
  cleanups.push(on(createNewBtn, 'click', handlers.onCreateNew));
  secondaryActions.appendChild(createNewBtn);

  infoSection.appendChild(secondaryActions);

  // Back to editor link
  const backLink = createElement('div', { className: 'complete-back-link' }, [
    createElement('button', { className: 'btn-text-link', type: 'button' }, [
      '\u2190 Back to Editor',
    ]),
  ]);
  const backButton = backLink.querySelector('button');
  if (backButton) {
    cleanups.push(on(backButton, 'click', handlers.onBackToEditor));
  }
  infoSection.appendChild(backLink);

  complete.appendChild(infoSection);

  return complete;
}

/**
 * Create checkmark SVG icon
 * @returns {SVGSVGElement}
 */
function createCheckmarkSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
  return svg;
}

/**
 * Create download SVG icon
 * @returns {SVGSVGElement}
 */
function createDownloadSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>';
  return svg;
}

/**
 * Create external link SVG icon
 * @returns {SVGSVGElement}
 */
function createExternalLinkSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>';
  return svg;
}

/**
 * Create settings/gear SVG icon
 * @returns {SVGSVGElement}
 */
function createSettingsSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>';
  return svg;
}

/**
 * Create plus SVG icon
 * @returns {SVGSVGElement}
 */
function createPlusSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>';
  return svg;
}

/**
 * Render error state
 * @param {import('./types.js').EncodingJob} job
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderError(job, handlers, cleanups) {
  return createErrorScreen({
    title: 'Export Failed',
    message: job.error || 'Unknown error occurred',
    actions: [
      {
        label: '\u21BB Try Again',
        onClick: handlers.onExport,
        primary: true,
      },
      {
        label: '\u2190 Back',
        onClick: handlers.onBackToEditor,
        primary: false,
      },
    ],
  }, cleanups);
}

/**
 * Update progress bar
 * @param {HTMLElement} container
 * @param {import('./types.js').EncodingJob} job
 */
export function updateProgressUI(container, job) {
  const fill = container.querySelector('.progress-bar-fill');
  if (fill) {
    /** @type {HTMLElement} */ (fill).style.width = `${job.progress}%`;
  }

  const info = container.querySelectorAll('.progress-info span');
  if (info.length >= 2) {
    info[0].textContent = `${job.currentFrame} / ${job.totalFrames} frames`;
    info[1].textContent = formatPercent(job.progress / 100);
  }

  const timeRemaining = container.querySelector('.progress-time');
  if (timeRemaining && job.estimatedRemaining) {
    timeRemaining.textContent = formatRemaining(job.estimatedRemaining);
  }
}
