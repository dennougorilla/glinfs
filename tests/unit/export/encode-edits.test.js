import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * encodeGif with the edit/transparency/merging params:
 * - mergeIdenticalFrames=false keeps today's output byte-identical
 * - merging collapses runs of identical frames into one GIF frame
 * - edits route extraction through the compositor with absolute indices
 * - transparent exports force gifenc
 */

const managerFactory = vi.hoisted(() => ({
  /** @type {(() => any) | null} */
  create: null,
}));

vi.mock('../../../src/workers/worker-manager.js', () => ({
  createEncoderManager: () => {
    if (!managerFactory.create) {
      throw new Error('Test did not install a fake manager factory');
    }
    return managerFactory.create();
  },
}));

const composeMock = vi.hoisted(() => ({
  /** @type {any} */
  impl: null,
}));

vi.mock('../../../src/shared/edits/compose.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    composeOutputFrameRGBA: vi.fn((...args) =>
      composeMock.impl ? composeMock.impl(...args) : actual.composeOutputFrameRGBA(...args),
    ),
  };
});

import {
  buildPaletteSample,
  encodeGif,
  MAX_IN_FLIGHT_FRAMES,
} from '../../../src/features/export/api.js';
import { calculateFrameDelay } from '../../../src/features/export/core.js';
import { createGifencEncoder } from '../../../src/features/export/encoders/gifenc-encoder.js';
import { composeOutputFrameRGBA } from '../../../src/shared/edits/compose.js';
import { createDefaultEdits, createTextLayer } from '../../../src/shared/edits/model.js';
import { readGifStructure } from './gif-structure.js';

const W = 4;
const H = 4;

/**
 * Frame whose copyTo paints a solid gray level (so equal levels are
 * byte-identical frames)
 * @param {number} level
 * @param {number} [alpha]
 */
function frameOf(level, alpha = 255) {
  return {
    id: `frame-${level}-${Math.random()}`,
    frame: {
      codedWidth: W,
      codedHeight: H,
      closed: false,
      copyTo: vi.fn(async (/** @type {Uint8ClampedArray} */ buffer) => {
        for (let p = 0; p < buffer.length; p += 4) buffer.set([level, level, level, alpha], p);
      }),
      close: vi.fn(),
    },
    timestamp: 0,
    width: W,
    height: H,
  };
}

/** @param {number[]} levels */
const framesOf = (levels) => levels.map((level) => frameOf(level));

/** @type {any} */
const SETTINGS = {
  quality: 0.7,
  frameSkip: 1,
  playbackSpeed: 1,
  encoderPreset: 'quality',
  loopCount: 0,
  encoderId: 'gifenc-js',
};

/**
 * Fake manager: records init/addFrame and acknowledges frames on a
 * macrotask (slower than extraction). With `real`, frames are also fed to a
 * real gifenc encoder so finish() returns real GIF bytes.
 */
class RecordingManager {
  /** @param {{ real?: boolean, autoProcess?: boolean }} [options] */
  constructor({ real = false, autoProcess = true } = {}) {
    this.onProgress = null;
    this.onError = null;
    /** @type {any} */
    this.initConfig = null;
    /** @type {{ frameIndex: number, delayMs: number | undefined, width: number, height: number, first: number[] }[]} */
    this.frames = [];
    this.processed = 0;
    this.maxInFlight = 0;
    this.disposed = false;
    this.cancelled = false;
    this.autoProcess = autoProcess;
    this.encoder = real ? createGifencEncoder() : null;
    /** @type {Uint8Array | null} */
    this.bytes = null;
  }

  async init(config) {
    this.initConfig = config;
    this.encoder?.init({ ...config });
  }

  addFrame(rgba, width, height, frameIndex, delayMs) {
    this.frames.push({ frameIndex, delayMs, width, height, first: Array.from(rgba.slice(0, 4)) });
    this.maxInFlight = Math.max(this.maxInFlight, this.frames.length - this.processed);
    this.encoder?.addFrame({ rgba, width, height, delayMs }, frameIndex);
    if (!this.autoProcess) return;
    setTimeout(() => {
      if (this.disposed) return;
      this.processed++;
      this.onProgress?.({ percent: 0, frameIndex, totalFrames: 0 });
    }, 0);
  }

  async finish() {
    while (this.processed < this.frames.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // jsdom's Blob has no arrayBuffer(), so tests read the bytes from here
    this.bytes = this.encoder ? this.encoder.finish() : new Uint8Array([0]);
    return new Blob([this.bytes], { type: 'image/gif' });
  }

  cancel() {
    this.cancelled = true;
  }

  dispose() {
    this.disposed = true;
    this.onProgress = null;
    this.onError = null;
  }
}

/** @type {RecordingManager} */
let manager;

/** @param {{ real?: boolean, autoProcess?: boolean }} [options] */
function installManager(options) {
  manager = new RecordingManager(options);
  managerFactory.create = () => manager;
}

/** Structure of the GIF the last (real) manager produced */
function lastGif() {
  if (!manager.bytes) throw new Error('No GIF was produced');
  return readGifStructure(manager.bytes);
}

beforeEach(() => {
  composeMock.impl = null;
  vi.mocked(composeOutputFrameRGBA).mockClear();
  installManager();
});

describe('mergeIdenticalFrames = false (default)', () => {
  it('submits every source frame with the fixed delay, as before merging existed', async () => {
    // Identical frames on purpose: without merging they must NOT collapse
    const frames = framesOf([7, 7, 7, 9, 9]);
    await encodeGif({ frames, crop: null, settings: SETTINGS, fps: 30, onProgress: vi.fn() });

    const delayMs = calculateFrameDelay(30, 1, 1) * 10;
    expect(manager.frames.map((f) => [f.frameIndex, f.delayMs])).toEqual([
      [0, delayMs],
      [1, delayMs],
      [2, delayMs],
      [3, delayMs],
      [4, delayMs],
    ]);
    expect(manager.initConfig).toMatchObject({
      encoderId: 'gifenc-js',
      totalFrames: 5,
      frameDelayMs: delayMs,
      transparent: false,
    });
    expect(composeOutputFrameRGBA).not.toHaveBeenCalled();
  });

  it('produces the same GIF bytes as the pre-merging encoder loop', async () => {
    installManager({ real: true });
    const levels = [10, 10, 40, 80, 80, 80, 120];
    const settings = { ...SETTINGS, encoderPreset: 'balanced' };
    const blob = await encodeGif({
      frames: framesOf(levels),
      crop: null,
      settings,
      fps: 30,
      onProgress: vi.fn(),
    });

    // The previous pipeline: one addFrame per frame, no per-frame delay,
    // encoder config without the transparency flag.
    const legacy = createGifencEncoder();
    legacy.init({
      width: W,
      height: H,
      maxColors: manager.initConfig.maxColors,
      frameDelayMs: calculateFrameDelay(30, 1, 1) * 10,
      loopCount: 0,
      quantizeFormat: manager.initConfig.quantizeFormat,
      paletteInterval: manager.initConfig.paletteInterval,
    });
    levels.forEach((level, i) => {
      const rgba = new Uint8ClampedArray(W * H * 4);
      for (let p = 0; p < rgba.length; p += 4) rgba.set([level, level, level, 255], p);
      legacy.addFrame({ rgba, width: W, height: H }, i);
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(manager.bytes).toEqual(legacy.finish());
    expect(lastGif().frames).toHaveLength(levels.length);
  });
});

describe('mergeIdenticalFrames = true', () => {
  it('collapses runs of identical frames into one GIF frame with the summed delay', async () => {
    installManager({ real: true });
    // fps 10: one source frame = 100ms, so the run sums are exact
    const blob = await encodeGif({
      frames: framesOf([5, 5, 5, 60, 90, 90]),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      mergeIdenticalFrames: true,
    });

    expect(manager.frames.map((f) => [f.frameIndex, f.delayMs, f.first[0]])).toEqual([
      [0, 300, 5],
      [1, 100, 60],
      [2, 200, 90],
    ]);
    expect(blob).toBeInstanceOf(Blob);
    expect(lastGif().frames.map((f) => f.delayCs)).toEqual([30, 10, 20]);
  });

  it('rounds the run as a whole and applies frame skip and playback speed', async () => {
    // fps 30, skip 2, speed 2: one kept frame = 33.3ms; a run of 3 = 100ms
    // (per-frame rounding would give 3 x 30 = 90ms)
    const frames = framesOf([1, 1, 1, 1, 1, 1, 2, 2]);
    await encodeGif({
      frames,
      crop: null,
      settings: { ...SETTINGS, frameSkip: 2, playbackSpeed: 2 },
      fps: 30,
      onProgress: vi.fn(),
      mergeIdenticalFrames: true,
    });
    expect(manager.frames.map((f) => f.delayMs)).toEqual([100, calculateFrameDelay(30, 2, 2) * 10]);
  });

  it('never goes below the 2cs minimum', async () => {
    await encodeGif({
      frames: framesOf([1, 2]),
      crop: null,
      settings: { ...SETTINGS, playbackSpeed: 4 },
      fps: 60,
      onProgress: vi.fn(),
      mergeIdenticalFrames: true,
    });
    expect(manager.frames.map((f) => f.delayMs)).toEqual([20, 20]);
  });

  it('keeps a single-frame clip and a clip without repeats unchanged', async () => {
    await encodeGif({
      frames: framesOf([3]),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      mergeIdenticalFrames: true,
    });
    expect(manager.frames.map((f) => f.delayMs)).toEqual([100]);

    installManager();
    await encodeGif({
      frames: framesOf([1, 2, 3]),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      mergeIdenticalFrames: true,
    });
    expect(manager.frames.map((f) => f.delayMs)).toEqual([100, 100, 100]);
  });

  it('reports monotonic source-frame progress that reaches 100', async () => {
    const onProgress = vi.fn();
    await encodeGif({
      frames: framesOf([1, 1, 1, 1, 2, 3, 3, 3, 3, 3]),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress,
      mergeIdenticalFrames: true,
    });

    const reports = onProgress.mock.calls.map(([p]) => p);
    expect(reports).toEqual([
      { percent: 40, current: 4, total: 10 },
      { percent: 50, current: 5, total: 10 },
      { percent: 100, current: 10, total: 10 },
    ]);
  });

  it('never exceeds the in-flight window', async () => {
    const levels = Array.from({ length: MAX_IN_FLIGHT_FRAMES * 3 }, (_, i) => i);
    await encodeGif({
      frames: framesOf(levels),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      mergeIdenticalFrames: true,
    });
    expect(manager.frames).toHaveLength(levels.length);
    expect(manager.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT_FRAMES);
  });

  it('rejects with AbortError when aborted while the final run waits for window space', async () => {
    installManager({ autoProcess: false });
    const controller = new AbortController();
    const levels = Array.from({ length: MAX_IN_FLIGHT_FRAMES + 1 }, (_, i) => i);
    const promise = encodeGif(
      {
        frames: framesOf(levels),
        crop: null,
        settings: SETTINGS,
        fps: 10,
        onProgress: vi.fn(),
        mergeIdenticalFrames: true,
      },
      controller.signal,
    );
    promise.catch(() => {});

    await vi.waitFor(() => {
      expect(manager.frames).toHaveLength(MAX_IN_FLIGHT_FRAMES);
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.frames).toHaveLength(MAX_IN_FLIGHT_FRAMES);
    expect(manager.cancelled).toBe(true);
  });

  it('fails when a worker error arrives before the final run is flushed', async () => {
    const frames = framesOf([1, 2, 2]);
    const err = new Error('frame failed');
    frames[2].frame.copyTo.mockImplementation(async (buffer) => {
      for (let p = 0; p < buffer.length; p += 4) buffer.set([2, 2, 2, 255], p);
      manager.onError?.(err);
    });
    await expect(
      encodeGif({
        frames,
        crop: null,
        settings: SETTINGS,
        fps: 10,
        onProgress: vi.fn(),
        mergeIdenticalFrames: true,
      }),
    ).rejects.toThrow('frame failed');
    // Frame 0's run was submitted; the held [2, 2] run never was
    expect(manager.frames).toHaveLength(1);
  });
});

describe('edits', () => {
  /** @param {number} textStart @param {number} textEnd */
  function textEdits(textStart, textEnd) {
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ text: 'Hi', start: textStart, end: textEnd }, 100));
    return edits;
  }

  beforeEach(() => {
    composeMock.impl = async () => ({
      data: new Uint8ClampedArray(W * H * 4),
      width: W,
      height: H,
    });
  });

  it('composes frames with their absolute clip index (rangeStart + k * frameSkip)', async () => {
    const frames = framesOf([1, 2, 3, 4, 5, 6, 7]);
    const edits = textEdits(0, 99);
    await encodeGif({
      frames,
      crop: null,
      settings: { ...SETTINGS, frameSkip: 3 },
      fps: 30,
      onProgress: vi.fn(),
      edits,
      rangeStart: 20,
    });

    const calls = vi.mocked(composeOutputFrameRGBA).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([frames[0], frames[3], frames[6]]);
    expect(calls.map((c) => c[3])).toEqual([20, 23, 26]);
    expect(calls[0][2]).toBe(edits);
    expect(frames[0].frame.copyTo).not.toHaveBeenCalled();
  });

  it('keeps the copyTo fast path for empty edits', async () => {
    const frames = framesOf([1, 2]);
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ text: '   ' }, 2));
    await encodeGif({
      frames,
      crop: null,
      settings: SETTINGS,
      fps: 30,
      onProgress: vi.fn(),
      edits,
    });
    expect(composeOutputFrameRGBA).not.toHaveBeenCalled();
    expect(frames[0].frame.copyTo).toHaveBeenCalled();
  });

  it('builds the fast-preset palette sample from composed frames', async () => {
    const frames = framesOf([1, 2, 3]);
    await encodeGif({
      frames,
      crop: null,
      settings: { ...SETTINGS, encoderPreset: 'fast' },
      fps: 30,
      onProgress: vi.fn(),
      edits: textEdits(0, 99),
    });
    // 3 sample extractions + 3 frame extractions
    expect(composeOutputFrameRGBA).toHaveBeenCalledTimes(6);
    expect(frames[0].frame.copyTo).not.toHaveBeenCalled();
  });
});

describe('transparent exports', () => {
  it('forces gifenc and tells the encoder to write transparency', async () => {
    await encodeGif({
      frames: framesOf([1, 2]),
      crop: null,
      settings: { ...SETTINGS, encoderId: 'gifsicle-wasm', encoderPreset: 'fast' },
      fps: 30,
      onProgress: vi.fn(),
      transparent: true,
    });
    expect(manager.initConfig).toMatchObject({ encoderId: 'gifenc-js', transparent: true });
    // gifenc gets the clip-wide sample that gifsicle would have skipped
    expect(manager.initConfig.paletteSample).toBeInstanceOf(Uint8ClampedArray);
  });

  it('keeps the selected encoder when not transparent', async () => {
    await encodeGif({
      frames: framesOf([1]),
      crop: null,
      settings: { ...SETTINGS, encoderId: 'gifsicle-wasm' },
      fps: 30,
      onProgress: vi.fn(),
    });
    expect(manager.initConfig).toMatchObject({ encoderId: 'gifsicle-wasm', transparent: false });
  });

  it('samples only opaque pixels for the clip-wide palette', async () => {
    const frames = [frameOf(50, 0), frameOf(200, 255)];
    await encodeGif({
      frames,
      crop: null,
      settings: { ...SETTINGS, encoderPreset: 'fast' },
      fps: 30,
      onProgress: vi.fn(),
      transparent: true,
    });
    const sample = manager.initConfig.paletteSample;
    expect(sample.length).toBe(W * H * 4);
    for (let p = 3; p < sample.length; p += 4) expect(sample[p]).toBe(255);
  });
});

describe('buildPaletteSample options', () => {
  it('uses a custom extractor and can drop transparent pixels', async () => {
    const extract = vi.fn(async (/** @type {number} */ index) => {
      const data = new Uint8ClampedArray(W * H * 4);
      for (let p = 0; p < data.length; p += 4) data.set([index, 0, 0, p < 32 ? 255 : 0], p);
      return { data, width: W, height: H };
    });
    const frames = framesOf([1, 2]);

    const all = await buildPaletteSample(frames, null, undefined, { extract });
    const opaque = await buildPaletteSample(frames, null, undefined, { extract, opaqueOnly: true });

    expect(extract).toHaveBeenCalledTimes(4);
    expect(frames[0].frame.copyTo).not.toHaveBeenCalled();
    expect(all.length).toBe(2 * W * H * 4);
    expect(opaque.length).toBe(2 * 8 * 4);
  });
});
