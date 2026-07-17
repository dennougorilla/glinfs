import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGif } from '../../../src/features/export/api.js';
import { Commands, Events } from '../../../src/workers/worker-protocol.js';

/**
 * Mock Worker simulating the GIF encoder worker protocol.
 *
 * - INIT      -> replies READY asynchronously
 * - ADD_FRAME -> accepted silently
 * - FINISH    -> never replies (simulates a long-running encode)
 * - CANCEL    -> replies CANCELLED asynchronously
 *
 * Messages are not delivered after terminate(), matching real Worker
 * semantics.
 */
class MockEncoderWorker {
  constructor() {
    /** @type {Map<string, Array<{handler: Function, options?: {once?: boolean}}>>} */
    this.listeners = new Map();
    this.terminated = false;
    /** @type {any[]} */
    this.messages = [];
  }

  addEventListener(event, handler, options) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)?.push({ handler, options });
  }

  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    const index = handlers.findIndex((h) => h.handler === handler);
    if (index !== -1) handlers.splice(index, 1);
  }

  postMessage(message) {
    this.messages.push(message);

    if (message.command === Commands.INIT) {
      this._reply({ event: Events.READY, encoderId: message.encoderId });
    } else if (message.command === Commands.CANCEL) {
      this._reply({ event: Events.CANCELLED });
    }
    // ADD_FRAME and FINISH intentionally get no reply: encoding "in progress"
  }

  terminate() {
    this.terminated = true;
  }

  /**
   * Deliver a worker event asynchronously (skipped if terminated)
   * @param {any} data
   */
  _reply(data) {
    queueMicrotask(() => {
      if (this.terminated) return;
      const handlers = [...(this.listeners.get('message') || [])];
      handlers.forEach(({ handler, options }) => {
        handler({ data });
        if (options?.once) {
          this.removeEventListener('message', handler);
        }
      });
    });
  }

  /**
   * @param {string} command
   * @returns {boolean}
   */
  received(command) {
    return this.messages.some((m) => m.command === command);
  }
}

/**
 * Create a mock frame whose VideoFrame supports copyTo
 * @param {string} id
 * @param {number} width
 * @param {number} height
 */
function createMockFrame(id, width = 16, height = 16) {
  return {
    id,
    frame: {
      codedWidth: width,
      codedHeight: height,
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    },
    timestamp: 0,
    width,
    height,
  };
}

const SETTINGS = {
  quality: 0.7,
  frameSkip: 1,
  playbackSpeed: 1,
  encoderPreset: 'balanced',
  loopCount: 0,
  encoderId: 'gifenc-js',
};

const OriginalWorker = globalThis.Worker;

describe('encodeGif cancellation (regression #38)', () => {
  /** @type {MockEncoderWorker | null} */
  let workerInstance = null;

  beforeEach(() => {
    workerInstance = null;
    // @ts-expect-error - Mock Worker
    globalThis.Worker = class extends MockEncoderWorker {
      constructor() {
        super();
        workerInstance = this;
      }
    };
  });

  afterEach(() => {
    globalThis.Worker = OriginalWorker;
  });

  it('settles with AbortError when cancelled while finish() is pending', async () => {
    // Arrange
    const controller = new AbortController();
    const frames = [createMockFrame('f0'), createMockFrame('f1')];

    // Act - mirror handleExport: start encode, then cancel mid-flight
    const encodePromise = encodeGif(
      { frames, crop: null, settings: SETTINGS, fps: 30, onProgress: vi.fn() },
      controller.signal,
    );
    // Guard against unhandled rejection between abort and the assertion
    encodePromise.catch(() => {});

    // Wait until the main thread is awaiting finish() (FINISH sent to worker)
    await vi.waitFor(() => {
      expect(workerInstance?.received(Commands.FINISH)).toBe(true);
    });

    controller.abort();

    // Assert - before the fix, encodePromise never settled (UI frozen on
    // "Creating your GIF..."), so this expectation timed out.
    await expect(encodePromise).rejects.toMatchObject({ name: 'AbortError' });
  }, 5000);

  it('sends CANCEL to the worker and disposes only after settling', async () => {
    // Arrange
    const controller = new AbortController();
    const frames = [createMockFrame('f0'), createMockFrame('f1')];

    const encodePromise = encodeGif(
      { frames, crop: null, settings: SETTINGS, fps: 30, onProgress: vi.fn() },
      controller.signal,
    );
    encodePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(workerInstance?.received(Commands.FINISH)).toBe(true);
    });

    // Act
    controller.abort();

    // Assert - abort must only request cancellation, not terminate the
    // worker (termination would kill the CANCELLED reply path)
    expect(workerInstance?.received(Commands.CANCEL)).toBe(true);
    expect(workerInstance?.terminated).toBe(false);

    await expect(encodePromise).rejects.toMatchObject({ name: 'AbortError' });

    // The finally block disposes the manager once the flow settles
    expect(workerInstance?.terminated).toBe(true);
  }, 5000);

  it('rejects with AbortError when aborted during frame submission', async () => {
    // Arrange
    const controller = new AbortController();
    const frames = [createMockFrame('f0'), createMockFrame('f1'), createMockFrame('f2')];
    // Abort as soon as the first frame is extracted
    frames[0].frame.copyTo.mockImplementation(async () => {
      controller.abort();
    });

    // Act & Assert
    await expect(
      encodeGif(
        { frames, crop: null, settings: SETTINGS, fps: 30, onProgress: vi.fn() },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(workerInstance?.terminated).toBe(true);
  }, 5000);
});
