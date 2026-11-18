import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteQueuedClip,
  enqueueClip,
  estimateQueuedClipMB,
  getClipMemoryEstimateMB,
  getClipPayload,
  getClipQueue,
  getHeldMemoryMB,
  planQueueEviction,
  prepareQueuedClipForPromote,
  promoteQueuedClip,
  registerClipCodec,
  registerMemoryHolder,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { updateSetting } from '../../../src/shared/user-settings.js';
import { BYTES_PER_MB, formatMemory } from '../../../src/shared/utils/memory-monitor.js';

/**
 * The memory budget counts what is held (spec-memory-accounting PR A):
 * - one unit: MB = 1,000,000 bytes, shown and compared alike;
 * - a decoded (opened) clip at its real allocation (I420 / NV12, 1.5 B/px);
 * - a clip headed for the queue at its compressed size when it will compress;
 * - the other holders (capture ring buffer, masks) in the total;
 * - opening a queued clip is checked: older clips go first, refused only
 *   when that cannot make room.
 */

const W = 1920;
const H = 1080;

/** RGBA frames like Create Clip / Clip Now make (texture-backed, 4 B/px) */
function rgbaFrames(count, tag = 'f', width = W, height = H) {
  return Array.from({ length: count }, (_, i) => {
    const vf = { closed: false, timestamp: i, codedWidth: width, codedHeight: height };
    vf.close = vi.fn(() => {
      vf.closed = true;
    });
    return { id: `${tag}${i}`, frame: vf, timestamp: i, width, height };
  });
}

/** What the codec worker hands back: CPU I420 frames (1.5 B/px) */
function decodedFrames(count, width = W, height = H) {
  return Array.from({ length: count }, (_, i) => {
    const vf = {
      closed: false,
      timestamp: i,
      codedWidth: width,
      codedHeight: height,
      format: 'I420',
      allocationSize: () => width * height * 1.5,
    };
    vf.close = vi.fn(() => {
      vf.closed = true;
    });
    return vf;
  });
}

function createMockCodec() {
  /** @type {{frames: any[], options: any, resolve: (r: any) => void}[]} */
  const encodeCalls = [];
  /** @type {{compressed: any, resolve: (r: any) => void}[]} */
  const decodeCalls = [];
  return {
    isCompressionAvailable: () => true,
    encode: vi.fn(
      (frames, options) =>
        new Promise((resolve) => {
          encodeCalls.push({ frames, options, resolve });
        }),
    ),
    decode: vi.fn(
      (compressed) =>
        new Promise((resolve) => {
          decodeCalls.push({ compressed, resolve });
        }),
    ),
    isEncodeQueued: () => false,
    cancelEncode: () => false,
    encodeCalls,
    decodeCalls,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Settle the newest encode with `bytes` of chunks */
async function finishEncode(codec, index, bytes = 10 * BYTES_PER_MB) {
  codec.encodeCalls[index].resolve({
    ok: true,
    chunks: [],
    config: { codec: 'vp8', codedWidth: W, codedHeight: H },
    byteLength: bytes,
  });
  await flush();
}

/** @type {Array<() => void>} */
let unregister = [];

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
});

afterEach(() => {
  registerClipCodec(null);
  for (const off of unregister) off();
  unregister = [];
});

describe('one unit (MB = 1,000,000 bytes)', () => {
  it('counts frames in decimal MB', () => {
    setClipPayload({ frames: rgbaFrames(10), fps: 30, capturedAt: 0 });
    expect(getClipMemoryEstimateMB()).toBeCloseTo((10 * W * H * 4) / 1_000_000, 6);
  });

  it('formats the budget the way Settings does: 4000 MB is 4.0 GB', () => {
    expect(BYTES_PER_MB).toBe(1_000_000);
    expect(formatMemory(4000)).toBe('4.0 GB');
    expect(formatMemory(2488.3)).toBe('2.5 GB');
    expect(formatMemory(250)).toBe('250 MB');
  });
});

describe('a decoded clip counts at its real allocation', () => {
  it('counts an opened clip at 1.5 bytes per pixel, not 4', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    enqueueClip({ frames: rgbaFrames(30, 'q'), fps: 30, capturedAt: 1 });
    await finishEncode(codec, 0);
    const [entry] = getClipQueue();

    const prepared = prepareQueuedClipForPromote(entry.id);
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(30) });
    expect((await prepared).ok).toBe(true);
    promoteQueuedClip(entry.id, null);

    expect(getClipMemoryEstimateMB()).toBeCloseTo((30 * W * H * 1.5) / BYTES_PER_MB, 6);
  });

  it('counts a clip while it decodes at the size it is decoding to', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    enqueueClip({ frames: rgbaFrames(30, 'q'), fps: 30, capturedAt: 1 });
    await finishEncode(codec, 0, 2 * BYTES_PER_MB);
    const [entry] = getClipQueue();

    const prepared = prepareQueuedClipForPromote(entry.id);
    // The worker holds the decoded frames until the decode ends
    expect(getClipMemoryEstimateMB()).toBeCloseTo(2 + (30 * W * H * 1.5) / BYTES_PER_MB, 6);
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(30) });
    await prepared;
  });
});

describe('a clip headed for the queue counts compressed', () => {
  it('estimates the compressed size from the bitrate the codec worker uses', () => {
    registerClipCodec(createMockCodec());
    // min(20 Mb/s, 1920*1080*30*0.15 = 9.33 Mb/s) for 300 frames at 30 fps = 10 s
    const bytes = ((1920 * 1080 * 30 * 0.15) / 8) * 10;
    expect(estimateQueuedClipMB({ frames: rgbaFrames(300), fps: 30 })).toBeCloseTo(
      bytes / BYTES_PER_MB,
      3,
    );
  });

  it('counts raw when nothing will compress it (no codec, or an alpha clip)', () => {
    const rawMB = (300 * W * H * 4) / BYTES_PER_MB;
    expect(estimateQueuedClipMB({ frames: rgbaFrames(300), fps: 30 })).toBeCloseTo(rawMB, 6);
    registerClipCodec(createMockCodec());
    expect(estimateQueuedClipMB({ frames: rgbaFrames(300), fps: 30, hasAlpha: true })).toBeCloseTo(
      rawMB,
      6,
    );
  });
});

describe('the total counts the other holders', () => {
  it('adds the capture ring buffer and the masks to the clips', () => {
    setClipPayload({ frames: rgbaFrames(10), fps: 30, capturedAt: 0 });
    unregister.push(registerMemoryHolder('capture-buffer', () => 1200));
    unregister.push(registerMemoryHolder('masks', () => 30));

    expect(getHeldMemoryMB()).toBeCloseTo(getClipMemoryEstimateMB() + 1230, 6);
  });

  it('can leave a holder out, and stops counting one that unregistered', () => {
    unregister.push(registerMemoryHolder('capture-buffer', () => 1200));
    const offMasks = registerMemoryHolder('masks', () => 30);

    expect(getHeldMemoryMB({ without: ['capture-buffer'] })).toBeCloseTo(30, 6);
    offMasks();
    expect(getHeldMemoryMB()).toBeCloseTo(1200, 6);
  });
});

describe('removing a clip frees its masks too (#230 review P2)', () => {
  it('counts the masks a queued clip takes with it when planning removals', () => {
    // Raw queue (no codec): two clips of ~99.5 MB, the older one with
    // 300 MB of masks
    enqueueClip({ frames: rgbaFrames(12, 'o'), fps: 30, capturedAt: 1 });
    enqueueClip({ frames: rgbaFrames(12, 'n'), fps: 30, capturedAt: 2 });
    const [newer, older] = getClipQueue();
    unregister.push(
      registerMemoryHolder('masks', () => 300, {
        forClip: (clipId) => (clipId === older.id ? 300 : 0),
      }),
    );

    // Held ~499; a 700 MB clip needs ~199 freed: the older clip and its
    // masks free ~399, so the newer one stays
    const plan = planQueueEviction({ needSlot: false, incomingMB: 700, budgetMB: 1000 });

    expect(plan).toMatchObject({ ok: true, ids: [older.id] });
    expect(plan.ids).not.toContain(newer.id);
  });
});

describe('opening a queued clip is checked against the budget', () => {
  /** A compressed queued clip of `count` 1080p frames, captured at `at` */
  async function compressedEntry(codec, count, at) {
    enqueueClip({ frames: rgbaFrames(count, `c${at}-`), fps: 30, capturedAt: at });
    await finishEncode(codec, codec.encodeCalls.length - 1);
    return getClipQueue().find((entry) => entry.capturedAt === at);
  }

  it('opens without removing anything when the decoded clip fits', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'memoryBudgetMB', 4000);
    const entry = await compressedEntry(codec, 300, 1);
    unregister.push(registerMemoryHolder('capture-buffer', () => 2400));

    const prepared = prepareQueuedClipForPromote(entry.id);
    expect(codec.decode).toHaveBeenCalledOnce();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(300) });
    expect(await prepared).toEqual({ ok: true, removed: [] });
  });

  it.each([
    ['the decode fails', 'decode-failed', { ok: false, error: 'boom' }],
    ['the clip is deleted while it decodes', 'not-found', 'delete'],
  ])('reports the clips it removed when %s (#230 review P2)', async (_label, reason, outcome) => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'memoryBudgetMB', 4000);
    const entry = await compressedEntry(codec, 300, 5);
    enqueueClip({ frames: rgbaFrames(100, 'alpha'), fps: 30, capturedAt: 1, hasAlpha: true });
    const raw = getClipQueue().find((e) => e.capturedAt === 1);
    unregister.push(registerMemoryHolder('capture-buffer', () => 2400));

    const prepared = prepareQueuedClipForPromote(entry.id);
    expect(raw.frames).toBeNull();
    if (outcome === 'delete') {
      deleteQueuedClip(entry.id);
      codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(300) });
    } else {
      codec.decodeCalls[0].resolve(outcome);
    }
    const result = await prepared;

    expect(result).toMatchObject({ ok: false, reason });
    expect(/** @type {any} */ (result).removed.map((e) => e.id)).toEqual([raw.id]);
  });

  it('removes older queued clips first when that makes room', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'memoryBudgetMB', 4000);
    const entry = await compressedEntry(codec, 300, 5);
    // An alpha clip stays raw in the queue: 100 x 1080p RGBA = 829 MB
    enqueueClip({ frames: rgbaFrames(100, 'alpha'), fps: 30, capturedAt: 1, hasAlpha: true });
    const raw = getClipQueue().find((e) => e.capturedAt === 1);
    // Buffer 2400 + raw 829 + decoded 933 = 4162 > 4000; without the raw one it fits
    unregister.push(registerMemoryHolder('capture-buffer', () => 2400));

    const prepared = prepareQueuedClipForPromote(entry.id);
    expect(getClipQueue().map((e) => e.id)).toEqual([entry.id]);
    expect(raw.frames).toBeNull();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(300) });
    const result = await prepared;
    expect(result.ok).toBe(true);
    expect(result.removed.map((e) => e.id)).toEqual([raw.id]);
  });

  it('refuses before decoding, removing nothing, when even that cannot make room', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'memoryBudgetMB', 3000);
    const entry = await compressedEntry(codec, 300, 5);
    enqueueClip({ frames: rgbaFrames(10, 'alpha'), fps: 30, capturedAt: 1, hasAlpha: true });
    unregister.push(registerMemoryHolder('capture-buffer', () => 2400));

    const result = await prepareQueuedClipForPromote(entry.id);

    expect(result).toEqual({
      ok: false,
      reason: 'memory-budget',
      projection: expect.objectContaining({ over: true, budgetMB: 3000 }),
    });
    expect(codec.decode).not.toHaveBeenCalled();
    expect(getClipQueue()).toHaveLength(2);
    expect(getClipQueue().find((e) => e.id === entry.id)?.status).toBe('compressed');
  });

  it('removes nothing with automatic removal off: a plain refusal', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'memoryBudgetMB', 4000);
    updateSetting('capture', 'autoRemoveOldClips', false);
    const entry = await compressedEntry(codec, 300, 5);
    enqueueClip({ frames: rgbaFrames(100, 'alpha'), fps: 30, capturedAt: 1, hasAlpha: true });
    unregister.push(registerMemoryHolder('capture-buffer', () => 2400));

    const result = await prepareQueuedClipForPromote(entry.id);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('memory-budget');
    expect(getClipQueue()).toHaveLength(2);
  });

  it('counts the active clip as it will be once queued (compressed)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    updateSetting('capture', 'memoryBudgetMB', 4000);
    const entry = await compressedEntry(codec, 300, 5);
    // Active: 300 x 1080p RGBA = 2488 MB, demotes and compresses on open
    setClipPayload({ frames: rgbaFrames(300, 'act'), fps: 30, capturedAt: 9 });
    unregister.push(registerMemoryHolder('capture-buffer', () => 2400));

    const prepared = prepareQueuedClipForPromote(entry.id);
    expect(codec.decode).toHaveBeenCalledOnce();
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames(300) });
    expect((await prepared).ok).toBe(true);
    expect(getClipPayload()?.capturedAt).toBe(9);
  });
});
