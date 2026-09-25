import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeManager = {
  analyzeFrames: vi.fn(),
  getCapabilities: vi.fn(async () => ({ webgpu: false })),
  dispose: vi.fn(),
  readyInfo: { backend: 'wasm' },
};

vi.mock('../../../src/features/ai-cutout/segmentation-manager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSegmentationManager: () => fakeManager,
  setDevModelOverride: vi.fn(),
}));

const { getSharedMaskStore } = await import('../../../src/features/ai-cutout/mask-store.js');
const { setDevModelOverride } = await import(
  '../../../src/features/ai-cutout/segmentation-manager.js'
);
const { installAiCutoutTestHooks } = await import('../../../src/features/ai-cutout/test-hooks.js');
const { resetAppStore, setClipPayload } = await import('../../../src/shared/app-store.js');

/** @type {any} */
let hooks;

function frame(id, sharedKey) {
  return { id, sharedKey, frame: { closed: false }, timestamp: 0, width: 4, height: 2 };
}

beforeEach(() => {
  hooks = {};
  installAiCutoutTestHooks(hooks);
  getSharedMaskStore().clear();
  fakeManager.analyzeFrames.mockReset();
});

afterEach(() => {
  resetAppStore();
});

describe('installAiCutoutTestHooks', () => {
  it('sets the DEV model override and resets the manager', () => {
    hooks.aiCutout.setModelOverride({ sha256: 'x', bytes: 1, allowWasm: true });
    expect(setDevModelOverride).toHaveBeenCalledWith({ sha256: 'x', bytes: 1, allowWasm: true });
    expect(fakeManager.dispose).toHaveBeenCalled();
  });

  it('forwards capabilities', async () => {
    await expect(hooks.aiCutout.getCapabilities()).resolves.toEqual({ webgpu: false });
  });

  it('analyzes the active clip and reports timings and phases', async () => {
    const frames = [frame('a'), frame('b')];
    setClipPayload({ frames, fps: 30, capturedAt: 0, id: 'clip-x' });
    fakeManager.analyzeFrames.mockImplementation(async (_frames, options) => {
      options.onProgress({ phase: 'downloading', loadedBytes: 5, frameMs: null, framesDone: 0 });
      options.onProgress({ phase: 'analyzing', loadedBytes: 9, frameMs: null, framesDone: 0 });
      options.onProgress({ phase: 'analyzing', loadedBytes: 9, frameMs: 12, framesDone: 1 });
      return { analyzed: 1, skipped: 0, backend: 'wasm' };
    });

    const result = await hooks.aiCutout.analyzeClip({ allowWasm: true, frameIndices: [1] });

    const [passedFrames, options] = fakeManager.analyzeFrames.mock.calls[0];
    expect(passedFrames).toEqual([frames[1]]);
    expect(options).toMatchObject({ allowWasm: true, clipId: 'clip-x' });
    expect(result).toMatchObject({
      analyzed: 1,
      backend: 'wasm',
      frameMs: [12],
      phases: ['downloading', 'analyzing'],
      maxLoadedBytes: 9,
      readyInfo: { backend: 'wasm' },
    });
    expect(result.firstFrameAtMs).toEqual(expect.any(Number));
  });

  it('aborts after the requested number of frames and returns the error', async () => {
    setClipPayload({ frames: [frame('a')], fps: 30, capturedAt: 0, id: 'clip-y' });
    fakeManager.analyzeFrames.mockImplementation(async (_frames, options) => {
      options.onProgress({ phase: 'analyzing', loadedBytes: 0, frameMs: 1, framesDone: 1 });
      expect(options.signal.aborted).toBe(true);
      throw new DOMException('Analysis cancelled', 'AbortError');
    });
    const result = await hooks.aiCutout.analyzeClip({ abortAfterFrames: 1 });
    expect(result.error).toEqual({ name: 'AbortError', code: null, message: 'Analysis cancelled' });
  });

  it('needs an active clip', async () => {
    await expect(hooks.aiCutout.analyzeClip()).rejects.toThrow('No active clip');
  });

  it('samples a frame’s mask at normalized source coordinates', () => {
    setClipPayload({
      frames: [frame('a'), frame('b', 'a')],
      fps: 30,
      capturedAt: 0,
      id: 'clip-z',
    });
    // 4×2 mask: row 0 = 0..3, row 1 = 10..13
    getSharedMaskStore().set(
      'a',
      { data: new Uint8Array([0, 1, 2, 3, 10, 11, 12, 13]), width: 4, height: 2 },
      'clip-z',
    );
    const points = [
      { x: 0, y: 0 },
      { x: 0.99, y: 0.99 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 },
    ];
    expect(hooks.aiCutout.sampleMask(1, points)).toEqual({
      width: 4,
      height: 2,
      values: [0, 13, 13, 12],
    });
    expect(hooks.aiCutout.sampleMask(5, points)).toBeNull();
    expect(hooks.aiCutout.getMaskStoreStats()).toMatchObject({ size: 1, byteLength: 8 });
    hooks.aiCutout.clearMasks();
    expect(hooks.aiCutout.getMaskStoreStats().size).toBe(0);
  });

  it('returns null for a PNG of a missing mask', async () => {
    await expect(hooks.aiCutout.maskToPngDataUrl(0)).resolves.toBeNull();
  });
});
