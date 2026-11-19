import { afterEach, describe, expect, it, vi } from 'vitest';
import { crashNextEncodeForTest, createClipCodecManager } from '../../../src/shared/clip-codec.js';

/**
 * Tests for #92: the ClipCodecManager job pipeline.
 *
 * jsdom has neither Worker nor WebCodecs, so both seams are driven directly:
 * - the worker factory is injected (a scriptable fake records postMessage
 *   calls and lets tests emit result messages)
 * - the probe stubs globalThis.VideoEncoder
 *
 * Covered: one-at-a-time dispatch, FIFO with decode-priority ordering,
 * result mapping (ENCODE_RESULT/DECODE_RESULT/JOB_ERROR), probe codec
 * preference (vp09 then vp8), unavailable-encode fast-fail, and worker-crash
 * recovery.
 */

/** Scriptable fake worker capturing postMessage traffic */
function createFakeWorker() {
  const worker = {
    /** @type {{message: any, transfer: any[]}[]} */
    posted: [],
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
    postMessage(message, transfer = []) {
      this.posted.push({ message, transfer });
    },
    /** Emit a worker->main message */
    emit(data) {
      this.onmessage?.({ data });
    },
    /** Emit a worker crash */
    crash(message = 'worker crashed') {
      this.onerror?.({ message });
    },
  };
  return worker;
}

/**
 * Every worker the manager creates (one for encodes, one for decodes, and
 * replacements), seen as one: `posted` lists what was sent to any of them
 * in order, `emit` delivers a reply from the worker that received its job,
 * `crash` crashes the worker that received the last message
 */
function createFakeWorkerHub() {
  /** @type {ReturnType<typeof createFakeWorker>[]} */
  const workers = [];
  /** @type {{message: any, transfer: any[], worker: ReturnType<typeof createFakeWorker>}[]} */
  const posted = [];
  const hub = {
    workers,
    posted,
    terminate: vi.fn(),
    /** Make postMessage throw (a failed structured clone) */
    throwOnPost: false,
    create() {
      const w = createFakeWorker();
      w.postMessage = (message, transfer = []) => {
        if (hub.throwOnPost) throw new Error('DataCloneError');
        w.posted.push({ message, transfer });
        posted.push({ message, transfer, worker: w });
      };
      const terminate = w.terminate;
      w.terminate = vi.fn(() => {
        terminate();
        hub.terminate();
      });
      workers.push(w);
      return w;
    },
    /** @param {any} data */
    emit(data) {
      const jobId = data?.payload?.jobId;
      const target = posted.find((p) => p.message.payload?.jobId === jobId)?.worker;
      (target ?? workers.at(-1))?.emit(data);
    },
    crash(message = 'worker crashed') {
      posted.at(-1)?.worker.crash(message);
    },
  };
  return hub;
}

/** Manager wired to fake workers, with support pre-probed as available */
async function createProbedManager() {
  vi.stubGlobal('VideoEncoder', {
    isConfigSupported: vi.fn(async () => ({ supported: true })),
  });
  const worker = createFakeWorkerHub();
  const manager = createClipCodecManager({ createWorker: () => worker.create() });
  await manager.probeSupport();
  return { manager, worker };
}

function fakeFrames(count = 2) {
  return Array.from({ length: count }, (_, i) => ({ i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('probeSupport', () => {
  it('prefers vp09 and reports availability', async () => {
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async (config) => ({ supported: true, config })),
    });
    const manager = createClipCodecManager({ createWorker: createFakeWorker });

    expect(manager.isCompressionAvailable()).toBe(false); // sync, pre-probe
    await expect(manager.probeSupport()).resolves.toBe(true);
    expect(manager.isCompressionAvailable()).toBe(true);
    expect(globalThis.VideoEncoder.isConfigSupported).toHaveBeenCalledTimes(1);
    expect(globalThis.VideoEncoder.isConfigSupported.mock.calls[0][0].codec).toBe('vp09.00.10.08');
  });

  it('falls back to vp8 when vp09 is unsupported', async () => {
    const isConfigSupported = vi.fn(async (config) => ({ supported: config.codec === 'vp8' }));
    vi.stubGlobal('VideoEncoder', { isConfigSupported });
    const worker = createFakeWorker();
    const manager = createClipCodecManager({ createWorker: () => worker });

    await expect(manager.probeSupport()).resolves.toBe(true);
    expect(isConfigSupported.mock.calls.map((c) => c[0].codec)).toEqual(['vp09.00.10.08', 'vp8']);

    // The chosen codec is what encode jobs carry
    void manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    expect(worker.posted[0].message.payload.codec).toBe('vp8');
  });

  it('reports unavailable without VideoEncoder and caches the probe', async () => {
    const manager = createClipCodecManager({ createWorker: createFakeWorker });
    await expect(manager.probeSupport()).resolves.toBe(false);
    expect(manager.isCompressionAvailable()).toBe(false);
    // Cached: same promise, still false
    await expect(manager.probeSupport()).resolves.toBe(false);
  });

  it('reports unavailable when no candidate codec is supported', async () => {
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async () => ({ supported: false })),
    });
    const manager = createClipCodecManager({ createWorker: createFakeWorker });
    await expect(manager.probeSupport()).resolves.toBe(false);
  });
});

describe('encode', () => {
  it('fast-fails (returning the frames) when compression is unavailable', async () => {
    const manager = createClipCodecManager({ createWorker: createFakeWorker });
    const frames = fakeFrames(2);
    await expect(manager.encode(frames, { fps: 30, width: 10, height: 10 })).resolves.toEqual({
      ok: false,
      error: 'compression-unavailable',
      frames,
    });
  });

  it('transfers the frames and resolves with the worker result', async () => {
    const { manager, worker } = await createProbedManager();
    const frames = fakeFrames(3);

    const promise = manager.encode(frames, { fps: 30, width: 100, height: 50 });

    expect(worker.posted).toHaveLength(1);
    const { message, transfer } = worker.posted[0];
    expect(message.type).toBe('ENCODE');
    expect(message.payload).toMatchObject({ fps: 30, width: 100, height: 50 });
    expect(message.payload.frames).toBe(frames);
    expect(transfer).toBe(frames); // TRANSFERRED, not cloned

    const chunks = [{ type: 'key', timestamp: 0, duration: null, data: new ArrayBuffer(4) }];
    worker.emit({
      type: 'ENCODE_RESULT',
      payload: {
        jobId: message.payload.jobId,
        chunks,
        config: { codec: 'vp8', codedWidth: 100, codedHeight: 50 },
        byteLength: 4,
      },
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      chunks,
      config: { codec: 'vp8', codedWidth: 100, codedHeight: 50 },
      byteLength: 4,
    });
  });

  it('maps JOB_ERROR to ok:false with the returned frames', async () => {
    const { manager, worker } = await createProbedManager();
    const promise = manager.encode(fakeFrames(2), { fps: 30, width: 10, height: 10 });
    const jobId = worker.posted[0].message.payload.jobId;
    const survivors = fakeFrames(2);

    worker.emit({ type: 'JOB_ERROR', payload: { jobId, message: 'boom', frames: survivors } });

    await expect(promise).resolves.toEqual({ ok: false, error: 'boom', frames: survivors });
  });
});

describe('job scheduling', () => {
  it('runs a decode at once on its own worker while an encode runs', async () => {
    const { manager, worker } = await createProbedManager();

    const e1 = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const d1 = manager.decode({
      chunks: [],
      config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 },
    });

    // Both dispatched, each to its own worker: opening a clip does not wait
    // for a background compression
    expect(worker.posted.map((p) => p.message.type)).toEqual(['ENCODE', 'DECODE']);
    expect(worker.posted[0].worker).not.toBe(worker.posted[1].worker);

    worker.emit({
      type: 'DECODE_RESULT',
      payload: { jobId: worker.posted[1].message.payload.jobId, frames: [] },
    });
    await expect(d1).resolves.toEqual({ ok: true, frames: [] });
    worker.emit({
      type: 'ENCODE_RESULT',
      payload: {
        jobId: worker.posted[0].message.payload.jobId,
        chunks: [],
        config: {},
        byteLength: 0,
      },
    });
    await expect(e1).resolves.toMatchObject({ ok: true });
  });

  it('runs encodes one at a time, and decodes one at a time, each in order', async () => {
    const { manager, worker } = await createProbedManager();
    const e1 = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    void manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const d1 = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    void manager.decode({ chunks: [], config: { codec: 'vp8' } });
    expect(worker.posted.map((p) => p.message.type)).toEqual(['ENCODE', 'DECODE']);

    worker.emit({
      type: 'DECODE_RESULT',
      payload: { jobId: worker.posted[1].message.payload.jobId, frames: [] },
    });
    await d1;
    expect(worker.posted.map((p) => p.message.type)).toEqual(['ENCODE', 'DECODE', 'DECODE']);
    // The second decode reuses the decode worker
    expect(worker.posted[2].worker).toBe(worker.posted[1].worker);

    worker.emit({
      type: 'ENCODE_RESULT',
      payload: {
        jobId: worker.posted[0].message.payload.jobId,
        chunks: [],
        config: {},
        byteLength: 0,
      },
    });
    await e1;
    expect(worker.posted.map((p) => p.message.type)).toEqual([
      'ENCODE',
      'DECODE',
      'DECODE',
      'ENCODE',
    ]);
    expect(worker.posted[3].worker).toBe(worker.posted[0].worker);
  });

  it('a decode that stalls leaves the running encode alone', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('VideoEncoder', { isConfigSupported: vi.fn(async () => ({ supported: true })) });
    const worker = createFakeWorkerHub();
    const manager = createClipCodecManager({ createWorker: () => worker.create(), stallMs: 1000 });
    await manager.probeSupport();
    const encode = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const decode = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    const [encodeJob, decodeJob] = worker.posted;
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(400);
      worker.emit({ type: 'JOB_PROGRESS', payload: { jobId: encodeJob.message.payload.jobId } });
    }
    await expect(decode).resolves.toEqual({ ok: false, error: 'stalled' });
    expect(decodeJob.worker.terminate).toHaveBeenCalled();
    expect(encodeJob.worker.terminate).not.toHaveBeenCalled();
    worker.emit({
      type: 'ENCODE_RESULT',
      payload: { jobId: encodeJob.message.payload.jobId, chunks: [], config: {}, byteLength: 0 },
    });
    await expect(encode).resolves.toMatchObject({ ok: true });
    vi.useRealTimers();
  });

  it('terminate() ends both workers and fails every job', async () => {
    const { manager, worker } = await createProbedManager();
    const encode = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const decode = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    manager.terminate();
    expect(worker.workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    await expect(encode).resolves.toEqual({ ok: false, error: 'terminated', frames: [] });
    await expect(decode).resolves.toEqual({ ok: false, error: 'terminated' });
  });

  it('does not clone/transfer chunk buffers into a decode job', async () => {
    const { manager, worker } = await createProbedManager();
    const chunks = [{ type: 'key', timestamp: 0, duration: null, data: new ArrayBuffer(8) }];

    void manager.decode({ chunks, config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 } });

    expect(worker.posted[0].message.type).toBe('DECODE');
    // Empty transfer list: a decode failure must leave the entry's bytes intact
    expect(worker.posted[0].transfer).toEqual([]);
  });
});

describe('cancelEncode (#186)', () => {
  it('withdraws a queued encode, handing its frames back, and keeps the queue moving', async () => {
    const { manager, worker } = await createProbedManager();
    const runningFrames = fakeFrames(1);
    const queuedFrames = fakeFrames(2);
    const nextFrames = fakeFrames(1);
    void manager.encode(runningFrames, { fps: 30, width: 10, height: 10 });
    const queued = manager.encode(queuedFrames, { fps: 30, width: 10, height: 10 });
    void manager.encode(nextFrames, { fps: 30, width: 10, height: 10 });

    expect(manager.isEncodeQueued(runningFrames)).toBe(false);
    expect(manager.isEncodeQueued(queuedFrames)).toBe(true);
    expect(manager.cancelEncode(queuedFrames)).toBe(true);
    expect(manager.isEncodeQueued(queuedFrames)).toBe(false);
    await expect(queued).resolves.toEqual({ ok: false, error: 'cancelled', frames: queuedFrames });

    worker.emit({
      type: 'ENCODE_RESULT',
      payload: { jobId: worker.posted[0].message.payload.jobId, chunks: [], config: {} },
    });
    // The withdrawn job never dispatches; the next one does
    await vi.waitFor(() => {
      expect(worker.posted).toHaveLength(2);
    });
    expect(worker.posted[1].transfer).toBe(nextFrames);
  });

  it('cannot withdraw the running encode (its frames are in the worker)', async () => {
    const { manager } = await createProbedManager();
    const runningFrames = fakeFrames(1);
    void manager.encode(runningFrames, { fps: 30, width: 10, height: 10 });

    expect(manager.cancelEncode(runningFrames)).toBe(false);
    expect(manager.cancelEncode(fakeFrames(1))).toBe(false);
  });
});

describe('worker crash', () => {
  it('fails the active job and recycles the worker for the next one', async () => {
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async () => ({ supported: true })),
    });
    const workers = [];
    const manager = createClipCodecManager({
      createWorker: () => {
        const w = createFakeWorker();
        workers.push(w);
        return w;
      },
    });
    await manager.probeSupport();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const promise = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    workers[0].crash('oom');

    await expect(promise).resolves.toEqual({ ok: false, error: 'oom', frames: [] });
    expect(workers[0].terminate).toHaveBeenCalled();

    // Next job spins up a fresh worker
    void manager.decode({ chunks: [], config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 } });
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].message.type).toBe('DECODE');
    spy.mockRestore();
  });
});

describe('crashNextEncodeForTest (E2E hook, dev builds only)', () => {
  it('flags exactly the next encode job for a forced worker crash', async () => {
    const { manager, worker } = await createProbedManager();
    crashNextEncodeForTest(manager);
    void manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    expect(worker.posted[0].message.payload.crashForTest).toBe(true);

    // The worker "crashes"; the following job is a normal one
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.crash('forced');
    void manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    expect(worker.posted[1].message.payload).not.toHaveProperty('crashForTest');
    spy.mockRestore();
  });
});

describe('worker crash then encode', () => {
  it('runs the next ENCODE on a fresh worker and resolves it normally', async () => {
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async () => ({ supported: true })),
    });
    const workers = [];
    const manager = createClipCodecManager({
      createWorker: () => {
        const w = createFakeWorker();
        workers.push(w);
        return w;
      },
    });
    await manager.probeSupport();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A second encode queued BEFORE the crash still owns its frames (not
    // transferred yet) and must run on the replacement worker
    const lost = manager.encode(fakeFrames(2), { fps: 30, width: 10, height: 10 });
    const queued = manager.encode(fakeFrames(2), { fps: 30, width: 10, height: 10 });
    workers[0].crash('boom');

    await expect(lost).resolves.toEqual({ ok: false, error: 'boom', frames: [] });
    expect(workers).toHaveLength(2);
    const { jobId } = workers[1].posted[0].message.payload;
    expect(workers[1].posted[0].message.type).toBe('ENCODE');
    workers[1].emit({
      type: 'ENCODE_RESULT',
      payload: { jobId, chunks: [], config: { codec: 'vp8' }, byteLength: 4 },
    });
    await expect(queued).resolves.toMatchObject({ ok: true, byteLength: 4 });

    // And a job submitted after everything settled also works
    const later = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const laterJob = workers[1].posted[1].message.payload.jobId;
    workers[1].emit({
      type: 'ENCODE_RESULT',
      payload: { jobId: laterJob, chunks: [], config: { codec: 'vp8' }, byteLength: 1 },
    });
    await expect(later).resolves.toMatchObject({ ok: true });
    spy.mockRestore();
  });
});

describe('terminate', () => {
  it('fails all in-flight and pending jobs without hanging their callers', async () => {
    const { manager, worker } = await createProbedManager();
    const e1 = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const d1 = manager.decode({
      chunks: [],
      config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 },
    });

    manager.terminate();

    await expect(e1).resolves.toEqual({ ok: false, error: 'terminated', frames: [] });
    await expect(d1).resolves.toEqual({ ok: false, error: 'terminated' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  // #120: terminate() is teardown-only (no production caller requeues), so it
  // fails pending jobs instead of pumping them — but it must hand back the
  // frames they never transferred rather than dropping them unclosed
  it('with 1 running + 2 pending: running encode is LOST, pending encode gets its own frames back', async () => {
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async () => ({ supported: true })),
    });
    const workers = [];
    const manager = createClipCodecManager({
      createWorker: () => {
        const w = createFakeWorker();
        workers.push(w);
        return w;
      },
    });
    await manager.probeSupport();

    const runningFrames = fakeFrames(2);
    const pendingFrames = fakeFrames(3);
    const running = manager.encode(runningFrames, { fps: 30, width: 10, height: 10 });
    const pendingEncode = manager.encode(pendingFrames, { fps: 30, width: 10, height: 10 });
    const pendingDecode = manager.decode({
      chunks: [],
      config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 },
    });
    // The first encode was dispatched (its frames transferred); the decode
    // runs at once on the decode worker
    expect(workers[0].posted).toHaveLength(1);
    expect(workers[0].posted[0].transfer).toBe(runningFrames);
    expect(workers[1].posted.map((p) => p.message.type)).toEqual(['DECODE']);

    manager.terminate();

    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    await expect(running).resolves.toEqual({ ok: false, error: 'terminated', frames: [] });
    const pendingResult = await pendingEncode;
    expect(pendingResult).toMatchObject({ ok: false, error: 'terminated' });
    // Same array, same length as submitted: the caller's RECOVERABLE path
    // (app-store rebuilds the raw entry, or closes the frames if deleted)
    expect(pendingResult.frames).toBe(pendingFrames);
    await expect(pendingDecode).resolves.toEqual({ ok: false, error: 'terminated' });
    // Nothing was requeued onto the dead workers or a new one
    expect(workers[0].posted).toHaveLength(1);
    expect(workers).toHaveLength(2);

    // Not terminal: the next job runs on a fresh worker
    void manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    expect(workers).toHaveLength(3);
    expect(workers[2].posted[0].message.type).toBe('ENCODE');
  });

  it('ignores late messages from the terminated worker', async () => {
    const { manager, worker } = await createProbedManager();
    const job = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    const { jobId } = worker.posted[0].message.payload;
    manager.terminate();
    worker.emit({
      type: 'ENCODE_RESULT',
      payload: { jobId, chunks: [], config: { codec: 'vp8' }, byteLength: 4 },
    });
    await expect(job).resolves.toEqual({ ok: false, error: 'terminated', frames: [] });
  });
});

describe('postMessage failure', () => {
  it('hands the untransferred frames back instead of reporting them lost', async () => {
    const { manager, worker } = await createProbedManager();
    worker.throwOnPost = true;
    const frames = fakeFrames(2);
    const result = await manager.encode(frames, { fps: 30, width: 10, height: 10 });
    expect(result).toMatchObject({ ok: false, error: 'DataCloneError' });
    expect(result.frames).toBe(frames);
  });
});

describe('stall watchdog (a job that stops making progress)', () => {
  /** Manager with a fresh fake worker per creation and a short bound */
  async function createWatchedManager(stallMs = 1000) {
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async () => ({ supported: true })),
    });
    /** @type {ReturnType<typeof createFakeWorker>[]} */
    const workers = [];
    const manager = createClipCodecManager({
      createWorker: () => {
        const w = createFakeWorker();
        workers.push(w);
        return w;
      },
      stallMs,
    });
    await manager.probeSupport();
    return { manager, workers };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a decode with no reply and no progress, then runs the next job on a fresh worker', async () => {
    vi.useFakeTimers();
    const { manager, workers } = await createWatchedManager(1000);
    const stuck = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    const next = manager.decode({ chunks: [], config: { codec: 'vp8' } });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(stuck).resolves.toEqual({ ok: false, error: 'stalled' });
    expect(workers[0].terminate).toHaveBeenCalled();
    // The queue continues on a new worker
    expect(workers).toHaveLength(2);
    const { jobId } = workers[1].posted[0].message.payload;
    workers[1].emit({ type: 'DECODE_RESULT', payload: { jobId, frames: [] } });
    await expect(next).resolves.toEqual({ ok: true, frames: [] });
  });

  it('keeps a long job alive while it reports progress', async () => {
    vi.useFakeTimers();
    const { manager, workers } = await createWatchedManager(1000);
    let settled = false;
    const job = manager.decode({ chunks: [], config: { codec: 'vp8' } }).then((r) => {
      settled = true;
      return r;
    });
    const { jobId } = workers[0].posted[0].message.payload;
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(900);
      workers[0].emit({ type: 'JOB_PROGRESS', payload: { jobId } });
    }
    expect(settled).toBe(false);
    workers[0].emit({ type: 'DECODE_RESULT', payload: { jobId, frames: [] } });
    await expect(job).resolves.toEqual({ ok: true, frames: [] });
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });

  it('fails a stalled encode as lost (its frames are in the dead worker)', async () => {
    vi.useFakeTimers();
    const { manager, workers } = await createWatchedManager(1000);
    const job = manager.encode(fakeFrames(2), { fps: 30, width: 10, height: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(job).resolves.toEqual({ ok: false, error: 'stalled', frames: [] });
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it('ignores progress from a job that is not running', async () => {
    vi.useFakeTimers();
    const { manager, workers } = await createWatchedManager(1000);
    const job = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    await vi.advanceTimersByTimeAsync(600);
    workers[0].emit({ type: 'JOB_PROGRESS', payload: { jobId: 999 } });
    await vi.advanceTimersByTimeAsync(400);
    await expect(job).resolves.toEqual({ ok: false, error: 'stalled' });
  });

  it('does not fire after the job settled', async () => {
    vi.useFakeTimers();
    const { manager, workers } = await createWatchedManager(1000);
    const job = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    const { jobId } = workers[0].posted[0].message.payload;
    workers[0].emit({ type: 'DECODE_RESULT', payload: { jobId, frames: [] } });
    await job;
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });
});

describe('replies for jobs that already settled', () => {
  it('closes the frames of a decode result that arrives after the job stalled', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('VideoEncoder', { isConfigSupported: vi.fn(async () => ({ supported: true })) });
    const worker = createFakeWorker();
    const manager = createClipCodecManager({ createWorker: () => worker, stallMs: 1000 });
    await manager.probeSupport();
    const job = manager.decode({ chunks: [], config: { codec: 'vp8' } });
    const { jobId } = worker.posted[0].message.payload;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(job).resolves.toEqual({ ok: false, error: 'stalled' });

    const late = [{ close: vi.fn() }, { close: vi.fn() }];
    worker.emit({ type: 'DECODE_RESULT', payload: { jobId, frames: late } });
    for (const frame of late) expect(frame.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
