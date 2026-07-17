import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initCaptureState } from '../../../src/features/capture/state.js';
import { renderCaptureScreen } from '../../../src/features/capture/ui.js';

/**
 * @returns {import('../../../src/features/capture/ui.js').CaptureUIHandlers}
 */
function createHandlers() {
  return {
    onStart: vi.fn(async () => {}),
    onStop: vi.fn(),
    onCreateClip: vi.fn(async () => {}),
    onSettingsChange: vi.fn(),
    getSettings: vi.fn(() => null),
  };
}

describe('renderCaptureScreen settings panel (issue #35)', () => {
  /** @type {HTMLElement} */
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
  });

  describe('when not sharing (isSharing=false)', () => {
    it('renders the FPS select enabled', () => {
      renderCaptureScreen(container, initCaptureState(), createHandlers());

      const fpsSelect = /** @type {HTMLSelectElement} */ (
        container.querySelector('.capture-settings select')
      );
      expect(fpsSelect).not.toBeNull();
      expect(fpsSelect.disabled).toBe(false);
      expect(fpsSelect.hasAttribute('disabled')).toBe(false);
    });

    it('renders the buffer duration range input enabled', () => {
      renderCaptureScreen(container, initCaptureState(), createHandlers());

      const rangeInput = /** @type {HTMLInputElement} */ (
        container.querySelector('.capture-settings input[type="range"]')
      );
      expect(rangeInput).not.toBeNull();
      expect(rangeInput.disabled).toBe(false);
      expect(rangeInput.hasAttribute('disabled')).toBe(false);
    });

    it('renders the scene detection toggle enabled without aria-disabled artifacts', () => {
      renderCaptureScreen(container, initCaptureState(), createHandlers());

      const toggle = /** @type {HTMLButtonElement} */ (
        container.querySelector('[data-setting="sceneDetection"]')
      );
      expect(toggle).not.toBeNull();
      expect(toggle.disabled).toBe(false);
      expect(toggle.hasAttribute('disabled')).toBe(false);
      expect(toggle.hasAttribute('aria-disabled')).toBe(false);
    });

    it('fires onSettingsChange when the FPS select changes', () => {
      const handlers = createHandlers();
      renderCaptureScreen(container, initCaptureState(), handlers);

      const fpsSelect = /** @type {HTMLSelectElement} */ (
        container.querySelector('.capture-settings select')
      );
      fpsSelect.value = '60';
      fpsSelect.dispatchEvent(new Event('change', { bubbles: true }));

      expect(handlers.onSettingsChange).toHaveBeenCalledWith({ fps: 60 });
    });
  });

  describe('when sharing (isSharing=true)', () => {
    /** @returns {import('../../../src/features/capture/types.js').CaptureState} */
    function createSharingState() {
      const state = initCaptureState();
      return { ...state, isSharing: true, stream: null };
    }

    it('renders the settings controls disabled', () => {
      renderCaptureScreen(container, createSharingState(), createHandlers());

      const fpsSelect = /** @type {HTMLSelectElement} */ (
        container.querySelector('.capture-settings select')
      );
      const rangeInput = /** @type {HTMLInputElement} */ (
        container.querySelector('.capture-settings input[type="range"]')
      );
      const toggle = /** @type {HTMLButtonElement} */ (
        container.querySelector('[data-setting="sceneDetection"]')
      );

      expect(fpsSelect.disabled).toBe(true);
      expect(rangeInput.disabled).toBe(true);
      expect(toggle.disabled).toBe(true);
      expect(toggle.getAttribute('aria-disabled')).toBe('true');
    });
  });
});
