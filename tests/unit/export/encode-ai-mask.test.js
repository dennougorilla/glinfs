import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * encodeGif with the AI cutout: the real compositor applies a fake
 * maskSource's final masks, a real gifenc encoder writes the GIF, and the
 * GIF's LZW data is decoded to check that exactly the pixels whose mask is
 * 0 carry the transparent index. Also: the export refuses to start when an
 * exported frame has no mask, and the color key path is byte-identical
 * with or without a mask source.
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

import { GIFEncoder } from 'gifenc';
import { encodeGif, MissingCutoutMasksError } from '../../../src/features/export/api.js';
import {
  findFramesMissingMasks,
  getExportedFrameIndices,
} from '../../../src/features/export/core.js';
import { createGifencEncoder } from '../../../src/features/export/encoders/gifenc-encoder.js';
import { applyColorKey } from '../../../src/shared/edits/color-key.js';
import { __resetComposeCacheForTests } from '../../../src/shared/edits/compose.js';
import { createDefaultEdits } from '../../../src/shared/edits/model.js';
import { maskBit, packMask } from '../../../src/shared/masks/mask-ops.js';
import { createFakeContext } from '../shared/edits/fake-context.js';
import { decodeGifFrames } from './gif-structure.js';

const W = 12;
const H = 8;
/** Masks are half the source resolution */
const MW = 6;
const MH = 4;

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
 * Source pixels of clip frame `index`: a few distinct colors, one of them
 * pure green (the key color of the color-path tests)
 * @param {number} index
 */
function sourcePixels(index) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const color =
        x < 2 ? [0, 255, 0, 255] : [(x * 20 + index * 7) & 255, y * 30, 120 + index, 255];
      rgba.set(color, (y * W + x) * 4);
    }
  }
  return rgba;
}

/**
 * Frame whose fake VideoFrame the fake canvas copies pixel for pixel
 * @param {number} index
 */
function frameOf(index) {
  return /** @type {any} */ ({
    id: `f${index}`,
    frame: { closed: false, rgba: sourcePixels(index), width: W, height: H },
    timestamp: 0,
    width: W,
    height: H,
  });
}

/** @param {number} count */
const framesOf = (count) => Array.from({ length: count }, (_, i) => frameOf(i));

/**
 * Final mask of clip frame `index`: a band of mask columns that moves with
 * the index, and the bottom mask row cleared
 * @param {number} index
 */
function maskFor(index) {
  const binary = new Uint8Array(MW * MH);
  for (let y = 0; y < MH - 1; y++) {
    for (let x = 0; x < MW; x++) {
      if (x >= index % 4 && x < (index % 4) + 3) binary[y * MW + x] = 1;
    }
  }
  return packMask(binary, MW, MH);
}

/**
 * Fake mask source with masks for the given clip indices
 * @param {Iterable<number>} indices
 */
function maskSourceFor(indices) {
  const masks = new Map([...indices].map((i) => [i, maskFor(i)]));
  return {
    version: 1,
    getFinalMask: vi.fn((/** @type {number} */ i) => masks.get(i) ?? null),
  };
}

/** Edits with the AI cutout on */
function aiEdits() {
  const edits = createDefaultEdits();
  edits.background = { ...edits.background, enabled: true, method: 'ai' };
  return edits;
}

/** Edits with a green color key on */
function colorEdits() {
  const edits = createDefaultEdits();
  edits.background = {
    ...edits.background,
    enabled: true,
    method: 'color',
    color: '#00ff00',
    tolerance: 5,
    mode: 'global',
  };
  return edits;
}

/** Fake manager feeding a real gifenc encoder; finish() returns its bytes */
class GifencManager {
  constructor() {
    this.onProgress = null;
    this.onError = null;
    /** @type {any} */
    this.initConfig = null;
    this.encoder = createGifencEncoder();
    this.pending = 0;
    /** @type {Uint8Array | null} */
    this.bytes = null;
  }

  async init(config) {
    this.initConfig = config;
    this.encoder.init({ ...config });
  }

  addFrame(rgba, width, height, frameIndex, delayMs) {
    this.encoder.addFrame({ rgba, width, height, delayMs }, frameIndex);
    this.pending++;
    setTimeout(() => {
      this.pending--;
      this.onProgress?.({ percent: 0, frameIndex, totalFrames: 0 });
    }, 0);
  }

  async finish() {
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    this.bytes = this.encoder.finish();
    return new Blob([this.bytes], { type: 'image/gif' });
  }

  cancel() {}

  dispose() {
    this.onProgress = null;
    this.onError = null;
  }
}

/** @type {GifencManager[]} */
let managers;

beforeEach(() => {
  managers = [];
  managerFactory.create = () => {
    const manager = new GifencManager();
    managers.push(manager);
    return manager;
  };
  __resetComposeCacheForTests();
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      /** @param {number} w @param {number} h */
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }

      getContext() {
        return createFakeContext(0, 0, this);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetComposeCacheForTests();
});

/**
 * Encode and return the decoded GIF frames
 * @param {Partial<import('../../../src/features/export/api.js').EncodeParams>} params
 */
async function encodeAndDecode(params) {
  await encodeGif(
    /** @type {any} */ ({
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      transparent: true,
      ...params,
    }),
  );
  const bytes = managers.at(-1)?.bytes;
  if (!bytes) throw new Error('No GIF was produced');
  return decodeGifFrames(bytes);
}

describe('decodeGifFrames (test helper)', () => {
  it('round-trips gifenc LZW data, including code-size growth and dictionary resets', () => {
    const width = 160;
    const height = 120;
    let seed = 3;
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      indices[i] = seed % 256;
    }
    const palette = Array.from({ length: 256 }, (_, i) => [i, i, i]);
    const gif = GIFEncoder();
    gif.writeFrame(indices, width, height, { palette, transparent: true, transparentIndex: 9 });
    gif.writeFrame(new Uint8Array(4).fill(1), 2, 2, { palette: palette.slice(0, 2) });
    gif.finish();

    const [first, second] = decodeGifFrames(gif.bytes());
    expect(first.indices).toEqual(indices);
    expect(first.transparentIndex).toBe(9);
    expect(Array.from(second.indices)).toEqual([1, 1, 1, 1]);
    expect(second.transparentIndex).toBeNull();
  });
});

describe('encodeGif with AI cutout masks', () => {
  it('writes the transparent index exactly where the mask is 0', async () => {
    const rangeStart = 20;
    const maskSource = maskSourceFor([20, 21, 22, 23]);
    const decoded = await encodeAndDecode({
      frames: framesOf(4),
      edits: aiEdits(),
      rangeStart,
      maskSource,
    });

    expect(maskSource.getFinalMask.mock.calls.map(([i]) => i)).toEqual(
      expect.arrayContaining([20, 21, 22, 23]),
    );
    expect(decoded).toHaveLength(4);
    decoded.forEach((gifFrame, k) => {
      expect(gifFrame.transparentIndex).not.toBeNull();
      const mask = maskFor(rangeStart + k);
      let cleared = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const keep = maskBit(mask, Math.floor(x / 2), Math.floor(y / 2)) === 1;
          const isTransparent = gifFrame.indices[y * W + x] === gifFrame.transparentIndex;
          expect(isTransparent, `frame ${k} pixel ${x},${y}`).toBe(!keep);
          if (!keep) cleared++;
        }
      }
      // Each frame really has both kept and cleared pixels
      expect(cleared).toBeGreaterThan(0);
      expect(cleared).toBeLessThan(W * H);
    });
  });

  it('samples masks by absolute index through a crop and frame skip', async () => {
    const maskSource = maskSourceFor([0, 2, 4]);
    const crop = { x: 2, y: 2, width: 8, height: 4, aspectRatio: 'free' };
    const decoded = await encodeAndDecode({
      frames: framesOf(6),
      crop: /** @type {any} */ (crop),
      settings: { ...SETTINGS, frameSkip: 2 },
      edits: aiEdits(),
      maskSource,
    });

    expect(new Set(maskSource.getFinalMask.mock.calls.map(([i]) => i))).toEqual(new Set([0, 2, 4]));
    expect(decoded).toHaveLength(3);
    decoded.forEach((gifFrame, k) => {
      expect([gifFrame.width, gifFrame.height]).toEqual([8, 4]);
      const mask = maskFor(k * 2);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 8; x++) {
          const keep =
            maskBit(mask, Math.floor((crop.x + x) / 2), Math.floor((crop.y + y) / 2)) === 1;
          const isTransparent = gifFrame.indices[y * 8 + x] === gifFrame.transparentIndex;
          expect(isTransparent, `frame ${k} pixel ${x},${y}`).toBe(!keep);
        }
      }
    });
  });

  it('refuses to start when an exported frame has no mask', async () => {
    const create = vi.fn(managerFactory.create);
    managerFactory.create = create;
    const params = /** @type {any} */ ({
      frames: framesOf(4),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      edits: aiEdits(),
      rangeStart: 20,
      transparent: true,
    });

    const partial = encodeGif({ ...params, maskSource: maskSourceFor([20, 21, 23]) });
    await expect(partial).rejects.toBeInstanceOf(MissingCutoutMasksError);
    await expect(
      encodeGif({ ...params, maskSource: maskSourceFor([20, 21, 23]) }),
    ).rejects.toMatchObject({
      name: 'MissingCutoutMasksError',
      frameIndices: [22],
      message: expect.stringMatching(/missing for 1 of 4 frames \(first: frame 22\)/),
    });
    await expect(encodeGif(params)).rejects.toMatchObject({ frameIndices: [20, 21, 22, 23] });
    // Refused before any worker or frame work
    expect(create).not.toHaveBeenCalled();
  });

  it('only needs masks for the frames frame skip keeps', async () => {
    const decoded = await encodeAndDecode({
      frames: framesOf(4),
      settings: { ...SETTINGS, frameSkip: 2 },
      edits: aiEdits(),
      maskSource: maskSourceFor([0, 2]),
    });
    expect(decoded).toHaveLength(2);
  });
});

describe('encodeGif color key path with a mask source', () => {
  it('is byte-identical to the v0.7.0 keyed export and never reads masks', async () => {
    const maskSource = maskSourceFor([0, 1, 2]);
    const base = /** @type {any} */ ({
      frames: framesOf(3),
      crop: null,
      settings: SETTINGS,
      fps: 10,
      onProgress: vi.fn(),
      edits: colorEdits(),
      transparent: true,
    });
    await encodeGif({ ...base, maskSource });
    const withSource = managers.at(-1)?.bytes;
    await encodeGif(base);
    const without = managers.at(-1)?.bytes;

    // The v0.7.0 pipeline: key each frame's pixels, encode
    const config = managers[0].initConfig;
    const legacy = createGifencEncoder();
    legacy.init({ ...config });
    for (let i = 0; i < 3; i++) {
      const rgba = sourcePixels(i);
      applyColorKey(rgba, W, H, colorEdits().background);
      legacy.addFrame({ rgba, width: W, height: H, delayMs: config.frameDelayMs }, i);
    }

    expect(withSource).toEqual(without);
    expect(withSource).toEqual(legacy.finish());
    expect(maskSource.getFinalMask).not.toHaveBeenCalled();
  });
});

describe('export frame index helpers', () => {
  it('lists the absolute indices frame skip keeps', () => {
    expect(getExportedFrameIndices(5, 1, 10)).toEqual([10, 11, 12, 13, 14]);
    expect(getExportedFrameIndices(5, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(getExportedFrameIndices(7, 3, 2)).toEqual([2, 5, 8]);
    expect(getExportedFrameIndices(0, 2)).toEqual([]);
  });

  it('finds exported frames without a final mask', () => {
    const source = { getFinalMask: (/** @type {number} */ i) => (i % 2 ? {} : null) };
    expect(findFramesMissingMasks([1, 2, 3, 4], source)).toEqual([2, 4]);
    expect(findFramesMissingMasks([1, 2], null)).toEqual([1, 2]);
  });
});
