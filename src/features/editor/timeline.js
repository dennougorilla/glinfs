/**
 * Timeline Component - Direct Manipulation Design
 * Click-drag to select range, handles to fine-tune
 * @module features/editor/timeline
 */

import { createElement, on } from '../../shared/utils/dom.js';
import { clamp } from '../../shared/utils/math.js';
import { frameToTimecode } from '../../shared/utils/format.js';
import { createThumbnailCanvas } from './api.js';

/**
 * @typedef {Object} TimelineHandlers
 * @property {(range: import('./types.js').FrameRange) => void} onRangeChange - Range changed
 */

/** Default FPS fallback for time calculations */
const DEFAULT_FPS = 30;

/** Number of thumbnail samples to show */
const MAX_THUMBNAILS = 30;

/** Minimum selection width in frames */
const MIN_SELECTION_FRAMES = 2;

/**
 * Render timeline component
 * @param {HTMLElement} container
 * @param {import('./types.js').Clip} clip
 * @param {number} currentFrame
 * @param {import('./types.js').FrameRange} selectedRange
 * @param {TimelineHandlers} handlers
 * @returns {() => void} Cleanup function
 */
export function renderTimeline(container, clip, currentFrame, selectedRange, handlers) {
  const cleanups = [];
  const totalFrames = clip.frames.length;
  const fps = clip.fps || DEFAULT_FPS;
  const duration = totalFrames / fps;

  // ═══════════════════════════════════════════════════════════
  // SHARED STATE - Single source of truth for range
  // ═══════════════════════════════════════════════════════════
  const state = {
    range: { ...selectedRange },
    isDraggingHandle: false,
    isDrawingSelection: false,
    activeHandle: /** @type {'start' | 'end' | null} */ (null),
    dragStartFrame: 0,
  };

  // Main timeline wrapper
  const timeline = createElement('div', {
    className: 'tl',
    role: 'slider',
    'aria-label': 'Video timeline - drag to select range',
    'aria-valuemin': '0',
    'aria-valuemax': String(totalFrames - 1),
    tabindex: '0',
  });

  // ═══════════════════════════════════════════════════════════
  // LAYER 1: Time Ruler (Top)
  // ═══════════════════════════════════════════════════════════
  const ruler = createElement('div', { className: 'tl-ruler' });

  const tickInterval = calculateTickInterval(duration);
  for (let t = 0; t <= duration; t += tickInterval) {
    const percent = (t / duration) * 100;
    const isMajor = t % (tickInterval * 2) === 0 || t === 0;

    const tick = createElement('div', {
      className: `tl-tick ${isMajor ? 'tl-tick--major' : ''}`,
      style: `left: ${percent}%`,
    });

    if (isMajor) {
      const frameAtTick = Math.round(t * DEFAULT_FPS);
      tick.appendChild(createElement('span', { className: 'tl-tick-label' }, [
        frameToTimecode(frameAtTick, DEFAULT_FPS)
      ]));
    }

    ruler.appendChild(tick);
  }
  timeline.appendChild(ruler);

  // ═══════════════════════════════════════════════════════════
  // LAYER 2: Main Track Area
  // ═══════════════════════════════════════════════════════════
  const track = createElement('div', { className: 'tl-track' });

  // Filmstrip background (thumbnails)
  const filmstrip = createElement('div', { className: 'tl-filmstrip' });
  const sampleStep = Math.max(1, Math.floor(totalFrames / MAX_THUMBNAILS));

  for (let i = 0; i < totalFrames; i += sampleStep) {
    const thumb = createElement('div', {
      className: 'tl-frame',
      'data-frame': String(i),
    });

    const frame = clip.frames[i];
    if (frame) {
      try {
        const canvas = createThumbnailCanvas(frame, 80);
        canvas.className = 'tl-frame-canvas';
        canvas.setAttribute('draggable', 'false');
        thumb.appendChild(canvas);
      } catch (error) {
        // Graceful degradation - show empty frame on error
        console.warn(`Failed to create thumbnail for frame ${i}:`, error);
      }
    }

    filmstrip.appendChild(thumb);
  }
  track.appendChild(filmstrip);

  // ═══════════════════════════════════════════════════════════
  // LAYER 3: Selection Range with Handles
  // ═══════════════════════════════════════════════════════════
  const selectionLayer = createElement('div', { className: 'tl-selection-layer' });

  // Dimmed areas outside selection
  const dimLeft = createElement('div', { className: 'tl-dim tl-dim--left' });
  const dimRight = createElement('div', { className: 'tl-dim tl-dim--right' });
  selectionLayer.appendChild(dimLeft);
  selectionLayer.appendChild(dimRight);

  // Selection box
  const selectionBox = createElement('div', { className: 'tl-selection' });

  // Left Handle (In Point)
  const handleIn = createElement('div', {
    className: 'tl-handle tl-handle--in',
    'aria-label': 'In point',
    title: 'Drag to adjust start',
  });
  handleIn.innerHTML = `
    <div class="tl-handle-wing"></div>
    <div class="tl-handle-grip">
      <svg viewBox="0 0 8 24" fill="currentColor">
        <rect x="1" y="4" width="2" height="16" rx="1"/>
        <rect x="5" y="4" width="2" height="16" rx="1"/>
      </svg>
    </div>
  `;

  // Right Handle (Out Point)
  const handleOut = createElement('div', {
    className: 'tl-handle tl-handle--out',
    'aria-label': 'Out point',
    title: 'Drag to adjust end',
  });
  handleOut.innerHTML = `
    <div class="tl-handle-grip">
      <svg viewBox="0 0 8 24" fill="currentColor">
        <rect x="1" y="4" width="2" height="16" rx="1"/>
        <rect x="5" y="4" width="2" height="16" rx="1"/>
      </svg>
    </div>
    <div class="tl-handle-wing"></div>
  `;

  selectionBox.appendChild(handleIn);
  selectionBox.appendChild(handleOut);
  selectionLayer.appendChild(selectionBox);

  // Initial positions
  updateSelectionPositions(dimLeft, dimRight, selectionBox, state.range, totalFrames);

  track.appendChild(selectionLayer);

  // ═══════════════════════════════════════════════════════════
  // LAYER 4: Hover Time Indicator
  // ═══════════════════════════════════════════════════════════
  const hoverIndicator = createElement('div', { className: 'tl-hover' });
  hoverIndicator.innerHTML = `
    <div class="tl-hover-line"></div>
    <div class="tl-hover-time"></div>
  `;
  hoverIndicator.style.display = 'none';
  track.appendChild(hoverIndicator);

  // ═══════════════════════════════════════════════════════════
  // LAYER 5: Draw Selection Indicator (during drag)
  // ═══════════════════════════════════════════════════════════
  const drawIndicator = createElement('div', { className: 'tl-draw-selection' });
  drawIndicator.style.display = 'none';
  track.appendChild(drawIndicator);

  timeline.appendChild(track);

  // ═══════════════════════════════════════════════════════════
  // HELPER: Convert mouse position to frame
  // ═══════════════════════════════════════════════════════════
  const getFrameFromEvent = (e) => {
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const progress = clamp(x / rect.width, 0, 1);
    return Math.round(progress * (totalFrames - 1));
  };

  const getPercentFromFrame = (frame) => {
    return (frame / (totalFrames - 1)) * 100;
  };

  // ═══════════════════════════════════════════════════════════
  // HELPER: Update range and notify
  // ═══════════════════════════════════════════════════════════
  const updateRange = (newRange) => {
    state.range = newRange;
    updateSelectionPositions(dimLeft, dimRight, selectionBox, newRange, totalFrames);
    handlers.onRangeChange(newRange);
  };

  // ═══════════════════════════════════════════════════════════
  // INTERACTIONS: Handle Dragging
  // ═══════════════════════════════════════════════════════════
  const onHandleMouseDown = (type) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    state.isDraggingHandle = true;
    state.activeHandle = type;

    const handle = type === 'start' ? handleIn : handleOut;
    handle.classList.add('tl-handle--dragging');
    timeline.classList.add('tl--dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  const onHandleMouseMove = (e) => {
    if (!state.isDraggingHandle || !state.activeHandle) return;

    const frameIndex = getFrameFromEvent(e);

    if (state.activeHandle === 'start') {
      // Start handle: can't go past end - MIN_SELECTION_FRAMES
      const newStart = Math.min(frameIndex, state.range.end - MIN_SELECTION_FRAMES);
      updateRange({
        start: Math.max(0, newStart),
        end: state.range.end,
      });
    } else {
      // End handle: can't go before start + MIN_SELECTION_FRAMES
      const newEnd = Math.max(frameIndex, state.range.start + MIN_SELECTION_FRAMES);
      updateRange({
        start: state.range.start,
        end: Math.min(totalFrames - 1, newEnd),
      });
    }

    // Show hover time during drag
    hoverIndicator.style.display = 'block';
    hoverIndicator.style.left = `${getPercentFromFrame(frameIndex)}%`;
    hoverIndicator.querySelector('.tl-hover-time').textContent = frameToTimecode(frameIndex, DEFAULT_FPS);
  };

  const onHandleMouseUp = () => {
    if (!state.isDraggingHandle) return;

    state.isDraggingHandle = false;
    handleIn.classList.remove('tl-handle--dragging');
    handleOut.classList.remove('tl-handle--dragging');
    timeline.classList.remove('tl--dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    hoverIndicator.style.display = 'none';
    state.activeHandle = null;
  };

  cleanups.push(on(handleIn, 'mousedown', onHandleMouseDown('start')));
  cleanups.push(on(handleOut, 'mousedown', onHandleMouseDown('end')));
  cleanups.push(on(document, 'mousemove', onHandleMouseMove));
  cleanups.push(on(document, 'mouseup', onHandleMouseUp));

  // ═══════════════════════════════════════════════════════════
  // INTERACTIONS: Draw Selection (Drag on track)
  // ═══════════════════════════════════════════════════════════
  const onTrackMouseDown = (e) => {
    // Don't start if clicking on a handle
    if (e.target.closest('.tl-handle')) return;

    state.isDrawingSelection = true;
    state.dragStartFrame = getFrameFromEvent(e);

    timeline.classList.add('tl--drawing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    // Show draw indicator
    const percent = getPercentFromFrame(state.dragStartFrame);
    drawIndicator.style.display = 'block';
    drawIndicator.style.left = `${percent}%`;
    drawIndicator.style.width = '0%';

    // Show time at cursor
    hoverIndicator.style.display = 'block';
    hoverIndicator.style.left = `${percent}%`;
    hoverIndicator.querySelector('.tl-hover-time').textContent = frameToTimecode(state.dragStartFrame, DEFAULT_FPS);
  };

  const onDrawMouseMove = (e) => {
    if (!state.isDrawingSelection) return;

    const currentFrame = getFrameFromEvent(e);
    const startFrame = Math.min(state.dragStartFrame, currentFrame);
    const endFrame = Math.max(state.dragStartFrame, currentFrame);

    // Update draw indicator
    const startPercent = getPercentFromFrame(startFrame);
    const endPercent = getPercentFromFrame(endFrame);
    drawIndicator.style.left = `${startPercent}%`;
    drawIndicator.style.width = `${endPercent - startPercent}%`;

    // Update hover time
    hoverIndicator.style.left = `${getPercentFromFrame(currentFrame)}%`;
    hoverIndicator.querySelector('.tl-hover-time').textContent = frameToTimecode(currentFrame, DEFAULT_FPS);

    // Live update the actual selection
    if (endFrame - startFrame >= MIN_SELECTION_FRAMES) {
      updateRange({ start: startFrame, end: endFrame });
    }
  };

  const onDrawMouseUp = (e) => {
    if (!state.isDrawingSelection) return;

    const currentFrame = getFrameFromEvent(e);
    const startFrame = Math.min(state.dragStartFrame, currentFrame);
    const endFrame = Math.max(state.dragStartFrame, currentFrame);

    // Commit the selection if it's valid
    if (endFrame - startFrame >= MIN_SELECTION_FRAMES) {
      updateRange({ start: startFrame, end: endFrame });
    }

    state.isDrawingSelection = false;
    timeline.classList.remove('tl--drawing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    drawIndicator.style.display = 'none';
    hoverIndicator.style.display = 'none';
  };

  cleanups.push(on(track, 'mousedown', onTrackMouseDown));
  cleanups.push(on(document, 'mousemove', onDrawMouseMove));
  cleanups.push(on(document, 'mouseup', onDrawMouseUp));

  // ═══════════════════════════════════════════════════════════
  // INTERACTIONS: Hover Time Display
  // ═══════════════════════════════════════════════════════════
  cleanups.push(on(track, 'mousemove', (e) => {
    if (state.isDraggingHandle || state.isDrawingSelection) return;

    const frameIndex = getFrameFromEvent(e);

    hoverIndicator.style.display = 'block';
    hoverIndicator.style.left = `${getPercentFromFrame(frameIndex)}%`;
    hoverIndicator.querySelector('.tl-hover-time').textContent = frameToTimecode(frameIndex, DEFAULT_FPS);
  }));

  cleanups.push(on(track, 'mouseleave', () => {
    if (!state.isDraggingHandle && !state.isDrawingSelection) {
      hoverIndicator.style.display = 'none';
    }
  }));

  // ═══════════════════════════════════════════════════════════
  // INTERACTIONS: Keyboard
  // ═══════════════════════════════════════════════════════════
  cleanups.push(on(timeline, 'keydown', (e) => {
    const ke = /** @type {KeyboardEvent} */ (e);
    const step = ke.shiftKey ? 10 : 1;

    switch (ke.key) {
      case 'ArrowLeft':
        ke.preventDefault();
        // Move entire selection left
        if (state.range.start - step >= 0) {
          updateRange({
            start: state.range.start - step,
            end: state.range.end - step,
          });
        }
        break;
      case 'ArrowRight':
        ke.preventDefault();
        // Move entire selection right
        if (state.range.end + step <= totalFrames - 1) {
          updateRange({
            start: state.range.start + step,
            end: state.range.end + step,
          });
        }
        break;
      case '[':
        ke.preventDefault();
        // Expand selection left
        updateRange({
          start: Math.max(0, state.range.start - step),
          end: state.range.end,
        });
        break;
      case ']':
        ke.preventDefault();
        // Expand selection right
        updateRange({
          start: state.range.start,
          end: Math.min(totalFrames - 1, state.range.end + step),
        });
        break;
      case 'Home':
        ke.preventDefault();
        // Select from start
        updateRange({ start: 0, end: state.range.end });
        break;
      case 'End':
        ke.preventDefault();
        // Select to end
        updateRange({ start: state.range.start, end: totalFrames - 1 });
        break;
    }
  }));

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  container.innerHTML = '';
  container.appendChild(timeline);

  return () => {
    cleanups.forEach((fn) => fn());
  };
}

/**
 * Calculate optimal tick interval based on duration
 * @param {number} duration - Duration in seconds
 * @returns {number} - Interval in seconds
 */
function calculateTickInterval(duration) {
  if (duration <= 2) return 0.5;
  if (duration <= 5) return 1;
  if (duration <= 15) return 2;
  if (duration <= 30) return 5;
  if (duration <= 60) return 10;
  return 15;
}

/**
 * Update selection and dim positions
 */
function updateSelectionPositions(dimLeft, dimRight, selectionBox, range, totalFrames) {
  const startPercent = (range.start / (totalFrames - 1)) * 100;
  const endPercent = (range.end / (totalFrames - 1)) * 100;

  dimLeft.style.width = `${startPercent}%`;
  dimRight.style.left = `${endPercent}%`;
  dimRight.style.width = `${100 - endPercent}%`;

  selectionBox.style.left = `${startPercent}%`;
  selectionBox.style.width = `${endPercent - startPercent}%`;
}

/**
 * Update timeline selection range (external API)
 */
export function updateTimelineRange(container, range, totalFrames) {
  const dimLeft = container.querySelector('.tl-dim--left');
  const dimRight = container.querySelector('.tl-dim--right');
  const selectionBox = container.querySelector('.tl-selection');

  if (dimLeft && dimRight && selectionBox) {
    updateSelectionPositions(
      /** @type {HTMLElement} */ (dimLeft),
      /** @type {HTMLElement} */ (dimRight),
      /** @type {HTMLElement} */ (selectionBox),
      range,
      totalFrames
    );
  }
}
