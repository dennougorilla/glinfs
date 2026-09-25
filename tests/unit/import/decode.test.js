import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportError } from '../../../src/features/import/core.js';
import { decodeImageFile, frameHasAlpha } from '../../../src/features/import/decode.js';

/**
 * decodeImageFile against a scripted ImageDecoder / VideoFrame mock (jsdom
 * has no WebCodecs). The ownership tests are the point: every VideoFrame the
 * decoder produced or cloned must be closed on every failure path.
 */

/** Every mock VideoFrame created during a test (decoded + clones) */
/** @type {MockVideoFrame[]} */
let allFrames = [];

class MockVideoFrame {
  /**
   * @param {{ width?: number, height?: number, format?: string|null, durationUs?: number|null, alpha?: number }} spec
   */
  constructor(spec) {
    this.spec = spec;
    this.format = spec.format === undefined ? 'RGBA' : spec.format;
    this.displayWidth = spec.width ?? 4;
    this.displayHeight = spec.height ?? 2;
    this.codedWidth = this.displayWidth;
    this.codedHeight = this.displayHeight;
    this.duration = spec.durationUs === undefined ? null : spec.durationUs;
    this.closed = false;
    this.close = vi.fn(() => {
      this.closed = true;
    });
    this.copyTo = vi.fn(async (buffer) => {
      if (this.spec.copyToThrows) throw new Error('cannot convert');
      buffer.fill(0);
      for (let i = 3; i < buffer.length; i += 4) buffer[i] = this.spec.alpha ?? 255;
      return [];
    });
    this.clone = vi.fn(() => {
      if (this.spec.cloneThrowsAfter !== undefined) {
        this.spec.cloneCount = (this.spec.cloneCount ?? 0) + 1;
        if (this.spec.cloneCount > this.spec.cloneThrowsAfter) throw new Error('clone failed');
      }
      return track(new MockVideoFrame({ ...this.spec, clonedFrom: this }));
    });
    allFrames.push(this);
  }

  allocationSize() {
    return this.displayWidth * this.displayHeight * 4;
  }
}

/** @param {MockVideoFrame} frame */
function track(frame) {
  return frame;
}

/**
 * @typedef {Object} DecoderScript
 * @property {Array<ConstructorParameters<typeof MockVideoFrame>[0]>} frames
 * @property {number} [failAt] - decode({frameIndex}) rejects at this index
 * @property {number} [frameCount] - Override the reported frame count
 * @property {boolean} [tracksReject]
 */

/** @type {DecoderScript} */
let script;
/** @type {any[]} */
let decoders = [];

class MockImageDecoder {
  static isTypeSupported = vi.fn(async () => true);

  /** @param {{ data: ArrayBuffer, type: string }} init */
  constructor(init) {
    this.init = init;
    this.close = vi.fn();
    this.decode = vi.fn(async ({ frameIndex }) => {
      if (script.failAt === frameIndex) throw new Error('corrupt frame');
      return { image: new MockVideoFrame(script.frames[frameIndex]), complete: true };
    });
    this.tracks = {
      ready: script.tracksReject ? Promise.reject(new Error('bad header')) : Promise.resolve(),
      selectedTrack: { frameCount: script.frameCount ?? script.frames.length },
    };
    // Avoid an unhandled rejection when the test expects the ready failure
    this.tracks.ready.catch(() => {});
    this.completed = Promise.resolve();
    decoders.push(this);
  }
}

/**
 * @param {string} [name]
 * @param {string} [type]
 */
function fakeFile(name = 'clip.gif', type = 'image/gif') {
  return { name, type, size: 16, arrayBuffer: vi.fn(async () => new ArrayBuffer(16)) };
}

/** @param {number} ms */
const us = (ms) => ms * 1000;

beforeEach(() => {
  allFrames = [];
  decoders = [];
  script = { frames: [] };
  MockImageDecoder.isTypeSupported.mockClear();
  MockImageDecoder.isTypeSupported.mockImplementation(async () => true);
  vi.stubGlobal('ImageDecoder', MockImageDecoder);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** @param {Promise<unknown>} promise */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return /** @type {ImportError} */ (err);
  }
  throw new Error('expected a rejection');
}

describe('decodeImageFile success', () => {
  it('builds constant-fps slots with clones for holds', async () => {
    script.frames = [
      { durationUs: us(100) },
      { durationUs: us(100) },
      { durationUs: us(500), alpha: 0 },
    ];

    const result = await decodeImageFile(fakeFile());

    expect(result).toMatchObject({ fps: 10, width: 4, height: 2, hasAlpha: true });
    expect(result.sourceFrameCount).toBe(3);
    expect(result.frames).toHaveLength(7);

    const keys = result.frames.map((f) => f.sharedKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys.slice(2).every((k) => k === keys[2])).toBe(true);
    // Unique wrapper ids; first slot id equals its sharedKey
    expect(new Set(result.frames.map((f) => f.id)).size).toBe(7);
    expect(result.frames[2].id).toBe(keys[2]);
    // Timestamps in microseconds at the chosen fps
    expect(result.frames.map((f) => f.timestamp)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => i * 100_000),
    );
    // Slots 3..6 are clones of the third decoded frame
    const third = result.frames[2].frame;
    expect(third.clone).toHaveBeenCalledTimes(4);
    for (const slot of result.frames.slice(3)) {
      expect(slot.frame).not.toBe(third);
      expect(/** @type {any} */ (slot.frame).spec.clonedFrom).toBe(third);
    }
    // Nothing closed on success; decoder released
    expect(allFrames.every((f) => !f.closed)).toBe(true);
    expect(decoders[0].close).toHaveBeenCalledTimes(1);
  });

  it('passes the file bytes and type to ImageDecoder', async () => {
    script.frames = [{ durationUs: null }];
    const file = fakeFile('a.gif');
    await decodeImageFile(file);
    expect(file.arrayBuffer).toHaveBeenCalled();
    expect(decoders[0].init.type).toBe('image/gif');
    expect(decoders[0].init.data).toBeInstanceOf(ArrayBuffer);
  });

  it('decodes an APNG with the PNG decoder', async () => {
    script.frames = [{ durationUs: null }];
    await decodeImageFile(fakeFile('a.apng', ''));
    expect(MockImageDecoder.isTypeSupported).toHaveBeenCalledWith('image/png');
    expect(decoders[0].init.type).toBe('image/png');
  });

  it('opens a still image as one frame at 30 fps', async () => {
    script.frames = [{ durationUs: null, format: 'I420' }];
    const result = await decodeImageFile(fakeFile('photo.jpg', 'image/jpeg'));
    expect(result).toMatchObject({ fps: 30, hasAlpha: false, sourceFrameCount: 1 });
    expect(result.frames).toHaveLength(1);
  });

  it('scans source frames only and stops once transparency is found', async () => {
    script.frames = [
      { durationUs: us(200), alpha: 128 },
      { durationUs: us(200) },
      { durationUs: us(200) },
    ];
    const result = await decodeImageFile(fakeFile());
    expect(result.hasAlpha).toBe(true);
    const sources = allFrames.filter((f) => !f.spec.clonedFrom);
    expect(sources[0].copyTo).toHaveBeenCalledTimes(1);
    expect(sources[1].copyTo).not.toHaveBeenCalled();
    expect(sources[2].copyTo).not.toHaveBeenCalled();
  });

  it('reports hasAlpha false for opaque frames and scans each source once', async () => {
    script.frames = [{ durationUs: us(40) }, { durationUs: us(80) }];
    const result = await decodeImageFile(fakeFile());
    expect(result.hasAlpha).toBe(false);
    expect(result.frames).toHaveLength(3);
    const clones = allFrames.filter((f) => f.spec.clonedFrom);
    expect(clones).toHaveLength(1);
    expect(clones[0].copyTo).not.toHaveBeenCalled();
    for (const source of allFrames.filter((f) => !f.spec.clonedFrom)) {
      expect(source.copyTo).toHaveBeenCalledTimes(1);
    }
  });

  it('reports progress per source frame', async () => {
    script.frames = [{ durationUs: us(100) }, { durationUs: us(100) }];
    const onProgress = vi.fn();
    await decodeImageFile(fakeFile(), { onProgress });
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('passes metadata to onMetadata after the first frame', async () => {
    script.frames = [{ durationUs: us(100), width: 64, height: 48 }, { durationUs: us(100) }];
    const onMetadata = vi.fn();
    await decodeImageFile(fakeFile(), { onMetadata });
    expect(onMetadata).toHaveBeenCalledWith({ sourceFrameCount: 2, width: 64, height: 48 });
    expect(decoders[0].decode).toHaveBeenCalledTimes(2);
  });
});

describe('decodeImageFile refusals close everything they created', () => {
  it('refuses an unsupported type without creating a decoder', async () => {
    const error = await rejection(decodeImageFile(fakeFile('a.txt', 'text/plain')));
    expect(error.code).toBe('unsupported-type');
    expect(decoders).toHaveLength(0);
  });

  it('refuses a type the browser cannot decode', async () => {
    MockImageDecoder.isTypeSupported.mockImplementation(async () => false);
    const error = await rejection(decodeImageFile(fakeFile('a.webp', 'image/webp')));
    expect(error.code).toBe('unsupported-type');
    expect(error.message).toContain('image/webp');
    expect(decoders).toHaveLength(0);
  });

  it('explains when ImageDecoder does not exist', async () => {
    vi.stubGlobal('ImageDecoder', undefined);
    const error = await rejection(decodeImageFile(fakeFile()));
    expect(error.code).toBe('decode-failed');
  });

  it('wraps a header parse failure and closes the decoder', async () => {
    script = { frames: [], tracksReject: true };
    const error = await rejection(decodeImageFile(fakeFile('bad.gif')));
    expect(error).toBeInstanceOf(ImportError);
    expect(error.code).toBe('decode-failed');
    expect(error.message).toContain('bad.gif');
    expect(decoders[0].close).toHaveBeenCalled();
  });

  it('a decode failure mid-file closes the frames decoded so far and the decoder', async () => {
    script = {
      frames: [{ durationUs: us(100) }, { durationUs: us(100) }, { durationUs: us(100) }],
      failAt: 2,
    };
    const error = await rejection(decodeImageFile(fakeFile()));
    expect(error.code).toBe('decode-failed');
    expect(allFrames).toHaveLength(2);
    expect(allFrames.every((f) => f.closed)).toBe(true);
    expect(decoders[0].close).toHaveBeenCalled();
  });

  it('an onMetadata refusal closes the first frame and stops decoding', async () => {
    script.frames = [{ durationUs: us(100) }, { durationUs: us(100) }];
    const refusal = new ImportError('memory-budget', 'too big');
    const error = await rejection(
      decodeImageFile(fakeFile(), {
        onMetadata: () => {
          throw refusal;
        },
      }),
    );
    expect(error).toBe(refusal);
    expect(decoders[0].decode).toHaveBeenCalledTimes(1);
    expect(allFrames).toHaveLength(1);
    expect(allFrames[0].closed).toBe(true);
    expect(decoders[0].close).toHaveBeenCalled();
  });

  it('aborting mid-decode closes every decoded frame', async () => {
    script.frames = [{ durationUs: us(100) }, { durationUs: us(100) }, { durationUs: us(100) }];
    const controller = new AbortController();
    const error = await rejection(
      decodeImageFile(fakeFile(), {
        signal: controller.signal,
        onProgress: (decoded) => {
          if (decoded === 2) controller.abort();
        },
      }),
    );
    expect(error.code).toBe('aborted');
    expect(allFrames).toHaveLength(2);
    expect(allFrames.every((f) => f.closed)).toBe(true);
    expect(decoders[0].close).toHaveBeenCalled();
  });

  it('an already-aborted signal refuses before reading the file', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = fakeFile();
    const error = await rejection(decodeImageFile(file, { signal: controller.signal }));
    expect(error.code).toBe('aborted');
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a file with more source frames than the limit before decoding', async () => {
    script = { frames: [], frameCount: 3601 };
    const error = await rejection(decodeImageFile(fakeFile()));
    expect(error.code).toBe('too-many-frames');
    expect(decoders[0].decode).not.toHaveBeenCalled();
    expect(decoders[0].close).toHaveBeenCalled();
  });

  it('refuses when holds expand past the slot limit, closing every source', async () => {
    // gcd 10 cs -> 10 fps; the 400 s hold would need 4000 slots
    script.frames = [{ durationUs: us(100) }, { durationUs: us(400_000) }];
    const error = await rejection(decodeImageFile(fakeFile()));
    expect(error.code).toBe('too-many-frames');
    expect(allFrames).toHaveLength(2);
    expect(allFrames.every((f) => f.closed)).toBe(true);
  });

  it('a clone failure closes the sources and the clones already made', async () => {
    script.frames = [{ durationUs: us(100) }, { durationUs: us(500), cloneThrowsAfter: 2 }];
    const error = await rejection(decodeImageFile(fakeFile()));
    expect(error.message).toBe('clone failed');
    // 2 sources + 2 successful clones
    expect(allFrames).toHaveLength(4);
    expect(allFrames.every((f) => f.closed)).toBe(true);
    expect(decoders[0].close).toHaveBeenCalled();
  });

  it('refuses a frame without image data', async () => {
    script.frames = [{ width: 0, height: 0, durationUs: null }];
    const error = await rejection(decodeImageFile(fakeFile()));
    expect(error.code).toBe('decode-failed');
    expect(allFrames[0].closed).toBe(true);
  });
});

describe('frameHasAlpha', () => {
  const scratch = () => ({ get: (size) => new Uint8Array(size) });

  it('answers false for opaque-only formats without reading pixels', async () => {
    const frame = new MockVideoFrame({ format: 'NV12', alpha: 0 });
    expect(await frameHasAlpha(/** @type {any} */ (frame), /** @type {any} */ (scratch()))).toBe(
      false,
    );
    expect(frame.copyTo).not.toHaveBeenCalled();
  });

  it('asks for an RGBA conversion for unknown formats', async () => {
    const frame = new MockVideoFrame({ format: 'I420A', alpha: 10 });
    expect(await frameHasAlpha(/** @type {any} */ (frame), /** @type {any} */ (scratch()))).toBe(
      true,
    );
    expect(frame.copyTo).toHaveBeenCalledWith(expect.any(Uint8Array), { format: 'RGBA' });
  });

  it('falls back to a canvas readback when copyTo cannot convert', async () => {
    const frame = new MockVideoFrame({ format: null, copyToThrows: true });
    const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
    const drawImage = vi.fn();
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage, getImageData: () => ({ data }) };
        }
      },
    );
    expect(await frameHasAlpha(/** @type {any} */ (frame), /** @type {any} */ (scratch()))).toBe(
      true,
    );
    expect(drawImage).toHaveBeenCalledWith(frame, 0, 0);
  });
});
