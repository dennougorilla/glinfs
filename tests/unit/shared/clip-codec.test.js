import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClipCodecManager } from '../../../src/shared/clip-codec.js';

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

/** Manager wired to a fake worker, with support pre-probed as available */
async function createProbedManager() {
  vi.stubGlobal('VideoEncoder', {
    isConfigSupported: vi.fn(async () => ({ supported: true })),
  });
  const worker = createFakeWorker();
  const manager = createClipCodecManager({ createWorker: () => worker });
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
  it('runs one job at a time, and pending decodes jump pending encodes', async () => {
    const { manager, worker } = await createProbedManager();

    const e1 = manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    void manager.encode(fakeFrames(1), { fps: 30, width: 10, height: 10 });
    void manager.decode({ chunks: [], config: { codec: 'vp8', codedWidth: 10, codedHeight: 10 } });

    // Only e1 dispatched so far — e2 and d1 are queued
    expect(worker.posted.map((p) => p.message.type)).toEqual(['ENCODE']);

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

    // The decode (a user is waiting) dispatched BEFORE the second encode
    expect(worker.posted.map((p) => p.message.type)).toEqual(['ENCODE', 'DECODE']);

    worker.emit({
      type: 'DECODE_RESULT',
      payload: { jobId: worker.posted[1].message.payload.jobId, frames: [] },
    });
    await vi.waitFor(() => {
      expect(worker.posted.map((p) => p.message.type)).toEqual(['ENCODE', 'DECODE', 'ENCODE']);
    });
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
});
