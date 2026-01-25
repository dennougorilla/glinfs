/**
 * Capture UI Components - Professional Layout
 * @module features/capture/ui
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { formatDuration } from '../../shared/utils/format.js';
import { navigate } from '../../shared/router.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';

/** @constant {string} GitHub repository URL */
const GITHUB_REPO_URL = 'https://github.com/dennougorilla/glinfs';
/** @constant {string} GitHub Sponsors URL */
const GITHUB_SPONSOR_URL = 'https://github.com/sponsors/dennougorilla';
/** @constant {string} Author profile URL */
const AUTHOR_URL = 'https://github.com/dennougorilla';

/**
 * Create a control section with title and content
 * @param {string} title
 * @param {HTMLElement} content
 * @returns {HTMLElement}
 */
function createControlSection(title, content) {
  const section = createElement('div', { className: 'control-section' });
  section.appendChild(
    createElement('div', { className: 'control-section-header' }, [
      createElement('span', { className: 'control-section-title' }, [title]),
    ])
  );
  section.appendChild(content);
  return section;
}

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
 * Create GitHub SVG icon
 * @returns {SVGElement}
 */
function createGitHubIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z');
  svg.appendChild(path);
  return svg;
}

/**
 * Create Heart SVG icon (for sponsor)
 * @returns {SVGElement}
 */
function createHeartIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.565 20.565 0 008 13.393a20.561 20.561 0 003.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.75.75 0 01-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5z');
  svg.appendChild(path);
  return svg;
}

/**
 * @typedef {Object} CaptureUIHandlers
 * @property {() => Promise<void>} onStart - Start capture handler
 * @property {() => void} onStop - Stop capture handler
 * @property {() => Promise<void>} onCreateClip - Create clip handler (async)
 * @property {(settings: Partial<import('./types.js').CaptureSettings>) => void} onSettingsChange - Settings change handler
 * @property {() => import('./types.js').CaptureSettings | null} getSettings - Get current settings
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
  sidebar.appendChild(createControlSection('Capture', renderCaptureActions(state, handlers, cleanups)));
  sidebar.appendChild(createControlSection('Buffer', renderStats(state.stats)));
  sidebar.appendChild(createControlSection('Settings', renderSettings(state.settings, handlers, cleanups)));

  content.appendChild(sidebar);
  screen.appendChild(content);

  // Footer
  screen.appendChild(renderFooter());

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
  if (state.isSharing && state.stream) {
    const previewClasses = [
      'video-preview',
      'video-preview--active',
      state.isCapturing ? 'video-preview--recording' : '',
    ].filter(Boolean).join(' ');

    const preview = createElement('div', { className: previewClasses });

    // Recording badge
    if (state.isCapturing) {
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
          // User cancelled or permission denied - reset button state
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
      on(clipBtn, 'click', async () => {
        clipBtn.setAttribute('disabled', 'true');
        clipBtn.textContent = 'Creating...';
        try {
          await handlers.onCreateClip();
          // Navigate to loading screen if scene detection is enabled, otherwise to editor
          const settings = handlers.getSettings();
          const targetRoute = settings?.sceneDetection ? '/loading' : '/editor';
          navigate(targetRoute);
        } catch (err) {
          console.error('[Capture UI] Failed to create clip:', err);
          clipBtn.removeAttribute('disabled');
          clipBtn.textContent = 'Create Clip';
        }
      })
    );
  }

  // Error display (inline with retry hint)
  if (state.error) {
    const errorContainer = createElement('div', {
      className: 'capture-error',
      role: 'alert',
      'aria-live': 'assertive',
    }, [
      createElement('span', { className: 'capture-error__icon' }, ['\u26A0\uFE0F']),
      createElement('span', { className: 'capture-error__text' }, [state.error]),
    ]);
    actions.appendChild(errorContainer);
  }

  return actions;
}

/**
 * Create a stat item element
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function createStatItem(label, value) {
  return createElement('div', { className: 'stat-item' }, [
    createElement('span', { className: 'stat-label' }, [label]),
    createElement('span', { className: 'stat-value' }, [value]),
  ]);
}

/**
 * Render buffer stats
 * @param {import('./types.js').BufferStats} stats
 * @returns {HTMLElement}
 */
function renderStats(stats) {
  return createElement('div', { className: 'capture-stats' }, [
    createStatItem('Frames', String(stats.frameCount)),
    createStatItem('Duration', formatDuration(stats.duration)),
    createStatItem('FPS', String(stats.fps)),
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

  // Scene Detection toggle
  const sceneDetectionRow = createElement('div', { className: 'setting-row' });
  sceneDetectionRow.appendChild(
    createElement('div', { className: 'setting-header' }, [
      createElement('span', { className: 'setting-label' }, ['Scene Detection']),
    ])
  );
  const sceneDetectionToggle = /** @type {HTMLButtonElement} */ (
    createElement('button', {
      className: `btn btn-toggle ${settings.sceneDetection ? 'btn-toggle--active' : ''}`,
      type: 'button',
      'data-setting': 'sceneDetection',
      'aria-pressed': String(settings.sceneDetection),
      title: 'Automatically detect scene changes when creating a clip',
    }, [settings.sceneDetection ? 'On' : 'Off'])
  );
  cleanups.push(
    on(sceneDetectionToggle, 'click', () => {
      const newValue = !settings.sceneDetection;
      handlers.onSettingsChange({ sceneDetection: newValue });
    })
  );
  sceneDetectionRow.appendChild(sceneDetectionToggle);
  settingsEl.appendChild(sceneDetectionRow);

  return settingsEl;
}

/**
 * Render footer with links
 * @returns {HTMLElement}
 */
function renderFooter() {
  const footer = createElement('div', { className: 'capture-status-bar capture-footer' });

  // GitHub link
  const githubLink = createElement('a', {
    href: GITHUB_REPO_URL,
    target: '_blank',
    rel: 'noopener noreferrer',
    className: 'footer-link',
  });
  githubLink.appendChild(createGitHubIcon());
  githubLink.appendChild(document.createTextNode('dennougorilla/glinfs'));
  footer.appendChild(githubLink);

  // Sponsor link
  const sponsorLink = createElement('a', {
    href: GITHUB_SPONSOR_URL,
    target: '_blank',
    rel: 'noopener noreferrer',
    className: 'footer-link footer-sponsor',
  });
  sponsorLink.appendChild(createHeartIcon());
  sponsorLink.appendChild(document.createTextNode('Sponsor'));
  footer.appendChild(sponsorLink);

  // Author link
  const authorLink = createElement('a', {
    href: AUTHOR_URL,
    target: '_blank',
    rel: 'noopener noreferrer',
    className: 'footer-link',
  });
  authorLink.appendChild(document.createTextNode('Made by dennougorilla'));
  footer.appendChild(authorLink);

  return footer;
}

/**
 * Update buffer status display
 * @param {HTMLElement} container
 * @param {import('./types.js').BufferStats} stats
 */
export function updateBufferStatus(container, stats) {
  const statValues = container.querySelectorAll('.stat-value');
  if (statValues.length >= 3) {
    statValues[0].textContent = String(stats.frameCount);
    statValues[1].textContent = formatDuration(stats.duration);
    statValues[2].textContent = String(stats.fps);
  }
}

/**
 * Update scene detection toggle button without full re-render
 * @param {HTMLElement} container
 * @param {boolean} enabled
 */
export function updateSceneDetectionToggle(container, enabled) {
  const toggle = container.querySelector('[data-setting="sceneDetection"]');
  if (toggle) {
    toggle.textContent = enabled ? 'On' : 'Off';
    toggle.classList.toggle('btn-toggle--active', enabled);
    toggle.setAttribute('aria-pressed', String(enabled));
  }
}
