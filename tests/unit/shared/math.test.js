import { describe, it, expect } from 'vitest';
import { clamp, lerp, mapRange, round } from '../../../src/shared/utils/math.js';

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('returns min when value is below range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('returns max when value is above range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('handles edge cases at boundaries', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('lerp', () => {
  it('returns start value when t is 0', () => {
    expect(lerp(0, 100, 0)).toBe(0);
  });

  it('returns end value when t is 1', () => {
    expect(lerp(0, 100, 1)).toBe(100);
  });

  it('returns midpoint when t is 0.5', () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it('works with negative numbers', () => {
    expect(lerp(-10, 10, 0.5)).toBe(0);
  });
});

describe('mapRange', () => {
  it('maps value from one range to another', () => {
    expect(mapRange(5, 0, 10, 0, 100)).toBe(50);
  });

  it('maps minimum to minimum', () => {
    expect(mapRange(0, 0, 10, 0, 100)).toBe(0);
  });

  it('maps maximum to maximum', () => {
    expect(mapRange(10, 0, 10, 0, 100)).toBe(100);
  });

  it('works with inverted ranges', () => {
    expect(mapRange(0, 0, 10, 100, 0)).toBe(100);
    expect(mapRange(10, 0, 10, 100, 0)).toBe(0);
  });
});

describe('round', () => {
  it('rounds to specified decimal places', () => {
    expect(round(3.14159, 2)).toBe(3.14);
    expect(round(3.14159, 3)).toBe(3.142);
  });

  it('rounds to whole number when decimals is 0', () => {
    expect(round(3.7, 0)).toBe(4);
    expect(round(3.2, 0)).toBe(3);
  });

  it('handles negative numbers', () => {
    expect(round(-3.14159, 2)).toBe(-3.14);
  });
});
