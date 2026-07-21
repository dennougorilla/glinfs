import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  createSceneDetectionManager: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../src/features/scene-detection/manager.js', () => ({
  createSceneDetectionManager: dependencies.createSceneDetectionManager,
}));

vi.mock('../../../src/shared/router.js', () => ({
  navigate: dependencies.navigate,
}));

import { initLoading } from '../../../src/features/loading/index.js';
import { getClipPayload, resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';
import { offAll, on } from '../../../src/shared/bus.js';

function createPayload(sceneDetectionEnabled = true) {
  return {
    frames: [{ id: 'frame-0', timestamp: 0, width: 16, height: 9 }],
    fps: 30,
    capturedAt: 1,
    sceneDetectionEnabled,
  };
}

function createManager() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    detect: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('loading feature production lifecycle', () => {
  let manager;

  beforeEach(() => {
    resetAppStore();
    offAll('loading:detection-complete');
    offAll('loading:detection-error');
    document.body.innerHTML = '<main id="main-content"></main>';
    dependencies.navigate.mockReset();
    dependencies.createSceneDetectionManager.mockReset();
    manager = createManager();
    dependencies.createSceneDetectionManager.mockReturnValue(manager);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAppStore();
    offAll('loading:detection-complete');
    offAll('loading:detection-error');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('redirects directly when scene detection is disabled', () => {
    setClipPayload(createPayload(false));

    const cleanup = initLoading();

    expect(dependencies.navigate).toHaveBeenCalledWith('/editor');
    expect(dependencies.createSceneDetectionManager).not.toHaveBeenCalled();
    expect(document.querySelector('.loading-screen')).toBeNull();
    expect(cleanup).toBeTypeOf('function');
  });

  it('renders progress, stores detected scenes, emits completion, and navigates', async () => {
    const payload = createPayload();
    const scenes = [{ id: 'scene-1', startFrame: 0, endFrame: 0 }];
    const onComplete = vi.fn();
    const unsubscribe = on('loading:detection-complete', onComplete);
    setClipPayload(payload);
    manager.detect.mockImplementation(async (_frames, options) => {
      options.onProgress({ percent: 42 });
      return {
        scenes,
        totalFrames: 1,
        processingTimeMs: 7,
        algorithmId: 'histogram',
      };
    });

    const cleanup = initLoading();

    expect(document.querySelector('.loading-title')?.textContent).toBe('Detecting Scenes...');
    await vi.waitFor(() => expect(dependencies.navigate).toHaveBeenCalledWith('/editor'));
    expect(manager.init).toHaveBeenCalledOnce();
    expect(manager.detect).toHaveBeenCalledWith(
      payload.frames,
      expect.objectContaining({
        threshold: 0.3,
        minSceneDuration: 5,
        sampleInterval: 1,
        onProgress: expect.any(Function),
      }),
    );
    expect(document.querySelector('[data-progress="fill"]')?.style.width).toBe('42%');
    expect(document.querySelector('[data-progress="text"]')?.textContent).toBe('42%');
    expect(getClipPayload()).toEqual({ ...payload, scenes });
    expect(onComplete).toHaveBeenCalledWith({ sceneCount: 1, processingTimeMs: 7 });
    expect(manager.dispose).toHaveBeenCalledOnce();

    cleanup();
    unsubscribe();
  });

  it('emits an error and continues to the editor when detection fails', async () => {
    const payload = createPayload();
    const onError = vi.fn();
    const unsubscribe = on('loading:detection-error', onError);
    setClipPayload(payload);
    manager.detect.mockRejectedValue(new Error('Histogram failed'));

    initLoading();

    await vi.waitFor(() => expect(dependencies.navigate).toHaveBeenCalledWith('/editor'));
    expect(onError).toHaveBeenCalledWith({ error: 'Histogram failed' });
    expect(getClipPayload()).toBe(payload);
    expect(manager.dispose).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('does not report cancellation as a detection failure', async () => {
    const onError = vi.fn();
    const unsubscribe = on('loading:detection-error', onError);
    setClipPayload(createPayload());
    manager.detect.mockRejectedValue(new DOMException('Detection cancelled', 'AbortError'));

    initLoading();

    await vi.waitFor(() => expect(manager.dispose).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    expect(dependencies.navigate).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('ignores a stale result after the loading route is cleaned up', async () => {
    const payload = createPayload();
    const onComplete = vi.fn();
    const unsubscribe = on('loading:detection-complete', onComplete);
    setClipPayload(payload);

    let resolveDetection;
    manager.detect.mockReturnValue(
      new Promise((resolve) => {
        resolveDetection = resolve;
      }),
    );

    const cleanup = initLoading();
    await vi.waitFor(() => expect(manager.detect).toHaveBeenCalledOnce());
    const detectionOptions = manager.detect.mock.calls[0][1];

    cleanup();
    detectionOptions.onProgress({ percent: 80 });
    resolveDetection({
      scenes: [{ id: 'stale-scene', startFrame: 0, endFrame: 0 }],
      totalFrames: 1,
      processingTimeMs: 99,
      algorithmId: 'histogram',
    });
    await vi.waitFor(() => expect(manager.dispose).toHaveBeenCalled());
    await Promise.resolve();

    expect(dependencies.navigate).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(getClipPayload()).toBe(payload);
    expect(document.querySelector('[data-progress="text"]')?.textContent).toBe('0%');
    unsubscribe();
  });

  it('does not let cleanup from an old mount dispose the current manager', async () => {
    const firstDetection = {};
    firstDetection.promise = new Promise((resolve) => {
      firstDetection.resolve = resolve;
    });
    const secondDetection = {};
    secondDetection.promise = new Promise((resolve) => {
      secondDetection.resolve = resolve;
    });
    const firstManager = createManager();
    firstManager.detect.mockReturnValue(firstDetection.promise);
    const secondManager = createManager();
    secondManager.detect.mockReturnValue(secondDetection.promise);
    dependencies.createSceneDetectionManager
      .mockReset()
      .mockReturnValueOnce(firstManager)
      .mockReturnValueOnce(secondManager);

    setClipPayload(createPayload());
    const cleanupFirst = initLoading();
    await vi.waitFor(() => expect(firstManager.detect).toHaveBeenCalledOnce());

    setClipPayload(createPayload());
    const cleanupSecond = initLoading();
    await vi.waitFor(() => expect(secondManager.detect).toHaveBeenCalledOnce());

    cleanupFirst();

    expect(firstManager.dispose).toHaveBeenCalled();
    expect(secondManager.dispose).not.toHaveBeenCalled();

    cleanupSecond();
    firstDetection.resolve({ scenes: [], processingTimeMs: 0 });
    secondDetection.resolve({ scenes: [], processingTimeMs: 0 });
    await Promise.resolve();
  });
});
