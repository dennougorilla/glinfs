/**
 * Capture UI Components - Professional Layout
 * @module features/capture/ui
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { formatDuration, formatBytes } from '../../shared/utils/format.js';
import { navigate } from '../../shared/router.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';

/**
 * Create SVG capture icon
 * @returns {SVGElement}
 */
function createCaptureIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = `
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
    <circle cx="12" cy="10" r="3"/>
    <path d="M17 21v-4H7v4"/>
    <line x1="12" y1="17" x2="12" y2="21"/>
  `;
  return svg;
}

/**
 * @typedef {Object} CaptureUIHandlers
 * @property {() => Promise<void>} onStart - Start capture handler
 * @property {() => void} onStop - Stop capture handler
 * @property {() => void} onCreateClip - Create clip handler
 * @property {(settings: Partial<import('./types.js').CaptureSettings>) => void} onSettingsChange - Settings change handler
 */

/**
 * Render the capture screen
 * @param {HTMLElement} container - Container element
 * @param {import('./types.js').CaptureState} state - Current state
 * @param {CaptureUIHandlers} handlers - Event handlers
 * @returns {() => void} Cleanup function
 */
export function renderCaptureScreen(container, state, handlers) {
  const cleanups = [];

  // Update step indicator
  updateStepIndicator('capture', { hasFrames: state.stats.frameCount > 0 });

  // Main layout
  const screen = createElement('div', { className: 'capture-screen screen' });

  // Content area (preview + sidebar)
  const content = createElement('div', { className: 'capture-content' });

  // Preview Panel
  const previewPanel = createElement('div', { className: 'capture-preview-panel' });
  const previewWrapper = createElement('div', { className: 'capture-preview-wrapper' });
  previewWrapper.appendChild(renderVideoPreview(state));
  previewPanel.appendChild(previewWrapper);
  content.appendChild(previewPanel);

  // Sidebar
  const sidebar = createElement('div', { className: 'capture-sidebar' });

  // Actions Section
  const actionsSection = createElement('div', { className: 'control-section' });
  actionsSection.appendChild(
    createElement('div', { className: 'control-section-header' }, [
      createElement('span', { className: 'control-section-title' }, ['Capture']),
    ])
  );
  actionsSection.appendChild(renderCaptureActions(state, handlers, cleanups));
  sidebar.appendChild(actionsSection);

  // Stats Section
  const statsSection = createElement('div', { className: 'control-section' });
  statsSection.appendChild(
    createElement('div', { className: 'control-section-header' }, [
      createElement('span', { className: 'control-section-title' }, ['Buffer']),
    ])
  );
  statsSection.appendChild(renderStats(state.stats));
  sidebar.appendChild(statsSection);

  // Settings Section
  const settingsSection = createElement('div', { className: 'control-section' });
  settingsSection.appendChild(
    createElement('div', { className: 'control-section-header' }, [
      createElement('span', { className: 'control-section-title' }, ['Settings']),
    ])
  );
  settingsSection.appendChild(renderSettings(state.settings, handlers, cleanups));
  sidebar.appendChild(settingsSection);

  content.appendChild(sidebar);
  screen.appendChild(content);

  // Status Bar
  screen.appendChild(renderStatusBar(state));

  container.innerHTML = '';
  container.appendChild(screen);

  return () => {
    cleanups.forEach((fn) => fn());
  };
}


/**
 * Render video preview area
 * @param {import('./types.js').CaptureState} state
 * @returns {HTMLElement}
 */
function renderVideoPreview(state) {
  const isRecording = state.isCapturing;
  const isActive = state.isSharing;

  if (state.isSharing && state.stream) {
    const previewClasses = [
      'video-preview',
      isActive ? 'video-preview--active' : '',
      isRecording ? 'video-preview--recording' : '',
    ].filter(Boolean).join(' ');

    const preview = createElement('div', { className: previewClasses });

    // Recording badge
    if (isRecording) {
      preview.appendChild(
        createElement('div', { className: 'recording-badge' }, [
          createElement('span', { className: 'dot' }),
          'REC',
        ])
      );
    }

    const video = createElement('video', {
      className: 'preview-video',
      autoplay: 'true',
      muted: 'true',
      playsinline: 'true',
    });
    /** @type {HTMLVideoElement} */ (video).srcObject = state.stream;
    preview.appendChild(video);

    return preview;
  }

  // Empty state - Glinfs branded
  return createElement('div', { className: 'empty-state preview-empty' }, [
    createElement('div', { className: 'empty-state-icon' }, [
      // Camera/Screen icon SVG
      createCaptureIcon(),
    ]),
    createElement('h2', { className: 'empty-state-title' }, ['Ready to Capture']),
    createElement('div', { className: 'empty-state-steps' }, [
      createElement('div', { className: 'empty-state-step' }, [
        createElement('span', { className: 'empty-state-step-number' }, ['1']),
        'Click "Select Screen" button',
      ]),
      createElement('div', { className: 'empty-state-step' }, [
        createElement('span', { className: 'empty-state-step-number' }, ['2']),
        'Choose a screen, window, or tab to capture',
      ]),
      createElement('div', { className: 'empty-state-step' }, [
        createElement('span', { className: 'empty-state-step-number' }, ['3']),
        'Click "Create Clip" to edit your recording',
      ]),
    ]),
  ]);
}

/**
 * Render capture action buttons (Fglips-style: Select Screen + Create Clip)
 * @param {import('./types.js').CaptureState} state
 * @param {CaptureUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderCaptureActions(state, handlers, cleanups) {
  const actions = createElement('div', { className: 'capture-actions' });

  if (!state.isSharing) {
    // Not sharing - show "Select Screen" button
    const selectBtn = createElement(
      'button',
      {
        className: 'btn btn-capture btn-capture-start',
        type: 'button',
        'aria-label': 'Select screen to capture',
      },
      ['Select Screen']
    );
    cleanups.push(
      on(selectBtn, 'click', async () => {
        selectBtn.setAttribute('disabled', 'true');
        selectBtn.textContent = 'Selecting...';
        try {
          await handlers.onStart();
        } catch {
          selectBtn.removeAttribute('disabled');
          selectBtn.textContent = 'Select Screen';
        }
      })
    );
    actions.appendChild(selectBtn);
  } else {
    // Sharing/Recording - show "Create Clip" as primary action
    const clipBtn = createElement(
      'button',
      {
        className: 'btn btn-primary btn-create-clip',
        type: 'button',
        'aria-label': 'Create clip from buffer',
      },
      ['Create Clip']
    );
    actions.appendChild(clipBtn);

    cleanups.push(
      on(clipBtn, 'click', () => {
        handlers.onCreateClip();
        navigate('/editor');
      })
    );
  }

  // Error display
  if (state.error) {
    actions.appendChild(
      createElement('div', { className: 'error-message', role: 'alert' }, [state.error])
    );
  }

  return actions;
}

/**
 * Render buffer stats
 * @param {import('./types.js').BufferStats} stats
 * @returns {HTMLElement}
 */
function renderStats(stats) {
  const memoryBytes = stats.memoryMB * 1024 * 1024;

  return createElement('div', { className: 'capture-stats' }, [
    createElement('div', { className: 'stat-item' }, [
      createElement('span', { className: 'stat-label' }, ['Frames']),
      createElement('span', { className: 'stat-value' }, [String(stats.frameCount)]),
    ]),
    createElement('div', { className: 'stat-item' }, [
      createElement('span', { className: 'stat-label' }, ['Duration']),
      createElement('span', { className: 'stat-value' }, [formatDuration(stats.duration)]),
    ]),
    createElement('div', { className: 'stat-item' }, [
      createElement('span', { className: 'stat-label' }, ['Memory']),
      createElement('span', { className: 'stat-value' }, [formatBytes(memoryBytes)]),
    ]),
    createElement('div', { className: 'stat-item' }, [
      createElement('span', { className: 'stat-label' }, ['FPS']),
      createElement('span', { className: 'stat-value' }, [String(stats.fps)]),
    ]),
  ]);
}

/**
 * Render settings panel
 * @param {import('./types.js').CaptureSettings} settings
 * @param {CaptureUIHandlers} handlers
 * @param {(() => void)[]} cleanups
 * @returns {HTMLElement}
 */
function renderSettings(settings, handlers, cleanups) {
  const settingsEl = createElement('div', { className: 'capture-settings' });

  // FPS
  const fpsRow = createElement('div', { className: 'setting-row' });
  fpsRow.appendChild(
    createElement('div', { className: 'setting-header' }, [
      createElement('span', { className: 'setting-label' }, ['Frame Rate']),
    ])
  );
  const fpsSelect = /** @type {HTMLSelectElement} */ (
    createElement('select', {}, [
      createElement('option', { value: '15' }, ['15 FPS']),
      createElement('option', { value: '30' }, ['30 FPS']),
      createElement('option', { value: '60' }, ['60 FPS']),
    ])
  );
  fpsSelect.value = String(settings.fps);
  cleanups.push(
    on(fpsSelect, 'change', () => {
      handlers.onSettingsChange({ fps: /** @type {15|30|60} */ (Number(fpsSelect.value)) });
    })
  );
  fpsRow.appendChild(fpsSelect);
  settingsEl.appendChild(fpsRow);

  // Buffer Duration
  const durationRow = createElement('div', { className: 'slider-row' });
  durationRow.appendChild(
    createElement('div', { className: 'slider-header' }, [
      createElement('span', { className: 'setting-label' }, ['Buffer']),
      createElement('span', { className: 'setting-value' }, [`${settings.bufferDuration}s`]),
    ])
  );
  const durationInput = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      min: '5',
      max: '60',
      step: '5',
    })
  );
  durationInput.value = String(settings.bufferDuration);
  cleanups.push(
    on(durationInput, 'input', () => {
      const valueEl = durationRow.querySelector('.setting-value');
      if (valueEl) valueEl.textContent = `${durationInput.value}s`;
    })
  );
  cleanups.push(
    on(durationInput, 'change', () => {
      handlers.onSettingsChange({ bufferDuration: Number(durationInput.value) });
    })
  );
  durationRow.appendChild(durationInput);
  settingsEl.appendChild(durationRow);

  return settingsEl;
}

/**
 * Render status bar (simplified: Recording or Ready)
 * @param {import('./types.js').CaptureState} state
 * @returns {HTMLElement}
 */
function renderStatusBar(state) {
  const statusBar = createElement('div', { className: 'capture-status-bar' });

  const leftSection = createElement('div', { className: 'status-section' });

  // Fglips-style: isSharing means always recording
  if (state.isSharing) {
    leftSection.appendChild(
      createElement('div', { className: 'status-recording' }, [
        createElement('span', { className: 'dot' }),
        'Recording',
      ])
    );
  } else {
    leftSection.appendChild(
      createElement('div', { className: 'status-item' }, ['Ready'])
    );
  }

  statusBar.appendChild(leftSection);

  const rightSection = createElement('div', { className: 'status-section' }, [
    createElement('div', { className: 'status-item' }, [
      'Frames: ',
      createElement('span', { className: 'value' }, [String(state.stats.frameCount)]),
    ]),
  ]);
  statusBar.appendChild(rightSection);

  return statusBar;
}

/**
 * Update buffer status display
 * @param {HTMLElement} container
 * @param {import('./types.js').BufferStats} stats
 */
export function updateBufferStatus(container, stats) {
  const statValues = container.querySelectorAll('.stat-value');
  if (statValues.length >= 4) {
    statValues[0].textContent = String(stats.frameCount);
    statValues[1].textContent = formatDuration(stats.duration);
    statValues[2].textContent = formatBytes(stats.memoryMB * 1024 * 1024);
    statValues[3].textContent = String(stats.fps);
  }
}
