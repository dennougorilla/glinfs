import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteQueuedClip,
  enqueueClip,
  getClipMemoryEstimateMB,
  getClipPayload,
  getClipQueue,
  isClipCompressionAvailable,
  prepareQueuedClipForPromote,
  promoteQueuedClip,
  registerClipCodec,
  releaseAllFramesAndReset,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import { updateSetting } from '../../../src/shared/user-settings.js';

/**
 * Tests for #92: the WebCodecs-compressed clip queue entry lifecycle.
 *
 * The codec is exercised through the registerClipCodec seam with a manually
 * resolved mock (jsdom has no WebCodecs), covering:
 * - raw -> compressing -> compressed (frames handed to the codec, then
 *   replaced by chunk accounting)
 * - encode failure -> back to raw with the returned frames, clip never lost
 * - no codec / unavailable codec -> entries stay raw exactly as before
 * - delete during compress/decode -> stale results are discarded/closed
 * - promote of a compressed entry: prepare decodes (decoding status,
 *   double-promote refused), then the normal sync promote works
 * - accounting switches from raw w*h*4 to actual compressed byteLength
 * - refusal semantics (queue-full) still decided before compression starts
 */

/**
 * Mock VideoFrame-wrapping Frame, matching the shape app-store expects.
 * close() flips .closed like a real VideoFrame, so double-close guards
 * (closeVideoFrames vs closeFrameList) are actually exercised.
 */
function createMockFrame(id = '1') {
  const videoFrame = { closed: false, timestamp: Number(id), codedWidth: 100, codedHeight: 100 };
  videoFrame.close = vi.fn(() => {
    videoFrame.closed = true;
  });
  return {
    id,
    frame: videoFrame,
    timestamp: Number(id),
    width: 100,
    height: 100,
  };
}

function createMockFrames(count = 3) {
  return Array.from({ length: count }, (_, i) => createMockFrame(String(i)));
}

function clipPayloadOf(frames, fps = 30) {
  return { frames, fps, capturedAt: Date.now() };
}

/**
 * Controllable mock codec: encode/decode return promises the test resolves
 * by hand, so every interleaving (delete-during-compress etc.) is scriptable.
 */
function createMockCodec({ available = true } = {}) {
  /** @type {{frames: any[], options: any, resolve: (r: any) => void}[]} */
  const encodeCalls = [];
  /** @type {{compressed: any, resolve: (r: any) => void}[]} */
  const decodeCalls = [];
  return {
    isCompressionAvailable: () => available,
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
    encodeCalls,
    decodeCalls,
  };
}

function okEncodeResult(byteLength = 2 * 1024 * 1024) {
  return {
    ok: true,
    chunks: [{ type: 'key', timestamp: 0, duration: null, data: new ArrayBuffer(16) }],
    config: { codec: 'vp8', codedWidth: 100, codedHeight: 100 },
    byteLength,
  };
}

/** Let the settled codec promise's .then handlers in app-store run */
async function flushJobs() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
});

afterEach(() => {
  registerClipCodec(null);
  vi.clearAllMocks();
});

describe('isClipCompressionAvailable', () => {
  it('reflects the registered codec (false with none registered)', () => {
    expect(isClipCompressionAvailable()).toBe(false);
    registerClipCodec(createMockCodec({ available: false }));
    expect(isClipCompressionAvailable()).toBe(false);
    registerClipCodec(createMockCodec());
    expect(isClipCompressionAvailable()).toBe(true);
  });
});

describe('enqueue with codec available', () => {
  it('enters the queue as compressing, then becomes compressed with byte accounting', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const frames = createMockFrames(2);

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload.type));

    const result = enqueueClip(clipPayloadOf(frames));

    expect(result.ok).toBe(true);
    expect(result.entry.status).toBe('compressing');
    expect(result.entry.frameCount).toBe(2);
    // The VideoFrames (not the wrappers) were handed to the codec
    expect(codec.encodeCalls[0].frames).toEqual(frames.map((f) => f.frame));
    expect(codec.encodeCalls[0].options).toEqual({ fps: 30, width: 100, height: 100 });
    // While compressing, accounting stays conservative raw RGBA
    expect(getClipMemoryEstimateMB()).toBeCloseTo((2 * 100 * 100 * 4) / (1024 * 1024), 6);

    codec.encodeCalls[0].resolve(okEncodeResult(2 * 1024 * 1024));
    await flushJobs();

    const entry = getClipQueue()[0];
    expect(entry.status).toBe('compressed');
    expect(entry.frames).toBeNull();
    expect(entry.byteLengthMB).toBeCloseTo(2, 6);
    expect(entry.compressed.byteLength).toBe(2 * 1024 * 1024);
    // Accounting switched to the actual compressed size
    expect(getClipMemoryEstimateMB()).toBeCloseTo(2, 6);
    expect(events).toEqual(['enqueue', 'compress']);

    unsubscribe();
  });

  it('stays raw when the codec reports unavailable (graceful fallback)', () => {
    const codec = createMockCodec({ available: false });
    registerClipCodec(codec);

    const result = enqueueClip(clipPayloadOf(createMockFrames(2)));

    expect(result.entry.status).toBe('raw');
    expect(codec.encode).not.toHaveBeenCalled();
  });

  it('checks the queue-full refusal BEFORE any compression starts', () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    // Limit 1: first clip fills the queue
    updateSetting('capture', 'clipQueueLimit', 1);
    enqueueClip(clipPayloadOf(createMockFrames(1)));
    codec.encode.mockClear();

    const refusedFrames = createMockFrames(1);
    const result = enqueueClip(clipPayloadOf(refusedFrames));

    expect(result).toEqual({ ok: false, reason: 'queue-full', limit: 1 });
    expect(codec.encode).not.toHaveBeenCalled();
    for (const f of refusedFrames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }
  });
});

describe('encode failure', () => {
  it('returns the entry to raw with the frames the worker sent back — clip never lost', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const frames = createMockFrames(3);
    const { entry } = enqueueClip(clipPayloadOf(frames));

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload.type));

    codec.encodeCalls[0].resolve({
      ok: false,
      error: 'encoder exploded',
      frames: codec.encodeCalls[0].frames,
    });
    await flushJobs();

    expect(entry.status).toBe('raw');
    expect(entry.frames).toHaveLength(3);
    // Wrapper identity metadata was restored around the same VideoFrames
    expect(entry.frames.map((f) => f.frame)).toEqual(frames.map((f) => f.frame));
    expect(entry.frames.map((f) => f.id)).toEqual(['0', '1', '2']);
    expect(entry.compressed).toBeNull();
    // Raw accounting again
    expect(getClipMemoryEstimateMB()).toBeCloseTo((3 * 100 * 100 * 4) / (1024 * 1024), 6);
    expect(events).toEqual(['compress-error']);
    // Nothing was closed on the failure path
    for (const f of frames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }

    unsubscribe();
  });
});

describe('delete during compress', () => {
  it('discards a late success result without resurrecting the entry', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(2)));

    expect(deleteQueuedClip(entry.id)).toBe(true);
    expect(getClipQueue()).toHaveLength(0);

    codec.encodeCalls[0].resolve(okEncodeResult());
    await flushJobs();

    expect(getClipQueue()).toHaveLength(0);
    expect(getClipMemoryEstimateMB()).toBe(0);
  });

  it('closes returned frames when the encode fails after the delete', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(2)));
    deleteQueuedClip(entry.id);

    const returned = codec.encodeCalls[0].frames;
    codec.encodeCalls[0].resolve({ ok: false, error: 'boom', frames: returned });
    await flushJobs();

    for (const vf of returned) {
      expect(vf.close).toHaveBeenCalledOnce();
    }
    expect(getClipQueue()).toHaveLength(0);
  });
});

describe('promote of a compressed entry (prepare + decode)', () => {
  /** Enqueue one clip and drive it to 'compressed' */
  async function enqueueCompressed(codec, frameCount = 2) {
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(frameCount)));
    codec.encodeCalls[codec.encodeCalls.length - 1].resolve(okEncodeResult());
    await flushJobs();
    expect(entry.status).toBe('compressed');
    return entry;
  }

  it('promoteQueuedClip alone REFUSES a compressed entry (no silent black frames)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const entry = await enqueueCompressed(codec);

    expect(promoteQueuedClip(entry.id, null)).toBeNull();
    expect(getClipQueue()).toHaveLength(1);
    expect(getClipPayload()).toBeNull();
  });

  it('prepare decodes (visible decoding state), then the sync promote works', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const entry = await enqueueCompressed(codec, 2);

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload.type));

    const preparePromise = prepareQueuedClipForPromote(entry.id);
    expect(entry.status).toBe('decoding');
    // Decoding entries keep byte accounting (frames are still in the worker)
    expect(getClipMemoryEstimateMB()).toBeCloseTo(2, 6);

    const decodedFrames = [
      { close: vi.fn(), closed: false, timestamp: 0, codedWidth: 100, codedHeight: 100 },
      { close: vi.fn(), closed: false, timestamp: 1, codedWidth: 100, codedHeight: 100 },
    ];
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames });

    const prep = await preparePromise;
    expect(prep).toEqual({ ok: true });
    expect(entry.status).toBe('raw');
    expect(entry.frames.map((f) => f.frame)).toEqual(decodedFrames);
    // Original wrapper ids survived the round-trip via frameMeta
    expect(entry.frames.map((f) => f.id)).toEqual(['0', '1']);
    expect(entry.compressed).toBeNull();
    expect(events).toEqual(['decode-start', 'decode']);

    const result = promoteQueuedClip(entry.id, null);
    expect(result).not.toBeNull();
    expect(getClipPayload()?.frames).toBe(entry.frames);
    expect(getClipQueue()).toHaveLength(0);

    unsubscribe();
  });

  it('refuses a double-promote while the entry is decoding', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const entry = await enqueueCompressed(codec);

    const first = prepareQueuedClipForPromote(entry.id);
    const second = await prepareQueuedClipForPromote(entry.id);
    expect(second).toEqual({ ok: false, reason: 'decoding' });

    codec.decodeCalls[0].resolve({
      ok: true,
      frames: [{ close: vi.fn(), closed: false, timestamp: 0 }],
    });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('returns the entry to compressed when the decode fails (chunks intact)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const entry = await enqueueCompressed(codec);
    const chunksBefore = entry.compressed.chunks;

    const preparePromise = prepareQueuedClipForPromote(entry.id);
    codec.decodeCalls[0].resolve({ ok: false, error: 'bad bitstream' });

    await expect(preparePromise).resolves.toEqual({ ok: false, reason: 'decode-failed' });
    expect(entry.status).toBe('compressed');
    expect(entry.compressed.chunks).toBe(chunksBefore);
  });

  it('closes decoded frames when the entry was deleted mid-decode', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const entry = await enqueueCompressed(codec);

    const preparePromise = prepareQueuedClipForPromote(entry.id);
    deleteQueuedClip(entry.id);

    const decodedFrames = [{ close: vi.fn(), closed: false, timestamp: 0 }];
    codec.decodeCalls[0].resolve({ ok: true, frames: decodedFrames });

    await expect(preparePromise).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(decodedFrames[0].close).toHaveBeenCalledOnce();
  });

  it('awaits an in-flight encode when promoting a still-compressing entry', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(1)));
    expect(entry.status).toBe('compressing');

    const preparePromise = prepareQueuedClipForPromote(entry.id);
    // Encode finishes first...
    codec.encodeCalls[0].resolve(okEncodeResult());
    await flushJobs();
    // ...then prepare proceeds into the decode
    await vi.waitFor(() => {
      expect(codec.decodeCalls).toHaveLength(1);
    });
    expect(entry.status).toBe('decoding');
    codec.decodeCalls[0].resolve({
      ok: true,
      frames: [{ close: vi.fn(), closed: false, timestamp: 0 }],
    });
    await expect(preparePromise).resolves.toEqual({ ok: true });
  });

  it('prepare on a raw entry resolves ok immediately (no codec round-trip)', async () => {
    registerClipCodec(createMockCodec({ available: false }));
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(1)));
    await expect(prepareQueuedClipForPromote(entry.id)).resolves.toEqual({ ok: true });
  });
});

describe('demote paths schedule compression', () => {
  it('compresses the clip demoted by setClipPayload', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    setClipPayload(clipPayloadOf(createMockFrames(1)));
    expect(codec.encode).not.toHaveBeenCalled(); // active clip stays raw

    setClipPayload(clipPayloadOf(createMockFrames(1)));

    const demoted = getClipQueue()[0];
    expect(demoted.status).toBe('compressing');
    expect(codec.encode).toHaveBeenCalledTimes(1);
  });

  it('compresses the clip demoted by promoteQueuedClip and never the promoted one', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    setClipPayload(clipPayloadOf(createMockFrames(1)));
    const { entry } = enqueueClip(clipPayloadOf(createMockFrames(1)));
    // Make the queued entry raw-promotable by failing its encode
    codec.encodeCalls[0].resolve({
      ok: false,
      error: 'nope',
      frames: codec.encodeCalls[0].frames,
    });
    await flushJobs();
    expect(entry.status).toBe('raw');
    codec.encode.mockClear();

    const result = promoteQueuedClip(entry.id, null);

    expect(result).not.toBeNull();
    const demoted = getClipQueue()[0];
    expect(demoted.status).toBe('compressing');
    expect(codec.encode).toHaveBeenCalledTimes(1);
    // The promoted clip's frames went to the active payload, not the codec
    expect(getClipPayload()?.frames).toBe(entry.frames);
  });
});

describe('reset with in-flight jobs', () => {
  it('releaseAllFramesAndReset discards a late encode result safely', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    enqueueClip(clipPayloadOf(createMockFrames(2)));

    releaseAllFramesAndReset();
    expect(getClipQueue()).toHaveLength(0);

    codec.encodeCalls[0].resolve(okEncodeResult());
    await flushJobs();

    expect(getClipQueue()).toHaveLength(0);
    expect(getClipMemoryEstimateMB()).toBe(0);
  });
});
