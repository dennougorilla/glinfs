/**
 * Editor properties panel (right column): live monitor slot, aspect ratio,
 * and the Playback / Overlay / Crop Range accordions
 * @module features/editor/panels/properties
 */

import { createElement, on } from '../../../shared/utils/dom.js';

/** @type {string[]} */
const ASPECT_RATIOS = ['free', '1:1', '16:9', '4:3', '9:16'];

/** @type {number[]} */
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/**
 * Render the right-hand properties panel
 * @param {import('../types.js').EditorState} state - Render-time state (initial values only)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderEditorPropertiesPanel(state, handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Sidebar
  const sidebar = createElement('div', { className: 'editor-sidebar' });

  // Panel content (tabs removed - all controls shown together for simplicity)
  const panelContent = createElement('div', { className: 'panel-content' });

  // Live source monitor slot (#100 layout v3 / plan 1): docked at the TOP of
  // the right panel — the underused properties column cedes its prime space
  // to a permanently visible monitor. Populated by live-monitor.js while a
  // capture session is live, empty and invisible otherwise.
  panelContent.appendChild(
    createElement('div', { className: 'live-monitor-slot', 'data-live-monitor': 'true' }),
  );

  // Speed control
  const speedGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Playback']),
    createElement('div', { className: 'property-row' }, [
      createElement('span', { className: 'property-label' }, ['Speed']),
    ]),
  ]);
  const speedSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      {},
      PLAYBACK_SPEEDS.map((speed) =>
        createElement('option', { value: String(speed) }, [`${speed}x`]),
      ),
    )
  );
  speedSelect.value = String(state.playbackSpeed);
  cleanups.push(on(speedSelect, 'change', () => handlers.onSpeedChange(Number(speedSelect.value))));
  speedGroup.querySelector('.property-row').appendChild(speedSelect);

  // Crop/Aspect ratio controls
  const cropGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Aspect Ratio']),
  ]);
  const ratioButtons = createElement('div', { className: 'aspect-ratio-buttons' });
  ASPECT_RATIOS.forEach((ratio) => {
    const btn = createElement(
      'button',
      {
        className: `aspect-btn ${(state.selectedAspectRatio || 'free') === ratio ? 'active' : ''}`,
        type: 'button',
        'data-ratio': ratio,
      },
      [ratio === 'free' ? 'Free' : ratio],
    );
    cleanups.push(on(btn, 'click', () => handlers.onAspectRatioChange(ratio)));
    ratioButtons.appendChild(btn);
  });
  cropGroup.appendChild(ratioButtons);
  panelContent.appendChild(cropGroup);

  // Grid toggle
  const gridGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Overlay']),
    createElement('div', { className: 'property-row' }, [
      createElement('span', { className: 'property-label' }, ['Show Grid']),
    ]),
  ]);
  const gridBtn = createElement(
    'button',
    {
      className: `btn btn-secondary btn-grid-toggle ${state.showGrid ? 'active' : ''}`,
      type: 'button',
      'aria-pressed': String(state.showGrid),
    },
    [state.showGrid ? 'On' : 'Off'],
  );
  cleanups.push(on(gridBtn, 'click', () => handlers.onToggleGrid()));
  gridGroup.querySelector('.property-row').appendChild(gridBtn);

  // Crop info panel (always visible)
  const cropValues = state.cropArea
    ? {
        x: String(Math.round(state.cropArea.x)),
        y: String(Math.round(state.cropArea.y)),
        w: String(Math.round(state.cropArea.width)),
        h: String(Math.round(state.cropArea.height)),
      }
    : { x: '-', y: '-', w: '-', h: '-' };

  const cropInfoGroup = createElement('div', { className: 'property-group crop-info-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Crop Range']),
    createElement('div', { className: 'crop-info-grid' }, [
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['X']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.x]),
      ]),
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['Y']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.y]),
      ]),
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['W']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.w]),
      ]),
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['H']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.h]),
      ]),
    ]),
  ]);
  if (state.cropArea) {
    cropInfoGroup.appendChild(createClearCropButton());
  }

  // Low-frequency property groups fold into accordions (#100 v3): the user
  // adjusts Aspect constantly (kept always-visible above) but touches
  // Playback/Overlay/Crop rarely — the monitor gets their vertical space.
  // Native <details> keeps this zero-JS; Crop opens itself while a crop
  // exists so its values are never hidden mid-operation.
  const makeAccordion = (label, node, open = false) => {
    const details = createElement('details', { className: 'prop-accordion' }, [
      createElement('summary', { className: 'prop-accordion-summary' }, [label]),
      node,
    ]);
    if (open) details.setAttribute('open', '');
    return details;
  };
  panelContent.appendChild(makeAccordion('Playback', speedGroup));
  panelContent.appendChild(makeAccordion('Overlay', gridGroup));
  panelContent.appendChild(makeAccordion('Crop Range', cropInfoGroup, Boolean(state.cropArea)));

  // Clear Crop clicks are handled via delegation so the listener survives
  // updateCropInfoPanel() re-creating the button on crop updates (issue #37)
  cleanups.push(
    on(panelContent, 'click', (e) => {
      const target = /** @type {Element | null} */ (e.target);
      if (target instanceof Element && target.closest('.btn-clear-crop')) {
        handlers.onCropChange(null);
      }
    }),
  );

  sidebar.appendChild(panelContent);

  return { element: sidebar, cleanups };
}

/**
 * Create the Clear Crop button element
 * Click handling is delegated to the properties panel (renderEditorPropertiesPanel),
 * so no listener is attached here (issue #37).
 * @returns {HTMLElement}
 */
export function createClearCropButton() {
  return createElement(
    'button',
    {
      className: 'btn btn-secondary btn-clear-crop',
      type: 'button',
      style: 'width: 100%; margin-top: var(--space-4);',
    },
    ['Clear Crop'],
  );
}
