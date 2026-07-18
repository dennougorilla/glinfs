import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureWorkerManager } from '../../../src/workers/capture-worker-manager.js';

/**
 * Mock Worker injected via globalThis.Worker.
 * Supports both `onmessage` assignment (used by the manager's main handler)
 * and addEventListener (used by terminateWithCleanup).
 */
class MockWorker {
  /** @type {MockWorker[]} */
  static instances = [];

  /**
   * @param {URL | string} url
   * @param {WorkerOptions} [options]
   */
  constructor(url, options) {
    this.url = url;
    this.options = options;
    /** @type {((e: { data: any }) => void) | null} */
    this.onmessage = null;
    /** @type {((e: { message: string }) => void) | null} */
    this.onerror = null;
    this.terminated = false;
    /** @type {Array<{ message: any, transfer?: any[] }>} */
    this.messages = [];
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    MockWorker.instances.push(this);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  addEventListener(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)?.push(handler);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    const index = handlers.indexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  }

  /**
   * @param {any} message
   * @param {any[]} [transfer]
   */
  postMessage(message, transfer) {
    this.messages.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  /**
   * Test helper: simulate a message from the worker
   * @param {any} data
   */
  _simulateMessage(data) {
    const event = { data };
    this.onmessage?.(event);
    for (const handler of [...(this.listeners.get('message') ?? [])]) {
      handler(event);
    }
  }

  /**
   * Test helper: find the last posted message of a given type
   * @param {string} type
   */
  _lastMessage(type) {
    return this.messages.filter((m) => m.message.type === type).at(-1);
  }
}

/**
 * Create a minimal fake video element
 * @param {number} [readyState]
 */
function createFakeVideo(readyState = 4) {
  return /** @type {HTMLVideoElement} */ (/** @type {unknown} */ ({ readyState }));
}

describe('CaptureWorkerManager', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('creates a worker on init and reports initialized', () => {
    const manager = new CaptureWorkerManager();
    expect(manager.isInitialized).toBe(false);

    manager.init(createFakeVideo());

    expect(manager.isInitialized).toBe(true);
    expect(MockWorker.instances).toHaveLength(1);
  });

  it('does not post START before init', () => {
    const manager = new CaptureWorkerManager();

    manager.start(30, 450);

    expect(MockWorker.instances).toHaveLength(0);
  });

  it('posts START with fps and maxFrames', () => {
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo());
    const worker = MockWorker.instances[0];

    manager.start(30, 450);

    const started = worker._lastMessage('START');
    expect(started).toBeDefined();
    expect(started?.message.payload).toEqual({ fps: 30, maxFrames: 450 });
  });

  it('resolves requestFrames with frames from FRAMES_RESPONSE', async () => {
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo());
    const worker = MockWorker.instances[0];

    const promise = manager.requestFrames();
    expect(worker._lastMessage('GET_FRAMES')).toBeDefined();

    const frames = [{ id: 'a', bitmap: {}, timestamp: 1 }];
    worker._simulateMessage({ type: 'FRAMES_RESPONSE', payload: { frames } });

    await expect(promise).resolves.toEqual(frames);
  });

  it('resolves requestFrames with an empty array when not initialized', async () => {
    const manager = new CaptureWorkerManager();

    await expect(manager.requestFrames()).resolves.toEqual([]);
  });

  it('forwards STATS_UPDATE to the stats callback', () => {
    const onStatsUpdate = vi.fn();
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo(), { onStatsUpdate });
    const worker = MockWorker.instances[0];

    const stats = { frameCount: 3, maxFrames: 450, fps: 30 };
    worker._simulateMessage({ type: 'STATS_UPDATE', payload: stats });

    expect(onStatsUpdate).toHaveBeenCalledWith(stats);
  });

  it('responds to FRAME_REQUEST with a null bitmap when the video is not ready', async () => {
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo(0));
    const worker = MockWorker.instances[0];

    worker._simulateMessage({ type: 'FRAME_REQUEST', payload: { timestamp: 42 } });
    await Promise.resolve();

    const response = worker._lastMessage('FRAME_RESPONSE');
    expect(response).toBeDefined();
    expect(response?.message.payload).toEqual({ bitmap: null, timestamp: 42 });
    expect(response?.transfer).toBeUndefined();
  });

  it('responds to FRAME_REQUEST with a transferred bitmap when the video is ready', async () => {
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));

    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo(4));
    const worker = MockWorker.instances[0];

    worker._simulateMessage({ type: 'FRAME_REQUEST', payload: { timestamp: 42 } });
    await vi.waitFor(() => {
      expect(worker._lastMessage('FRAME_RESPONSE')).toBeDefined();
    });

    const response = worker._lastMessage('FRAME_RESPONSE');
    expect(response?.message.payload).toEqual({ bitmap, timestamp: 42 });
    expect(response?.transfer).toEqual([bitmap]);
  });

  it('closes an in-flight bitmap when terminated during capture', async () => {
    // A FRAME_REQUEST whose createImageBitmap resolves only after the
    // manager was terminated: the bitmap can no longer be transferred and
    // must be closed instead of leaking to nondeterministic GC.
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    /** @type {(b: typeof bitmap) => void} */
    let resolveCapture;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
      ),
    );

    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo(4));
    const worker = MockWorker.instances[0];

    worker._simulateMessage({ type: 'FRAME_REQUEST', payload: { timestamp: 42 } });
    manager.terminate();
    resolveCapture(bitmap);
    await vi.waitFor(() => {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    });

    expect(worker._lastMessage('FRAME_RESPONSE')).toBeUndefined();
  });

  it('terminate() terminates the worker and resets state', () => {
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo());
    const worker = MockWorker.instances[0];

    manager.terminate();

    expect(worker.terminated).toBe(true);
    expect(manager.isInitialized).toBe(false);
  });

  it('terminate() resolves a pending frame request with an empty array', async () => {
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo());

    const framesPromise = manager.requestFrames();
    manager.terminate();

    await expect(framesPromise).resolves.toEqual([]);
  });

  it('terminateWithCleanup posts CLEAR and terminates once the buffer is empty (#40)', async () => {
    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo());
    const worker = MockWorker.instances[0];

    const promise = manager.terminateWithCleanup();

    // CLEAR must be sent before termination so the worker can close its bitmaps
    expect(worker._lastMessage('CLEAR')).toBeDefined();
    expect(worker.terminated).toBe(false);

    worker._simulateMessage({
      type: 'STATS_UPDATE',
      payload: { frameCount: 0, maxFrames: 450, fps: 30 },
    });
    await promise;

    expect(worker.terminated).toBe(true);
    expect(manager.isInitialized).toBe(false);
  });

  it('terminateWithCleanup falls back to terminating after a timeout if the worker never responds', async () => {
    vi.useFakeTimers();

    const manager = new CaptureWorkerManager();
    manager.init(createFakeVideo());
    const worker = MockWorker.instances[0];

    const promise = manager.terminateWithCleanup();
    expect(worker.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(worker.terminated).toBe(true);
    expect(worker.listeners.get('message')).toHaveLength(0);
  });

  it('terminateWithCleanup on an uninitialized manager resolves without a worker', async () => {
    const manager = new CaptureWorkerManager();

    await expect(manager.terminateWithCleanup()).resolves.toBeUndefined();
    expect(MockWorker.instances).toHaveLength(0);
  });
});
