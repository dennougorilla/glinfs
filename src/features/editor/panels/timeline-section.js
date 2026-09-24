/**
 * Editor timeline section: Clip Range header (Open Grid, IN/OUT/SEL) and the
 * empty container timeline.js renders thumbnails into
 * @module features/editor/panels/timeline-section
 */

import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import { calculateSelectionInfo } from '../core.js';

/**
 * Render the timeline section
 * @param {import('../types.js').EditorState} state - Render-time state (initial values only)
 * @param {number} fps
 * @param {() => void} onOpenFrameGrid - Opens the frame grid modal
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderEditorTimelineSection(state, fps, onOpenFrameGrid) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Timeline section
  const timelineSection = createElement('div', { className: 'editor-timeline' });

  // Calculate selection info using the new utility function
  const selectionInfo = calculateSelectionInfo(state.selectedRange, fps);
  const inPoint = frameToTimecode(state.selectedRange.start, fps);
  const outPoint = frameToTimecode(state.selectedRange.end, fps);

  // Frame Grid button for timeline header
  const frameGridBtn = createElement(
    'button',
    {
      className: 'btn-frame-grid-compact',
      type: 'button',
      'aria-label': 'Open frame grid for selection',
      title: 'Frame Grid (F)',
    },
    ['Open Grid'],
  );
  cleanups.push(on(frameGridBtn, 'click', onOpenFrameGrid));

  timelineSection.appendChild(
    createElement('div', { className: 'timeline-header' }, [
      createElement('div', { className: 'timeline-header-left' }, [
        createElement('span', { className: 'timeline-title' }, ['Clip Range']),
        frameGridBtn,
      ]),
      createElement('div', { className: 'timeline-info' }, [
        createElement('span', { className: 'timeline-point' }, [
          createElement('span', { className: 'label' }, ['IN']),
          createElement('span', { className: 'value timeline-in-value' }, [inPoint]),
        ]),
        createElement('span', { className: 'timeline-point' }, [
          createElement('span', { className: 'label' }, ['OUT']),
          createElement('span', { className: 'value timeline-out-value' }, [outPoint]),
        ]),
        // Selection info using calculateSelectionInfo formatted values
        createElement('span', { className: 'timeline-point timeline-selection-info' }, [
          createElement('span', { className: 'label' }, ['SEL']),
          createElement('span', { className: 'value timeline-sel-value' }, [
            selectionInfo.formattedDuration,
          ]),
          createElement('span', { className: 'frames timeline-sel-frames' }, [
            `(${selectionInfo.formattedFrameCount})`,
          ]),
        ]),
      ]),
    ]),
  );

  // Timeline container - rendered by timeline.js with thumbnails
  const timelineContainer = createElement('div', { className: 'editor-timeline-container' });
  timelineSection.appendChild(timelineContainer);

  return { element: timelineSection, cleanups };
}
