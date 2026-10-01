/**
 * Editor toolbar panel: back button, playback controls, time display, export
 * @module features/editor/panels/toolbar
 */

import { navigate } from '../../../shared/router.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import { getPositionInSelection } from '../core.js';

/**
 * A 16px stroked toolbar glyph (decorative: the button text names the action)
 * @param {string} d - Path data on a 16x16 grid
 * @returns {SVGSVGElement}
 */
function toolbarIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

/**
 * Render the editor toolbar
 * @param {import('../types.js').EditorState} state - Render-time state (initial values only)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @param {number} fps
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderEditorToolbar(state, handlers, fps) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Read live state via handlers to avoid stale closures (render runs once)
  const getCurrentState = () => handlers.getState?.() ?? state;

  // Toolbar
  const toolbar = createElement('div', { className: 'editor-toolbar' });

  // Toolbar left - Back button
  const toolbarLeft = createElement('div', { className: 'editor-toolbar-left' }, [
    createElement(
      'button',
      {
        className: 'btn btn-ghost',
        type: 'button',
        'aria-label': 'Back to capture',
      },
      [toolbarIcon('M10 3.5 5.5 8l4.5 4.5'), 'Capture'],
    ),
  ]);
  cleanups.push(on(toolbarLeft.querySelector('button'), 'click', () => navigate('/capture')));

  // Toolbar center - Playback controls
  const playbackControls = createElement('div', { className: 'playback-controls' });

  // First frame
  const firstBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Go to first frame',
      title: 'First frame (Home)',
    },
    ['⏮'],
  );
  cleanups.push(
    on(firstBtn, 'click', () => handlers.onFrameChange(getCurrentState().selectedRange.start)),
  );
  playbackControls.appendChild(firstBtn);

  // Previous frame
  const prevBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Previous frame',
      title: 'Previous frame (←)',
    },
    ['⏴'],
  );
  cleanups.push(
    on(prevBtn, 'click', () => handlers.onFrameChange(getCurrentState().currentFrame - 1)),
  );
  playbackControls.appendChild(prevBtn);

  // Play/Pause
  const playBtn = createElement(
    'button',
    {
      className: `btn-play ${state.isPlaying ? 'playing' : ''}`,
      type: 'button',
      'aria-label': state.isPlaying ? 'Pause' : 'Play',
      title: 'Play/Pause (Space)',
    },
    [state.isPlaying ? '⏸' : '▶'],
  );
  cleanups.push(on(playBtn, 'click', () => handlers.onTogglePlay()));
  playbackControls.appendChild(playBtn);

  // Next frame
  const nextBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Next frame',
      title: 'Next frame (→)',
    },
    ['⏵'],
  );
  cleanups.push(
    on(nextBtn, 'click', () => handlers.onFrameChange(getCurrentState().currentFrame + 1)),
  );
  playbackControls.appendChild(nextBtn);

  // Last frame
  const lastBtn = createElement(
    'button',
    {
      className: 'btn-playback',
      type: 'button',
      'aria-label': 'Go to last frame',
      title: 'Last frame (End)',
    },
    ['⏭'],
  );
  cleanups.push(
    on(lastBtn, 'click', () => handlers.onFrameChange(getCurrentState().selectedRange.end)),
  );
  playbackControls.appendChild(lastBtn);

  // Time display - show current position within selection range
  const selectionFrameCount = state.selectedRange.end - state.selectedRange.start + 1;
  const currentInSelection = getPositionInSelection(state.currentFrame, state.selectedRange);
  const timeDisplay = createElement('div', { className: 'time-display' }, [
    createElement('span', { className: 'current' }, [frameToTimecode(currentInSelection, fps)]),
    createElement('span', { className: 'separator' }, [' / ']),
    createElement('span', { className: 'total' }, [frameToTimecode(selectionFrameCount, fps)]),
  ]);
  playbackControls.appendChild(timeDisplay);

  // Toolbar right - Export button (opens the Export GIF dialog over the
  // editor)
  const toolbarRight = createElement('div', { className: 'editor-toolbar-right' });
  const exportBtn = createElement(
    'button',
    {
      className: 'btn btn-primary',
      type: 'button',
      'aria-label': 'Export as GIF',
      'aria-haspopup': 'dialog',
      title: 'Export GIF (Ctrl/Cmd+E)',
    },
    [toolbarIcon('M8 2.5v8m-3.5-3.5L8 10.5l3.5-3.5M3 13.5h10'), 'Export GIF'],
  );
  cleanups.push(on(exportBtn, 'click', () => handlers.onExport()));
  toolbarRight.appendChild(exportBtn);

  toolbar.appendChild(toolbarLeft);
  toolbar.appendChild(playbackControls);
  toolbar.appendChild(toolbarRight);

  return { element: toolbar, cleanups };
}
