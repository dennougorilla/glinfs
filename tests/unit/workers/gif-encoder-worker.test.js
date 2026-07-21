import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/workers/gif-encoder-worker.js session-abort handling (#45
 * remaining hardening): a frame-add failure must not be silently swallowed
 * by continuing to feed the (possibly inconsistent) encoder further frames,
 * and FINISH must fail fast rather than emit a GIF missing frames.
 *
 * The worker registers `self.onmessage` at import time, so it can be tested
 * directly in jsdom by stubbing `self.postMessage` and invoking the handler
 * with synthetic MessageEvent-shaped objects (see capture-worker.test.js).
 */

const addFrame = vi.fn();
const finish = vi.fn(() => new Uint8Array([1, 2, 3]));
const dispose = vi.fn();
const init = vi.fn(async () => {});

vi.mock('../../../src/features/export/encoders/gifenc-encoder.js', () => ({
  createGifencEncoder: () => ({
    init,
    addFrame,
    finish,
    dispose,
  }),
}));

vi.mock('../../../src/features/export/encoders/gifsicle-encoder.js', () => ({
  createGifsicleEncoder: () => ({
    init,
    addFrame,
    finish,
    dispose,
  }),
}));

describe('gif-encoder-worker session abort (#45)', () => {
  /** @type {(e: { data: any }) => void} */
  let onmessage;

  /** @type {ReturnType<typeof vi.fn>} */
  let postMessage;

  /** @type {any} */
  let originalOnMessage;

  /** @type {any} */
  let originalPostMessage;

  /**
   * Dispatch a command to the worker's onmessage handler and flush
   * microtasks (INIT/handler bodies are async).
   * @param {Record<string, any>} data
   */
  async function send(data) {
    await onmessage({ data });
    await Promise.resolve();
  }

  /**
   * Find the last posted event of a given type
   * @param {string} event
   */
  function lastPosted(event) {
    const call = postMessage.mock.calls.filter(([msg]) => msg.event === event).at(-1);
    return call ? call[0] : undefined;
  }

  function makeFrame(frameIndex = 0) {
    return {
      command: 'add-frame',
      rgbaData: new Uint8ClampedArray(16).buffer,
      width: 2,
      height: 2,
      frameIndex,
    };
  }

  beforeEach(async () => {
    addFrame.mockReset();
    finish.mockReset().mockReturnValue(new Uint8Array([1, 2, 3]));
    dispose.mockReset();
    init.mockReset().mockResolvedValue(undefined);

    originalOnMessage = self.onmessage;
    originalPostMessage = self.postMessage;
    postMessage = vi.fn();
    // @ts-expect-error - stub worker postMessage on jsdom window
    self.postMessage = postMessage;

    vi.resetModules();
    await import('../../../src/workers/gif-encoder-worker.js');
    onmessage = /** @type {any} */ (self.onmessage);
  });

  afterEach(() => {
    self.onmessage = originalOnMessage;
    // @ts-expect-error - restore jsdom window postMessage
    self.postMessage = originalPostMessage;
  });

  it('drops further ADD_FRAME calls after a frame failure instead of feeding the encoder', async () => {
    addFrame.mockImplementationOnce(() => {
      throw new Error('quantize failed');
    });

    await send({
      command: 'init',
      encoderId: 'gifenc-js',
      width: 2,
      height: 2,
      totalFrames: 2,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    });

    await send(makeFrame(0));
    expect(addFrame).toHaveBeenCalledTimes(1);
    const errorEvent = lastPosted('error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.code).toBe('FRAME_ERROR');

    postMessage.mockClear();
    await send(makeFrame(1));

    // The second frame must never reach the (possibly inconsistent) encoder.
    expect(addFrame).toHaveBeenCalledTimes(1);
    // And no PROGRESS should be reported for a frame that was dropped.
    expect(lastPosted('progress')).toBeUndefined();
  });

  it('fails FINISH immediately after a frame failure instead of producing a GIF missing frames', async () => {
    addFrame.mockImplementationOnce(() => {
      throw new Error('quantize failed');
    });

    await send({
      command: 'init',
      encoderId: 'gifenc-js',
      width: 2,
      height: 2,
      totalFrames: 2,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    });

    await send(makeFrame(0));

    postMessage.mockClear();
    await send({ command: 'finish' });

    expect(finish).not.toHaveBeenCalled();
    const errorEvent = lastPosted('error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.code).toBe('SESSION_ABORTED');
    expect(lastPosted('complete')).toBeUndefined();
  });

  it('resets the abort flag on a fresh INIT so a new session is not poisoned by the previous failure', async () => {
    addFrame.mockImplementationOnce(() => {
      throw new Error('quantize failed');
    });

    await send({
      command: 'init',
      encoderId: 'gifenc-js',
      width: 2,
      height: 2,
      totalFrames: 1,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    });
    await send(makeFrame(0));
    expect(lastPosted('error').code).toBe('FRAME_ERROR');

    // Start a brand-new session.
    postMessage.mockClear();
    await send({
      command: 'init',
      encoderId: 'gifenc-js',
      width: 2,
      height: 2,
      totalFrames: 1,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    });
    expect(lastPosted('ready')).toBeDefined();

    await send(makeFrame(0));
    expect(addFrame).toHaveBeenCalledTimes(2);
    expect(lastPosted('progress')).toBeDefined();

    postMessage.mockClear();
    await send({ command: 'finish' });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(lastPosted('complete')).toBeDefined();
  });
});
