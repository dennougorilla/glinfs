import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Thumbnails record the requested format instead of drawing (jsdom has no
// 2D canvas), so the PNG-for-alpha rule is observable
vi.mock('../../../src/shared/utils/canvas.js', () => ({
  createFrameThumbnailDataUrl: vi.fn(
    (_frame, _maxDimension, mimeType = 'image/jpeg') => `thumb:${mimeType}`,
  ),
}));

import {
  compressQueuedClip,
  deleteActiveClip,
  deleteQueuedClip,
  enqueueClip,
  getClipMemoryEstimateMB,
  getClipPayload,
  getClipQueue,
  getThumbnailMimeType,
  prepareQueuedClipForPromote,
  promoteQueuedClip,
  registerClipCodec,
  resetAppStore,
  setClipPayload,
  undoDelete,
} from '../../../src/shared/app-store.js';

/**
 * Import-related app-store behavior: hasAlpha/sourceName travel with a clip
 * through every ownership move, alpha clips are never codec-compressed and
 * get PNG thumbnails, saved editor state carries edits, and shared-pixel
 * frames (sharedKey) count once in the memory estimate.
 */

function createMockFrame(id, { width = 100, height = 100, sharedKey } = {}) {
  const videoFrame = { closed: false, codedWidth: width, codedHeight: height };
  videoFrame.close = vi.fn(() => {
    videoFrame.closed = true;
  });
  /** @type {any} */
  const frame = { id, frame: videoFrame, timestamp: 0, width, height };
  if (sharedKey !== undefined) frame.sharedKey = sharedKey;
  return frame;
}

function createFrames(prefix, count = 3, options = {}) {
  return Array.from({ length: count }, (_, i) => createMockFrame(`${prefix}-${i}`, options));
}

function alphaPayload(frames = createFrames('alpha')) {
  return { frames, fps: 10, capturedAt: 1, hasAlpha: true, sourceName: 'cat.gif' };
}

function capturePayload(frames = createFrames('cap')) {
  return { frames, fps: 30, capturedAt: 2 };
}

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

describe('hasAlpha / sourceName travel with the clip', () => {
  it('enqueueClip copies both onto the entry (defaults for captures)', () => {
    const alpha = enqueueClip(alphaPayload());
    expect(alpha.entry).toMatchObject({ hasAlpha: true, sourceName: 'cat.gif', fps: 10 });

    const capture = enqueueClip(capturePayload());
    expect(capture.entry).toMatchObject({ hasAlpha: false, sourceName: null });
  });

  it('a demote (setClipPayload with a new clip) keeps them on the queued entry', () => {
    setClipPayload(alphaPayload());
    setClipPayload(capturePayload());

    const [demoted] = getClipQueue();
    expect(demoted).toMatchObject({ hasAlpha: true, sourceName: 'cat.gif' });
    expect(getClipPayload()?.hasAlpha).toBeUndefined();
  });

  it('promote exposes them on the new active payload, and the swap keeps both sides', () => {
    setClipPayload(alphaPayload());
    setClipPayload(capturePayload());
    const [queued] = getClipQueue();

    const result = promoteQueuedClip(queued.id, null);

    expect(result?.payload).toMatchObject({ hasAlpha: true, sourceName: 'cat.gif', fps: 10 });
    expect(getClipQueue()[0]).toMatchObject({ hasAlpha: false, sourceName: null });

    // Round trip back: the alpha clip is demoted again with its flag intact
    promoteQueuedClip(getClipQueue()[0].id, null);
    expect(getClipQueue()[0]).toMatchObject({ hasAlpha: true, sourceName: 'cat.gif' });
  });

  it('survives delete-active + undo', () => {
    setClipPayload(alphaPayload());
    deleteActiveClip();
    expect(undoDelete()).toBe(true);

    expect(getClipQueue()[0]).toMatchObject({ hasAlpha: true, sourceName: 'cat.gif' });
  });

  it('survives delete-queued + undo', () => {
    const { entry } = enqueueClip(alphaPayload());
    deleteQueuedClip(entry.id);
    expect(getClipQueue()).toHaveLength(0);
    undoDelete();

    expect(getClipQueue()[0]).toMatchObject({ hasAlpha: true, sourceName: 'cat.gif' });
  });
});

describe('alpha clips are never codec-compressed', () => {
  it('enqueue leaves an alpha entry raw while a capture entry compresses', () => {
    const codec = createMockCodec();
    registerClipCodec(codec);

    const alpha = enqueueClip(alphaPayload());
    const capture = enqueueClip(capturePayload());

    expect(alpha.entry.status).toBe('raw');
    expect(capture.entry.status).toBe('compressing');
    expect(codec.encode).toHaveBeenCalledTimes(1);
    expect(alpha.entry.frames.every((f) => !f.frame.closed)).toBe(true);
  });

  it('demote and compressQueuedClip leave an alpha entry raw', () => {
    const codec = createMockCodec();
    registerClipCodec(codec);

    setClipPayload(alphaPayload());
    setClipPayload(capturePayload());
    const [demoted] = getClipQueue();
    expect(demoted.status).toBe('raw');

    compressQueuedClip(demoted.id);
    expect(demoted.status).toBe('raw');
    expect(codec.encode).not.toHaveBeenCalled();
  });

  it('an alpha entry promotes immediately (no decode needed)', async () => {
    registerClipCodec(createMockCodec());
    const { entry } = enqueueClip(alphaPayload());

    await expect(prepareQueuedClipForPromote(entry.id)).resolves.toEqual({ ok: true });
  });
});

describe('queue thumbnails', () => {
  it('getThumbnailMimeType picks PNG only for alpha clips', () => {
    expect(getThumbnailMimeType({ hasAlpha: true })).toBe('image/png');
    expect(getThumbnailMimeType({ hasAlpha: false })).toBe('image/jpeg');
    expect(getThumbnailMimeType({})).toBe('image/jpeg');
  });

  it('alpha clips render PNG thumbnails and preview frames; captures stay JPEG', () => {
    const alpha = enqueueClip(alphaPayload());
    const capture = enqueueClip(capturePayload());

    expect(alpha.entry.thumbnailDataUrl).toBe('thumb:image/png');
    expect(alpha.entry.previewFrames?.every((url) => url === 'thumb:image/png')).toBe(true);
    expect(capture.entry.thumbnailDataUrl).toBe('thumb:image/jpeg');
    expect(capture.entry.previewFrames?.every((url) => url === 'thumb:image/jpeg')).toBe(true);
  });
});

describe('saved editor state carries edits', () => {
  const baseState = {
    selectedRange: { start: 1, end: 2 },
    cropArea: null,
    playbackSpeed: 1,
    currentFrame: 1,
  };

  it('promote copies edits from the demoted editor state', () => {
    const edits = { textLayers: [{ id: 't1', text: 'hi' }], background: { enabled: true } };
    setClipPayload(capturePayload());
    const { entry } = enqueueClip(alphaPayload());

    promoteQueuedClip(entry.id, { ...baseState, edits, scenes: [] });

    expect(getClipQueue()[0].savedEditorState).toEqual({ ...baseState, edits });
  });

  it('omits the edits key when the editor state has none', () => {
    setClipPayload(capturePayload());
    const { entry } = enqueueClip(alphaPayload());

    promoteQueuedClip(entry.id, baseState);

    expect(getClipQueue()[0].savedEditorState).toStrictEqual(baseState);
  });
});

describe('sharedKey memory accounting', () => {
  it('counts each shared key once for the active clip and the queue', () => {
    // 100x100x4 = 40,000 bytes per unique frame
    const unit = (100 * 100 * 4) / (1024 * 1024);
    const shared = [
      createMockFrame('a0', { sharedKey: 'src-a' }),
      createMockFrame('a1', { sharedKey: 'src-a' }),
      createMockFrame('a2', { sharedKey: 'src-a' }),
      createMockFrame('b0', { sharedKey: 'src-b' }),
    ];
    setClipPayload({ ...alphaPayload(shared) });
    enqueueClip(capturePayload(createFrames('q', 3)));

    expect(getClipMemoryEstimateMB()).toBeCloseTo(unit * (2 + 3), 10);
  });

  it('a recoverable encode failure restores sharedKey on the returned frames', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const frames = [
      createMockFrame('s0', { sharedKey: 'k' }),
      createMockFrame('s1', { sharedKey: 'k' }),
    ];
    const { entry } = enqueueClip({ frames, fps: 10, capturedAt: 1, sourceName: 'x.gif' });
    expect(entry.status).toBe('compressing');

    const [call] = codec.encodeCalls;
    call.resolve({ ok: false, frames: call.frames, error: 'boom' });
    await flushJobs();

    expect(entry.status).toBe('raw');
    expect(entry.frames.map((f) => f.sharedKey)).toEqual(['k', 'k']);
  });

  it('a decode round trip drops sharedKey (decoded frames no longer share pixels)', async () => {
    const codec = createMockCodec();
    registerClipCodec(codec);
    const frames = [
      createMockFrame('s0', { sharedKey: 'k' }),
      createMockFrame('s1', { sharedKey: 'k' }),
    ];
    const { entry } = enqueueClip({ frames, fps: 10, capturedAt: 1 });
    codec.encodeCalls[0].resolve({
      ok: true,
      chunks: [],
      config: { codec: 'vp8', codedWidth: 100, codedHeight: 100 },
      byteLength: 10,
    });
    await flushJobs();
    expect(entry.status).toBe('compressed');
    expect(entry.compressed.frameMeta.map((m) => m.sharedKey)).toEqual(['k', 'k']);

    const pending = prepareQueuedClipForPromote(entry.id);
    const decoded = [0, 1].map(() => ({ closed: false, close: vi.fn() }));
    codec.decodeCalls[0].resolve({ ok: true, frames: decoded });
    await expect(pending).resolves.toEqual({ ok: true });

    expect(entry.frames.map((f) => f.id)).toEqual(['s0', 's1']);
    expect(entry.frames.every((f) => f.sharedKey === undefined)).toBe(true);
  });
});
