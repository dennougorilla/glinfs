import { describe, it, expect } from 'vitest';
import { getEffectiveDimensions } from '../../../src/shared/utils/geometry.js';

describe('getEffectiveDimensions', () => {
  it('returns source dimensions when crop is null', () => {
    const source = { width: 1920, height: 1080 };
    const result = getEffectiveDimensions(source, null);

    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('returns crop dimensions when crop is provided', () => {
    const source = { width: 1920, height: 1080 };
    const crop = { width: 800, height: 600 };
    const result = getEffectiveDimensions(source, crop);

    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  it('handles small dimensions', () => {
    const source = { width: 100, height: 100 };
    const crop = { width: 10, height: 10 };
    const result = getEffectiveDimensions(source, crop);

    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });

  it('handles crop equal to source', () => {
    const source = { width: 640, height: 480 };
    const crop = { width: 640, height: 480 };
    const result = getEffectiveDimensions(source, crop);

    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });

  it('returns new object, not reference to input', () => {
    const source = { width: 1920, height: 1080 };
    const result = getEffectiveDimensions(source, null);

    expect(result).not.toBe(source);
    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('returns new object when crop is provided', () => {
    const source = { width: 1920, height: 1080 };
    const crop = { width: 800, height: 600 };
    const result = getEffectiveDimensions(source, crop);

    expect(result).not.toBe(crop);
    expect(result).toEqual({ width: 800, height: 600 });
  });
});
