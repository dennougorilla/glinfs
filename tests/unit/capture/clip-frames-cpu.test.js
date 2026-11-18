import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D3's cheap half: Create Clip and Clip Now turn the capture bitmaps into
 * CPU I420 VideoFrames (1.5 B/px, off the GPU) through the converter
 * worker. Frames the worker gives back are made the old way (RGBA).
 */

vi.mock('../../../src/workers/i420-converter.js', () => ({
  convertBitmapsToI420: vi.fn(),
  isCpuFrameConversionAvailable: vi.fn(() => true),
}));

import { convertBitmapFramesToClipFrames } from '../../../src/features/capture/index.js';
import { I420_COLOR_SPACE } from '../../../src/shared/i420.js';
import { convertBitmapsToI420 } from '../../../src/workers/i420-converter.js';

class MockVideoFrame {
  /**
   * @param {any} source - An ArrayBuffer (I420 bytes) or a bitmap
   * @param {any} [init]
   */
  constructor(source, init = {}) {
    this.init = init;
    this.fromBuffer = source instanceof ArrayBuffer;
    this.format = this.fromBuffer ? init.format : 'RGBA';
    this.codedWidth = this.fromBuffer ? init.codedWidth : source.width;
    this.codedHeight = this.fromBuffer ? init.codedHeight : source.height;
    this.timestamp = init.timestamp ?? 0;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

/** @param {number} i @param {number} [w] @param {number} [h] */
function item(i, w = 4, h = 2) {
  return { id: `f${i}`, timestamp: i * 33, bitmap: { width: w, height: h, close: vi.fn() } };
}

/** @param {{ index: number, id: string, timestamp: number }} entry */
function converted({ index, id, timestamp }, w = 4, h = 2) {
  return { index, id, timestamp, width: w, height: h, data: new ArrayBuffer(w * h * 1.5) };
}

beforeEach(() => {
  vi.stubGlobal('VideoFrame', MockVideoFrame);
  vi.mocked(convertBitmapsToI420).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('convertBitmapFramesToClipFrames', () => {
  it('makes I420 VideoFrames from the converted bytes, with their real size', async () => {
    const input = [item(0), item(1)];
    vi.mocked(convertBitmapsToI420).mockImplementation(async (items) => ({
      converted: items.map((it, index) => converted({ index, id: it.id, timestamp: it.timestamp })),
      rest: [],
      lost: 0,
      engine: 'webgl2',
    }));

    const frames = await convertBitmapFramesToClipFrames(input);

    expect(frames.map((f) => [f.id, f.timestamp, f.width, f.height, f.byteLength])).toEqual([
      ['f0', 0, 4, 2, 12],
      ['f1', 33000, 4, 2, 12],
    ]);
    const vf = /** @type {any} */ (frames[0].frame);
    expect(vf.format).toBe('I420');
    expect(vf.init).toMatchObject({
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 0,
      colorSpace: I420_COLOR_SPACE,
    });
    // The bytes move into the frame without a copy
    expect(vf.init.transfer).toHaveLength(1);
  });

  it('makes the frames the worker gave back the old way, in capture order', async () => {
    const input = [item(0), item(1), item(2)];
    vi.mocked(convertBitmapsToI420).mockImplementation(async (items) => ({
      converted: [converted({ index: 0, id: items[0].id, timestamp: items[0].timestamp })],
      rest: [1, 2].map((index) => ({ index, item: items[index] })),
      lost: 0,
      engine: 'webgl2',
    }));

    const frames = await convertBitmapFramesToClipFrames(input);

    expect(frames.map((f) => f.id)).toEqual(['f0', 'f1', 'f2']);
    expect(frames.map((f) => /** @type {any} */ (f.frame).format)).toEqual([
      'I420',
      'RGBA',
      'RGBA',
    ]);
    expect(input[1].bitmap.close).toHaveBeenCalled();
    expect(frames[1].byteLength).toBeUndefined();
  });

  it('sends only the newest source, and closes the older and empty bitmaps', async () => {
    const old = item(0, 8, 4);
    const empty = item(2, 0, 0);
    const input = [old, item(1), empty, item(3)];
    vi.mocked(convertBitmapsToI420).mockImplementation(async (items) => ({
      converted: items.map((it, index) => converted({ index, id: it.id, timestamp: it.timestamp })),
      rest: [],
      lost: 0,
      engine: 'webgl2',
    }));

    const frames = await convertBitmapFramesToClipFrames(input);

    expect(vi.mocked(convertBitmapsToI420).mock.calls[0][0].map((it) => it.id)).toEqual([
      'f1',
      'f3',
    ]);
    expect(old.bitmap.close).toHaveBeenCalled();
    expect(empty.bitmap.close).toHaveBeenCalled();
    expect(frames.map((f) => f.id)).toEqual(['f1', 'f3']);
  });

  it('skips a frame whose bytes cannot make a VideoFrame', async () => {
    vi.mocked(convertBitmapsToI420).mockImplementation(async (items) => ({
      converted: items.map((it, index) => ({
        ...converted({ index, id: it.id, timestamp: it.timestamp }),
        // Too short for a 4x2 I420 frame
        ...(index === 0 ? { data: new ArrayBuffer(2) } : {}),
      })),
      rest: [],
      lost: 0,
      engine: 'webgl2',
    }));
    vi.stubGlobal(
      'VideoFrame',
      class extends MockVideoFrame {
        /** @param {any} source @param {any} init */
        constructor(source, init) {
          if (source instanceof ArrayBuffer && source.byteLength < 12) throw new TypeError('size');
          super(source, init);
        }
      },
    );

    const frames = await convertBitmapFramesToClipFrames([item(0), item(1)]);
    expect(frames.map((f) => f.id)).toEqual(['f1']);
  });
});
