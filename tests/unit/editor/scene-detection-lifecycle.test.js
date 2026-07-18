import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sceneDetection = vi.hoisted(() => ({
  createManager: vi.fn(),
}));

vi.mock('../../../src/features/scene-detection/index.js', () => ({
  createSceneDetectionManager: sceneDetection.createManager,
}));

import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

function createFrames(prefix) {
  return Array.from({ length: 2 }, (_, index) => ({
    id: `${prefix}-${index}`,
    data: {
      data: new Uint8ClampedArray(10 * 10 * 4),
      width: 10,
      height: 10,
    },
    timestamp: index * 33_333,
    width: 10,
    height: 10,
  }));
}

function setDetectedClip(prefix) {
  setClipPayload({
    frames: createFrames(prefix),
    fps: 30,
    capturedAt: Date.now(),
    sceneDetectionEnabled: true,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Editor scene detection lifecycle', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    sceneDetection.createManager.mockReset();
    document.body.innerHTML = '<main id="main-content"></main>';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not let an old mount use or dispose the new mount manager', async () => {
    const firstInit = deferred();
    const secondDetection = deferred();
    const firstManager = {
      init: vi.fn(() => firstInit.promise),
      detect: vi.fn(),
      dispose: vi.fn(),
    };
    const secondManager = {
      init: vi.fn().mockResolvedValue(undefined),
      detect: vi.fn(() => secondDetection.promise),
      dispose: vi.fn(),
    };
    sceneDetection.createManager
      .mockReturnValueOnce(firstManager)
      .mockReturnValueOnce(secondManager);

    setDetectedClip('old');
    const cleanupFirst = initEditor();
    expect(firstManager.init).toHaveBeenCalledOnce();

    cleanupFirst();
    setDetectedClip('new');
    cleanup = initEditor();
    await flushMicrotasks();
    expect(secondManager.detect).toHaveBeenCalledOnce();

    // The old init settles only after a new Editor and manager are active.
    firstInit.resolve();
    await flushMicrotasks();

    expect(firstManager.detect).not.toHaveBeenCalled();
    expect(secondManager.detect).toHaveBeenCalledOnce();
    expect(secondManager.dispose).not.toHaveBeenCalled();

    const scenes = [{ id: 'new-scene', startFrame: 0, endFrame: 1 }];
    secondDetection.resolve({ scenes, processingTimeMs: 4 });
    await flushMicrotasks();

    expect(getEditorState()?.scenes).toEqual(scenes);
    expect(getEditorState()?.sceneDetectionStatus).toBe('completed');
    expect(secondManager.dispose).toHaveBeenCalledOnce();
  });
});
