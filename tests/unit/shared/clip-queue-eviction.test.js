import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteQueuedClip,
  enqueueClip,
  evictQueuedClips,
  getClipMemoryEstimateMB,
  getClipPayload,
  getClipQueue,
  hasPendingDeletion,
  planQueueEviction,
  prepareQueuedClipForPromote,
  promoteQueuedClip,
  registerClipCodec,
  resetAppStore,
  setClipPayload,
  undoDelete,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { createClipCodecManager } from '../../../src/shared/clip-codec.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

/**
 * Tests for #186: removing the oldest queued clips to make room for a new
 * clip (planQueueEviction + evictQueuedClips).
 *
 * - oldest first, as few as needed, for the queue limit and the budget
 * - the plan changes nothing; refusing when every candidate is not enough
 * - the active clip, a 'decoding' entry and a clip held for Undo are never
 *   removed
 * - raw frames are closed, a compressing entry's late encode result never
 *   resurrects it or leaks returned frames
 */

const MB = 1024 * 1024;

/** One mock frame of `sizeMB` raw RGBA memory (close() flips .closed) */
function createMockFrame(id, sizeMB = 1) {
  const side = Math.round(Math.sqrt((sizeMB * MB) / 4));
  const videoFrame = { closed: false, timestamp: 0, codedWidth: side, codedHeight: side };
  videoFrame.close = vi.fn(() => {
    videoFrame.closed = true;
  });
  return { id, frame: videoFrame, timestamp: 0, width: side, height: side };
}

let clipCounter = 0;

/** Enqueue a one-frame clip of about `sizeMB`; returns its entry */
function enqueueSized(sizeMB = 1) {
  clipCounter += 1;
  const result = enqueueClip({
    frames: [createMockFrame(`f${clipCounter}`, sizeMB)],
    fps: 30,
    capturedAt: clipCounter,
  });
  if (!result.ok) throw new Error('enqueue refused in test setup');
  return /** @type {NonNullable<typeof result.entry>} */ (result.entry);
}

/** Controllable mock codec (see clip-queue-compression.test.js) */
function createMockCodec() {
  /** @type {{frames: any[], resolve: (r: any) => void}[]} */
  const encodeCalls = [];
  /** @type {{resolve: (r: any) => void}[]} */
  const decodeCalls = [];
  return {
    isCompressionAvailable: () => true,
    encode: vi.fn(
      (frames) =>
        new Promise((resolve) => {
          encodeCalls.push({ frames, resolve });
        }),
    ),
    decode: vi.fn(
      () =>
        new Promise((resolve) => {
          decodeCalls.push({ resolve });
        }),
    ),
    encodeCalls,
    decodeCalls,
  };
}

function okEncodeResult(byteLength = 0.5 * MB) {
  return {
    ok: true,
    chunks: [{ type: 'key', timestamp: 0, duration: null, data: new ArrayBuffer(16) }],
    config: { codec: 'vp8', codedWidth: 100, codedHeight: 100 },
    byteLength,
  };
}

async function flushJobs() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
  clipCounter = 0;
});

afterEach(() => {
  registerClipCodec(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The real ClipCodecManager on a fake worker (as in clip-codec.test.js), so
 * queued vs running encodes behave exactly as in the app
 */
async function registerRealCodecOnFakeWorker() {
  vi.stubGlobal('VideoEncoder', { isConfigSupported: vi.fn(async () => ({ supported: true })) });
  const worker = {
    /** @type {{message: any}[]} */
    posted: [],
    onmessage: /** @type {((e: {data: any}) => void) | null} */ (null),
    onerror: null,
    terminate: vi.fn(),
    postMessage(message) {
      this.posted.push({ message });
    },
  };
  const manager = createClipCodecManager({ createWorker: () => /** @type {any} */ (worker) });
  await manager.probeSupport();
  registerClipCodec(manager);
  /** Finish the running encode the way the worker reports success */
  const finishRunningEncode = (index) => {
    const { jobId } = worker.posted[index].message.payload;
    worker.onmessage?.({
      data: {
        type: 'ENCODE_RESULT',
        payload: { jobId, chunks: [], config: { codec: 'vp8' }, byteLength: 0.1 * MB },
      },
    });
  };
  return { worker, finishRunningEncode };
}

describe('planQueueEviction', () => {
  it('plans nothing when the new clip already fits', () => {
    updateSetting('capture', 'clipQueueLimit', 3);
    enqueueSized();
    expect(planQueueEviction({ needSlot: true, incomingMB: 1, budgetMB: 100 })).toEqual({
      ok: true,
      ids: [],
    });
  });

  it('frees one slot with the oldest clip when the queue is full', () => {
    updateSetting('capture', 'clipQueueLimit', 2);
    const oldest = enqueueSized();
    enqueueSized();

    const plan = planQueueEviction({ needSlot: true });

    expect(plan).toEqual({ ok: true, reason: 'queue-full', ids: [oldest.id] });
    // Planning changes nothing
    expect(getClipQueue()).toHaveLength(2);
  });

  it('needs no slot when the clip does not take one (Create Clip without an active clip)', () => {
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueSized();
    expect(planQueueEviction({ needSlot: false })).toEqual({ ok: true, ids: [] });
  });

  it('removes as few of the oldest clips as the budget needs', () => {
    updateSetting('capture', 'clipQueueLimit', 10);
    const a = enqueueSized(10);
    const b = enqueueSized(10);
    enqueueSized(10);
    // Held 30 MB + incoming 15 MB vs 28 MB budget: 17 MB over -> two oldest
    const plan = planQueueEviction({ needSlot: true, incomingMB: 15, budgetMB: 28 });
    expect(plan).toEqual({ ok: true, reason: 'memory-budget', ids: [a.id, b.id] });
  });

  it('refuses (and plans nothing) when removing every queued clip is not enough', () => {
    setClipPayload({ frames: [createMockFrame('active', 50)], fps: 30, capturedAt: 0 });
    enqueueSized(10);
    const plan = planQueueEviction({ needSlot: true, incomingMB: 20, budgetMB: 60 });
    expect(plan).toEqual({ ok: false, reason: 'memory-budget', ids: [] });
  });

  it('refuses with nothing queued and the active clip over budget', () => {
    setClipPayload({ frames: [createMockFrame('active', 50)], fps: 30, capturedAt: 0 });
    expect(planQueueEviction({ needSlot: true, incomingMB: 20, budgetMB: 60 })).toEqual({
      ok: false,
      reason: 'memory-budget',
      ids: [],
    });
  });

  it('ignores the budget when it is 0 or less', () => {
    enqueueSized(10);
    expect(planQueueEviction({ needSlot: true, incomingMB: 1e6, budgetMB: 0 }).ids).toEqual([]);
  });

  it('goes by capture age, not queue position, after a promote demoted an older clip', () => {
    // Regression (PR #191 review): the demoted active clip enters the queue
    // FRONT, so walking the queue from the back removed a newer capture
    updateSetting('capture', 'clipQueueLimit', 2);
    setClipPayload({ frames: [createMockFrame('a')], fps: 30, capturedAt: 1 });
    const a = /** @type {string} */ (getClipPayload()?.id);
    const b = enqueueClip({ frames: [createMockFrame('b')], fps: 30, capturedAt: 2 }).entry;
    const c = enqueueClip({ frames: [createMockFrame('c')], fps: 30, capturedAt: 3 }).entry;
    expect(promoteQueuedClip(/** @type {any} */ (c).id)).not.toBeNull();
    expect(getClipQueue().map((e) => e.id)).toEqual([a, b?.id]);

    expect(planQueueEviction({ needSlot: true })).toEqual({
      ok: true,
      reason: 'queue-full',
      ids: [a],
    });
  });

  it('never plans a clip that is decoding for a promote', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'clipQueueLimit', 2);
    const decoding = enqueueSized();
    const newer = enqueueSized();
    codec.encodeCalls[0].resolve(okEncodeResult());
    codec.encodeCalls[1].resolve(okEncodeResult());
    await flushJobs();
    void prepareQueuedClipForPromote(decoding.id);
    expect(getClipQueue().find((e) => e.id === decoding.id)?.status).toBe('decoding');

    expect(planQueueEviction({ needSlot: true }).ids).toEqual([newer.id]);
  });

  it('refuses queue-full when only decoding clips could go', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'clipQueueLimit', 1);
    const decoding = enqueueSized();
    codec.encodeCalls[0].resolve(okEncodeResult());
    await flushJobs();
    void prepareQueuedClipForPromote(decoding.id);

    expect(planQueueEviction({ needSlot: true })).toEqual({
      ok: false,
      reason: 'queue-full',
      ids: [],
    });
  });
});

describe('evictQueuedClips', () => {
  it('removes the entries, closes their raw frames and tells listeners', () => {
    const a = enqueueSized();
    const b = enqueueSized();
    const kept = enqueueSized();
    const aFrame = a.frames?.[0].frame;
    const bFrame = b.frames?.[0].frame;
    const changes = [];
    const released = [];
    const offChanged = onBus('queue:changed', (e) => changes.push(e));
    const offReleased = onBus('clips:released', (e) => released.push(e));

    const removed = evictQueuedClips([a.id, b.id]);

    expect(removed.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(getClipQueue().map((e) => e.id)).toEqual([kept.id]);
    expect(aFrame?.close).toHaveBeenCalledOnce();
    expect(bFrame?.close).toHaveBeenCalledOnce();
    expect(kept.frames?.[0].frame.close).not.toHaveBeenCalled();
    expect(changes).toEqual([expect.objectContaining({ type: 'evict', ids: [a.id, b.id] })]);
    expect(released).toEqual([{ ids: [a.id, b.id], reset: false }]);
    // No Undo hold: the memory is gone now
    expect(hasPendingDeletion()).toBe(false);
    expect(getClipMemoryEstimateMB()).toBeCloseTo(1, 1);

    offChanged();
    offReleased();
  });

  it('skips ids that are no longer queued and emits nothing when none are', () => {
    const changes = [];
    const off = onBus('queue:changed', (e) => changes.push(e));
    expect(evictQueuedClips(['missing'])).toEqual([]);
    expect(changes).toEqual([]);
    off();
  });

  it('never touches the active clip', () => {
    const activeFrame = createMockFrame('active');
    setClipPayload({ frames: [activeFrame], fps: 30, capturedAt: 0 });
    const queued = enqueueSized();
    const activeId = /** @type {string} */ (getClipPayload()?.id);

    evictQueuedClips([activeId, queued.id]);

    expect(getClipPayload()?.frames).toEqual([activeFrame]);
    expect(activeFrame.frame.close).not.toHaveBeenCalled();
    expect(getClipQueue()).toHaveLength(0);
  });

  it('leaves a clip held for Undo alone, and Undo still restores it', () => {
    updateSetting('capture', 'clipQueueLimit', 2);
    const held = enqueueSized();
    const oldest = enqueueSized();
    deleteQueuedClip(held.id);
    enqueueSized();

    const plan = planQueueEviction({ needSlot: true });
    expect(plan.ids).toEqual([oldest.id]);
    evictQueuedClips(plan.ids);
    enqueueSized();

    expect(hasPendingDeletion()).toBe(true);
    expect(held.frames?.[0].frame.close).not.toHaveBeenCalled();
    // The queue is full again, so Undo is refused as before; free a slot
    // and it restores the held clip intact
    expect(undoDelete()).toBe(false);
    evictQueuedClips([getClipQueue().at(-1)?.id ?? '']);
    expect(undoDelete()).toBe(true);
    expect(getClipQueue().some((e) => e.id === held.id)).toBe(true);
  });

  describe('a clip that is still compressing', () => {
    it('does not come back when its encode succeeds later', async () => {
      const codec = createMockCodec();
      registerClipCodec(codec);
      const compressing = enqueueSized();
      expect(compressing.status).toBe('compressing');

      evictQueuedClips([compressing.id]);
      codec.encodeCalls[0].resolve(okEncodeResult());
      await flushJobs();

      expect(getClipQueue()).toEqual([]);
      expect(getClipMemoryEstimateMB()).toBe(0);
      // Its frames were in the worker: nothing to close on this side
      expect(compressing.frames?.[0].frame.close).not.toHaveBeenCalled();
    });

    it('closes the frames a failed encode hands back, without a dead entry', async () => {
      const codec = createMockCodec();
      registerClipCodec(codec);
      const compressing = enqueueSized();
      const returned = codec.encodeCalls[0].frames;
      const changes = [];
      const off = onBus('queue:changed', (e) => changes.push(e.type));

      evictQueuedClips([compressing.id]);
      codec.encodeCalls[0].resolve({ ok: false, error: 'encoder error', frames: returned });
      await flushJobs();

      for (const vf of returned) expect(vf.closed).toBe(true);
      expect(getClipQueue()).toEqual([]);
      // No 'compress-lost' notice for a clip that was removed on purpose
      expect(changes).toEqual(['evict']);
      off();
    });

    it('drops the chunks of a compressed clip (nothing to close)', async () => {
      const codec = createMockCodec();
      registerClipCodec(codec);
      const entry = enqueueSized();
      codec.encodeCalls[0].resolve(okEncodeResult());
      await flushJobs();
      expect(getClipQueue()[0].status).toBe('compressed');

      expect(evictQueuedClips([entry.id])).toHaveLength(1);
      expect(getClipQueue()).toEqual([]);
      expect(getClipMemoryEstimateMB()).toBe(0);
    });
  });

  describe('memory of a removed clip whose encode has not finished (PR #191 review)', () => {
    it('withdraws a queued encode and frees its frames at once', async () => {
      updateSetting('capture', 'clipQueueLimit', 10);
      await registerRealCodecOnFakeWorker();
      const running = enqueueSized(10);
      const queued = enqueueSized(10);
      const queuedFrame = queued.frames?.[0].frame;
      expect(running.status).toBe('compressing');
      expect(queued.status).toBe('compressing');

      // 20 MB held + 15 MB incoming vs 25 MB: only the queued encode can
      // give its memory back now, so it goes although it is newer
      const plan = planQueueEviction({ needSlot: false, incomingMB: 15, budgetMB: 25 });
      expect(plan).toEqual({ ok: true, reason: 'memory-budget', ids: [queued.id] });

      evictQueuedClips(plan.ids);

      expect(queuedFrame?.close).toHaveBeenCalled();
      expect(getClipMemoryEstimateMB()).toBeCloseTo(10, 0);
      await flushJobs();
      expect(getClipQueue().map((e) => e.id)).toEqual([running.id]);
    });

    it('keeps counting a running encode until it settles, and refuses meanwhile', async () => {
      // Before the fix each capture removed the previous compressing clip and
      // was admitted, while the worker kept every set of frames alive
      updateSetting('capture', 'clipQueueLimit', 1);
      const { finishRunningEncode } = await registerRealCodecOnFakeWorker();
      const running = enqueueSized(256);
      expect(running.status).toBe('compressing');

      // A slot can be made (the queue no longer holds it) ...
      const slotPlan = planQueueEviction({ needSlot: true, incomingMB: 200, budgetMB: 500 });
      expect(slotPlan).toEqual({ ok: true, reason: 'queue-full', ids: [running.id] });
      evictQueuedClips(slotPlan.ids);
      expect(getClipQueue()).toEqual([]);
      // ... but its frames are still in the worker, and still counted
      expect(getClipMemoryEstimateMB()).toBeCloseTo(256, 0);
      expect(running.frames?.[0].frame.close).not.toHaveBeenCalled();

      // The next 256 MB clip cannot fit until that memory is really back
      expect(planQueueEviction({ needSlot: true, incomingMB: 256, budgetMB: 500 })).toEqual({
        ok: false,
        reason: 'memory-budget',
        ids: [],
      });

      finishRunningEncode(0);
      await flushJobs();
      expect(getClipMemoryEstimateMB()).toBe(0);
      expect(planQueueEviction({ needSlot: true, incomingMB: 256, budgetMB: 500 }).ok).toBe(true);
    });

    it('does not remove a running encode for memory it cannot give back', async () => {
      updateSetting('capture', 'clipQueueLimit', 10);
      await registerRealCodecOnFakeWorker();
      const running = enqueueSized(100);
      const queued = enqueueSized(1);
      expect(running.status).toBe('compressing');

      // Over by 50 MB: the running encode frees nothing now and the rest
      // cannot cover it, so nothing is planned and the clip is refused
      expect(planQueueEviction({ needSlot: false, incomingMB: 50, budgetMB: 100 })).toEqual({
        ok: false,
        reason: 'memory-budget',
        ids: [],
      });
      expect(getClipQueue().map((e) => e.id)).toEqual([queued.id, running.id]);
    });
  });

  it('skips an entry that started decoding after the plan was made', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const entry = enqueueSized();
    codec.encodeCalls[0].resolve(okEncodeResult());
    await flushJobs();
    const { ids } = planQueueEviction({ needSlot: true, incomingMB: 1, budgetMB: 1 });
    expect(ids).toEqual([entry.id]);
    void prepareQueuedClipForPromote(entry.id);

    expect(evictQueuedClips([entry.id])).toEqual([]);
    expect(getClipQueue()).toHaveLength(1);
  });
});
