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

  /**
   * Answer the pending FRAME_REQUEST, then let the capture interval post the
   * next one (fps 30 in these tests)
   * @param {any} bitmap
   * @param {number} timestamp
   */
  function respond(bitmap, timestamp) {
    const requestId = lastPosted('FRAME_REQUEST')?.payload.requestId;
    send('FRAME_RESPONSE', { bitmap, timestamp, requestId });
    vi.advanceTimersByTime(34);
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
    respond(bitmap, 123);

    expect(bitmap.close).not.toHaveBeenCalled();

    send('GET_FRAMES');
    const response = lastPosted('FRAMES_RESPONSE');
    expect(response).toBeDefined();
    expect(response.payload.frames).toHaveLength(1);
    expect(response.payload.frames[0].bitmap).toBe(bitmap);
    expect(response.payload.frames[0].timestamp).toBe(123);
    expect(lastPosted('STATS_UPDATE').payload.frameCount).toBe(0);
  });

  it('closes an in-flight frame that arrives after STOP instead of leaking it (#40)', () => {
    const bitmap = createMockBitmap();

    send('START', { fps: 30, maxFrames: 10 });
    // A FRAME_REQUEST is in flight on the main thread when STOP is processed
    send('STOP');
    respond(bitmap, 456);

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

  it('keeps one grab in flight when a request from before a restart is answered late', () => {
    // A change of source restarts capture while a grab is still pending.
    send('START', { fps: 10, maxFrames: 10 });
    const stale = lastPosted('FRAME_REQUEST').payload.requestId;
    send('STOP');
    send('CLEAR');
    send('START', { fps: 10, maxFrames: 10 });
    const current = lastPosted('FRAME_REQUEST').payload.requestId;
    const requests = () =>
      postMessage.mock.calls.filter(([m]) => m.type === 'FRAME_REQUEST').length;
    const before = requests();

    // The old grab's (null) answer must not release the new grab's slot
    send('FRAME_RESPONSE', { bitmap: null, timestamp: 1, requestId: stale });
    vi.advanceTimersByTime(300);
    expect(requests()).toBe(before);

    // A late frame for the old request is closed, not buffered
    const late = createMockBitmap();
    send('FRAME_RESPONSE', { bitmap: late, timestamp: 2, requestId: stale });
    expect(late.close).toHaveBeenCalledTimes(1);

    // The current request's answer is buffered and frees the slot again
    const frame = createMockBitmap();
    send('FRAME_RESPONSE', { bitmap: frame, timestamp: 3, requestId: current });
    vi.advanceTimersByTime(100);
    expect(requests()).toBe(before + 1);
    send('GET_FRAMES');
    expect(lastPosted('FRAMES_RESPONSE').payload.frames.map((f) => f.bitmap)).toEqual([frame]);
  });

  it('evicts and closes the oldest frame when the buffer is full', () => {
    const first = createMockBitmap();
    const second = createMockBitmap();
    const third = createMockBitmap();

    send('START', { fps: 30, maxFrames: 2 });
    respond(first, 1);
    respond(second, 2);
    respond(third, 3);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(third.close).not.toHaveBeenCalled();
  });

  it('returns wrapped frames in capture order without shifting the array', () => {
    const first = createMockBitmap();
    const second = createMockBitmap();
    const third = createMockBitmap();
    const fourth = createMockBitmap();

    send('START', { fps: 30, maxFrames: 2 });
    respond(first, 1);
    respond(second, 2);
    respond(third, 3);
    respond(fourth, 4);
    send('GET_FRAMES');

    const response = lastPosted('FRAMES_RESPONSE');
    expect(response.payload.frames.map((frame) => frame.timestamp)).toEqual([3, 4]);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest frames when the buffer capacity shrinks', () => {
    const first = createMockBitmap();
    const second = createMockBitmap();
    const third = createMockBitmap();

    send('START', { fps: 30, maxFrames: 3 });
    respond(first, 1);
    respond(second, 2);
    respond(third, 3);
    send('STOP');
    send('START', { fps: 30, maxFrames: 2 });
    send('GET_FRAMES');

    const response = lastPosted('FRAMES_RESPONSE');
    expect(response.payload.frames.map((frame) => frame.timestamp)).toEqual([2, 3]);
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it('closes all buffered frames on CLEAR', () => {
    const first = createMockBitmap();
    const second = createMockBitmap();

    send('START', { fps: 30, maxFrames: 10 });
    respond(first, 1);
    respond(second, 2);

    send('CLEAR');

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);

    const stats = lastPosted('STATS_UPDATE');
    expect(stats.payload.frameCount).toBe(0);
  });
});
