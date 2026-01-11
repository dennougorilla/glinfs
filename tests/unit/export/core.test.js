import { describe, it, expect } from 'vitest';
import {
  createDefaultSettings,
  validateSettings,
  estimateSize,
  ENCODER_PRESETS,
  getEncoderPreset,
  calculateMaxColors,
} from '../../../src/features/export/core.js';

describe('createDefaultSettings', () => {
  it('creates default export settings', () => {
    const settings = createDefaultSettings();

    expect(settings.quality).toBe(0.8);
    expect(settings.frameSkip).toBe(1);
    expect(settings.playbackSpeed).toBe(1);
    expect(settings.dithering).toBe(true);
    expect(settings.loopCount).toBe(0);
    expect(settings.openInNewTab).toBe(false);
    expect(settings.encoderPreset).toBe('balanced');
  });
});

describe('validateSettings', () => {
  it('accepts valid settings', () => {
    const result = validateSettings({
      quality: 0.8,
      frameSkip: 1,
      playbackSpeed: 1,
      dithering: true,
      loopCount: 0,
      openInNewTab: false,
      encoderPreset: 'balanced',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects quality below minimum', () => {
    const result = validateSettings({
      quality: 0.05,
      frameSkip: 1,
      playbackSpeed: 1,
      dithering: true,
      loopCount: 0,
      openInNewTab: false,
      encoderPreset: 'balanced',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Quality must be between 0.1 and 1.0');
  });

  it('rejects quality above maximum', () => {
    const result = validateSettings({
      quality: 1.5,
      frameSkip: 1,
      playbackSpeed: 1,
      dithering: true,
      loopCount: 0,
      openInNewTab: false,
      encoderPreset: 'balanced',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Quality must be between 0.1 and 1.0');
  });

  it('rejects invalid frameSkip', () => {
    const result = validateSettings({
      quality: 0.8,
      frameSkip: 10,
      playbackSpeed: 1,
      dithering: true,
      loopCount: 0,
      openInNewTab: false,
      encoderPreset: 'balanced',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Frame skip must be 1, 2, 3, 4, or 5');
  });

  it('rejects playbackSpeed below minimum', () => {
    const result = validateSettings({
      quality: 0.8,
      frameSkip: 1,
      playbackSpeed: 0.1,
      dithering: true,
      loopCount: 0,
      openInNewTab: false,
      encoderPreset: 'balanced',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Playback speed must be between 0.25 and 4.0');
  });

  it('rejects negative loopCount', () => {
    const result = validateSettings({
      quality: 0.8,
      frameSkip: 1,
      playbackSpeed: 1,
      dithering: true,
      loopCount: -1,
      openInNewTab: false,
      encoderPreset: 'balanced',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Loop count cannot be negative');
  });

  it('rejects invalid encoderPreset', () => {
    const result = validateSettings({
      quality: 0.8,
      frameSkip: 1,
      playbackSpeed: 1,
      dithering: true,
      loopCount: 0,
      openInNewTab: false,
      encoderPreset: /** @type {any} */ ('invalid'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid encoder preset');
  });

  it('accepts all valid encoder presets', () => {
    const presets = ['quality', 'balanced', 'fast'];
    for (const preset of presets) {
      const result = validateSettings({
        quality: 0.8,
        frameSkip: 1,
        playbackSpeed: 1,
        dithering: true,
        loopCount: 0,
        openInNewTab: false,
        encoderPreset: /** @type {any} */ (preset),
      });
      expect(result.valid).toBe(true);
    }
  });

  it('collects multiple errors', () => {
    const result = validateSettings({
      quality: 0.05,
      frameSkip: 10,
      playbackSpeed: 0.1,
      dithering: true,
      loopCount: -1,
      openInNewTab: false,
      encoderPreset: /** @type {any} */ ('invalid'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('estimateSize', () => {
  it('estimates size based on dimensions and frame count', () => {
    const size = estimateSize({
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: true,
      frameSkip: 1,
    });

    expect(size).toBeGreaterThan(0);
    // Size should be reasonable (not too small, not too big)
    expect(size).toBeGreaterThan(10000); // At least 10KB
    expect(size).toBeLessThan(100000000); // Less than 100MB
  });

  it('higher quality increases size', () => {
    const lowQuality = estimateSize({
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 0.3,
      dithering: false,
      frameSkip: 1,
    });

    const highQuality = estimateSize({
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 1.0,
      dithering: false,
      frameSkip: 1,
    });

    expect(highQuality).toBeGreaterThan(lowQuality);
  });

  it('dithering increases size', () => {
    const withoutDithering = estimateSize({
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: false,
      frameSkip: 1,
    });

    const withDithering = estimateSize({
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: true,
      frameSkip: 1,
    });

    expect(withDithering).toBeGreaterThan(withoutDithering);
  });

  it('frame skip reduces effective frame count', () => {
    const noSkip = estimateSize({
      frameCount: 60,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: false,
      frameSkip: 1,
    });

    const withSkip = estimateSize({
      frameCount: 60,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: false,
      frameSkip: 2,
    });

    // With skip of 2, should be roughly half the size
    expect(withSkip).toBeLessThan(noSkip);
  });

  it('fast preset produces smaller estimated size than quality preset', () => {
    const baseParams = {
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: false,
      frameSkip: 1,
    };

    const qualitySize = estimateSize({ ...baseParams, encoderPreset: 'quality' });
    const fastSize = estimateSize({ ...baseParams, encoderPreset: 'fast' });

    expect(fastSize).toBeLessThan(qualitySize);
  });

  it('balanced preset produces intermediate size', () => {
    const baseParams = {
      frameCount: 30,
      width: 640,
      height: 480,
      quality: 0.8,
      dithering: false,
      frameSkip: 1,
    };

    const qualitySize = estimateSize({ ...baseParams, encoderPreset: 'quality' });
    const balancedSize = estimateSize({ ...baseParams, encoderPreset: 'balanced' });
    const fastSize = estimateSize({ ...baseParams, encoderPreset: 'fast' });

    expect(balancedSize).toBeLessThan(qualitySize);
    expect(balancedSize).toBeGreaterThan(fastSize);
  });
});

describe('ENCODER_PRESETS', () => {
  it('should have three presets', () => {
    expect(ENCODER_PRESETS).toHaveLength(3);
  });

  it('should have valid preset structure', () => {
    ENCODER_PRESETS.forEach((preset) => {
      expect(preset).toHaveProperty('id');
      expect(preset).toHaveProperty('name');
      expect(preset).toHaveProperty('description');
      expect(preset).toHaveProperty('format');
      expect(preset).toHaveProperty('maxColorsMultiplier');
    });
  });

  it('should include quality, balanced, and fast presets', () => {
    const ids = ENCODER_PRESETS.map((p) => p.id);
    expect(ids).toContain('quality');
    expect(ids).toContain('balanced');
    expect(ids).toContain('fast');
  });

  it('should have valid format values', () => {
    ENCODER_PRESETS.forEach((preset) => {
      expect(['rgb565', 'rgb444']).toContain(preset.format);
    });
  });
});

describe('getEncoderPreset', () => {
  it('should return preset for quality id', () => {
    const preset = getEncoderPreset('quality');
    expect(preset.id).toBe('quality');
    expect(preset.format).toBe('rgb565');
    expect(preset.maxColorsMultiplier).toBe(1.0);
  });

  it('should return preset for balanced id', () => {
    const preset = getEncoderPreset('balanced');
    expect(preset.id).toBe('balanced');
    expect(preset.format).toBe('rgb565');
    expect(preset.maxColorsMultiplier).toBe(0.5);
  });

  it('should return preset for fast id', () => {
    const preset = getEncoderPreset('fast');
    expect(preset.id).toBe('fast');
    expect(preset.format).toBe('rgb444');
    expect(preset.maxColorsMultiplier).toBe(0.25);
  });

  it('should throw for invalid preset id', () => {
    expect(() => getEncoderPreset(/** @type {any} */ ('invalid'))).toThrow(
      'Unknown encoder preset: invalid'
    );
  });
});

describe('calculateMaxColors', () => {
  it('should return full colors for quality preset at max quality', () => {
    const colors = calculateMaxColors(1.0, 'quality');
    expect(colors).toBe(256);
  });

  it('should return reduced colors for balanced preset', () => {
    const colors = calculateMaxColors(1.0, 'balanced');
    expect(colors).toBe(128); // 256 * 0.5
  });

  it('should return further reduced colors for fast preset', () => {
    const colors = calculateMaxColors(1.0, 'fast');
    expect(colors).toBe(64); // 256 * 0.25
  });

  it('should respect minimum of 16 colors', () => {
    const colors = calculateMaxColors(0.1, 'fast');
    expect(colors).toBeGreaterThanOrEqual(16);
  });

  it('should scale with quality setting', () => {
    const highQuality = calculateMaxColors(1.0, 'quality');
    const lowQuality = calculateMaxColors(0.5, 'quality');
    expect(highQuality).toBeGreaterThan(lowQuality);
  });
});

