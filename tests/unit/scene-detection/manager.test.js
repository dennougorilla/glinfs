import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneDetectionManager } from '../../../src/features/scene-detection/manager.js';

/**
 * Mock Worker class for testing (mirrors tests/unit/workers/worker-manager.test.js)
 */
class MockWorker {
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
  }

  terminate() {
    this.terminated = true;
  }

  _simulateMessage(data) {
    const handlers = [...(this.listeners.get('message') || [])];
    handlers.forEach(({ handler, options }) => {
      handler({ data });
      if (options?.once) {
        this.removeEventListener('message', handler);
      }
    });
  }

  _simulateError(message) {
    const handlers = [...(this.listeners.get('error') || [])];
    handlers.forEach(({ handler, options }) => {
      handler({ message });
      if (options?.once) {
        this.removeEventListener('error', handler);
      }
    });
  }
}

const OriginalWorker = globalThis.Worker;
const OriginalOffscreenCanvas = globalThis.OffscreenCanvas;

/** @type {MockWorker} */
let mockWorker;

beforeEach(() => {
  mockWorker = new MockWorker();
  globalThis.Worker = function WorkerMock() {
    return mockWorker;
  };
  // jsdom has no OffscreenCanvas; detect() initializes one before extraction
  globalThis.OffscreenCanvas = function OffscreenCanvasMock() {
    return {
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      }),
    };
  };
});

afterEach(() => {
  globalThis.Worker = OriginalWorker;
  globalThis.OffscreenCanvas = OriginalOffscreenCanvas;
  vi.useRealTimers();
});

/** Initialize a manager against the mock worker (responds READY) */
async function createInitializedManager() {
  const manager = new SceneDetectionManager();
  const initPromise = manager.init();
  mockWorker._simulateMessage({ type: 'READY' });
  await initPromise;
  return manager;
}

describe('SceneDetectionManager init', () => {
  it('resolves when the worker reports READY', async () => {
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    mockWorker._simulateMessage({ type: 'READY' });

    await expect(initPromise).resolves.toBeUndefined();
  });

  it('rejects and terminates the worker when init reports ERROR', async () => {
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    mockWorker._simulateMessage({ type: 'ERROR', payload: { message: 'init boom' } });

    await expect(initPromise).rejects.toThrow('init boom');
    // A rejected init must not leave a live worker behind
    expect(mockWorker.terminated).toBe(true);
  });

  it('rejects and terminates the worker on a worker error event during init', async () => {
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    mockWorker._simulateError('creation boom');

    await expect(initPromise).rejects.toThrow('creation boom');
    expect(mockWorker.terminated).toBe(true);
  });

  it('rejects after the init timeout when the worker never responds', async () => {
    vi.useFakeTimers();
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();
    const assertion = expect(initPromise).rejects.toThrow('Worker initialization timed out');

    vi.advanceTimersByTime(5001);

    await assertion;
    expect(mockWorker.terminated).toBe(true);
  });

  it('rejects a pending init immediately when disposed (no timeout wait)', async () => {
    const manager = new SceneDetectionManager();
    const initPromise = manager.init();

    manager.dispose();

    await expect(initPromise).rejects.toThrow('Manager disposed during init');
    expect(mockWorker.terminated).toBe(true);
  });
});

describe('SceneDetectionManager detect', () => {
  it('throws when not initialized', async () => {
    const manager = new SceneDetectionManager();

    await expect(manager.detect([])).rejects.toThrow('Manager not initialized');
  });

  it('resolves with the worker COMPLETE payload', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = { scenes: [{ startFrame: 0, endFrame: 5 }], processingTimeMs: 12 };
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: result });

    await expect(detectPromise).resolves.toEqual(result);
  });

  it('rejects when the worker reports ERROR', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockWorker._simulateMessage({ type: 'ERROR', payload: { message: 'detect boom' } });

    await expect(detectPromise).rejects.toThrow('detect boom');
  });

  it('rejects an in-flight detect when the worker crashes after init', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Previously this left detect() pending forever (loading screen hang)
    mockWorker._simulateError('worker crashed');

    await expect(detectPromise).rejects.toThrow('worker crashed');
  });

  it('rejects a second detect while one is in flight instead of orphaning the first', async () => {
    const manager = await createInitializedManager();
    const first = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(manager.detect([])).rejects.toThrow('Detection already in progress');

    // First detect still settles normally
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: { scenes: [] } });
    await expect(first).resolves.toEqual({ scenes: [] });
  });

  it('allows a new detect after the previous one completed', async () => {
    const manager = await createInitializedManager();
    const first = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: { scenes: [] } });
    await first;

    const second = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: { scenes: [] } });

    await expect(second).resolves.toEqual({ scenes: [] });
  });

  it('cancel() rejects a pending detect with AbortError', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    manager.cancel();

    await expect(detectPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('dispose() rejects a pending detect and terminates the worker', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    manager.dispose();

    await expect(detectPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockWorker.terminated).toBe(true);
  });

  it('reports progress via onProgress', async () => {
    const manager = await createInitializedManager();
    const onProgress = vi.fn();
    const detectPromise = manager.detect([], { onProgress });
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockWorker._simulateMessage({
      type: 'PROGRESS',
      payload: { percent: 50, currentFrame: 5, totalFrames: 10, stage: 'detecting' },
    });
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: { scenes: [] } });
    await detectPromise;

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 50, stage: 'detecting' }),
    );
  });
});

describe('SceneDetectionManager after worker crash', () => {
  it('fails later detect() calls fast instead of posting to the dead worker', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockWorker._simulateError('worker crashed');
    await expect(detectPromise).rejects.toThrow('worker crashed');
    expect(mockWorker.terminated).toBe(true);

    // Previously this passed the init guard and hung forever on a dead worker
    await expect(manager.detect([])).rejects.toThrow('Scene detection worker crashed');
  });

  it('recovers after a successful re-init', async () => {
    const manager = await createInitializedManager();
    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockWorker._simulateError('worker crashed');
    await detectPromise.catch(() => {});

    // Re-init creates a fresh worker (same mock instance in this harness)
    mockWorker.terminated = false;
    const initPromise = manager.init();
    mockWorker._simulateMessage({ type: 'READY' });
    await initPromise;

    const second = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: { scenes: [] } });
    await expect(second).resolves.toEqual({ scenes: [] });
  });
});

describe('SceneDetectionManager sampleInterval validation', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects invalid sampleInterval %p', async (interval) => {
    const manager = await createInitializedManager();

    await expect(manager.detect([], { sampleInterval: interval })).rejects.toThrow(RangeError);
  });

  it('allows a subsequent valid detect() after a rejected sampleInterval', async () => {
    const manager = await createInitializedManager();
    await expect(manager.detect([], { sampleInterval: 0 })).rejects.toThrow(RangeError);

    const detectPromise = manager.detect([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockWorker._simulateMessage({ type: 'COMPLETE', payload: { scenes: [] } });
    await expect(detectPromise).resolves.toEqual({ scenes: [] });
  });
});

describe('SceneDetectionManager dispose', () => {
  it('is idempotent', async () => {
    const manager = await createInitializedManager();

    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
    expect(mockWorker.terminated).toBe(true);
  });
});
