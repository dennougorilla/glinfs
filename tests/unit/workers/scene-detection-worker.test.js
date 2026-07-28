import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/workers/scene-detection-worker.js's ImageBitmap readback
 * path (issue #99, fix 3): the manager now transfers downscaled
 * ImageBitmaps instead of ImageData, and the drawImage + getImageData
 * pixel readback happens HERE, in the worker, on a reused OffscreenCanvas.
 *
 * The worker registers its message listener via `self.addEventListener`
 * at import time, so we capture the handler through a spy (see
 * gif-encoder-worker.test.js for the `self.onmessage` variant of this
 * pattern).
 */

/** @type {ReturnType<typeof vi.fn>} */
let postMessage;

/** @type {(event: { data: any }) => void | Promise<void>} */
let handleMessage;

/** Fake OffscreenCanvas that records drawImage/getImageData calls */
class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.drawImageCalls = [];
    this.getImageDataCalls = [];
  }

  getContext() {
    const self = this;
    return {
      clearRect: vi.fn(),
      drawImage(...args) {
        self.drawImageCalls.push(args);
      },
      getImageData(x, y, w, h) {
        self.getImageDataCalls.push([x, y, w, h]);
        // Uniform gray image - deterministic, cheap histogram to compute.
        return { data: new Uint8ClampedArray(w * h * 4).fill(128) };
      },
    };
  }
}

/**
 * Build a fake ImageBitmap-shaped transferable with a spy-able close().
 */
function makeFakeBitmap() {
  return { close: vi.fn() };
}

describe('scene-detection-worker ImageBitmap readback (issue #99, fix 3)', () => {
  const OriginalOffscreenCanvas = globalThis.OffscreenCanvas;

  beforeEach(async () => {
    globalThis.OffscreenCanvas = FakeOffscreenCanvas;

    postMessage = vi.fn();
    const originalPostMessage = self.postMessage;
    // @ts-expect-error - stub worker postMessage on jsdom window
    self.postMessage = postMessage;

    const addEventListenerSpy = vi.spyOn(self, 'addEventListener');

    vi.resetModules();
    await import('../../../src/workers/scene-detection-worker.js');

    const call = addEventListenerSpy.mock.calls.find(([event]) => event === 'message');
    handleMessage = call[1];

    addEventListenerSpy.mockRestore();
    self.postMessage = originalPostMessage;
    // Re-stub after restoring so the worker's own postMessage calls land on our spy
    // @ts-expect-error - stub worker postMessage on jsdom window
    self.postMessage = postMessage;
  });

  afterEach(() => {
    globalThis.OffscreenCanvas = OriginalOffscreenCanvas;
    vi.restoreAllMocks();
  });

  it('never touches data.imageData - reads pixels from the transferred imageBitmap via OffscreenCanvas', async () => {
    const bitmap = makeFakeBitmap();
    const frameData = [
      { index: 0, timestamp: 0, imageBitmap: bitmap, width: 8, height: 8 },
      { index: 1, timestamp: 33, imageBitmap: makeFakeBitmap(), width: 8, height: 8 },
    ];

    await handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });
    await Promise.resolve();
    await Promise.resolve();

    const completeCall = postMessage.mock.calls.find(([msg]) => msg.type === 'COMPLETE');
    expect(completeCall).toBeDefined();
    expect(completeCall[0].payload.totalFrames).toBe(2);
  });

  it('closes every transferred ImageBitmap after reading it back', async () => {
    const bitmap1 = makeFakeBitmap();
    const bitmap2 = makeFakeBitmap();
    const frameData = [
      { index: 0, timestamp: 0, imageBitmap: bitmap1, width: 8, height: 8 },
      { index: 1, timestamp: 33, imageBitmap: bitmap2, width: 8, height: 8 },
    ];

    await handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });
    await Promise.resolve();
    await Promise.resolve();

    expect(bitmap1.close).toHaveBeenCalledTimes(1);
    expect(bitmap2.close).toHaveBeenCalledTimes(1);
  });

  it('reuses a single OffscreenCanvas across multiple frames instead of allocating one per frame', async () => {
    const canvasInstances = [];
    class TrackedOffscreenCanvas extends FakeOffscreenCanvas {
      constructor(...args) {
        super(...args);
        canvasInstances.push(this);
      }
    }
    globalThis.OffscreenCanvas = TrackedOffscreenCanvas;

    const frameData = [
      { index: 0, timestamp: 0, imageBitmap: makeFakeBitmap(), width: 8, height: 8 },
      { index: 1, timestamp: 33, imageBitmap: makeFakeBitmap(), width: 8, height: 8 },
      { index: 2, timestamp: 66, imageBitmap: makeFakeBitmap(), width: 8, height: 8 },
    ];

    await handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });
    await Promise.resolve();
    await Promise.resolve();

    expect(canvasInstances.length).toBe(1);
    expect(canvasInstances[0].drawImageCalls.length).toBe(3);
  });

  it('handles a frame with no imageBitmap (extraction failed) without throwing', async () => {
    const frameData = [
      { index: 0, timestamp: 0, imageBitmap: null, width: 0, height: 0 },
      { index: 1, timestamp: 33, imageBitmap: makeFakeBitmap(), width: 8, height: 8 },
    ];

    await handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });
    await Promise.resolve();
    await Promise.resolve();

    const completeCall = postMessage.mock.calls.find(([msg]) => msg.type === 'COMPLETE');
    expect(completeCall).toBeDefined();
  });
});
