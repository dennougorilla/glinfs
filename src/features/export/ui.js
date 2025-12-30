/**
 * Export UI Components - Professional Layout
 * @module features/export/ui
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { formatBytes, formatRemaining, formatPercent, formatDuration } from '../../shared/utils/format.js';
import { navigate } from '../../shared/router.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';

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

  // Quality group
  const qualityGroup = createElement('div', { className: 'settings-group' }, [
    createElement('div', { className: 'settings-group-title' }, ['Quality']),
  ]);

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
  qualityGroup.appendChild(qualityRow);
  content.appendChild(qualityGroup);

  // Playback group
  const playbackGroup = createElement('div', { className: 'settings-group' }, [
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
  playbackGroup.appendChild(skipRow);

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
  playbackGroup.appendChild(speedRow);
  content.appendChild(playbackGroup);

  // Options group
  const optionsGroup = createElement('div', { className: 'settings-group' }, [
    createElement('div', { className: 'settings-group-title' }, ['Options']),
  ]);

  // Dithering
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
  ditherRow.appendChild(createElement('label', { for: 'dither-check' }, ['Enable dithering']));
  optionsGroup.appendChild(ditherRow);
  content.appendChild(optionsGroup);

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

  const complete = createElement('div', { className: 'export-complete' }, [
    createElement('div', { className: 'complete-icon' }, ['\u2713']),
    createElement('h2', { className: 'complete-title' }, ['Export Complete!']),
    createElement('p', { className: 'complete-subtitle' }, ['Your GIF is ready to download']),
    createElement('div', { className: 'file-info' }, [
      createElement('div', { className: 'file-info-item' }, [
        createElement('div', { className: 'file-info-label' }, ['File Size']),
        createElement('div', { className: 'file-info-value' }, [formatBytes(size)]),
      ]),
    ]),
  ]);

  const actions = createElement('div', { className: 'complete-actions' });

  const downloadBtn = createElement(
    'button',
    { className: 'btn btn-download', type: 'button' },
    ['\u2B07 Download']
  );
  cleanups.push(on(downloadBtn, 'click', handlers.onDownload));
  actions.appendChild(downloadBtn);

  const openBtn = createElement(
    'button',
    { className: 'btn btn-secondary', type: 'button' },
    ['Open in Tab']
  );
  cleanups.push(on(openBtn, 'click', handlers.onOpenInTab));
  actions.appendChild(openBtn);

  complete.appendChild(actions);

  return complete;
}

/**
 * Render error state
 * @param {import('./types.js').EncodingJob} job
 * @param {ExportUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderError(job, handlers, cleanups) {
  const error = createElement('div', { className: 'export-error' }, [
    createElement('div', { className: 'error-icon' }, ['\u26A0\uFE0F']),
    createElement('h2', { className: 'error-title' }, ['Export Failed']),
    createElement('div', { className: 'error-message' }, [job.error || 'Unknown error occurred']),
  ]);

  const actions = createElement('div', { className: 'error-actions' });

  const retryBtn = createElement(
    'button',
    { className: 'btn btn-retry', type: 'button' },
    ['\u21BB Try Again']
  );
  cleanups.push(on(retryBtn, 'click', handlers.onExport));
  actions.appendChild(retryBtn);

  const backBtn = createElement(
    'button',
    { className: 'btn btn-secondary', type: 'button' },
    ['\u2190 Back']
  );
  cleanups.push(on(backBtn, 'click', handlers.onBackToEditor));
  actions.appendChild(backBtn);

  error.appendChild(actions);

  return error;
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
