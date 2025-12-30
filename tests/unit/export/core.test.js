import { describe, it, expect } from 'vitest';
import {
  createDefaultSettings,
  validateSettings,
  estimateSize,
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
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Loop count cannot be negative');
  });

  it('collects multiple errors', () => {
    const result = validateSettings({
      quality: 0.05,
      frameSkip: 10,
      playbackSpeed: 0.1,
      dithering: true,
      loopCount: -1,
      openInNewTab: false,
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
});

