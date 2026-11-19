import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The main-thread client of the I420 converter worker (D3's cheap half):
 * RGBA frames (VideoFrame clones or bitmaps) go to the worker, CPU I420
 * bytes come back per frame.
 */

/** @type {FakeWorker[]} */
let workers = [];

class FakeWorker {
  constructor() {
    /** @type {{ message: any, transfer: any[] }[]} */
    this.sent = [];
    /** @type {((e: MessageEvent) => void) | null} */
    this.onmessage = null;
    /** @type {((e: ErrorEvent) => void) | null} */
    this.onerror = null;
    this.terminated = false;
    workers.push(this);
  }
  /** @param {any} message @param {any[]} [transfer] */
  postMessage(message, transfer = []) {
    this.sent.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  /** @param {any} data */
  reply(data) {
    this.onmessage?.(/** @type {MessageEvent} */ ({ data }));
  }
}

/** @param {number} n */
function items(n, w = 4, h = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    timestamp: i * 33,
    source: { width: w, height: h, close: vi.fn() },
  }));
}

/** @returns {Promise<typeof import('../../../src/workers/i420-converter.js')>} */
async function load() {
  vi.resetModules();
  return import('../../../src/workers/i420-converter.js');
}

beforeEach(() => {
  workers = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('OffscreenCanvas', class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('convertToI420', () => {
  it('hands every source to the worker and returns the bytes in order', async () => {
    const { convertToI420 } = await load();
    const input = items(3);
    const job = convertToI420(input);
    const worker = workers[0];
    const { message, transfer } = worker.sent[0];
    expect(message.type).toBe('CONVERT');
    expect(message.frames.map((/** @type {any} */ f) => f.id)).toEqual(['f0', 'f1', 'f2']);
    expect(transfer).toEqual(input.map((item) => item.source));

    const jobId = message.jobId;
    for (const index of [1, 0, 2]) {
      worker.reply({
        type: 'FRAME',
        jobId,
        index,
        width: 4,
        height: 2,
        data: new ArrayBuffer(12),
      });
    }
    worker.reply({ type: 'DONE', jobId, engine: 'webgl2' });

    const result = await job;
    expect(result.engine).toBe('webgl2');
    expect(result.converted.map((c) => [c.index, c.id, c.timestamp])).toEqual([
      [0, 'f0', 0],
      [1, 'f1', 33],
      [2, 'f2', 66],
    ]);
    expect(result.rest).toEqual([]);
    // The sources are the worker's now: this side closes none of them
    for (const item of input) expect(item.source.close).not.toHaveBeenCalled();
  });

  it('hands each frame to onFrame as it arrives', async () => {
    const { convertToI420 } = await load();
    /** @type {number[]} */
    const seen = [];
    const job = convertToI420(items(2), { onFrame: (frame) => seen.push(frame.index) });
    const worker = workers[0];
    const { jobId } = worker.sent[0].message;
    const frame = (/** @type {number} */ index) => ({
      type: 'FRAME',
      jobId,
      index,
      width: 4,
      height: 2,
      data: new ArrayBuffer(12),
    });
    worker.reply(frame(0));
    expect(seen).toEqual([0]);
    worker.reply(frame(1));
    worker.reply({ type: 'DONE', jobId, engine: 'webgpu' });
    expect((await job).converted).toHaveLength(2);
    expect(seen).toEqual([0, 1]);
  });

  it('gives back the sources the worker could not convert, and stops using it', async () => {
    const { convertToI420, isCpuFrameConversionAvailable } = await load();
    const input = items(3);
    const job = convertToI420(input);
    const worker = workers[0];
    const { jobId } = worker.sent[0].message;
    worker.reply({
      type: 'FRAME',
      jobId,
      index: 0,
      width: 4,
      height: 2,
      data: new ArrayBuffer(12),
    });
    const back = [1, 2].map((index) => ({
      index,
      source: { width: 4, height: 2, close: vi.fn() },
    }));
    worker.reply({ type: 'FAILED', jobId, error: 'context lost', rest: back });

    const result = await job;
    expect(result.converted.map((c) => c.index)).toEqual([0]);
    expect(result.rest.map((r) => [r.index, r.item.id, r.item.source])).toEqual([
      [1, 'f1', back[0].source],
      [2, 'f2', back[1].source],
    ]);
    expect(worker.terminated).toBe(true);
    expect(isCpuFrameConversionAvailable()).toBe(false);
  });

  it('settles with what was converted when the worker dies', async () => {
    const { convertToI420, isCpuFrameConversionAvailable } = await load();
    const job = convertToI420(items(2));
    const worker = workers[0];
    const { jobId } = worker.sent[0].message;
    worker.reply({
      type: 'FRAME',
      jobId,
      index: 0,
      width: 4,
      height: 2,
      data: new ArrayBuffer(12),
    });
    worker.onerror?.(/** @type {ErrorEvent} */ ({ message: 'boom' }));

    const result = await job;
    expect(result.converted.map((c) => c.index)).toEqual([0]);
    expect(result.rest).toEqual([]);
    expect(result.lost).toBe(1);
    expect(isCpuFrameConversionAvailable()).toBe(false);
  });

  it('converts nothing without workers or OffscreenCanvas', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const { convertToI420, isCpuFrameConversionAvailable } = await load();
    expect(isCpuFrameConversionAvailable()).toBe(false);
    const input = items(2);
    const result = await convertToI420(input);
    expect(workers).toHaveLength(0);
    expect(result.converted).toEqual([]);
    expect(result.rest.map((r) => r.item)).toEqual(input);
  });

  it('warms the worker up ahead of the first clip, once', async () => {
    const { warmI420Converter, convertToI420 } = await load();
    warmI420Converter();
    warmI420Converter();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((s) => s.message.type)).toEqual(['WARM']);
    void convertToI420(items(1));
    expect(workers).toHaveLength(1);
  });

  it('does not start a worker to warm up where it cannot run', async () => {
    vi.stubGlobal('Worker', undefined);
    const { warmI420Converter } = await load();
    expect(() => warmI420Converter()).not.toThrow();
    expect(workers).toHaveLength(0);
  });

  it('keeps one worker across jobs', async () => {
    const { convertToI420 } = await load();
    for (let round = 0; round < 2; round++) {
      const job = convertToI420(items(1));
      const worker = workers[0];
      const { jobId } = worker.sent[worker.sent.length - 1].message;
      worker.reply({
        type: 'FRAME',
        jobId,
        index: 0,
        width: 4,
        height: 2,
        data: new ArrayBuffer(12),
      });
      worker.reply({ type: 'DONE', jobId, engine: 'js' });
      await job;
    }
    expect(workers).toHaveLength(1);
  });
});
