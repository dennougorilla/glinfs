import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDefaultSettings,
  loadSettings,
  onSettingsChange,
  rememberAiCutoutModel,
  resetCategory,
  resetSettings,
  saveSettings,
  updateSetting,
} from '../../../src/shared/user-settings.js';

const STORAGE_KEY = 'glinfs_user_settings';

describe('user-settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('loadSettings', () => {
    it('returns defaults when nothing is stored', () => {
      const settings = loadSettings();
      expect(settings).toEqual(getDefaultSettings());
    });

    it('returns defaults when stored JSON is corrupted', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      localStorage.setItem(STORAGE_KEY, '{not valid json!!');

      const settings = loadSettings();

      expect(settings).toEqual(getDefaultSettings());
      expect(errorSpy).toHaveBeenCalled();
    });

    it('returns a deep copy so mutations cannot corrupt the defaults', () => {
      // Regression: loadSettings returned a shallow copy sharing the nested
      // capture/export objects, so updateSetting mutated DEFAULT_SETTINGS
      // itself and reset could never restore the original values.
      const settings = loadSettings();
      settings.capture.fps = 999;
      settings.export.dithering = false;

      expect(getDefaultSettings().capture.fps).toBe(30);
      expect(loadSettings().capture.fps).toBe(30);
      expect(loadSettings().export.dithering).toBe(true);
    });

    it('merges stored partial settings with defaults', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ capture: { fps: 60 } }));

      const settings = loadSettings();

      expect(settings.capture.fps).toBe(60);
      // Missing keys fall back to defaults
      expect(settings.capture.sceneDetection).toBe(true);
      expect(settings.export.dithering).toBe(true);
      expect(settings.thumbnailQuality).toBe('auto');
    });
  });

  describe('saveSettings / roundtrip', () => {
    it('persists and reloads the same values', () => {
      const settings = loadSettings();
      settings.capture.fps = 15;
      settings.export.dithering = false;
      settings.thumbnailQuality = 'high';

      saveSettings(settings);

      const reloaded = loadSettings();
      expect(reloaded.capture.fps).toBe(15);
      expect(reloaded.export.dithering).toBe(false);
      expect(reloaded.thumbnailQuality).toBe('high');
    });
  });

  describe('updateSetting', () => {
    it('updates a category setting and persists it', () => {
      updateSetting('capture', 'sceneDetection', false);
      expect(loadSettings().capture.sceneDetection).toBe(false);
    });

    it('prepares downloaded AI models by default, and stores the choice', () => {
      expect(loadSettings().aiCutout.preloadModels).toBe(true);
      updateSetting('aiCutout', 'preloadModels', false);
      expect(loadSettings().aiCutout.preloadModels).toBe(false);
      // Settings saved before the option existed get the default
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ capture: {}, export: {} }));
      expect(loadSettings().aiCutout).toEqual({
        preloadModels: true,
        lastModel: null,
        lastModelBySubject: {},
      });
    });

    it('remembers the AI cutout model chosen last, overall and per subject', () => {
      expect(loadSettings().aiCutout.lastModel).toBeNull();
      const listener = vi.fn();
      const unsubscribe = onSettingsChange(listener);
      rememberAiCutoutModel('ben2', 'general');
      rememberAiCutoutModel('portrait', 'portrait');
      expect(loadSettings().aiCutout.lastModel).toBe('portrait');
      expect(loadSettings().aiCutout.lastModelBySubject).toEqual({
        general: 'ben2',
        portrait: 'portrait',
      });
      // The same choice again writes nothing
      rememberAiCutoutModel('portrait', 'portrait');
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      // Without a subject only the overall choice changes
      rememberAiCutoutModel('anime');
      expect(loadSettings().aiCutout.lastModel).toBe('anime');
      expect(loadSettings().aiCutout.lastModelBySubject.general).toBe('ben2');
    });

    it('drops remembered models of the wrong shape', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          aiCutout: { lastModel: 42, lastModelBySubject: { general: 'ben2', portrait: 7 } },
        }),
      );
      expect(loadSettings().aiCutout).toEqual({
        preloadModels: true,
        lastModel: null,
        lastModelBySubject: { general: 'ben2' },
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ aiCutout: { lastModelBySubject: [] } }));
      expect(loadSettings().aiCutout.lastModelBySubject).toEqual({});
    });

    it('updates thumbnailQuality with a null key', () => {
      updateSetting('thumbnailQuality', null, 'ultra');
      expect(loadSettings().thumbnailQuality).toBe('ultra');
    });

    it('notifies listeners with the updated settings', () => {
      const listener = vi.fn();
      const unsubscribe = onSettingsChange(listener);

      updateSetting('export', 'quality', 0.5);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].export.quality).toBe(0.5);
      unsubscribe();
    });
  });

  describe('resetCategory / resetSettings', () => {
    it('resets only the given category', () => {
      updateSetting('capture', 'fps', 60);
      updateSetting('export', 'dithering', false);

      resetCategory('capture');

      const settings = loadSettings();
      expect(settings.capture.fps).toBe(30);
      expect(settings.export.dithering).toBe(false);
    });

    it('resets the AI cutout category with fresh remembered models', () => {
      rememberAiCutoutModel('ben2', 'general');
      resetCategory('aiCutout');
      expect(loadSettings().aiCutout).toEqual(getDefaultSettings().aiCutout);
      rememberAiCutoutModel('portrait', 'portrait');
      expect(getDefaultSettings().aiCutout.lastModelBySubject).toEqual({});
    });

    it('resets everything to defaults', () => {
      updateSetting('capture', 'fps', 60);
      updateSetting('thumbnailQuality', null, 'low');

      resetSettings();

      expect(loadSettings()).toEqual(getDefaultSettings());
    });
  });
});
