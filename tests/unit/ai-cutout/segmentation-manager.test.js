import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';
import {
  collectPendingFrames,
  createSegmentationManager,
  frameKey,
  getSegmentationManager,
  MAX_FRAMES_IN_FLIGHT,
  setDevModelOverride,
} from '../../../src/features/ai-cutout/segmentation-manager.js';

const SPEC = {
  url: '/glinfs/models/isnetis.onnx',
  bytes: 176_069_933,
  sha256: 'f'.repeat(64),
  inputName: 'img',
  outputName: 'mask',
  inputSize: 1024,
};

/** Wait for queued promise callbacks and microtasks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Scriptable stand-in for the segmentation worker. By default it answers
 * `init` with `ready` (webgpu) and every `segment` with a mask whose bytes
 * are the request id.
 */
class FakeWorker {
  constructor({ autoReady = true, autoMask = true, backend = 'webgpu' } = {}) {
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    /** @type {{ msg: any, transfer?: any[] }[]} */
    this.posted = [];
    this.terminated = false;
    this.autoReady = autoReady;
    this.autoMask = autoMask;
    this.backend = backend;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer });
    if (msg.type === 'init' && this.autoReady) {
      queueMicrotask(() => this.ready());
    }
    if (msg.type === 'segment' && this.autoMask) {
      queueMicrotask(() => this.mask(msg));
    }
  }

  terminate() {
    this.terminated = true;
  }

  emit(data) {
    for (const handler of this.listeners.get('message') ?? []) handler({ data });
  }

  ready(extra = {}) {
    this.emit({
      type: 'ready',
      backend: this.backend,
      adapter: { vendor: 'apple', architecture: 'metal-3', description: '' },
      fromCache: false,
      timings: { loadMs: 1, createMs: 2 },
      ...extra,
    });
  }

  mask(msg) {
    const data = new Uint8Array(msg.maskWidth * msg.maskHeight).fill(msg.requestId);
    this.emit({
      type: 'mask',
      requestId: msg.requestId,
      width: msg.maskWidth,
      height: msg.maskHeight,
      data: data.buffer,
      inferenceMs: 5,
      totalMs: 7,
    });
  }

  crash(message = 'boom') {
    const event = new ErrorEvent('error', { message });
    for (const handler of this.listeners.get('error') ?? []) handler(event);
  }

  get segments() {
    return this.posted.filter((p) => p.msg.type === 'segment').map((p) => p.msg);
  }
}

/** @param {string} id */
function makeFrame(id, { width = 1280, height = 720, sharedKey, closed = false } = {}) {
  return { id, frame: { closed }, timestamp: 0, width, height, sharedKey };
}

function createHarness(workerOptions = {}, managerOptions = {}) {
  /** @type {FakeWorker[]} */
  const workers = [];
  const bitmaps = [];
  const maskStore = createMaskStore();
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker(workerOptions);
    workers.push(worker);
    return /** @type {any} */ (worker);
  });
  const createBitmap = vi.fn(async (_source, width, height) => {
    const bitmap = { width, height, close: vi.fn() };
    bitmaps.push(bitmap);
    return /** @type {any} */ (bitmap);
  });
  const manager = createSegmentationManager({
    maskStore,
    createWorker,
    createBitmap,
    getModelSpec: () => SPEC,
    ...managerOptions,
  });
  return { manager, maskStore, workers, bitmaps, createWorker, createBitmap };
}

afterEach(() => {
  setDevModelOverride(null);
});

describe('frameKey / collectPendingFrames', () => {
  it('keys frames by sharedKey, else id', () => {
    expect(frameKey(makeFrame('a'))).toBe('a');
    expect(frameKey(makeFrame('b', { sharedKey: 'src' }))).toBe('src');
  });

  it('keeps one frame per key and skips keys already stored', () => {
    const store = { has: (key) => key === 'done' };
    const frames = [
      makeFrame('done'),
      makeFrame('a'),
      makeFrame('h1', { sharedKey: 'a' }),
      makeFrame('b'),
      makeFrame('b'),
    ];
    expect(collectPendingFrames(frames, store).map((p) => p.key)).toEqual(['a', 'b']);
  });
});

describe('SegmentationManager.analyzeFrames', () => {
  it('does nothing — no worker, no download — when every mask exists', async () => {
    const { manager, maskStore, createWorker } = createHarness();
    maskStore.set('a', { data: new Uint8Array(1), width: 1, height: 1 });
    const result = await manager.analyzeFrames([makeFrame('a')]);
    expect(result).toEqual({ analyzed: 0, skipped: 1, backend: null });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('analyzes pending frames, dedupes holds and stores masks under the clip', async () => {
    const { manager, maskStore, workers, bitmaps } = createHarness();
    const frames = [
      makeFrame('f0'),
      makeFrame('f1'),
      makeFrame('f2', { sharedKey: 'f1' }),
      makeFrame('f3', { width: 480, height: 640 }),
    ];
    const onProgress = vi.fn();

    const result = await manager.analyzeFrames(frames, { onProgress, clipId: 'clip-1' });

    expect(result).toEqual({ analyzed: 3, skipped: 1, backend: 'webgpu' });
    expect(workers).toHaveLength(1);
    expect(workers[0].posted[0].msg).toEqual({ type: 'init', model: SPEC, allowWasm: false });

    // Bitmaps at mask resolution, transferred, source size sent along
    const segments = workers[0].segments;
    expect(segments.map((s) => [s.maskWidth, s.maskHeight])).toEqual([
      [1024, 576],
      [1024, 576],
      [480, 640],
    ]);
    expect(segments[0]).toMatchObject({ sourceWidth: 1280, sourceHeight: 720 });
    const transfers = workers[0].posted.filter((p) => p.msg.type === 'segment');
    expect(transfers.every((p) => p.transfer?.[0] === p.msg.bitmap)).toBe(true);
    expect(bitmaps.every((b) => b.close.mock.calls.length === 0)).toBe(true);

    expect(maskStore.keysForClip('clip-1').sort()).toEqual(['f0', 'f1', 'f3']);
    expect(maskStore.get('f3')).toMatchObject({ width: 480, height: 640 });
    expect(manager.backend).toBe('webgpu');
    expect(manager.readyInfo).toMatchObject({ backend: 'webgpu', modelBytes: SPEC.bytes });

    const analyzing = onProgress.mock.calls.map(([p]) => p).filter((p) => p.phase === 'analyzing');
    expect(analyzing.map((p) => p.framesDone)).toEqual([0, 1, 2, 3]);
    expect(analyzing.at(-1)).toMatchObject({ framesTotal: 3, frameMs: 7, backend: 'webgpu' });
  });

  it('forwards download status while the model loads', async () => {
    const { manager, workers } = createHarness({ autoReady: false });
    const onProgress = vi.fn();
    const run = manager.analyzeFrames([makeFrame('a')], { onProgress });
    await flush();
    workers[0].emit({
      type: 'status',
      phase: 'downloading',
      loadedBytes: 10,
      totalBytes: 100,
      fromCache: false,
    });
    workers[0].ready();
    await run;
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'downloading',
        loadedBytes: 10,
        totalBytes: 100,
        framesTotal: 1,
      }),
    );
  });

  it('keeps at most MAX_FRAMES_IN_FLIGHT frames in the worker', async () => {
    const { manager, workers } = createHarness({ autoMask: false });
    const frames = Array.from({ length: 5 }, (_, i) => makeFrame(`f${i}`));
    const run = manager.analyzeFrames(frames);
    await flush();
    const worker = workers[0];
    expect(worker.segments).toHaveLength(MAX_FRAMES_IN_FLIGHT);
    for (let i = 0; i < 5; i++) {
      worker.mask(worker.segments[i]);
      await flush();
      expect(worker.segments.length).toBeLessThanOrEqual(Math.min(5, i + 1 + MAX_FRAMES_IN_FLIGHT));
    }
    await expect(run).resolves.toMatchObject({ analyzed: 5 });
  });

  it('reuses the loaded worker for later calls', async () => {
    const { manager, createWorker } = createHarness();
    await manager.analyzeFrames([makeFrame('a')]);
    await manager.analyzeFrames([makeFrame('b')]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('runs calls one after another, so a later call skips earlier results', async () => {
    const { manager, workers } = createHarness();
    const first = manager.analyzeFrames([makeFrame('a'), makeFrame('b')]);
    const second = manager.analyzeFrames([makeFrame('a'), makeFrame('b'), makeFrame('c')]);
    await expect(first).resolves.toMatchObject({ analyzed: 2 });
    await expect(second).resolves.toMatchObject({ analyzed: 1, skipped: 2 });
    expect(workers[0].segments).toHaveLength(3);
  });

  it('asks the worker for WASM only when allowed', async () => {
    const { manager, workers } = createHarness({ backend: 'wasm' });
    const result = await manager.analyzeFrames([makeFrame('a')], { allowWasm: true });
    expect(workers[0].posted[0].msg.allowWasm).toBe(true);
    expect(result.backend).toBe('wasm');
  });

  it('applies the DEV model override (stub hash/size, WASM without asking)', async () => {
    setDevModelOverride({ sha256: 'abc', bytes: 170, allowWasm: true });
    const { manager, workers } = createHarness();
    await manager.analyzeFrames([makeFrame('a')]);
    expect(workers[0].posted[0].msg).toEqual({
      type: 'init',
      model: { ...SPEC, sha256: 'abc', bytes: 170 },
      allowWasm: true,
    });
    expect(manager.readyInfo?.modelBytes).toBe(170);
  });

  it('rejects with the init error code, terminates the worker and retries fresh', async () => {
    const { manager, workers } = createHarness({ autoReady: false });
    const run = manager.analyzeFrames([makeFrame('a')]);
    await flush();
    workers[0].emit({
      type: 'init-error',
      error: { code: SegmentationErrorCode.WEBGPU_UNAVAILABLE, message: 'no adapter' },
    });
    const error = await run.catch((e) => e);
    expect(error.name).toBe('SegmentationError');
    expect(error.code).toBe(SegmentationErrorCode.WEBGPU_UNAVAILABLE);
    expect(workers[0].terminated).toBe(true);

    const retry = manager.analyzeFrames([makeFrame('a')], { allowWasm: true });
    await flush();
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].msg.allowWasm).toBe(true);
    workers[1].ready({ backend: 'wasm' });
    await expect(retry).resolves.toMatchObject({ analyzed: 1, backend: 'wasm' });
  });

  it('fails with INFERENCE_FAILED and cancels the rest of the job', async () => {
    const { manager, workers } = createHarness({ autoMask: false });
    const run = manager.analyzeFrames([makeFrame('a'), makeFrame('b'), makeFrame('c')]);
    await flush();
    const worker = workers[0];
    worker.emit({
      type: 'segment-error',
      requestId: worker.segments[0].requestId,
      error: { code: SegmentationErrorCode.INFERENCE_FAILED, message: 'bad op' },
    });
    const error = await run.catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.INFERENCE_FAILED);
    expect(error.message).toBe('bad op');
    expect(worker.posted.at(-1)?.msg).toEqual({ type: 'cancel', jobId: worker.segments[0].jobId });
  });

  it('recycles the worker after an inference failure, so a retry gets a fresh session', async () => {
    const { manager, workers } = createHarness({ autoMask: false });
    const run = manager.analyzeFrames([makeFrame('a'), makeFrame('b')]);
    await flush();
    const worker = workers[0];
    worker.emit({
      type: 'segment-error',
      requestId: worker.segments[0].requestId,
      error: { code: SegmentationErrorCode.INFERENCE_FAILED, message: 'device lost' },
    });
    const error = await run.catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.INFERENCE_FAILED);
    expect(worker.terminated).toBe(true);
    expect(manager.backend).toBeNull();

    const retry = manager.analyzeFrames([makeFrame('a')]);
    await flush();
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].msg.type).toBe('init');
    workers[1].mask(workers[1].segments[0]);
    await expect(retry).resolves.toMatchObject({ analyzed: 1, backend: 'webgpu' });
  });

  it('keeps the worker when a job fails for a reason other than inference', async () => {
    const { manager, workers } = createHarness();
    await manager.analyzeFrames([makeFrame('a')]);
    const error = await manager.analyzeFrames([makeFrame('b', { closed: true })]).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.FRAME_UNAVAILABLE);
    expect(workers[0].terminated).toBe(false);
    await expect(manager.analyzeFrames([makeFrame('c')])).resolves.toMatchObject({ analyzed: 1 });
    expect(workers).toHaveLength(1);
  });

  it('abort rejects with AbortError, cancels queued frames and keeps finished masks', async () => {
    const { manager, maskStore, workers } = createHarness({ autoMask: false });
    const controller = new AbortController();
    const frames = Array.from({ length: 6 }, (_, i) => makeFrame(`f${i}`));
    const run = manager.analyzeFrames(frames, { signal: controller.signal });
    await flush();
    const worker = workers[0];
    const [running, queued] = worker.segments;

    controller.abort();
    const error = await run.catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(worker.posted.at(-1)?.msg).toEqual({ type: 'cancel', jobId: running.jobId });

    // The running frame still finishes: its mask is kept
    worker.mask(running);
    worker.emit({ type: 'dropped', requestIds: [queued.requestId] });
    await flush();
    expect(maskStore.has('f0')).toBe(true);
    expect(maskStore.has('f1')).toBe(false);
    expect(worker.segments).toHaveLength(2);
    expect(worker.terminated).toBe(false);
  });

  it('drops a mask that finishes after its clip was released for good', async () => {
    const { manager, maskStore, workers } = createHarness({ autoMask: false });
    const controller = new AbortController();
    const frames = [makeFrame('a0'), makeFrame('a1')];
    const run = manager.analyzeFrames(frames, { signal: controller.signal, clipId: 'clip-a' });
    await flush();
    const worker = workers[0];
    const [running] = worker.segments;
    controller.abort();
    await run.catch(() => undefined);

    // The clip's deletion becomes final while its frame is still in the worker
    maskStore.deleteClip('clip-a');
    manager.forgetClip('clip-a');
    worker.mask(running);
    await flush();
    expect(maskStore.has('a0')).toBe(false);
    expect(maskStore.keysForClip('clip-a')).toEqual([]);

    // Other clips still store their masks
    const other = manager.analyzeFrames([makeFrame('b0')], { clipId: 'clip-b' });
    await flush();
    worker.mask(worker.segments.at(-1));
    await other;
    expect(maskStore.keysForClip('clip-b')).toEqual(['b0']);
  });

  it('closes a bitmap that finishes creating after the job was cancelled', async () => {
    /** @type {(value: unknown) => void} */
    let releaseBitmap = () => {};
    const late = { width: 1024, height: 576, close: vi.fn() };
    const { manager, workers } = createHarness(
      { autoMask: false },
      {
        createBitmap: vi
          .fn()
          .mockImplementationOnce(async () => ({ width: 1, height: 1, close: vi.fn() }))
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                releaseBitmap = resolve;
              }),
          ),
      },
    );
    const controller = new AbortController();
    const run = manager.analyzeFrames([makeFrame('a'), makeFrame('b')], {
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    await run.catch(() => undefined);
    releaseBitmap(late);
    await flush();
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(workers[0].segments).toHaveLength(1);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const { manager, createWorker } = createHarness();
    const controller = new AbortController();
    controller.abort();
    const error = await manager
      .analyzeFrames([makeFrame('a')], { signal: controller.signal })
      .catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('aborting during the model download terminates the worker', async () => {
    const { manager, workers } = createHarness({ autoReady: false });
    const controller = new AbortController();
    const run = manager.analyzeFrames([makeFrame('a')], { signal: controller.signal });
    await flush();
    controller.abort();
    expect((await run.catch((e) => e)).name).toBe('AbortError');
    expect(workers[0].terminated).toBe(true);
    expect(manager.backend).toBeNull();
  });

  it('a worker crash fails the analysis and the next call starts a new worker', async () => {
    const { manager, workers } = createHarness({ autoMask: false });
    const run = manager.analyzeFrames([makeFrame('a'), makeFrame('b')]);
    await flush();
    workers[0].crash('out of memory');
    const error = await run.catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.WORKER_CRASHED);
    expect(error.message).toContain('out of memory');
    expect(workers[0].terminated).toBe(true);

    workers.length = 0;
    const next = manager.analyzeFrames([makeFrame('a')]);
    await flush();
    expect(workers).toHaveLength(1);
    workers[0].mask(workers[0].segments[0]);
    await expect(next).resolves.toMatchObject({ analyzed: 1 });
  });

  it('reports a worker that cannot be created', async () => {
    const { manager } = createHarness(
      {},
      {
        createWorker: () => {
          throw new Error('blocked');
        },
      },
    );
    const error = await manager.analyzeFrames([makeFrame('a')]).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.WORKER_CRASHED);
    expect(error.message).toContain('blocked');
  });

  it('refuses frames whose VideoFrame is closed', async () => {
    const { manager } = createHarness();
    const error = await manager.analyzeFrames([makeFrame('a', { closed: true })]).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.FRAME_UNAVAILABLE);
  });

  it('refuses a VideoFrame with a zero coded size (how browsers expose a closed one)', async () => {
    const { manager, createBitmap } = createHarness();
    const frame = { ...makeFrame('a'), frame: { codedWidth: 0, codedHeight: 0 } };
    const error = await manager.analyzeFrames([/** @type {any} */ (frame)]).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.FRAME_UNAVAILABLE);
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it('reports FRAME_UNAVAILABLE when a VideoFrame closed without a closed flag cannot be read', async () => {
    const { manager } = createHarness(
      {},
      {
        createBitmap: async () => {
          throw new DOMException('The VideoFrame has been closed', 'InvalidStateError');
        },
      },
    );
    const error = await manager.analyzeFrames([makeFrame('a')]).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.FRAME_UNAVAILABLE);
    expect(error.message).toContain('The VideoFrame has been closed');
  });

  it('closes the bitmap when posting to the worker throws', async () => {
    const { manager, workers, bitmaps } = createHarness();
    const run = manager.analyzeFrames([makeFrame('a')]);
    await flush();
    // The worker is ready; make the next post fail
    workers[0].postMessage = () => {
      throw new DOMException('could not clone', 'DataCloneError');
    };
    const second = manager.analyzeFrames([makeFrame('b')]);
    await run;
    const error = await second.catch((e) => e);
    expect(error.name).toBe('DataCloneError');
    expect(bitmaps.at(-1)?.close).toHaveBeenCalledTimes(1);
  });

  it('dispose() terminates the worker and rejects pending work with AbortError', async () => {
    const { manager, workers } = createHarness({ autoMask: false });
    const run = manager.analyzeFrames([makeFrame('a')]);
    await flush();
    manager.dispose();
    expect((await run.catch((e) => e)).name).toBe('AbortError');
    expect(workers[0].terminated).toBe(true);
    expect(manager.backend).toBeNull();
  });

  it('ignores messages from a worker that was replaced', async () => {
    const { manager, workers, maskStore } = createHarness({ autoMask: false });
    const run = manager.analyzeFrames([makeFrame('a')]);
    await flush();
    const old = workers[0];
    const stale = old.segments[0];
    manager.dispose();
    await run.catch(() => undefined);
    old.mask(stale);
    old.crash();
    expect(maskStore.size).toBe(0);
  });
});

describe('SegmentationManager.getCapabilities', () => {
  it('reports a WebGPU adapter', async () => {
    const requestAdapter = vi.fn(async () => ({}));
    const { manager } = createHarness(
      {},
      { navigatorImpl: /** @type {any} */ ({ gpu: { requestAdapter } }) },
    );
    await expect(manager.getCapabilities()).resolves.toEqual({ webgpu: true });
    await manager.getCapabilities();
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });

  it('reports no WebGPU without navigator.gpu, a null adapter or an error', async () => {
    const cases = [
      {},
      { gpu: { requestAdapter: async () => null } },
      {
        gpu: {
          requestAdapter: async () => {
            throw new Error('nope');
          },
        },
      },
    ];
    for (const navigatorImpl of cases) {
      const { manager } = createHarness({}, { navigatorImpl: /** @type {any} */ (navigatorImpl) });
      await expect(manager.getCapabilities()).resolves.toEqual({ webgpu: false });
    }
  });
});

describe('getSegmentationManager', () => {
  it('returns one app-wide manager bound to the shared mask store', () => {
    const manager = getSegmentationManager();
    expect(getSegmentationManager()).toBe(manager);
    expect(manager.maskStore).toBeDefined();
  });
});
