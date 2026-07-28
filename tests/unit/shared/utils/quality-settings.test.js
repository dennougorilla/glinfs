import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSetting } from '../../../../src/shared/user-settings.js';
import {
  getQualityPreset,
  getThumbnailSizes,
} from '../../../../src/shared/utils/quality-settings.js';

const LEGACY_KEY = 'thumbnailQuality';

describe('quality-settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('getQualityPreset', () => {
    it('reads the preset saved by the settings screen (glinfs_user_settings blob)', () => {
      // Regression: the settings UI persists thumbnailQuality inside the
      // glinfs_user_settings JSON blob via user-settings.js, but
      // getQualityPreset only ever read a raw 'thumbnailQuality' key that
      // nothing wrote, so the setting had no effect.
      updateSetting('thumbnailQuality', undefined, 'high');

      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
      expect(getQualityPreset()).toBe('high');
    });

    it('falls back to device auto-detection when the saved preference is "auto"', () => {
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
      updateSetting('thumbnailQuality', undefined, 'auto');

      expect(getQualityPreset()).toBe('high');
    });

    it('falls back to device auto-detection when nothing is stored', () => {
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 2 });

      expect(getQualityPreset()).toBe('low');
    });

    it('ignores a stale raw thumbnailQuality key entirely (no legacy fallback)', () => {
      // Nothing shipped ever wrote this key; honoring it would let a stale
      // value override an explicit Auto (Codex review on #86)
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
      localStorage.setItem(LEGACY_KEY, 'low');

      expect(getQualityPreset()).toBe('high'); // device auto-detect wins
    });

    it('an explicit Auto in settings beats a stale raw key', () => {
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
      localStorage.setItem(LEGACY_KEY, 'low');
      updateSetting('thumbnailQuality', undefined, 'auto');

      expect(getQualityPreset()).toBe('high');
    });

    it('prefers the settings-screen blob over a stale raw key', () => {
      localStorage.setItem(LEGACY_KEY, 'low');
      updateSetting('thumbnailQuality', undefined, 'ultra');

      expect(getQualityPreset()).toBe('ultra');
    });
  });

  describe('getThumbnailSizes', () => {
    it('reflects the settings-screen preference end-to-end', () => {
      updateSetting('thumbnailQuality', undefined, 'ultra');

      expect(getThumbnailSizes()).toEqual({
        timeline: 160,
        gridMax: 400,
        gridDefault: 200,
        gridMin: 100,
      });
    });
  });
});
