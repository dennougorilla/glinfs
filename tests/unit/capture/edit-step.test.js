/**
 * The header's Edit step on the Capture screen leads back to the clips:
 * it is reachable whenever there is a clip to edit (the open one or a
 * queued one), whether or not a screen is being shared, and follows the
 * queue while Capture is on screen. The capture buffer alone is not a clip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCaptureState } from '../../../src/features/capture/state.js';
import { renderCaptureScreen } from '../../../src/features/capture/ui.js';
import { enqueueClip, resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

const MARKUP = `
  <nav class="step-indicator">
    <a href="#/capture" class="step" data-step="capture"></a>
    <span class="step-connector"></span>
    <a href="#/editor" class="step" data-step="editor"></a>
  </nav>
  <main id="main-content"></main>`;

function handlers() {
  return {
    onStart: vi.fn(async () => {}),
    onStop: vi.fn(),
    onCreateClip: vi.fn(async () => false),
    onSettingsChange: vi.fn(),
    getSettings: vi.fn(() => null),
  };
}

/** @param {string} id */
function clip(id) {
  return {
    id,
    frames: [{ id: `${id}-0`, frame: { close() {} }, timestamp: 0, width: 4, height: 4 }],
    fps: 10,
    capturedAt: Date.now(),
  };
}

const editStep = () => /** @type {Element} */ (document.querySelector('[data-step="editor"]'));

describe('Capture screen: the Edit step (feedback 2026-11-17, "cannot open another clip")', () => {
  /** @type {() => void} */
  let cleanup = () => {};

  beforeEach(() => {
    resetAppStore();
    document.body.innerHTML = MARKUP;
  });

  afterEach(() => {
    cleanup();
    resetAppStore();
    document.body.innerHTML = '';
  });

  it('is disabled with no clip, even while the buffer fills', () => {
    const state = initCaptureState();
    cleanup = renderCaptureScreen(
      /** @type {HTMLElement} */ (document.querySelector('#main-content')),
      { ...state, isSharing: true, stats: { ...state.stats, frameCount: 40 } },
      handlers(),
    );
    expect(editStep().classList).toContain('step--disabled');
  });

  it('leads back to the open clip with no screen shared', () => {
    setClipPayload(clip('a'));
    cleanup = renderCaptureScreen(
      /** @type {HTMLElement} */ (document.querySelector('#main-content')),
      initCaptureState(),
      handlers(),
    );
    expect(editStep().classList).not.toContain('step--disabled');
  });

  it('becomes reachable when a clip is queued while Capture is on screen', () => {
    cleanup = renderCaptureScreen(
      /** @type {HTMLElement} */ (document.querySelector('#main-content')),
      initCaptureState(),
      handlers(),
    );
    expect(editStep().classList).toContain('step--disabled');
    expect(enqueueClip(clip('b')).ok).toBe(true);
    expect(editStep().classList).not.toContain('step--disabled');
  });
});
