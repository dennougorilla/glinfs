import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettings } from '../../../src/features/settings/ui.js';
import { loadSettings, saveSettings } from '../../../src/shared/user-settings.js';

describe('renderSettings', () => {
  /** @type {HTMLElement} */
  let container;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<main id="main-content"></main>';
    container = document.getElementById('main-content');
  });

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  describe('text rendering', () => {
    it('renders visible label text (not empty elements)', () => {
      // Regression for #36: textContent was passed inside the attrs object,
      // becoming a useless "textcontent" attribute, so every label was blank.
      renderSettings(container);

      const text = container.textContent;
      expect(text).toContain('Settings');
      expect(text).toContain('← Back');
      expect(text).toContain('Reset All');
      expect(text).toContain('Capture');
      expect(text).toContain('Export');
      expect(text).toContain('Frame Rate');
      expect(text).toContain('Scene Detection');
      expect(text).toContain('Dithering');
      expect(text).toContain('Thumbnail Quality');
    });

    it('renders in English, matching the rest of the app', () => {
      // The screen used to be the only Japanese surface in an English UI.
      renderSettings(container);
      expect(container.textContent).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    });

    it('does not leave stray textcontent attributes', () => {
      renderSettings(container);
      expect(container.querySelector('[textcontent]')).toBeNull();
    });

    it('renders toggle button text reflecting the current value', () => {
      renderSettings(container);
      // First toggle is capture.sceneDetection (default: true)
      const toggle = container.querySelector('.btn-toggle');
      expect(toggle.textContent).toBe('On');
      expect(toggle.classList.contains('btn-toggle--active')).toBe(true);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
    });

    it('uses the shared toggle classes so it matches the Capture sidebar', () => {
      // settings.css used to ship a competing `.btn-toggle` rule; both
      // screens now render the one defined in form-controls.css.
      renderSettings(container);
      const toggle = container.querySelector('.btn-toggle');
      expect(toggle.classList.contains('btn')).toBe(true);
      expect(toggle.getAttribute('type')).toBe('button');
    });
  });

  describe('boolean toggle', () => {
    it('toggling twice restores the original saved value', () => {
      // Regression for #36: the click handler captured the initial value in a
      // closure, so every click saved !initialValue and the setting could
      // never be restored.
      renderSettings(container);
      const toggle = container.querySelector('.btn-toggle'); // capture.sceneDetection

      expect(loadSettings().capture.sceneDetection).toBe(true);

      toggle.click();
      expect(loadSettings().capture.sceneDetection).toBe(false);
      expect(toggle.textContent).toBe('Off');
      expect(toggle.getAttribute('aria-pressed')).toBe('false');

      toggle.click();
      expect(loadSettings().capture.sceneDetection).toBe(true);
      expect(toggle.textContent).toBe('On');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('select controls', () => {
    it('marks only the option matching the saved value as selected', () => {
      // Regression for #36: the selected attribute was set even when false,
      // so the last option always rendered selected.
      renderSettings(container);

      // First select is capture.fps (default: 30, not the last option)
      const select = container.querySelector('.settings-select');
      expect(select.value).toBe('30');

      const selectedOptions = [...select.querySelectorAll('option[selected]')];
      expect(selectedOptions).toHaveLength(1);
      expect(selectedOptions[0].value).toBe('30');
    });

    it('reflects a non-default saved value', () => {
      const settings = loadSettings();
      settings.capture.fps = 15;
      saveSettings(settings);

      renderSettings(container);

      const select = container.querySelector('.settings-select');
      expect(select.value).toBe('15');
    });

    it('persists the typed option value on change', () => {
      renderSettings(container);

      const select = container.querySelector('.settings-select');
      select.value = '60';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      // Stored as the number 60, not the string '60'
      expect(loadSettings().capture.fps).toBe(60);
    });
  });

  describe('re-render on reset', () => {
    it('keeps the back handler working after a category reset', () => {
      // Regression for #36: re-render after reset read the handler from the
      // container._onBack expando, which renderSettings never set.
      vi.stubGlobal(
        'confirm',
        vi.fn(() => true),
      );
      const onBack = vi.fn();
      renderSettings(container, { onBack });

      const categoryResetBtn = container.querySelector('.settings-section-header .btn-sm');
      categoryResetBtn.click();

      // Screen re-rendered; back button must still call the original handler
      const backBtn = container.querySelector('.settings-header button');
      backBtn.click();
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('resets values to defaults when "reset all" is confirmed', () => {
      vi.stubGlobal(
        'confirm',
        vi.fn(() => true),
      );
      const settings = loadSettings();
      settings.capture.fps = 60;
      saveSettings(settings);

      renderSettings(container);
      // Header buttons: [back, reset all]
      const resetAllBtn = container.querySelectorAll('.settings-header button')[1];
      resetAllBtn.click();

      expect(loadSettings().capture.fps).toBe(30);
      expect(container.querySelector('.settings-select').value).toBe('30');
    });
  });

  it('returns a cleanup function that detaches listeners without throwing', () => {
    const cleanup = renderSettings(container);
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });
});
