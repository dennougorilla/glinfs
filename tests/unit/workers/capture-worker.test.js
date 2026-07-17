import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/workers/capture-worker.js (frame buffer lifecycle, #40).
 *
 * The worker registers `self.onmessage` at import time, so it can be tested
 * directly in jsdom by stubbing `self.postMessage` and invoking the handler
 * with synthetic MessageEvent-shaped objects.
 */

/**
 * Create a mock ImageBitmap
 * @param {number} [width]
 * @param {number} [height]
 */
function createMockBitmap(width = 640, height = 480) {
  return {
    width,
    height,
    close: vi.fn(),
  };
}

describe('capture-worker', () => {
  /** @type {(e: { data: any }) => void} */
  let onmessage;

  /** @type {ReturnType<typeof vi.fn>} */
  let postMessage;

  /** @type {any} */
  let originalOnMessage;

  /** @type {any} */
  let originalPostMessage;

  /**
   * Dispatch a message to the worker's onmessage handler
   * @param {string} type
   * @param {any} [payload]
   */
  function send(type, payload) {
    onmessage({ data: { type, payload } });
  }

  /**
   * Find the last posted message of a given type
   * @param {string} type
   */
  function lastPosted(type) {
    const call = postMessage.mock.calls.filter(([msg]) => msg.type === type).at(-1);
    return call ? call[0] : undefined;
  }

  beforeEach(async () => {
    vi.useFakeTimers();

    originalOnMessage = self.onmessage;
    originalPostMessage = self.postMessage;
    postMessage = vi.fn();
    // @ts-expect-error - stub worker postMessage on jsdom window
    self.postMessage = postMessage;

    // Fresh worker module state per test
    vi.resetModules();
    await import('../../../src/workers/capture-worker.js');
    onmessage = /** @type {any} */ (self.onmessage);
  });

  afterEach(() => {
    // Stop the capture interval and drop buffered frames
    send('STOP');
    send('CLEAR');

    self.onmessage = originalOnMessage;
    // @ts-expect-error - restore jsdom window postMessage
    self.postMessage = originalPostMessage;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('buffers frames that arrive while capturing without closing them', () => {
    const bitmap = createMockBitmap();

    send('START', { fps: 30, maxFrames: 10 });
    send('FRAME_RESPONSE', { bitmap, timestamp: 123 });

    expect(bitmap.close).not.toHaveBeenCalled();

    send('GET_FRAMES');
    const response = lastPosted('FRAMES_RESPONSE');
    expect(response).toBeDefined();
    expect(response.payload.frames).toHaveLength(1);
    expect(response.payload.frames[0].bitmap).toBe(bitmap);
    expect(response.payload.frames[0].timestamp).toBe(123);
  });

  it('closes an in-flight frame that arrives after STOP instead of leaking it (#40)', () => {
    const bitmap = createMockBitmap();

    send('START', { fps: 30, maxFrames: 10 });
    // A FRAME_REQUEST is in flight on the main thread when STOP is processed
    send('STOP');
    send('FRAME_RESPONSE', { bitmap, timestamp: 456 });

    expect(bitmap.close).toHaveBeenCalledTimes(1);

    // The late frame must not have been buffered either
    send('GET_FRAMES');
    const response = lastPosted('FRAMES_RESPONSE');
    expect(response.payload.frames).toHaveLength(0);
  });

  it('ignores a null frame response after STOP', () => {
    send('START', { fps: 30, maxFrames: 10 });
    send('STOP');

    expect(() => send('FRAME_RESPONSE', { bitmap: null, timestamp: 456 })).not.toThrow();
  });

  it('evicts and closes the oldest frame when the buffer is full', () => {
    const first = createMockBitmap();
    const second = createMockBitmap();
    const third = createMockBitmap();

    send('START', { fps: 30, maxFrames: 2 });
    send('FRAME_RESPONSE', { bitmap: first, timestamp: 1 });
    send('FRAME_RESPONSE', { bitmap: second, timestamp: 2 });
    send('FRAME_RESPONSE', { bitmap: third, timestamp: 3 });

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(third.close).not.toHaveBeenCalled();
  });

  it('closes all buffered frames on CLEAR', () => {
    const first = createMockBitmap();
    const second = createMockBitmap();

    send('START', { fps: 30, maxFrames: 10 });
    send('FRAME_RESPONSE', { bitmap: first, timestamp: 1 });
    send('FRAME_RESPONSE', { bitmap: second, timestamp: 2 });

    send('CLEAR');

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);

    const stats = lastPosted('STATS_UPDATE');
    expect(stats.payload.frameCount).toBe(0);
  });
});
