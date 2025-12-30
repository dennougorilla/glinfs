import { describe, it, expect } from 'vitest';
import { validateSettings } from '../../../src/features/capture/core.js';

describe('validateSettings', () => {
  it('accepts valid settings', () => {
    const result = validateSettings({
      fps: 30,
      bufferDuration: 10,
      thumbnailQuality: 0.5,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts all valid fps values', () => {
    expect(validateSettings({ fps: 15 }).valid).toBe(true);
    expect(validateSettings({ fps: 30 }).valid).toBe(true);
    expect(validateSettings({ fps: 60 }).valid).toBe(true);
  });

  it('rejects invalid fps', () => {
    const result = validateSettings({ fps: 45 });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('FPS must be 15, 30, or 60');
  });

  it('rejects buffer duration below minimum', () => {
    const result = validateSettings({ bufferDuration: 3 });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Buffer duration must be between 5 and 60 seconds');
  });

  it('rejects buffer duration above maximum', () => {
    const result = validateSettings({ bufferDuration: 120 });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Buffer duration must be between 5 and 60 seconds');
  });

  it('accepts valid buffer duration range', () => {
    expect(validateSettings({ bufferDuration: 5 }).valid).toBe(true);
    expect(validateSettings({ bufferDuration: 30 }).valid).toBe(true);
    expect(validateSettings({ bufferDuration: 60 }).valid).toBe(true);
  });

  it('rejects thumbnail quality below minimum', () => {
    const result = validateSettings({ thumbnailQuality: 0.05 });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Thumbnail quality must be between 0.1 and 1.0');
  });

  it('rejects thumbnail quality above maximum', () => {
    const result = validateSettings({ thumbnailQuality: 1.5 });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Thumbnail quality must be between 0.1 and 1.0');
  });

  it('collects multiple errors', () => {
    const result = validateSettings({
      fps: 45,
      bufferDuration: 2,
      thumbnailQuality: 2.0,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it('handles partial settings', () => {
    // Only check fields that are provided
    const result = validateSettings({ fps: 30 });

    expect(result.valid).toBe(true);
  });
});
