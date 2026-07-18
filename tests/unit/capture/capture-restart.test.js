import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for #40: re-selecting a screen after "Stop sharing" must
 * terminate the previous CaptureWorkerManager (and thereby release its frame
 * buffer) before creating a new one. Before the fix, handleStart simply
 * overwrote `workerManager`, orphaning a dedicated worker holding up to
 * maxFrames ImageBitmaps.
 */

const managerInstances = vi.hoisted(() => /** @type {any[]} */ ([]));
const uiCapture = vi.hoisted(() => /** @type {{ handlers: any }} */ ({ handlers: null }));

vi.mock('../../../src/workers/capture-worker-manager.js', () => {
  class FakeCaptureWorkerManager {
    constructor() {
      this.init = vi.fn();
      this.start = vi.fn();
      this.stop = vi.fn();
      this.clear = vi.fn();
      this.terminate = vi.fn();
      this.requestFrames = vi.fn().mockResolvedValue([]);
      /** Number of managers that existed when terminateWithCleanup was called */
      this.instanceCountAtCleanup = -1;
      this.terminateWithCleanup = vi.fn(() => {
        this.instanceCountAtCleanup = managerInstances.length;
        return Promise.resolve();
      });
      managerInstances.push(this);
    }
  }
  return { CaptureWorkerManager: FakeCaptureWorkerManager };
});

vi.mock('../../../src/features/capture/api.js', () => ({
  startScreenCapture: vi.fn(),
  createVideoElement: vi.fn(),
  stopScreenCapture: vi.fn(),
}));

vi.mock('../../../src/features/capture/ui.js', () => ({
  renderCaptureScreen: vi.fn((_container, _state, handlers) => {
    uiCapture.handlers = handlers;
    return () => {};
  }),
  updateBufferStatus: vi.fn(),
  updateSceneDetectionToggle: vi.fn(),
}));

import { createVideoElement, startScreenCapture } from '../../../src/features/capture/api.js';

/**
 * Create a fake live MediaStreamTrack
 */
function createFakeTrack() {
  return {
    readyState: 'live',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
}

/**
 * Create a fake MediaStream wrapping a track
 * @param {ReturnType<typeof createFakeTrack>} track
 */
function createFakeStream(track) {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
}

describe('capture handleStart worker lifecycle (#40)', () => {
  beforeEach(() => {
    vi.resetModules();
    managerInstances.length = 0;
    uiCapture.handlers = null;
    document.body.innerHTML = '<div id="main-content"></div>';

    vi.mocked(startScreenCapture).mockImplementation(
      async () => /** @type {any} */ (createFakeStream(createFakeTrack())),
    );
    vi.mocked(createVideoElement).mockImplementation(
      async () => /** @type {any} */ ({ pause: vi.fn(), srcObject: null }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /**
   * Initialize the capture feature and return the UI handlers it registered
   */
  async function initCaptureFeature() {
    const { initCapture } = await import('../../../src/features/capture/index.js');
    const cleanup = initCapture();
    expect(uiCapture.handlers).not.toBeNull();
    return { handlers: uiCapture.handlers, cleanup };
  }

  it('creates a worker manager on first start without terminating anything', async () => {
    const { handlers } = await initCaptureFeature();

    await handlers.onStart();

    expect(managerInstances).toHaveLength(1);
    expect(managerInstances[0].init).toHaveBeenCalledTimes(1);
    expect(managerInstances[0].start).toHaveBeenCalledTimes(1);
    expect(managerInstances[0].terminateWithCleanup).not.toHaveBeenCalled();
  });

  it('terminates the previous worker manager before creating a new one on re-select (#40)', async () => {
    const { handlers } = await initCaptureFeature();

    // First share
    await handlers.onStart();
    expect(managerInstances).toHaveLength(1);
    const firstManager = managerInstances[0];

    // Browser-side "Stop sharing": buffer is preserved, manager stays alive
    handlers.onStop();
    expect(firstManager.terminateWithCleanup).not.toHaveBeenCalled();
    expect(firstManager.stop).toHaveBeenCalled();

    // Select Screen again
    await handlers.onStart();

    expect(firstManager.terminateWithCleanup).toHaveBeenCalledTimes(1);
    expect(managerInstances).toHaveLength(2);
    // The old manager must be cleaned up BEFORE the new one is created
    expect(firstManager.instanceCountAtCleanup).toBe(1);
    // The new manager is the one that got started
    expect(managerInstances[1].start).toHaveBeenCalledTimes(1);
  });

  it('cleans up each orphaned manager across repeated stop/re-select cycles', async () => {
    const { handlers } = await initCaptureFeature();

    for (let cycle = 0; cycle < 3; cycle++) {
      await handlers.onStart();
      handlers.onStop();
    }

    expect(managerInstances).toHaveLength(3);
    expect(managerInstances[0].terminateWithCleanup).toHaveBeenCalledTimes(1);
    expect(managerInstances[1].terminateWithCleanup).toHaveBeenCalledTimes(1);
    // The latest manager is still alive (only stopped, buffer preserved)
    expect(managerInstances[2].terminateWithCleanup).not.toHaveBeenCalled();
  });

  it('uses cleanup-aware termination for a stopped worker with a retained buffer', async () => {
    const { handlers, cleanup } = await initCaptureFeature();
    await handlers.onStart();
    const manager = managerInstances[0];
    handlers.onStop();

    cleanup();

    expect(manager.terminateWithCleanup).toHaveBeenCalledTimes(1);
    expect(manager.terminate).not.toHaveBeenCalled();
  });

  it('closes transferred bitmaps when route cleanup wins the Create Clip race', async () => {
    const { handlers, cleanup } = await initCaptureFeature();
    await handlers.onStart();
    const manager = managerInstances[0];
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    /** @type {(frames: any[]) => void} */
    let resolveFrames;
    manager.requestFrames.mockReturnValue(
      new Promise((resolve) => {
        resolveFrames = resolve;
      }),
    );

    const createPromise = handlers.onCreateClip();
    cleanup();
    resolveFrames([{ id: 'late', bitmap, timestamp: 1 }]);

    await expect(createPromise).resolves.toBe(false);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a Create Clip response from an earlier mount after preserving and restoring', async () => {
    const { handlers, cleanup } = await initCaptureFeature();
    await handlers.onStart();
    const manager = managerInstances[0];
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    /** @type {(frames: any[]) => void} */
    let resolveFrames;
    manager.requestFrames.mockReturnValue(
      new Promise((resolve) => {
        resolveFrames = resolve;
      }),
    );
    vi.stubGlobal(
      'VideoFrame',
      class {
        constructor() {
          this.closed = false;
          this.codedWidth = 640;
          this.codedHeight = 480;
        }

        close() {}
      },
    );

    const staleCreatePromise = handlers.onCreateClip();
    cleanup();

    // The active stream restores the exact same store and manager objects.
    // Only the mount generation distinguishes this response from the new UI.
    await initCaptureFeature();
    resolveFrames([{ id: 'stale', bitmap, timestamp: 1 }]);

    await expect(staleCreatePromise).resolves.toBe(false);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
