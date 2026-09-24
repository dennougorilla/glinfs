/**
 * Editor toolbar panel: back button, playback controls, time display, export
 * @module features/editor/panels/toolbar
 */

import { navigate } from '../../../shared/router.js';
import { createElement, on } from '../../../shared/utils/dom.js';
import { frameToTimecode } from '../../../shared/utils/format.js';
import { getPositionInSelection } from '../core.js';

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
      ['← Capture'],
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

  // Toolbar right - Export button
  const toolbarRight = createElement('div', { className: 'editor-toolbar-right' });
  const exportBtn = createElement(
    'button',
    {
      className: 'btn btn-primary',
      type: 'button',
      'aria-label': 'Export as GIF',
    },
    ['Export →'],
  );
  cleanups.push(
    on(exportBtn, 'click', () => {
      handlers.onExport();
      navigate('/export');
    }),
  );
  toolbarRight.appendChild(exportBtn);

  toolbar.appendChild(toolbarLeft);
  toolbar.appendChild(playbackControls);
  toolbar.appendChild(toolbarRight);

  return { element: toolbar, cleanups };
}
