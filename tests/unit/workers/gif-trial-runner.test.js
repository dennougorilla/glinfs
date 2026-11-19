import { describe, expect, it, vi } from 'vitest';
import { createTrialRunner } from '../../../src/workers/gif-trial-runner.js';

/** A Worker stand-in that records posted jobs */
function fakeWorker() {
  return {
    /** @type {((event: { data: any }) => void) | null} */
    onmessage: null,
    /** @type {((event: { message: string, preventDefault?: () => void }) => void) | null} */
    onerror: null,
    posted: /** @type {Array<{ data: any, transfer: Transferable[] }>} */ ([]),
    postMessage(data, transfer) {
      this.posted.push({ data, transfer });
    },
    terminate: vi.fn(),
  };
}

const job = () => ({
  width: 2,
  height: 1,
  index: new Uint8Array([0, 1]).buffer,
  differenced: new Uint8Array([2, 1]).buffer,
  wholeOptions: { palette: [[0, 0, 0]], delay: 10 },
  keptOptions: { palette: [[0, 0, 0]], delay: 10, transparent: true, transparentIndex: 2 },
});

describe('createTrialRunner', () => {
  it('transfers the index buffers and answers each job by its id', async () => {
    const workers = [];
    const runner = createTrialRunner(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    });
    const a = job();
    const first = runner.run(a);
    const second = runner.run(job());
    expect(workers).toHaveLength(1);
    expect(runner.pending).toBe(2);
    const [p1, p2] = workers[0].posted;
    expect(p1.transfer).toEqual([a.index, a.differenced]);

    workers[0].onmessage({ data: { id: p2.data.id, bytes: new Uint8Array([9]).buffer } });
    workers[0].onmessage({
      data: {
        id: p1.data.id,
        bytes: new Uint8Array([7, 8]).buffer,
        index: a.index,
        differenced: a.differenced,
      },
    });
    expect(Array.from((await first).bytes)).toEqual([7, 8]);
    expect(Array.from((await second).bytes)).toEqual([9]);
    expect((await first).index).toBe(a.index);
    expect(runner.pending).toBe(0);
  });

  it('rejects a job the worker reports as failed', async () => {
    const w = fakeWorker();
    const runner = createTrialRunner(() => w);
    const pending = runner.run(job());
    w.onmessage({ data: { id: w.posted[0].data.id, error: 'boom' } });
    await expect(pending).rejects.toThrow('boom');
  });

  it('rejects every waiting job when the worker breaks, and starts a new one next time', async () => {
    const workers = [];
    const runner = createTrialRunner(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    });
    const a = runner.run(job());
    const b = runner.run(job());
    workers[0].onerror({ message: 'crashed', preventDefault() {} });
    await expect(a).rejects.toThrow('crashed');
    await expect(b).rejects.toThrow('crashed');
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(runner.pending).toBe(0);

    runner.run(job());
    expect(workers).toHaveLength(2);
  });

  it('terminate stops the worker and rejects what waits', async () => {
    const w = fakeWorker();
    const runner = createTrialRunner(() => w);
    const pending = runner.run(job());
    runner.terminate();
    await expect(pending).rejects.toThrow('terminated');
    expect(w.terminate).toHaveBeenCalled();
  });
});
