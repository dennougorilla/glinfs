import { describe, expect, it } from 'vitest';
import { estimateFramesMemoryMB } from '../../../../src/shared/utils/memory-monitor.js';

const MB = 1024 * 1024;

describe('estimateFramesMemoryMB', () => {
  it('counts every frame without a sharedKey at w*h*4', () => {
    const frames = [
      { width: 100, height: 50 },
      { width: 100, height: 50 },
    ];
    expect(estimateFramesMemoryMB(frames)).toBeCloseTo((2 * 100 * 50 * 4) / MB, 10);
  });

  it('counts each distinct sharedKey once (clone slots share pixels)', () => {
    const frames = [
      { width: 64, height: 48, sharedKey: 'a' },
      { width: 64, height: 48, sharedKey: 'a' },
      { width: 64, height: 48, sharedKey: 'a' },
      { width: 64, height: 48, sharedKey: 'b' },
      { width: 64, height: 48 },
    ];
    expect(estimateFramesMemoryMB(frames)).toBeCloseTo((3 * 64 * 48 * 4) / MB, 10);
  });

  it('treats missing dimensions and null entries as zero', () => {
    expect(estimateFramesMemoryMB([null, {}, { width: 10 }])).toBe(0);
    expect(estimateFramesMemoryMB([])).toBe(0);
  });
});
