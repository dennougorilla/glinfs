/**
 * Frame Grid DOM assembly
 * Builds the modal chrome and grid item elements. Pure element construction:
 * no listeners, no state, so the modal can wire behaviour on top.
 * @module features/editor/frame-grid/dom
 */

import { createElement } from '../../../shared/utils/dom.js';
import { createThumbnailCanvas } from '../api.js';

/**
 * @typedef {Object} FrameGridShell
 * @property {HTMLElement} backdrop - Dialog root appended to the container
 * @property {HTMLElement} modal - Modal panel (Tab trap boundary)
 * @property {HTMLInputElement} sizeSlider - Thumbnail size slider
 * @property {HTMLElement} sizeValue - Slider value label
 * @property {HTMLElement} closeBtn - Header close button
 * @property {HTMLElement[]} sceneButtons - One button per scene (empty without scenes)
 * @property {HTMLElement} body - Scroll container
 * @property {HTMLElement} gridContainer - Grid item parent
 * @property {HTMLElement} selectionInfo - Footer selection summary
 * @property {HTMLElement} cancelBtn - Footer Cancel button
 * @property {HTMLElement} applyBtn - Footer Apply button
 */

/**
 * Build the scene sidebar button for one scene, with its first-frame thumbnail.
 * @param {import('../../scene-detection/types.js').Scene} scene
 * @param {number} index
 * @param {import('../../capture/types.js').Frame | undefined} frame - Scene's first frame
 * @returns {HTMLElement}
 */
function createSceneButton(scene, index, frame) {
  const sceneBtn = createElement('button', {
    className: 'frame-grid-scene-btn',
    type: 'button',
    'data-scene-index': String(index),
    'aria-label': `Scene ${index + 1}, frames ${scene.startFrame} to ${scene.endFrame}, ${scene.endFrame - scene.startFrame + 1} frames`,
  });

  // Add thumbnail from first frame of scene
  const thumbContainer = createElement('div', { className: 'frame-grid-scene-thumb' });
  if (frame) {
    try {
      const canvas = createThumbnailCanvas(frame, 120);
      canvas.className = 'frame-grid-scene-thumb-canvas';
      thumbContainer.appendChild(canvas);
    } catch {
      thumbContainer.appendChild(
        createElement('div', { className: 'frame-grid-scene-thumb-placeholder' }, ['🎥']),
      );
    }
  } else {
    thumbContainer.appendChild(
      createElement('div', { className: 'frame-grid-scene-thumb-placeholder' }, ['🎥']),
    );
  }
  sceneBtn.appendChild(thumbContainer);

  // Scene content (header + range)
  const sceneContent = createElement('div', { className: 'frame-grid-scene-content' }, [
    createElement('div', { className: 'frame-grid-scene-header' }, [
      createElement('span', { className: 'frame-grid-scene-num' }, [String(index + 1)]),
      createElement('span', { className: 'frame-grid-scene-frames' }, [
        `${scene.endFrame - scene.startFrame + 1}f`,
      ]),
    ]),
    createElement('div', { className: 'frame-grid-scene-range' }, [
      `${scene.startFrame} → ${scene.endFrame}`,
    ]),
  ]);
  sceneBtn.appendChild(sceneContent);

  return sceneBtn;
}

/**
 * Build the modal: header (title, size slider, close), optional scenes panel,
 * the scrollable grid body and the footer. The grid itself starts empty.
 * @param {Object} params
 * @param {import('../../capture/types.js').Frame[]} params.frames
 * @param {import('../../scene-detection/types.js').Scene[]} params.scenes
 * @param {number} params.thumbnailSize - Initial slider value
 * @param {number} params.minThumbnailSize
 * @param {number} params.maxThumbnailSize
 * @param {boolean} params.applyDisabled - Initial Apply button state
 * @returns {FrameGridShell}
 */
export function buildFrameGridShell({
  frames,
  scenes,
  thumbnailSize,
  minThumbnailSize,
  maxThumbnailSize,
  applyDisabled,
}) {
  // Create backdrop
  const backdrop = createElement('div', {
    className: 'frame-grid-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'frame-grid-title',
  });

  // Create modal
  const modal = createElement('div', { className: 'frame-grid-modal' });

  // Header
  const header = createElement('div', { className: 'frame-grid-header' });

  const headerLeft = createElement('div', { className: 'frame-grid-header-left' }, [
    createElement('h2', { id: 'frame-grid-title', className: 'frame-grid-title' }, ['Frame Grid']),
  ]);

  const headerRight = createElement('div', { className: 'frame-grid-header-right' });

  // Grid size control
  const sizeControl = createElement('div', { className: 'grid-size-control' });
  const sizeLabel = createElement('span', { className: 'size-label' }, ['Grid:']);
  const sizeSlider = /** @type {HTMLInputElement} */ (
    createElement('input', {
      type: 'range',
      min: String(minThumbnailSize),
      max: String(maxThumbnailSize),
      value: String(thumbnailSize),
      className: 'grid-size-slider',
    })
  );
  const sizeValue = createElement('span', { className: 'size-value' }, [`${thumbnailSize}px`]);

  sizeControl.appendChild(sizeLabel);
  sizeControl.appendChild(sizeSlider);
  sizeControl.appendChild(sizeValue);

  const closeBtn = createElement(
    'button',
    {
      className: 'frame-grid-close',
      type: 'button',
      'aria-label': 'Close',
    },
    ['×'],
  );

  headerRight.appendChild(sizeControl);
  headerRight.appendChild(closeBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  modal.appendChild(header);

  // Layout container (scenes panel + main content)
  const layout = createElement('div', { className: 'frame-grid-layout' });

  // Scenes panel (left sidebar) - only show if scenes exist
  /** @type {HTMLElement[]} */
  const sceneButtons = [];

  if (scenes.length > 0) {
    const scenesPanel = createElement('div', { className: 'frame-grid-scenes-panel' });
    scenesPanel.appendChild(
      createElement('div', { className: 'frame-grid-scenes-header' }, ['Scenes']),
    );

    const scenesList = createElement('div', { className: 'frame-grid-scenes-list' });

    scenes.forEach((scene, index) => {
      const sceneBtn = createSceneButton(scene, index, frames[scene.startFrame]);
      sceneButtons.push(sceneBtn);
      scenesList.appendChild(sceneBtn);
    });

    scenesPanel.appendChild(scenesList);
    layout.appendChild(scenesPanel);
  }

  // Main content area
  const mainContent = createElement('div', { className: 'frame-grid-main' });

  // Body with grid
  const body = createElement('div', { className: 'frame-grid-body' });
  // tabindex="-1" makes the container a valid programmatic-focus target
  // (not a Tab stop) so eviction can safely relocate focus without leaving
  // the modal's focus trap.
  const gridContainer = createElement('div', {
    className: 'frame-grid-container',
    tabindex: '-1',
  });

  body.appendChild(gridContainer);
  mainContent.appendChild(body);

  // Footer (inside mainContent)
  const footer = createElement('div', { className: 'frame-grid-footer' });

  const selectionInfo = createElement('div', { className: 'frame-grid-selection-info' });

  const actions = createElement('div', { className: 'frame-grid-actions' });

  const cancelBtn = createElement(
    'button',
    {
      className: 'frame-grid-btn frame-grid-btn-cancel',
      type: 'button',
    },
    ['Cancel'],
  );

  const applyBtn = createElement(
    'button',
    {
      className: 'frame-grid-btn frame-grid-btn-apply',
      type: 'button',
      disabled: applyDisabled,
    },
    ['Apply'],
  );

  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  footer.appendChild(selectionInfo);
  footer.appendChild(actions);
  mainContent.appendChild(footer);

  layout.appendChild(mainContent);
  modal.appendChild(layout);

  backdrop.appendChild(modal);

  return {
    backdrop,
    modal,
    sizeSlider,
    sizeValue,
    closeBtn,
    sceneButtons,
    body,
    gridContainer,
    selectionInfo,
    cancelBtn,
    applyBtn,
  };
}

/**
 * Release a canvas backing store immediately instead of waiting for GC.
 * @param {HTMLElement} item
 */
export function releaseThumbnail(item) {
  item.querySelectorAll('canvas').forEach((canvas) => {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  });
}

/**
 * Add a placeholder when an item does not yet have a thumbnail.
 * @param {HTMLElement} item
 */
function ensureThumbnailPlaceholder(item) {
  if (
    !item.querySelector('canvas') &&
    !item.querySelector('.frame-grid-placeholder') &&
    !item.querySelector('.frame-grid-thumbnail-error')
  ) {
    item.insertBefore(
      createElement('div', { className: 'frame-grid-placeholder' }),
      item.firstChild,
    );
  }
}

/**
 * Warning tile shown in place of a thumbnail that failed to render.
 * @returns {HTMLElement}
 */
export function createThumbnailErrorPlaceholder() {
  return createElement(
    'div',
    {
      className: 'frame-grid-thumbnail-error',
      style:
        'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;',
    },
    ['⚠'],
  );
}

/**
 * Create one frame item without registering per-item listeners.
 * @param {number} index
 * @returns {HTMLElement}
 */
export function createGridItem(index) {
  const item = createElement('div', {
    className: 'frame-grid-item',
    tabIndex: 0,
    'data-index': String(index),
    'aria-label': `Frame ${index + 1}`,
  });

  ensureThumbnailPlaceholder(item);
  item.appendChild(
    createElement('div', { className: 'frame-hover-actions' }, [
      createElement(
        'button',
        {
          className: 'frame-action-btn action-start',
          type: 'button',
          title: 'Set as Start',
        },
        ['S'],
      ),
      createElement(
        'button',
        {
          className: 'frame-action-btn action-end',
          type: 'button',
          title: 'Set as End',
        },
        ['E'],
      ),
    ]),
  );
  item.appendChild(createElement('span', { className: 'frame-grid-number' }, [String(index + 1)]));
  return item;
}

/**
 * Apply a frame's selection classes and IN/OUT badges to its item.
 * @param {HTMLElement} item
 * @param {ReturnType<typeof import('./selection.js').getFrameSelectionState>} state
 */
export function renderItemSelectionState(item, { isStart, isEnd, inRange, badges }) {
  item.classList.toggle('is-start', isStart);
  item.classList.toggle('is-end', isEnd);
  item.classList.toggle('is-in-range', inRange);

  // Remove existing badges
  item.querySelectorAll('.frame-grid-badge').forEach((badge) => {
    badge.remove();
  });

  for (const { variant, label } of badges) {
    item.appendChild(
      createElement('span', { className: `frame-grid-badge ${variant}-badge` }, [label]),
    );
  }
}
