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

describe('scene-detection-worker ImageBitmap ownership (issue #99, item c)', () => {
  const OriginalOffscreenCanvas = globalThis.OffscreenCanvas;

  beforeEach(async () => {
    globalThis.OffscreenCanvas = FakeOffscreenCanvas;

    postMessage = vi.fn();
    const addEventListenerSpy = vi.spyOn(self, 'addEventListener');

    vi.resetModules();
    await import('../../../src/workers/scene-detection-worker.js');

    const call = addEventListenerSpy.mock.calls.find(([event]) => event === 'message');
    handleMessage = call[1];
    addEventListenerSpy.mockRestore();

    // @ts-expect-error - stub worker postMessage on jsdom window
    self.postMessage = postMessage;
  });

  afterEach(() => {
    globalThis.OffscreenCanvas = OriginalOffscreenCanvas;
    vi.restoreAllMocks();
  });

  /** @param {number} count */
  function makeFrameData(count) {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      timestamp: i * 33,
      imageBitmap: makeFakeBitmap(),
      width: 8,
      height: 8,
    }));
  }

  /** @param {ReturnType<typeof makeFrameData>} frameData */
  function bitmapsOf(frameData) {
    return frameData.map((f) => f.imageBitmap);
  }

  function postedTypes() {
    return postMessage.mock.calls.map(([msg]) => msg.type);
  }

  it('closes every bitmap exactly once on normal completion', async () => {
    const frameData = makeFrameData(12);
    const bitmaps = bitmapsOf(frameData);

    await handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });

    expect(postedTypes()).toContain('COMPLETE');
    for (const bitmap of bitmaps) {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    }
  });

  it('closes the unprocessed bitmaps exactly once when a readback throws mid-batch', async () => {
    let drawCount = 0;
    class FailingOffscreenCanvas extends FakeOffscreenCanvas {
      getContext() {
        const ctx = super.getContext();
        const draw = ctx.drawImage;
        ctx.drawImage = (...args) => {
          drawCount++;
          if (drawCount === 3) throw new Error('readback boom');
          draw(...args);
        };
        return ctx;
      }
    }
    globalThis.OffscreenCanvas = FailingOffscreenCanvas;

    const frameData = makeFrameData(6);
    const bitmaps = bitmapsOf(frameData);

    await handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });

    const errorCall = postMessage.mock.calls.find(([msg]) => msg.type === 'ERROR');
    expect(errorCall[0].payload.message).toBe('readback boom');
    expect(postedTypes()).not.toContain('COMPLETE');
    // Frames 3-5 were never read back - they must still be released
    for (const bitmap of bitmaps) {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    }
  });

  it('closes the unprocessed bitmaps exactly once when cancelled mid-batch', async () => {
    const frameData = makeFrameData(15);
    const bitmaps = bitmapsOf(frameData);

    // Frame 0 is processed, then the loop yields - cancel lands there
    const detect = handleMessage({ data: { type: 'DETECT', payload: { frameData, options: {} } } });
    await handleMessage({ data: { type: 'CANCEL' } });
    await detect;

    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    expect(postedTypes()).not.toContain('COMPLETE');
    expect(postedTypes()).not.toContain('ERROR');
    for (const bitmap of bitmaps) {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a cancelled run cancelled when a new DETECT arrives before it observes the cancel', async () => {
    const staleFrames = makeFrameData(15);
    const freshFrames = makeFrameData(3);
    const allBitmaps = [...bitmapsOf(staleFrames), ...bitmapsOf(freshFrames)];

    const stale = handleMessage({
      data: { type: 'DETECT', payload: { frameData: staleFrames, options: {} } },
    });
    await handleMessage({ data: { type: 'CANCEL' } });
    const fresh = handleMessage({
      data: { type: 'DETECT', payload: { frameData: freshFrames, options: {} } },
    });
    await Promise.all([stale, fresh]);

    // Only the fresh run completes; the stale one must not post a result
    // that the manager would attribute to the new request
    const completes = postMessage.mock.calls.filter(([msg]) => msg.type === 'COMPLETE');
    expect(completes).toHaveLength(1);
    expect(completes[0][0].payload.totalFrames).toBe(3);
    for (const bitmap of allBitmaps) {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    }
  });

  /**
   * Resolves once the run has posted the 'analyzing' PROGRESS for its last
   * frame. The run is then synchronously finishing that frame and parks on
   * its final yield, so messages sent after awaiting this land in that yield.
   * @param {number} lastIndex
   */
  function whenLastFrameAnalyzing(lastIndex) {
    return new Promise((resolve) => {
      postMessage.mockImplementation((msg) => {
        if (msg.type === 'PROGRESS' && msg.payload.currentFrame === lastIndex) resolve();
      });
    });
  }

  it.each([
    [1, 3],
    [1, 1],
    [11, 3],
    [11, 1],
  ])(
    'drops a %i-frame run cancelled during its final yield; the %i-frame restart gets the only COMPLETE',
    async (staleCount, freshCount) => {
      const staleFrames = makeFrameData(staleCount);
      const freshFrames = makeFrameData(freshCount);
      const allBitmaps = [...bitmapsOf(staleFrames), ...bitmapsOf(freshFrames)];

      const lastAnalyzing = whenLastFrameAnalyzing(staleCount - 1);
      const stale = handleMessage({
        data: { type: 'DETECT', requestId: 1, payload: { frameData: staleFrames, options: {} } },
      });
      await lastAnalyzing;
      postMessage.mockImplementation(() => {});
      const staleMessagesBeforeCancel = postMessage.mock.calls.length;

      await handleMessage({ data: { type: 'CANCEL' } });
      const fresh = handleMessage({
        data: { type: 'DETECT', requestId: 2, payload: { frameData: freshFrames, options: {} } },
      });
      await Promise.all([stale, fresh]);

      const completes = postMessage.mock.calls.filter(([msg]) => msg.type === 'COMPLETE');
      expect(completes).toHaveLength(1);
      expect(completes[0][0].requestId).toBe(2);
      expect(completes[0][0].payload.totalFrames).toBe(freshCount);
      // Nothing at all from the stale run after the cancel - not even its
      // final 'complete' PROGRESS
      const staleAfterCancel = postMessage.mock.calls
        .slice(staleMessagesBeforeCancel)
        .filter(([msg]) => msg.requestId === 1);
      expect(staleAfterCancel).toEqual([]);
      expect(postedTypes()).not.toContain('ERROR');
      for (const bitmap of allBitmaps) {
        expect(bitmap.close).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('echoes the DETECT requestId on every PROGRESS and COMPLETE', async () => {
    await handleMessage({
      data: { type: 'DETECT', requestId: 7, payload: { frameData: makeFrameData(3), options: {} } },
    });

    const replies = postMessage.mock.calls.map(([msg]) => msg);
    expect(replies.map((msg) => msg.type)).toContain('COMPLETE');
    for (const msg of replies) {
      expect(msg.requestId).toBe(7);
    }
  });

  it('echoes the requestId on ERROR', async () => {
    class FailingOffscreenCanvas extends FakeOffscreenCanvas {
      getContext() {
        const ctx = super.getContext();
        ctx.drawImage = () => {
          throw new Error('readback boom');
        };
        return ctx;
      }
    }
    globalThis.OffscreenCanvas = FailingOffscreenCanvas;

    await handleMessage({
      data: { type: 'DETECT', requestId: 4, payload: { frameData: makeFrameData(2), options: {} } },
    });

    const errorCall = postMessage.mock.calls.find(([msg]) => msg.type === 'ERROR');
    expect(errorCall[0].requestId).toBe(4);
  });

  it('does not post ERROR for a run that was cancelled before it failed', async () => {
    class CancelThenFailOffscreenCanvas extends FakeOffscreenCanvas {
      getContext() {
        const ctx = super.getContext();
        ctx.drawImage = () => {
          handleMessage({ data: { type: 'CANCEL' } });
          throw new Error('readback boom');
        };
        return ctx;
      }
    }
    globalThis.OffscreenCanvas = CancelThenFailOffscreenCanvas;
    const frameData = makeFrameData(4);
    const bitmaps = bitmapsOf(frameData);

    await handleMessage({
      data: { type: 'DETECT', requestId: 5, payload: { frameData, options: {} } },
    });

    expect(postedTypes()).not.toContain('ERROR');
    expect(postedTypes()).not.toContain('COMPLETE');
    for (const bitmap of bitmaps) {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    }
  });
});
