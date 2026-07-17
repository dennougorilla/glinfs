import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertBitmapFramesToVideoFrames } from '../../../src/features/capture/index.js';

/**
 * Tests for the ImageBitmap -> VideoFrame conversion used by Create Clip.
 *
 * Regression for #40: the success path must close the source ImageBitmap
 * right after the VideoFrame is constructed (a VideoFrame owns its own copy
 * of the pixel data), instead of leaving up to maxFrames full-resolution
 * bitmaps to nondeterministic GC.
 */

/**
 * Mock VideoFrame for jsdom (which has no WebCodecs).
 * Reads control fields from the source bitmap:
 * - `__throwOnConstruct`: constructor throws
 * - `__codedWidth` / `__codedHeight`: override reported coded size
 */
class MockVideoFrame {
  /**
   * @param {any} source
   * @param {{ timestamp?: number }} [options]
   */
  constructor(source, options = {}) {
    if (source.__throwOnConstruct) {
      throw new Error('VideoFrame construction failed');
    }
    this.codedWidth = source.__codedWidth ?? source.width;
    this.codedHeight = source.__codedHeight ?? source.height;
    this.timestamp = options.timestamp ?? 0;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

/**
 * Create a mock transferred frame
 * @param {any} [bitmapOverrides]
 */
function createFrameItem(bitmapOverrides = {}) {
  return {
    id: crypto.randomUUID(),
    timestamp: 100,
    bitmap: {
      width: 640,
      height: 480,
      close: vi.fn(),
      ...bitmapOverrides,
    },
  };
}

describe('convertBitmapFramesToVideoFrames', () => {
  beforeEach(() => {
    vi.stubGlobal('VideoFrame', MockVideoFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes the source bitmap after a successful conversion (#40)', () => {
    const item = createFrameItem();

    const result = convertBitmapFramesToVideoFrames([item]);

    expect(result).toHaveLength(1);
    expect(item.bitmap.close).toHaveBeenCalledTimes(1);
    // The produced VideoFrame itself must stay open for the Editor
    expect(result[0].frame.closed).toBe(false);
  });

  it('produces frames with converted metadata', () => {
    const item = createFrameItem();

    const [frame] = convertBitmapFramesToVideoFrames([item]);

    expect(frame.id).toBe(item.id);
    expect(frame.timestamp).toBe(100 * 1000); // ms -> microseconds
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(480);
    expect(frame.frame).toBeInstanceOf(MockVideoFrame);
  });

  it('closes the bitmap and skips the frame when VideoFrame construction throws', () => {
    const item = createFrameItem({ __throwOnConstruct: true });

    const result = convertBitmapFramesToVideoFrames([item]);

    expect(result).toHaveLength(0);
    expect(item.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('closes an invalid bitmap (zero size) without constructing a VideoFrame', () => {
    const item = createFrameItem({ width: 0 });

    const result = convertBitmapFramesToVideoFrames([item]);

    expect(result).toHaveLength(0);
    expect(item.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('skips entries without a bitmap', () => {
    const item = { id: 'missing', timestamp: 1, bitmap: null };

    expect(() => convertBitmapFramesToVideoFrames([item])).not.toThrow();
    expect(convertBitmapFramesToVideoFrames([item])).toHaveLength(0);
  });

  it('closes both the VideoFrame and the bitmap when the VideoFrame is invalid', () => {
    const item = createFrameItem({ __codedWidth: 0 });

    const result = convertBitmapFramesToVideoFrames([item]);

    expect(result).toHaveLength(0);
    expect(item.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('converts valid frames and drops invalid ones in a mixed batch', () => {
    const valid = createFrameItem();
    const invalid = createFrameItem({ __throwOnConstruct: true });
    const validAfter = createFrameItem();

    const result = convertBitmapFramesToVideoFrames([valid, invalid, validAfter]);

    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual([valid.id, validAfter.id]);
    expect(valid.bitmap.close).toHaveBeenCalledTimes(1);
    expect(invalid.bitmap.close).toHaveBeenCalledTimes(1);
    expect(validAfter.bitmap.close).toHaveBeenCalledTimes(1);
  });
});
