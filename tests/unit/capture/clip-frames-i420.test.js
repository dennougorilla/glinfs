import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D3's cheap half, without the wait (#233 after win-r9's measurement): the
 * open clip shows at once on its GPU RGBA frames, and those are swapped for
 * CPU I420 copies one by one in the background, each GPU frame closed as
 * its copy lands. Only while the clip is still the open one: a clip that
 * left (queued, deleted) is being encoded or held, and keeps its frames.
 */

vi.mock('../../../src/workers/i420-converter.js', () => ({
  convertToI420: vi.fn(),
  isCpuFrameConversionAvailable: vi.fn(() => true),
}));

import {
  convertOpenClipFrames,
  countAsCpuCopies,
} from '../../../src/features/capture/clip-frames-i420.js';
import { getClipPayload, resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';
import { I420_COLOR_SPACE } from '../../../src/shared/i420.js';
import {
  convertToI420,
  isCpuFrameConversionAvailable,
} from '../../../src/workers/i420-converter.js';

class MockVideoFrame {
  /**
   * @param {any} source - I420 bytes (ArrayBuffer)
   * @param {any} [init]
   */
  constructor(source, init = {}) {
    this.init = init;
    this.format = init.format;
    this.codedWidth = init.codedWidth;
    this.codedHeight = init.codedHeight;
    this.timestamp = init.timestamp;
    this.closed = false;
    this.bytes = source;
  }
  close() {
    this.closed = true;
  }
}

/** A GPU RGBA VideoFrame of the open clip */
function gpuFrame(timestamp, w = 4, h = 2) {
  const vf = {
    format: 'RGBA',
    codedWidth: w,
    codedHeight: h,
    displayWidth: w,
    displayHeight: h,
    timestamp,
    closed: false,
    close: vi.fn(() => {
      vf.closed = true;
    }),
    /** @type {any[]} */
    clones: [],
    clone: vi.fn(() => {
      const copy = { ...vf, close: vi.fn(), clone: undefined, isClone: true };
      vf.clones.push(copy);
      return copy;
    }),
  };
  return vf;
}

/** @param {number} n */
function openClip(n) {
  const frames = Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    frame: /** @type {any} */ (gpuFrame(i * 33_333)),
    timestamp: i * 33_333,
    width: 4,
    height: 2,
  }));
  setClipPayload({ frames, fps: 30, capturedAt: 1 });
  return frames;
}

/**
 * A converter whose frames are delivered by the test
 * @returns {{ deliver: (index: number) => void, finish: (rest?: number[]) => void, calls: any[] }}
 */
function manualConverter() {
  /** @type {any[]} */
  const calls = [];
  vi.mocked(convertToI420).mockImplementation((items, options = {}) => {
    /** @type {(value: any) => void} */
    let settle = () => {};
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    calls.push({ items, options, settle });
    return /** @type {any} */ (done);
  });
  return {
    calls,
    deliver(index) {
      const { items, options } = calls.at(-1);
      options.onFrame?.({
        index,
        id: items[index].id,
        timestamp: items[index].timestamp,
        width: 4,
        height: 2,
        data: new ArrayBuffer(12),
      });
    },
    finish(rest = []) {
      const { items, settle } = calls.at(-1);
      settle({
        converted: [],
        rest: rest.map((index) => ({ index, item: items[index] })),
        lost: 0,
        engine: 'webgpu',
      });
    },
  };
}

beforeEach(() => {
  resetAppStore();
  vi.stubGlobal('VideoFrame', MockVideoFrame);
  vi.mocked(convertToI420).mockReset();
  vi.mocked(isCpuFrameConversionAvailable).mockReturnValue(true);
});

afterEach(() => {
  resetAppStore();
  vi.unstubAllGlobals();
});

describe('convertOpenClipFrames', () => {
  it('swaps each GPU frame of the open clip for its I420 copy as it lands', async () => {
    const converter = manualConverter();
    const frames = openClip(3);
    const originals = frames.map((f) => f.frame);
    const job = convertOpenClipFrames();

    // Clones go to the worker; the clip keeps showing its own frames
    const { items } = converter.calls[0];
    expect(items.map((/** @type {any} */ i) => i.source.isClone)).toEqual([true, true, true]);
    expect(frames.map((f) => f.frame)).toEqual(originals);

    converter.deliver(1);
    expect(frames[1].frame).toBeInstanceOf(MockVideoFrame);
    expect(frames[1].frame.init).toMatchObject({
      format: 'I420',
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 33_333,
      colorSpace: I420_COLOR_SPACE,
    });
    expect(frames[1].byteLength).toBe(12);
    expect(originals[1].close).toHaveBeenCalledOnce();
    // The others are untouched until their copy lands
    expect(frames[0].frame).toBe(originals[0]);
    expect(originals[0].close).not.toHaveBeenCalled();

    converter.deliver(0);
    converter.deliver(2);
    converter.finish();
    await job;
    expect(frames.every((f) => f.frame instanceof MockVideoFrame)).toBe(true);
    expect(getClipPayload()?.frames).toBe(frames);
  });

  it('stops swapping once the clip is no longer the open one', async () => {
    const converter = manualConverter();
    const frames = openClip(2);
    const originals = frames.map((f) => f.frame);
    const job = convertOpenClipFrames();
    converter.deliver(0);

    // Another clip opens: this one is queued (and encoded) as it is now
    openClip(1);
    converter.deliver(1);
    converter.finish();
    await job;

    expect(frames[0].frame).toBeInstanceOf(MockVideoFrame);
    expect(frames[1].frame).toBe(originals[1]);
    expect(originals[1].close).not.toHaveBeenCalled();
  });

  it('runs one job per clip, and none for frames already on the CPU', async () => {
    const converter = manualConverter();
    openClip(2);
    const job = convertOpenClipFrames();
    expect(convertOpenClipFrames()).toBeNull();
    expect(converter.calls).toHaveLength(1);
    converter.deliver(0);
    converter.deliver(1);
    converter.finish();
    await job;

    // Every frame is I420 now: nothing left to do
    expect(convertOpenClipFrames()).toBeNull();
    expect(converter.calls).toHaveLength(1);
  });

  it('closes the clones the worker gave back, and the clip keeps those frames', async () => {
    const converter = manualConverter();
    const frames = openClip(2);
    const originals = frames.map((f) => f.frame);
    const job = convertOpenClipFrames();
    const { items } = converter.calls[0];
    converter.deliver(0);
    converter.finish([1]);
    await job;

    expect(items[1].source.close).toHaveBeenCalledOnce();
    expect(frames[1].frame).toBe(originals[1]);
    expect(originals[1].close).not.toHaveBeenCalled();
  });

  it('counts frames at their copy size, and back at GPU size where no copy landed', async () => {
    const converter = manualConverter();
    const frames = openClip(2);
    countAsCpuCopies(frames);
    // The budget check sees what the clip will hold (4x2 I420 = 12 B)
    expect(frames.map((f) => f.byteLength)).toEqual([12, 12]);
    const job = convertOpenClipFrames();
    // Counted ahead does not mean copied: both still go
    expect(converter.calls[0].items).toHaveLength(2);
    converter.deliver(0);
    converter.finish([1]);
    await job;
    expect(frames[0].byteLength).toBe(12);
    // Still the GPU frame: counted as one again
    expect(frames[1].byteLength).toBeUndefined();
  });

  it('counts nothing ahead without a converter', () => {
    vi.mocked(isCpuFrameConversionAvailable).mockReturnValue(false);
    const frames = openClip(1);
    countAsCpuCopies(frames);
    expect(frames[0].byteLength).toBeUndefined();
  });

  it('does nothing without a converter, or without an open clip', () => {
    expect(convertOpenClipFrames()).toBeNull();
    openClip(2);
    vi.mocked(isCpuFrameConversionAvailable).mockReturnValue(false);
    expect(convertOpenClipFrames()).toBeNull();
    expect(convertToI420).not.toHaveBeenCalled();
  });
});
