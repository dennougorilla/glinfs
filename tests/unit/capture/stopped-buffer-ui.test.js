import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initCaptureState } from '../../../src/features/capture/state.js';
import { renderCaptureScreen } from '../../../src/features/capture/ui.js';

/**
 * B2 (memory audit, PR C preview): after the browser's "Stop sharing" the
 * ring buffer is kept. Create Clip stays reachable while it holds frames, so
 * the buffer can still become a clip; Select Screen comes after it.
 */

function createHandlers() {
  return {
    onStart: vi.fn(async () => {}),
    onStop: vi.fn(),
    onCreateClip: vi.fn(async () => false),
    onSettingsChange: vi.fn(),
    getSettings: vi.fn(() => null),
  };
}

/** @param {number} frameCount */
function stoppedState(frameCount) {
  const state = initCaptureState();
  return { ...state, isSharing: false, stats: { frameCount, duration: frameCount / 30, fps: 30 } };
}

describe('capture actions after the share stopped (B2)', () => {
  /** @type {HTMLElement} */
  let container;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('offers Create Clip first, then Select Screen, while frames are buffered', () => {
    renderCaptureScreen(container, stoppedState(90), createHandlers());
    const buttons = [...container.querySelectorAll('.capture-actions button')].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(['Create Clip', 'Select Screen']);
  });

  it('runs Create Clip from the stopped state', () => {
    const handlers = createHandlers();
    renderCaptureScreen(container, stoppedState(90), handlers);
    /** @type {HTMLButtonElement} */ (container.querySelector('.btn-create-clip')).click();
    expect(handlers.onCreateClip).toHaveBeenCalledOnce();
  });

  it('offers Select Screen alone with an empty buffer', () => {
    renderCaptureScreen(container, stoppedState(0), createHandlers());
    expect(container.querySelector('.btn-create-clip')).toBeNull();
    expect(container.querySelector('.btn-capture-start')).not.toBeNull();
  });
});
