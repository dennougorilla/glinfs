import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSceneDetectionManager,
  SceneDetectionManager,
} from '../../../src/features/scene-detection/manager.js';

class MockWorker {
  /** @type {MockWorker[]} */
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.terminated = false;
    /** @type {Array<{message: any, transfer?: Transferable[]}>} */
    this.messages = [];
    /** @type {Map<string, Array<{handler: Function, once: boolean}>>} */
    this.listeners = new Map();
    MockWorker.instances.push(this);
  }

  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)?.push({ handler, once: options.once === true });
  }

  removeEventListener(type, handler) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((listener) => listener.handler !== handler),
    );
  }

  postMessage(message, transfer) {
    this.messages.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  emitMessage(data) {
    this.#emit('message', { data });
  }

  emitError(message) {
    this.#emit('error', { message });
  }

  lastMessage(type) {
    return this.messages.filter(({ message }) => message.type === type).at(-1);
  }

  #emit(type, event) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener.handler(event);
      if (listener.once) this.removeEventListener(type, listener.handler);
    }
  }
}

function createContext() {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x, _y, width, height) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
  };
}

class MockOffscreenCanvas {
  /** @type {ReturnType<typeof createContext> | null} */
  static context = null;

  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return MockOffscreenCanvas.context;
  }
}

function createFrame(index, width = 160, height = 90) {
  return {
    id: `frame-${index}`,
    timestamp: index * 33_333,
    width,
    height,
    frame: { closed: false },
  };
}

async function initialize(manager, config) {
  const initPromise = manager.init(config);
  const worker = MockWorker.instances.at(-1);
  worker.emitMessage({ type: 'READY', payload: {} });
  await initPromise;
  return worker;
}

describe('SceneDetectionManager production lifecycle', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    MockOffscreenCanvas.context = createContext();
    vi.stubGlobal('Worker', MockWorker);
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('initializes the real manager and sends the selected algorithm to its worker', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager, { algorithmId: 'histogram' });

    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.lastMessage('INIT')?.message).toEqual({
      type: 'INIT',
      payload: { algorithmId: 'histogram' },
    });

    // Repeated initialization is a no-op for an active manager.
    await manager.init({ algorithmId: 'other' });
    expect(MockWorker.instances).toHaveLength(1);
    manager.dispose();
  });

  it('shares one worker initialization across concurrent init calls', async () => {
    const manager = new SceneDetectionManager();
    const firstInit = manager.init({ algorithmId: 'histogram' });
    const secondInit = manager.init({ algorithmId: 'ignored-while-pending' });

    expect(MockWorker.instances).toHaveLength(1);
    MockWorker.instances[0].emitMessage({ type: 'READY', payload: {} });

    await expect(Promise.all([firstInit, secondInit])).resolves.toEqual([undefined, undefined]);
    expect(
      MockWorker.instances[0].messages.filter(({ message }) => message.type === 'INIT'),
    ).toHaveLength(1);
    manager.dispose();
  });

  it('rejects pending initialization immediately when disposed', async () => {
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    const worker = MockWorker.instances[0];

    manager.dispose();

    await expect(initPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });

  it('extracts sampled thumbnails, forwards progress, and resolves the worker result', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);
    const frames = [createFrame(0), createFrame(1), createFrame(2, 90, 160)];
    const onProgress = vi.fn();

    const detection = manager.detect(frames, {
      threshold: 0.45,
      minSceneDuration: 3,
      sampleInterval: 2,
      onProgress,
    });

    await vi.waitFor(() => expect(worker.lastMessage('DETECT')).toBeDefined());
    const detectCommand = worker.lastMessage('DETECT');
    expect(detectCommand?.message.payload.frameData.map(({ index }) => index)).toEqual([0, 2]);
    expect(detectCommand?.message.payload.options).toEqual({
      threshold: 0.45,
      minSceneDuration: 3,
      sampleInterval: 1,
    });
    expect(detectCommand?.transfer).toHaveLength(2);
    expect(MockOffscreenCanvas.context?.drawImage).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith({
      percent: 0,
      currentFrame: 0,
      totalFrames: 3,
      stage: 'extracting',
    });

    const workerProgress = {
      percent: 75,
      currentFrame: 2,
      totalFrames: 3,
      stage: 'detecting',
    };
    worker.emitMessage({ type: 'PROGRESS', payload: workerProgress });
    expect(onProgress).toHaveBeenLastCalledWith(workerProgress);

    const result = {
      scenes: [{ id: 'scene-1', startFrame: 0, endFrame: 2 }],
      totalFrames: 3,
      processingTimeMs: 12,
      algorithmId: 'histogram',
    };
    expect(manager.isDetecting()).toBe(true);
    worker.emitMessage({ type: 'COMPLETE', payload: result });

    await expect(detection).resolves.toBe(result);
    expect(manager.isDetecting()).toBe(false);
    manager.dispose();
  });

  it('rejects detection with the worker-reported error', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);
    const detection = manager.detect([createFrame(0)]);

    await vi.waitFor(() => expect(worker.lastMessage('DETECT')).toBeDefined());
    worker.emitMessage({ type: 'ERROR', payload: { message: 'Detection failed' } });

    await expect(detection).rejects.toThrow('Detection failed');
    expect(manager.isDetecting()).toBe(false);
    manager.dispose();
  });

  it('rejects pending detection when the initialized worker crashes', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);
    const detection = manager.detect([createFrame(0)]);

    await vi.waitFor(() => expect(worker.lastMessage('DETECT')).toBeDefined());
    worker.emitError('Worker crashed');

    await expect(detection).rejects.toThrow('Worker crashed');
    expect(manager.isDetecting()).toBe(false);
    manager.dispose();
  });

  it('rejects when the worker crashes while frame extraction is yielding', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);
    const detection = manager.detect(Array.from({ length: 6 }, (_, index) => createFrame(index)));
    const rejection = expect(detection).rejects.toThrow('Worker crashed during extraction');

    // The first frame yields before DETECT is posted, leaving a window where
    // no per-detection reject callback exists yet.
    expect(worker.lastMessage('DETECT')).toBeUndefined();
    worker.emitError('Worker crashed during extraction');

    await rejection;
    expect(worker.lastMessage('DETECT')).toBeUndefined();
    manager.dispose();
  });

  it('cancels a pending detection with AbortError', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);
    const detection = manager.detect([createFrame(0)]);

    await vi.waitFor(() => expect(worker.lastMessage('DETECT')).toBeDefined());
    manager.cancel();

    await expect(detection).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.lastMessage('CANCEL')?.message).toEqual({ type: 'CANCEL' });
    expect(worker.terminated).toBe(true);
    expect(manager.isDetecting()).toBe(false);

    // Cancellation is terminal for the active worker so an old async DETECT
    // handler cannot race a new run. A fresh init is required before reuse.
    await expect(manager.detect([createFrame(1)])).rejects.toThrow('Manager not initialized');
    const replacementWorker = await initialize(manager);
    expect(replacementWorker).not.toBe(worker);
    expect(MockWorker.instances).toHaveLength(2);
    manager.dispose();
  });

  it('cancels while thumbnail extraction is yielding without posting DETECT', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);
    const detection = manager.detect(Array.from({ length: 6 }, (_, index) => createFrame(index)));
    const rejection = expect(detection).rejects.toMatchObject({ name: 'AbortError' });

    manager.cancel();

    await rejection;
    expect(worker.lastMessage('DETECT')).toBeUndefined();
    expect(worker.lastMessage('CANCEL')).toBeDefined();
    manager.dispose();
  });

  it('rejects a concurrent detect call while the first call is still extracting', async () => {
    const manager = new SceneDetectionManager();
    await initialize(manager);
    const firstDetection = manager.detect(
      Array.from({ length: 6 }, (_, index) => createFrame(index)),
    );
    const firstRejection = expect(firstDetection).rejects.toMatchObject({ name: 'AbortError' });

    expect(manager.isDetecting()).toBe(true);
    await expect(manager.detect([createFrame(10)])).rejects.toThrow(
      'Scene detection is already in progress',
    );

    manager.cancel();
    await firstRejection;
    manager.dispose();
  });

  it('rejects invalid sampling intervals before starting detection', async () => {
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);

    await expect(manager.detect([createFrame(0)], { sampleInterval: 0 })).rejects.toThrow(
      'sampleInterval must be a positive integer',
    );
    expect(manager.isDetecting()).toBe(false);
    expect(worker.lastMessage('DETECT')).toBeUndefined();
    manager.dispose();
  });

  it('fails before posting DETECT when a canvas context is unavailable', async () => {
    MockOffscreenCanvas.context = null;
    const manager = new SceneDetectionManager();
    const worker = await initialize(manager);

    await expect(manager.detect([createFrame(0)])).rejects.toThrow('Failed to get canvas context');
    expect(worker.lastMessage('DETECT')).toBeUndefined();
    manager.dispose();
  });

  it('rejects calls made before initialization', async () => {
    const manager = createSceneDetectionManager();
    expect(manager).toBeInstanceOf(SceneDetectionManager);
    await expect(manager.detect([createFrame(0)])).rejects.toThrow('Manager not initialized');
  });

  it('rejects an initialization error reported by the worker', async () => {
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    const worker = MockWorker.instances[0];
    worker.emitMessage({ type: 'ERROR', payload: { message: 'Unknown detector' } });

    await expect(initPromise).rejects.toThrow('Unknown detector');
    manager.dispose();
  });

  it('times out initialization and terminates the worker', async () => {
    vi.useFakeTimers();
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    const worker = MockWorker.instances[0];
    const rejection = expect(initPromise).rejects.toThrow('Worker initialization timed out');

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(worker.terminated).toBe(true);
  });
});
