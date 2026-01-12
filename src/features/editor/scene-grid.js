/**
 * Scene Grid Modal Component
 * Displays detected scenes for quick selection of Start/End points
 * @module features/editor/scene-grid
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { createThumbnailCanvas } from './api.js';
import { detectScenesAsync } from './scene-detection.js';
import { getThumbnailSizes } from '../../shared/utils/quality-settings.js';
import { formatCompactDuration } from '../../shared/utils/format.js';

/** Thumbnail sizes from quality settings (device-adaptive) */
const { gridDefault: DEFAULT_THUMBNAIL_SIZE, gridMin: MIN_THUMBNAIL_SIZE, gridMax: MAX_THUMBNAIL_SIZE } = getThumbnailSizes();

/** CSS styles for scene grid modal */
const SCENE_GRID_STYLES = `
  .scene-grid-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.95);
    backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    animation: sceneGridFadeIn 0.15s ease-out;
  }

  @keyframes sceneGridFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .scene-grid-modal {
    background: var(--color-panel, #0d0d0d);
    border-radius: 12px;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    animation: sceneGridSlideUp 0.2s ease-out;
  }

  @keyframes sceneGridSlideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .scene-grid-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border, #333);
    flex-shrink: 0;
  }

  .scene-grid-header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .scene-grid-title {
    font-size: var(--font-size-xl, 20px);
    font-weight: 700;
    color: var(--color-text, #fff);
    margin: 0;
    letter-spacing: -0.01em;
  }

  .scene-grid-subtitle {
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text-secondary, #888);
  }

  .scene-grid-header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .scene-grid-close {
    background: transparent;
    border: none;
    color: var(--color-text-secondary, #888);
    font-size: 24px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: background 0.15s, color 0.15s;
    line-height: 1;
  }

  .scene-grid-close:hover {
    background: var(--color-surface, #333);
    color: var(--color-text, #fff);
  }

  .scene-grid-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .scene-grid-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: var(--color-text-secondary, #888);
  }

  .scene-grid-loading-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--color-surface, #333);
    border-top-color: var(--color-primary, #4da6ff);
    border-radius: 50%;
    animation: sceneGridSpin 1s linear infinite;
  }

  @keyframes sceneGridSpin {
    to { transform: rotate(360deg); }
  }

  .scene-grid-progress {
    width: 200px;
    height: 4px;
    background: var(--color-surface, #333);
    border-radius: 2px;
    overflow: hidden;
  }

  .scene-grid-progress-bar {
    height: 100%;
    background: var(--color-primary, #4da6ff);
    transition: width 0.1s ease-out;
  }

  .scene-grid-container {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
    padding: 4px;
  }

  .scene-grid-item {
    position: relative;
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
    transition: transform 0.15s, box-shadow 0.15s;
    background: var(--color-surface, #222);
    border: 2px solid transparent;
  }

  .scene-grid-item:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
  }

  .scene-grid-item:focus {
    outline: none;
  }

  .scene-grid-item:focus-visible {
    outline: 2px solid var(--color-primary, #4da6ff);
    outline-offset: 2px;
  }

  .scene-grid-item.is-selected {
    border-color: var(--color-primary, #4da6ff);
    box-shadow: 0 0 0 2px rgba(77, 166, 255, 0.3);
  }

  .scene-grid-item canvas {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    display: block;
  }

  .scene-grid-item-info {
    padding: 8px 12px;
    background: var(--color-bg-secondary, #1a1a1a);
  }

  .scene-grid-item-title {
    font-size: var(--font-size-sm, 13px);
    font-weight: 600;
    color: var(--color-text, #fff);
    margin: 0 0 4px 0;
  }

  .scene-grid-item-meta {
    font-size: var(--font-size-xs, 11px);
    color: var(--color-text-secondary, #888);
    font-family: var(--font-mono, monospace);
  }

  .scene-grid-item-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 4px 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-radius: 4px;
    background: var(--color-primary, #4da6ff);
    color: var(--color-text, #fff);
  }

  .scene-grid-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--color-text-secondary, #888);
    text-align: center;
  }

  .scene-grid-empty-icon {
    font-size: 48px;
    opacity: 0.5;
  }

  .scene-grid-footer {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 16px);
    padding: var(--space-5, 20px);
    border-top: 1px solid var(--color-border, #333);
    flex-shrink: 0;
  }

  .scene-grid-selection-info {
    text-align: center;
    padding: var(--space-2, 8px) var(--space-4, 16px);
    background: var(--color-bg-tertiary, #1f1f23);
    border-radius: var(--radius-md, 8px);
    color: var(--color-text-secondary, #888);
    font-size: var(--font-size-sm, 13px);
  }

  .scene-grid-actions {
    display: flex;
    gap: var(--space-3, 12px);
  }

  .scene-grid-btn {
    flex: 1;
    padding: var(--space-3, 12px) var(--space-5, 20px);
    font-size: var(--font-size-base, 14px);
    font-weight: 600;
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
  }

  .scene-grid-btn:active {
    transform: scale(0.98);
  }

  .scene-grid-btn-cancel {
    background: var(--color-surface, #333);
    border: 1px solid var(--color-border, #444);
    color: var(--color-text, #fff);
  }

  .scene-grid-btn-cancel:hover {
    background: var(--color-surface-hover, #444);
  }

  .scene-grid-btn-apply {
    background: var(--color-primary, #3b82f6);
    border: none;
    color: var(--color-text, #fff);
  }

  .scene-grid-btn-apply:hover:not(:disabled) {
    background: var(--color-primary-hover, #2563eb);
  }

  .scene-grid-btn-apply:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

/**
 * @typedef {Object} SceneGridCallbacks
 * @property {(range: import('./types.js').FrameRange) => void} onApply - Called when user clicks Apply
 * @property {() => void} onCancel - Called when user cancels
 */

/**
 * Inject styles into document (only once)
 */
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = SCENE_GRID_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

/**
 * Render Scene Grid Modal
 * @param {Object} params
 * @param {HTMLElement} params.container - Container to render into
 * @param {import('../capture/types.js').Frame[]} params.frames - All clip frames
 * @param {number} params.fps - Frames per second
 * @param {SceneGridCallbacks} params.callbacks - Event callbacks
 * @returns {{ cleanup: () => void }} - Cleanup function
 */
export function renderSceneGridModal({ container, frames, fps, callbacks }) {
  injectStyles();

  const cleanups = [];

  // Local state
  /** @type {import('./scene-detection.js').Scene | null} */
  let selectedScene = null;
  /** @type {import('./scene-detection.js').Scene[]} */
  let scenes = [];
  let isLoading = true;
  let loadingProgress = 0;

  // Create backdrop
  const backdrop = createElement('div', {
    className: 'scene-grid-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'scene-grid-title',
  });

  // Create modal
  const modal = createElement('div', { className: 'scene-grid-modal' });

  // Header
  const header = createElement('div', { className: 'scene-grid-header' });

  const headerLeft = createElement('div', { className: 'scene-grid-header-left' }, [
    createElement('h2', { id: 'scene-grid-title', className: 'scene-grid-title' }, ['Scene Selection']),
    createElement('span', { className: 'scene-grid-subtitle' }, ['Select a scene to set trim range']),
  ]);

  const headerRight = createElement('div', { className: 'scene-grid-header-right' });

  const closeBtn = createElement('button', {
    className: 'scene-grid-close',
    type: 'button',
    'aria-label': 'Close',
  }, ['\u00D7']);

  headerRight.appendChild(closeBtn);
  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  modal.appendChild(header);

  cleanups.push(on(closeBtn, 'click', () => callbacks.onCancel()));

  // Body
  const body = createElement('div', { className: 'scene-grid-body' });

  // Loading state
  const loadingEl = createElement('div', { className: 'scene-grid-loading' }, [
    createElement('div', { className: 'scene-grid-loading-spinner' }),
    createElement('div', {}, ['Detecting scenes...']),
    createElement('div', { className: 'scene-grid-progress' }, [
      createElement('div', { className: 'scene-grid-progress-bar', style: 'width: 0%' }),
    ]),
  ]);
  body.appendChild(loadingEl);

  // Grid container (hidden initially)
  const gridContainer = createElement('div', { className: 'scene-grid-container', style: 'display: none;' });
  body.appendChild(gridContainer);

  // Empty state (hidden initially)
  const emptyEl = createElement('div', { className: 'scene-grid-empty', style: 'display: none;' }, [
    createElement('div', { className: 'scene-grid-empty-icon' }, ['\uD83C\uDFAC']),
    createElement('div', {}, ['No distinct scenes detected']),
    createElement('div', { style: 'font-size: 12px;' }, ['The clip appears to be a single continuous scene']),
  ]);
  body.appendChild(emptyEl);

  modal.appendChild(body);

  // Footer
  const footer = createElement('div', { className: 'scene-grid-footer' });

  const selectionInfo = createElement('div', { className: 'scene-grid-selection-info' }, [
    'Click a scene to select it',
  ]);

  const actions = createElement('div', { className: 'scene-grid-actions' });

  const cancelBtn = createElement('button', {
    className: 'scene-grid-btn scene-grid-btn-cancel',
    type: 'button',
  }, ['Cancel']);
  cleanups.push(on(cancelBtn, 'click', () => callbacks.onCancel()));

  const applyBtn = createElement('button', {
    className: 'scene-grid-btn scene-grid-btn-apply',
    type: 'button',
    disabled: 'true',
  }, ['Apply']);
  cleanups.push(on(applyBtn, 'click', handleApply));

  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  footer.appendChild(selectionInfo);
  footer.appendChild(actions);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  container.appendChild(backdrop);

  // Escape key handler
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      callbacks.onCancel();
    }
  };
  document.addEventListener('keydown', handleKeyDown);
  cleanups.push(() => document.removeEventListener('keydown', handleKeyDown));

  // Click outside to close
  cleanups.push(on(backdrop, 'click', (e) => {
    if (e.target === backdrop) {
      callbacks.onCancel();
    }
  }));

  // Start scene detection
  detectScenesAsync(frames, {
    threshold: 0.12,
    minSceneFrames: Math.max(3, Math.floor(fps / 5)), // At least 0.2s per scene
    onProgress: (progress) => {
      loadingProgress = progress;
      const progressBar = loadingEl.querySelector('.scene-grid-progress-bar');
      if (progressBar instanceof HTMLElement) {
        progressBar.style.width = `${Math.round(progress * 100)}%`;
      }
    },
  }).then((result) => {
    scenes = result.scenes;
    isLoading = false;
    renderScenes();
  });

  /**
   * Render detected scenes
   */
  function renderScenes() {
    loadingEl.style.display = 'none';

    if (scenes.length === 0) {
      emptyEl.style.display = 'flex';
      return;
    }

    gridContainer.style.display = 'grid';
    gridContainer.innerHTML = '';

    scenes.forEach((scene, index) => {
      const item = createElement('div', {
        className: 'scene-grid-item',
        tabIndex: '0',
        'data-index': String(index),
        'aria-label': `Scene ${index + 1}`,
      });

      // Generate thumbnail from representative frame
      const thumbnailFrame = frames[scene.thumbnailIndex];
      try {
        const canvas = createThumbnailCanvas(thumbnailFrame, MAX_THUMBNAIL_SIZE);
        item.appendChild(canvas);
      } catch (e) {
        const placeholder = createElement('div', {
          style: 'width:100%;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:#666;background:#222;',
        }, ['\u26A0']);
        item.appendChild(placeholder);
      }

      // Scene info
      const duration = scene.frameCount / fps;
      const info = createElement('div', { className: 'scene-grid-item-info' }, [
        createElement('div', { className: 'scene-grid-item-title' }, [`Scene ${index + 1}`]),
        createElement('div', { className: 'scene-grid-item-meta' }, [
          `${formatCompactDuration(duration)} \u2022 ${scene.frameCount} frames \u2022 #${scene.startFrame + 1}-${scene.endFrame + 1}`,
        ]),
      ]);
      item.appendChild(info);

      // Badge for scene number
      const badge = createElement('span', { className: 'scene-grid-item-badge' }, [String(index + 1)]);
      item.appendChild(badge);

      // Click handler
      cleanups.push(on(item, 'click', () => {
        selectScene(scene, index);
      }));

      // Keyboard handler
      cleanups.push(on(item, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectScene(scene, index);
        }
      }));

      // Double-click to apply immediately
      cleanups.push(on(item, 'dblclick', () => {
        selectScene(scene, index);
        handleApply();
      }));

      gridContainer.appendChild(item);
    });

    // Focus first item
    const firstItem = gridContainer.querySelector('.scene-grid-item');
    if (firstItem instanceof HTMLElement) {
      firstItem.focus();
    }
  }

  /**
   * Select a scene
   * @param {import('./scene-detection.js').Scene} scene
   * @param {number} index
   */
  function selectScene(scene, index) {
    selectedScene = scene;

    // Update visual state
    const items = gridContainer.querySelectorAll('.scene-grid-item');
    items.forEach((item, i) => {
      item.classList.toggle('is-selected', i === index);
    });

    // Update selection info
    const duration = scene.frameCount / fps;
    selectionInfo.textContent = `Selected: Scene ${index + 1} (${formatCompactDuration(duration)}, frames ${scene.startFrame + 1}-${scene.endFrame + 1})`;

    // Enable apply button
    applyBtn.removeAttribute('disabled');
  }

  /**
   * Handle apply button click
   */
  function handleApply() {
    if (selectedScene) {
      callbacks.onApply({
        start: selectedScene.startFrame,
        end: selectedScene.endFrame,
      });
    }
  }

  // Cleanup function
  function cleanup() {
    cleanups.forEach((fn) => fn());
    backdrop.remove();
  }

  return { cleanup };
}
