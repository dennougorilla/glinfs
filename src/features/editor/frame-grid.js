/**
 * Frame Grid Modal Component
 * Displays all captured frames in a grid layout for visual selection of Start/End points
 * @module features/editor/frame-grid
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { createThumbnailCanvas } from './api.js';
import { normalizeSelectionRange, isFrameInRange } from './core.js';
import { getThumbnailSizes } from '../../shared/utils/quality-settings.js';

/** Thumbnail sizes from quality settings (device-adaptive) */
const { gridDefault: DEFAULT_THUMBNAIL_SIZE, gridMin: MIN_THUMBNAIL_SIZE, gridMax: MAX_THUMBNAIL_SIZE } = getThumbnailSizes();

/** CSS styles for frame grid modal */
const FRAME_GRID_STYLES = `
  .frame-grid-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.95);
    backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .frame-grid-modal {
    background: var(--color-panel, #0d0d0d);
    border-radius: 12px;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    animation: slideUp 0.2s ease-out;
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .frame-grid-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border, #333);
    flex-shrink: 0;
  }

  .frame-grid-header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .frame-grid-title {
    font-size: var(--font-size-xl, 20px);
    font-weight: 700;
    color: var(--color-text, #fff);
    margin: 0;
    letter-spacing: -0.01em;
  }

  .frame-grid-header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  /* Grid Size Control */
  .grid-size-control {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .size-label {
    font-size: 13px;
    color: var(--color-text-secondary, #888);
  }

  .grid-size-slider {
    width: 100px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--color-surface, #333);
    border-radius: 2px;
    cursor: pointer;
  }

  .grid-size-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    background: var(--color-primary, #4da6ff);
    border-radius: 50%;
    cursor: grab;
  }

  .grid-size-slider::-webkit-slider-thumb:active {
    cursor: grabbing;
  }

  .size-value {
    font-size: 12px;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-secondary, #888);
    min-width: 40px;
  }

  .frame-grid-close {
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

  .frame-grid-close:hover {
    background: var(--color-surface, #333);
    color: var(--color-text, #fff);
  }

  .frame-grid-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .frame-grid-container {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px;
    padding: 4px; /* Space for focus-visible outline */
    content-visibility: auto;
  }

  .frame-grid-item {
    position: relative;
    cursor: pointer;
    border-radius: 6px;
    overflow: hidden;
    transition: box-shadow 0.15s;
    aspect-ratio: 16 / 9;
    background: var(--color-surface, #222);
  }

  .frame-grid-item:focus {
    outline: none;
  }

  .frame-grid-item:focus-visible {
    outline: 2px solid var(--color-primary, #4da6ff);
    outline-offset: 2px;
  }

  /* Start frame - green outline + overlay */
  .frame-grid-item.is-start {
    outline: 3px solid var(--color-success, #22c55e);
    outline-offset: 1px;
    z-index: 2;
  }

  .frame-grid-item.is-start::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(34, 197, 94, 0.20);
    pointer-events: none;
    border-radius: inherit;
    z-index: 1;
  }

  /* End frame - red outline + overlay */
  .frame-grid-item.is-end {
    outline: 3px solid var(--color-error, #ef4444);
    outline-offset: 1px;
    z-index: 2;
  }

  .frame-grid-item.is-end::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(239, 68, 68, 0.20);
    pointer-events: none;
    border-radius: inherit;
    z-index: 1;
  }

  /* Single selection (start = end) - orange outline */
  .frame-grid-item.is-start.is-end {
    outline: 3px solid var(--color-selection, #f59e0b);
  }

  .frame-grid-item.is-start.is-end::before {
    background: rgba(245, 158, 11, 0.25);
  }

  /* Range frames - blue outline */
  .frame-grid-item.is-in-range {
    outline: 2px solid var(--color-primary, #3b82f6);
    outline-offset: 0px;
    z-index: 1;
  }

  .frame-grid-item.is-in-range::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg,
      rgba(59, 130, 246, 0.15) 0%,
      rgba(59, 130, 246, 0.08) 100%);
    pointer-events: none;
    border-radius: inherit;
  }

  /* Start/End frames take priority over range styling */
  .frame-grid-item.is-start.is-in-range,
  .frame-grid-item.is-end.is-in-range {
    z-index: 2;
  }

  .frame-grid-item canvas {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Lazy loading placeholder */
  .frame-grid-placeholder {
    width: 100%;
    height: 100%;
    background: var(--color-surface, #222);
  }

  /* Hover Actions (S/E buttons) */
  .frame-hover-actions {
    position: absolute;
    top: 4px;
    left: 4px;
    right: 4px;
    display: flex;
    justify-content: space-between;
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
  }

  .frame-grid-item:hover .frame-hover-actions {
    opacity: 1;
    pointer-events: auto;
  }

  /* Touch device support: long-press shows S/E buttons */
  .frame-grid-item.touch-active .frame-hover-actions {
    opacity: 1;
    pointer-events: auto;
  }

  /* Larger touch targets for touch devices */
  @media (pointer: coarse) {
    .frame-action-btn {
      width: 44px;
      height: 44px;
      font-size: 16px;
    }
  }

  .frame-action-btn {
    width: 28px;
    height: 24px;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.1s, background 0.1s;
  }

  .frame-action-btn:hover {
    transform: scale(1.1);
  }

  .frame-action-btn:active {
    transform: scale(0.95);
  }

  .action-start {
    background: var(--color-success, #22c55e);
    color: var(--color-text, #fff);
  }

  .action-start:hover {
    background: var(--color-success-hover, #16a34a);
  }

  .action-end {
    background: var(--color-error, #ef4444);
    color: var(--color-text, #fff);
  }

  .action-end:hover {
    background: var(--color-error-hover, #dc2626);
  }

  /* Selection badges - opaque background for readability on any thumbnail */
  .frame-grid-badge {
    position: absolute;
    bottom: 4px;
    left: 4px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-radius: var(--radius-sm, 4px);
    background: rgba(0, 0, 0, 0.85);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    z-index: 5;
  }

  .frame-grid-badge.start-badge {
    border: 2px solid var(--color-success, #22c55e);
    color: var(--color-success, #22c55e);
  }

  .frame-grid-badge.end-badge {
    left: auto;
    right: 4px;
    border: 2px solid var(--color-error, #ef4444);
    color: var(--color-error, #ef4444);
  }

  .frame-grid-badge.single-badge {
    border: 2px solid var(--color-selection, #f59e0b);
    color: var(--color-selection, #f59e0b);
  }

  .frame-grid-number {
    position: absolute;
    bottom: 4px;
    right: 4px;
    padding: 2px 6px;
    font-size: 11px;
    font-weight: 500;
    font-family: var(--font-mono, monospace);
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border-radius: 3px;
  }

  .frame-grid-item.is-start .frame-grid-number,
  .frame-grid-item.is-end .frame-grid-number {
    display: none;
  }

  .frame-grid-footer {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 16px);
    padding: var(--space-5, 20px);
    border-top: 1px solid var(--color-border, #333);
    flex-shrink: 0;
  }

  .frame-grid-selection-info {
    text-align: center;
    padding: var(--space-2, 8px) var(--space-4, 16px);
    background: var(--color-bg-tertiary, #1f1f23);
    border-radius: var(--radius-md, 8px);
    color: var(--color-text-secondary, #888);
    font-size: var(--font-size-sm, 13px);
  }

  .frame-grid-actions {
    display: flex;
    gap: var(--space-3, 12px);
  }

  .frame-grid-btn {
    flex: 1;
    padding: var(--space-3, 12px) var(--space-5, 20px);
    font-size: var(--font-size-base, 14px);
    font-weight: 600;
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
  }

  .frame-grid-btn:active {
    transform: scale(0.98);
  }

  .frame-grid-btn-cancel {
    background: var(--color-surface, #333);
    border: 1px solid var(--color-border, #444);
    color: var(--color-text, #fff);
  }

  .frame-grid-btn-cancel:hover {
    background: var(--color-surface-hover, #444);
  }

  .frame-grid-btn-apply {
    background: var(--color-primary, #3b82f6);
    border: none;
    color: var(--color-text, #fff);
  }

  .frame-grid-btn-apply:hover:not(:disabled) {
    background: var(--color-primary-hover, #2563eb);
  }

  .frame-grid-btn-apply:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Scene Navigation Panel - Enhanced */
  .frame-grid-scenes-panel {
    display: flex;
    flex-direction: column;
    width: 220px;
    background: linear-gradient(180deg, var(--color-panel, #1a1a1a) 0%, rgba(24, 24, 27, 0.95) 100%);
    border-right: 1px solid var(--color-border, #333);
    overflow: hidden;
  }

  .frame-grid-scenes-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--color-border, #333);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-secondary, #888);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: rgba(0, 0, 0, 0.2);
  }

  .frame-grid-scenes-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Scene Button with Thumbnail */
  .frame-grid-scene-btn {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 8px;
    background: var(--color-bg-tertiary, #1f1f23);
    border: 1px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s ease-out;
    text-align: left;
    position: relative;
    overflow: hidden;
  }

  .frame-grid-scene-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(139, 92, 246, 0.05));
    opacity: 0;
    transition: opacity 0.2s;
  }

  .frame-grid-scene-btn:hover {
    background: var(--color-surface, #333);
    border-color: var(--color-primary, #3b82f6);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }

  .frame-grid-scene-btn:hover::before {
    opacity: 1;
  }

  .frame-grid-scene-btn:active {
    transform: scale(0.98);
  }

  .frame-grid-scene-btn.is-active {
    background: var(--color-primary-muted, rgba(59, 130, 246, 0.15));
    border-color: var(--color-primary, #3b82f6);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2), 0 4px 12px rgba(59, 130, 246, 0.15);
  }

  /* Scene Thumbnail */
  .frame-grid-scene-thumb {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--color-surface, #222);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }

  .frame-grid-scene-thumb::after {
    content: '\u25B6';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) scale(0.8);
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    border-radius: 50%;
    font-size: 10px;
    opacity: 0;
    transition: all 0.2s;
    backdrop-filter: blur(4px);
  }

  .frame-grid-scene-btn:hover .frame-grid-scene-thumb::after {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  .frame-grid-scene-thumb-canvas {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .frame-grid-scene-thumb-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: var(--color-text-muted, #666);
    background: linear-gradient(135deg, rgba(39, 39, 42, 0.8), rgba(24, 24, 27, 0.8));
  }

  /* Scene Content */
  .frame-grid-scene-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    position: relative;
    z-index: 1;
  }

  .frame-grid-scene-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .frame-grid-scene-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 8px;
    background: var(--color-surface, #333);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    color: var(--color-text, #fff);
  }

  .frame-grid-scene-btn.is-active .frame-grid-scene-num {
    background: linear-gradient(135deg, var(--color-primary, #3b82f6), #2563eb);
    box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
  }

  .frame-grid-scene-frames {
    font-size: 10px;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-muted, #666);
    padding: 3px 8px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 10px;
  }

  .frame-grid-scene-range {
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-secondary, #888);
  }

  /* Layout with scenes panel */
  .frame-grid-layout {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .frame-grid-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
`;

/**
 * @typedef {Object} FrameGridCallbacks
 * @property {(range: import('./types.js').FrameRange) => void} onApply - Called when user clicks Apply
 * @property {() => void} onCancel - Called when user cancels (Escape, click outside, Cancel button)
 */

/**
 * Inject styles into document (only once)
 */
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = FRAME_GRID_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

/**
 * Calculate optimal thumbnail size to fit all frames in viewport
 * @param {number} frameCount - Total number of frames
 * @param {number} containerWidth - Available width
 * @param {number} containerHeight - Available height
 * @returns {number} - Optimal thumbnail width
 */
function calculateOptimalThumbnailSize(frameCount, containerWidth, containerHeight) {
  const aspectRatio = 16 / 9;
  const gap = 12;

  // Binary search for optimal size
  let low = MIN_THUMBNAIL_SIZE;
  let high = MAX_THUMBNAIL_SIZE;
  let optimal = DEFAULT_THUMBNAIL_SIZE;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cols = Math.floor((containerWidth + gap) / (mid + gap));
    if (cols < 1) {
      high = mid - 1;
      continue;
    }
    const rows = Math.ceil(frameCount / cols);
    const itemHeight = mid / aspectRatio;
    const totalHeight = rows * (itemHeight + gap) - gap;

    if (totalHeight <= containerHeight) {
      optimal = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return Math.max(MIN_THUMBNAIL_SIZE, Math.min(optimal, MAX_THUMBNAIL_SIZE));
}

/**
 * Render Frame Grid Modal
 * @param {Object} params
 * @param {HTMLElement} params.container - Container to render into
 * @param {import('../capture/types.js').Frame[]} params.frames - All clip frames
 * @param {import('./types.js').FrameRange} params.initialRange - Current selection from editor
 * @param {import('../scene-detection/types.js').Scene[]} [params.scenes] - Detected scenes
 * @param {FrameGridCallbacks} params.callbacks - Event callbacks
 * @returns {{ cleanup: () => void }} - Cleanup function
 */
export function renderFrameGridModal({ container, frames, initialRange, scenes = [], callbacks }) {
  injectStyles();

  const cleanups = [];

  // Local state
  let startFrame = initialRange.start;
  let endFrame = initialRange.end;
  let focusedFrame = startFrame;
  let thumbnailSize = DEFAULT_THUMBNAIL_SIZE;
  const hasScenes = scenes.length > 0;

  // Track previous selection for optimized updates (null initially to trigger full update)
  /** @type {number | null} */
  let prevStartFrame = null;
  /** @type {number | null} */
  let prevEndFrame = null;

  // Touch device support
  /** @type {number | null} */
  let touchTimer = null;
  /** @type {HTMLElement | null} */
  let touchActiveItem = null;

  /**
   * Clear touch-active state from any item
   */
  function clearTouchActive() {
    if (touchActiveItem) {
      touchActiveItem.classList.remove('touch-active');
      touchActiveItem = null;
    }
  }

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
  const sizeSlider = /** @type {HTMLInputElement} */ (createElement('input', {
    type: 'range',
    min: String(MIN_THUMBNAIL_SIZE),
    max: String(MAX_THUMBNAIL_SIZE),
    value: String(thumbnailSize),
    className: 'grid-size-slider',
  }));
  const sizeValue = createElement('span', { className: 'size-value' }, [`${thumbnailSize}px`]);

  sizeControl.appendChild(sizeLabel);
  sizeControl.appendChild(sizeSlider);
  sizeControl.appendChild(sizeValue);

  const closeBtn = createElement('button', {
    className: 'frame-grid-close',
    type: 'button',
    'aria-label': 'Close',
  }, ['\u00D7']);

  headerRight.appendChild(sizeControl);
  headerRight.appendChild(closeBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  modal.appendChild(header);

  cleanups.push(on(closeBtn, 'click', () => callbacks.onCancel()));

  // Layout container (scenes panel + main content)
  const layout = createElement('div', { className: 'frame-grid-layout' });

  // Scenes panel (left sidebar) - only show if scenes exist
  /** @type {HTMLElement[]} */
  const sceneButtons = [];

  if (hasScenes) {
    const scenesPanel = createElement('div', { className: 'frame-grid-scenes-panel' });
    scenesPanel.appendChild(
      createElement('div', { className: 'frame-grid-scenes-header' }, ['Scenes'])
    );

    const scenesList = createElement('div', { className: 'frame-grid-scenes-list' });

    scenes.forEach((scene, index) => {
      const sceneBtn = createElement('button', {
        className: 'frame-grid-scene-btn',
        type: 'button',
        'data-scene-index': String(index),
        'aria-label': `Scene ${index + 1}, frames ${scene.startFrame} to ${scene.endFrame}, ${scene.endFrame - scene.startFrame + 1} frames`,
      });

      // Add thumbnail from first frame of scene
      const thumbContainer = createElement('div', { className: 'frame-grid-scene-thumb' });
      const frame = frames[scene.startFrame];
      if (frame) {
        try {
          const canvas = createThumbnailCanvas(frame, 120);
          canvas.className = 'frame-grid-scene-thumb-canvas';
          thumbContainer.appendChild(canvas);
        } catch {
          thumbContainer.appendChild(
            createElement('div', { className: 'frame-grid-scene-thumb-placeholder' }, ['\uD83C\uDFA5'])
          );
        }
      } else {
        thumbContainer.appendChild(
          createElement('div', { className: 'frame-grid-scene-thumb-placeholder' }, ['\uD83C\uDFA5'])
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
          `${scene.startFrame} \u2192 ${scene.endFrame}`,
        ]),
      ]);
      sceneBtn.appendChild(sceneContent);

      sceneButtons.push(sceneBtn);

      // Click to select entire scene
      cleanups.push(on(sceneBtn, 'click', () => {
        setStartFrame(scene.startFrame);
        setEndFrame(scene.endFrame);
        // Update scene button states
        updateSceneButtonStates();
        // Scroll to scene start
        const firstItem = gridItems[scene.startFrame];
        if (firstItem) {
          firstItem.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }));

      scenesList.appendChild(sceneBtn);
    });

    scenesPanel.appendChild(scenesList);
    layout.appendChild(scenesPanel);
  }

  /**
   * Update scene button active states
   */
  function updateSceneButtonStates() {
    sceneButtons.forEach((btn, index) => {
      const scene = scenes[index];
      const isActive = startFrame === scene.startFrame && endFrame === scene.endFrame;
      btn.classList.toggle('is-active', isActive);
    });
  }

  // Main content area
  const mainContent = createElement('div', { className: 'frame-grid-main' });

  // Body with grid
  const body = createElement('div', { className: 'frame-grid-body' });
  const gridContainer = createElement('div', { className: 'frame-grid-container' });

  // Generate thumbnails and grid items
  /** @type {HTMLElement[]} */
  const gridItems = [];

  /**
   * Render thumbnail for a grid item
   * @param {HTMLElement} item
   * @param {import('../capture/types.js').Frame} frame
   */
  function renderThumbnail(item, frame) {
    // Remove placeholder if exists
    const placeholder = item.querySelector('.frame-grid-placeholder');
    if (placeholder) placeholder.remove();

    try {
      const canvas = createThumbnailCanvas(frame, MAX_THUMBNAIL_SIZE);
      item.insertBefore(canvas, item.firstChild);
    } catch {
      const errorPlaceholder = createElement('div', {
        style: 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;',
      }, ['\u26A0']);
      item.insertBefore(errorPlaceholder, item.firstChild);
    }
  }

  // Lazy loading with IntersectionObserver (with fallback for unsupported environments)
  const supportsIntersectionObserver =
    typeof window !== 'undefined' && 'IntersectionObserver' in window;

  /** @type {IntersectionObserver | null} */
  const thumbnailObserver = supportsIntersectionObserver
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const item = /** @type {HTMLElement} */ (entry.target);
              const index = parseInt(item.dataset.index, 10);

              // Render thumbnail if not already rendered
              if (!item.querySelector('canvas')) {
                renderThumbnail(item, frames[index]);
              }

              thumbnailObserver.unobserve(item);
            }
          });
        },
        {
          root: body, // Scroll container
          rootMargin: '200px', // Pre-load 200px before visible
        }
      )
    : null;

  // Cleanup observer on unmount (only if observer exists)
  if (thumbnailObserver) {
    cleanups.push(() => thumbnailObserver.disconnect());
  }

  frames.forEach((frame, index) => {
    const item = createElement('div', {
      className: 'frame-grid-item',
      tabIndex: 0,
      'data-index': String(index),
      'aria-label': `Frame ${index + 1}`,
    });

    // Immediately render selected frames, lazy-load others
    const isInitiallySelected = index === initialRange.start || index === initialRange.end;

    if (isInitiallySelected || !thumbnailObserver) {
      // Selected frames OR no observer support: render immediately
      renderThumbnail(item, frame);
    } else {
      // Other frames with observer support: add placeholder and observe
      const placeholder = createElement('div', {
        className: 'frame-grid-placeholder',
      });
      item.appendChild(placeholder);
      thumbnailObserver.observe(item);
    }

    // Hover actions: [S] [E] buttons
    const hoverActions = createElement('div', { className: 'frame-hover-actions' }, [
      createElement('button', {
        className: 'frame-action-btn action-start',
        type: 'button',
        title: 'Set as Start',
      }, ['S']),
      createElement('button', {
        className: 'frame-action-btn action-end',
        type: 'button',
        title: 'Set as End',
      }, ['E']),
    ]);
    item.appendChild(hoverActions);

    // Frame number label
    const numberLabel = createElement('span', { className: 'frame-grid-number' }, [String(index + 1)]);
    item.appendChild(numberLabel);

    gridItems.push(item);
    gridContainer.appendChild(item);

    // Touch device support: long-press (400ms) to show S/E buttons
    // (kept on individual items due to timer complexity)
    cleanups.push(on(item, 'touchstart', () => {
      clearTouchActive();
      touchTimer = window.setTimeout(() => {
        item.classList.add('touch-active');
        touchActiveItem = item;
      }, 400);
    }, { passive: true }));

    cleanups.push(on(item, 'touchend', () => {
      if (touchTimer) {
        clearTimeout(touchTimer);
        touchTimer = null;
      }
    }));

    cleanups.push(on(item, 'touchmove', () => {
      if (touchTimer) {
        clearTimeout(touchTimer);
        touchTimer = null;
      }
    }));
  });

  // Event delegation for mouse events on grid container
  // (reduces ~1200 listeners to 2 listeners)
  cleanups.push(on(gridContainer, 'click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const item = target.closest('.frame-grid-item');
    if (!item) return;

    const index = parseInt(item.dataset.index, 10);

    // [S] button click
    if (target.closest('.action-start')) {
      e.stopPropagation();
      setStartFrame(index);
      updateSceneButtonStates();
      return;
    }

    // [E] button click
    if (target.closest('.action-end')) {
      e.stopPropagation();
      setEndFrame(index);
      updateSceneButtonStates();
      return;
    }

    // Frame item click (shift+click support)
    const shiftKey = /** @type {MouseEvent} */ (e).shiftKey;
    handleFrameClick(index, shiftKey);
    updateSceneButtonStates();
  }));

  cleanups.push(on(gridContainer, 'dblclick', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const item = target.closest('.frame-grid-item');
    if (!item) return;

    const index = parseInt(item.dataset.index, 10);
    handleFrameDoubleClick(index);
    updateSceneButtonStates();
  }));

  body.appendChild(gridContainer);
  mainContent.appendChild(body);

  // Footer (inside mainContent)
  const footer = createElement('div', { className: 'frame-grid-footer' });

  const selectionInfo = createElement('div', { className: 'frame-grid-selection-info' });
  updateSelectionInfo();

  const actions = createElement('div', { className: 'frame-grid-actions' });

  const cancelBtn = createElement('button', {
    className: 'frame-grid-btn frame-grid-btn-cancel',
    type: 'button',
  }, ['Cancel']);
  cleanups.push(on(cancelBtn, 'click', () => callbacks.onCancel()));

  const applyBtn = createElement('button', {
    className: 'frame-grid-btn frame-grid-btn-apply',
    type: 'button',
    disabled: startFrame === null,
  }, ['Apply']);
  cleanups.push(on(applyBtn, 'click', handleApply));

  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  footer.appendChild(selectionInfo);
  footer.appendChild(actions);
  mainContent.appendChild(footer);

  layout.appendChild(mainContent);
  modal.appendChild(layout);

  // Initial scene button states
  updateSceneButtonStates();

  backdrop.appendChild(modal);

  // Add to container
  container.appendChild(backdrop);

  // Update visual state
  updateVisualState();

  // Auto-fit grid size after DOM is ready
  requestAnimationFrame(() => {
    const optimalSize = calculateOptimalThumbnailSize(
      frames.length,
      gridContainer.offsetWidth,
      body.offsetHeight - 32 // padding
    );
    thumbnailSize = optimalSize;
    sizeSlider.value = String(optimalSize);
    sizeValue.textContent = `${optimalSize}px`;
    updateGridSize();

    // Focus first selected item
    if (gridItems[focusedFrame]) {
      gridItems[focusedFrame].focus();
    }
  });

  // Slider change handler
  cleanups.push(on(sizeSlider, 'input', () => {
    thumbnailSize = parseInt(sizeSlider.value, 10);
    sizeValue.textContent = `${thumbnailSize}px`;
    updateGridSize();
  }));

  // Escape key handler
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      callbacks.onCancel();
      return;
    }

    // Arrow key navigation
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      navigateGrid(e.key);
      return;
    }

    // Enter/Space to select
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const shiftKey = e.shiftKey;
      handleFrameClick(focusedFrame, shiftKey);
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

  // Trap focus within modal
  const handleTabTrap = (e) => {
    if (e.key !== 'Tab') return;

    const focusableElements = modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable?.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable?.focus();
      }
    }
  };
  modal.addEventListener('keydown', handleTabTrap);
  cleanups.push(() => modal.removeEventListener('keydown', handleTabTrap));

  // =========================================
  // Internal handlers
  // =========================================

  /**
   * Set start frame
   * @param {number} index
   */
  function setStartFrame(index) {
    startFrame = index;
    // Clear end if it's before start
    if (endFrame !== null && endFrame < startFrame) {
      endFrame = null;
    }
    focusedFrame = index;
    updateVisualState();
    updateSelectionInfo();
  }

  /**
   * Set end frame
   * @param {number} index
   */
  function setEndFrame(index) {
    endFrame = index;
    // Auto-set start if not set, or if end < start, set single frame selection (IN=OUT)
    if (startFrame === null || startFrame > endFrame) {
      startFrame = index;
    }
    focusedFrame = index;
    updateVisualState();
    updateSelectionInfo();
  }

  /**
   * Handle frame click (legacy behavior)
   * @param {number} index
   * @param {boolean} shiftKey
   */
  function handleFrameClick(index, shiftKey) {
    if (shiftKey && startFrame !== null) {
      setEndFrame(index);
    } else {
      setStartFrame(index);
    }
  }

  /**
   * Handle double-click (single frame selection)
   * @param {number} index
   */
  function handleFrameDoubleClick(index) {
    startFrame = index;
    endFrame = index;
    focusedFrame = index;
    updateVisualState();
    updateSelectionInfo();
  }

  /**
   * Update grid template columns based on thumbnail size
   */
  function updateGridSize() {
    gridContainer.style.gridTemplateColumns =
      `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`;
  }

  /**
   * Navigate grid with arrow keys
   * @param {string} key
   */
  function navigateGrid(key) {
    const itemsPerRow = Math.floor(gridContainer.offsetWidth / (thumbnailSize + 12));
    let newIndex = focusedFrame;

    switch (key) {
      case 'ArrowLeft':
        newIndex = Math.max(0, focusedFrame - 1);
        break;
      case 'ArrowRight':
        newIndex = Math.min(frames.length - 1, focusedFrame + 1);
        break;
      case 'ArrowUp':
        newIndex = Math.max(0, focusedFrame - itemsPerRow);
        break;
      case 'ArrowDown':
        newIndex = Math.min(frames.length - 1, focusedFrame + itemsPerRow);
        break;
    }

    if (newIndex !== focusedFrame) {
      focusedFrame = newIndex;
      if (gridItems[focusedFrame]) {
        gridItems[focusedFrame].focus();
        gridItems[focusedFrame].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  /**
   * Handle apply button click
   */
  function handleApply() {
    const range = normalizeSelectionRange(startFrame, endFrame, frames.length);
    if (range) {
      callbacks.onApply(range);
    }
  }

  /**
   * Update visual state of a single grid item
   * @param {HTMLElement} item
   * @param {number} index
   */
  function updateSingleItemVisualState(item, index) {
    const isStart = index === startFrame;
    const isEnd = index === endFrame;
    const effectiveEnd = endFrame ?? startFrame;
    const inRange = startFrame !== null && isFrameInRange(index, startFrame, effectiveEnd);

    item.classList.toggle('is-start', isStart);
    item.classList.toggle('is-end', isEnd && endFrame !== null);
    item.classList.toggle('is-in-range', inRange);

    // Remove existing badges
    item.querySelectorAll('.frame-grid-badge').forEach((b) => b.remove());

    // Add badges
    if (isStart && isEnd && startFrame === endFrame) {
      const badge = createElement('span', { className: 'frame-grid-badge single-badge' }, ['IN=OUT']);
      item.appendChild(badge);
    } else {
      if (isStart) {
        const badge = createElement('span', { className: 'frame-grid-badge start-badge' }, ['IN']);
        item.appendChild(badge);
      }
      if (isEnd && endFrame !== null) {
        const badge = createElement('span', { className: 'frame-grid-badge end-badge' }, ['OUT']);
        item.appendChild(badge);
      }
    }
  }

  /**
   * Get all indices affected by range change
   * @param {number | null} oldStart
   * @param {number | null} oldEnd
   * @param {number | null} newStart
   * @param {number | null} newEnd
   * @returns {Set<number>}
   */
  function getAffectedRangeIndices(oldStart, oldEnd, newStart, newEnd) {
    const affected = new Set();

    // Add old range
    if (oldStart !== null) {
      const oldEffectiveEnd = oldEnd ?? oldStart;
      const min = Math.min(oldStart, oldEffectiveEnd);
      const max = Math.max(oldStart, oldEffectiveEnd);
      for (let i = min; i <= max; i++) {
        affected.add(i);
      }
    }

    // Add new range
    if (newStart !== null) {
      const newEffectiveEnd = newEnd ?? newStart;
      const min = Math.min(newStart, newEffectiveEnd);
      const max = Math.max(newStart, newEffectiveEnd);
      for (let i = min; i <= max; i++) {
        affected.add(i);
      }
    }

    return affected;
  }

  /**
   * Update visual state of grid items (optimized: only changed items)
   */
  function updateVisualState() {
    // Collect all affected indices
    const changedIndices = getAffectedRangeIndices(
      prevStartFrame,
      prevEndFrame,
      startFrame,
      endFrame
    );

    // Update only changed items
    changedIndices.forEach((index) => {
      if (gridItems[index]) {
        updateSingleItemVisualState(gridItems[index], index);
      }
    });

    // Update tracking state
    prevStartFrame = startFrame;
    prevEndFrame = endFrame;

    // Update apply button state
    applyBtn.disabled = startFrame === null;
  }

  /**
   * Update selection info text
   */
  function updateSelectionInfo() {
    if (startFrame === null) {
      selectionInfo.textContent = 'Click [S] to set Start, [E] to set End';
    } else if (endFrame === null) {
      selectionInfo.textContent = `Start: Frame ${startFrame + 1} \u2014 Click [E] on another frame`;
    } else {
      const count = Math.abs(endFrame - startFrame) + 1;
      const min = Math.min(startFrame, endFrame);
      const max = Math.max(startFrame, endFrame);
      selectionInfo.textContent = `Selection: Frame ${min + 1} \u2192 Frame ${max + 1} (${count} frame${count !== 1 ? 's' : ''})`;
    }
  }

  // Cleanup function
  function cleanup() {
    cleanups.forEach((fn) => fn());
    backdrop.remove();
  }

  return { cleanup };
}
