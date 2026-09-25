import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_IMPORT_TYPES,
  checkSourceFrameCount,
  checkTotalSlots,
  chooseImportFps,
  computeFrameSlots,
  formatAlphaSupport,
  formatImportBusyLabel,
  hasTransparentPixel,
  IMPORT_ACCEPT_ATTRIBUTE,
  ImportError,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TOTAL_SLOTS,
  normalizeFrameDurationMs,
  projectImportMemoryMB,
  resolveImportMimeType,
  validateImportFile,
} from '../../../src/features/import/core.js';
import { calculateFrameDelay } from '../../../src/features/export/core.js';

describe('resolveImportMimeType', () => {
  it.each(ACCEPTED_IMPORT_TYPES)('accepts the reported type %s', (type) => {
    expect(resolveImportMimeType({ name: 'x', type })).toBe(type);
  });

  it('is case-insensitive on the reported type', () => {
    expect(resolveImportMimeType({ name: 'x', type: 'IMAGE/GIF' })).toBe('image/gif');
  });

  it('falls back to the extension only when the type is empty', () => {
    expect(resolveImportMimeType({ name: 'Cat.GIF', type: '' })).toBe('image/gif');
    expect(resolveImportMimeType({ name: 'a.jpg', type: '' })).toBe('image/jpeg');
    expect(resolveImportMimeType({ name: 'a.apng' })).toBe('image/apng');
    expect(resolveImportMimeType({ name: 'a.txt', type: '' })).toBeNull();
    expect(resolveImportMimeType({ name: 'noext', type: '' })).toBeNull();
    // A non-image reported type wins over a misleading extension
    expect(resolveImportMimeType({ name: 'a.gif', type: 'text/plain' })).toBeNull();
  });

  it('refuses video types (out of scope)', () => {
    expect(resolveImportMimeType({ name: 'a.mp4', type: 'video/mp4' })).toBeNull();
  });
});

describe('IMPORT_ACCEPT_ATTRIBUTE', () => {
  it('lists every accepted type and the common extensions', () => {
    for (const type of ACCEPTED_IMPORT_TYPES) {
      expect(IMPORT_ACCEPT_ATTRIBUTE).toContain(type);
    }
    expect(IMPORT_ACCEPT_ATTRIBUTE).toContain('.gif');
    expect(IMPORT_ACCEPT_ATTRIBUTE).toContain('.webp');
  });
});

describe('validateImportFile', () => {
  it('accepts a supported, non-empty file within the size limit', () => {
    expect(validateImportFile({ name: 'a.gif', type: 'image/gif', size: 1024 })).toBeNull();
    expect(
      validateImportFile({ name: 'a.gif', type: 'image/gif', size: MAX_IMPORT_FILE_BYTES }),
    ).toBeNull();
  });

  it('refuses unsupported types with a message naming the file', () => {
    const error = validateImportFile({ name: 'notes.txt', type: 'text/plain', size: 10 });
    expect(error).toBeInstanceOf(ImportError);
    expect(error?.code).toBe('unsupported-type');
    expect(error?.message).toContain('"notes.txt"');
  });

  it('refuses empty files', () => {
    expect(validateImportFile({ name: 'a.gif', type: 'image/gif', size: 0 })?.code).toBe(
      'empty-file',
    );
  });

  it('refuses files over 200 MB', () => {
    const error = validateImportFile({
      name: 'big.gif',
      type: 'image/gif',
      size: MAX_IMPORT_FILE_BYTES + 1,
    });
    expect(error?.code).toBe('file-too-large');
    expect(error?.message).toContain('200 MB');
  });
});

describe('normalizeFrameDurationMs', () => {
  it.each([
    [0, 100],
    [10, 100],
    [5, 100],
    [null, 100],
    [undefined, 100],
    [Number.NaN, 100],
    [-20, 100],
  ])('treats %s ms as the 100 ms browser default', (input, expected) => {
    expect(normalizeFrameDurationMs(input)).toBe(expected);
  });

  it('rounds to the 10 ms GIF resolution', () => {
    expect(normalizeFrameDurationMs(20)).toBe(20);
    expect(normalizeFrameDurationMs(33.4)).toBe(30);
    expect(normalizeFrameDurationMs(35)).toBe(40);
    expect(normalizeFrameDurationMs(500)).toBe(500);
    expect(normalizeFrameDurationMs(11)).toBe(10);
  });
});

describe('chooseImportFps', () => {
  it('uses 30 fps for a single still image', () => {
    expect(chooseImportFps([null])).toBe(30);
    expect(chooseImportFps([])).toBe(30);
  });

  it('picks round(100 / gcd in centiseconds)', () => {
    expect(chooseImportFps([100, 100, 500])).toBe(10);
    expect(chooseImportFps([40, 40, 40])).toBe(25);
    expect(chooseImportFps([20, 20])).toBe(50);
    expect(chooseImportFps([30, 30, 30])).toBe(33);
    expect(chooseImportFps([70, 70])).toBe(14);
  });

  it('clamps to 1..50', () => {
    // gcd 1 cs -> 100 fps, clamped
    expect(chooseImportFps([30, 20])).toBe(50);
    // gcd 300 cs -> 0.33 fps, clamped up
    expect(chooseImportFps([3000, 3000])).toBe(1);
  });

  it('normalizes 0/1 cs delays to 100 ms before taking the gcd', () => {
    expect(chooseImportFps([0, 0, 0])).toBe(10);
    expect(chooseImportFps([10, 200])).toBe(10);
  });
});

describe('import -> export timing round trip', () => {
  /**
   * What an unedited import exports: each source frame becomes one merged
   * GIF frame covering its slots (mergeIdenticalFrames on the export side).
   * @param {number[]} durationsMs
   */
  function exportedDelaysMs(durationsMs) {
    const fps = chooseImportFps(durationsMs);
    return computeFrameSlots(durationsMs, fps).map(
      (runLength) => calculateFrameDelay(fps, 1, 1, runLength) * 10,
    );
  }

  it.each([
    [[400, 400, 400], 5],
    [[150, 150, 150], 20],
    [[120, 120, 120], 25],
    [[700, 700], 10],
    [[400, 800], 5],
    [[300, 700], 10],
    [[100, 100, 500], 10],
  ])('keeps %j exact (fps %i)', (durationsMs, fps) => {
    expect(chooseImportFps(durationsMs)).toBe(fps);
    expect(exportedDelaysMs(durationsMs)).toEqual(durationsMs);
  });

  it('keeps 30 ms and 70 ms frames exact through the round(100 / gcd) fallback', () => {
    expect(exportedDelaysMs(Array.from({ length: 20 }, () => 30))).toEqual(
      Array.from({ length: 20 }, () => 30),
    );
    expect(exportedDelaysMs([70, 70, 70])).toEqual([70, 70, 70]);
  });
});

describe('computeFrameSlots', () => {
  it('imports uniform timing 1:1', () => {
    expect(computeFrameSlots([40, 40, 40, 40], 25)).toEqual([1, 1, 1, 1]);
  });

  it('turns holds into repeated slots', () => {
    const slots = computeFrameSlots([100, 100, 500], 10);
    expect(slots).toEqual([1, 1, 5]);
    expect(slots.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('rounds cumulatively so error never accumulates', () => {
    // 30/20 ms at 50 fps (1.5 / 1 slots): ends round(1.5)=2, round(2.5)=3,
    // round(4)=4, round(5)=5 -> 5 slots = exactly 100 ms. Per-frame
    // rounding would give 2,1,2,1 = 6 slots (120 ms)
    expect(computeFrameSlots([30, 20, 30, 20], 50)).toEqual([2, 1, 1, 1]);

    // 70 ms at 30 fps = 2.1 slots each: per-frame rounding gives 2 each
    // (20 slots = 667 ms for 700 ms); cumulative keeps the total at 21
    const slots = computeFrameSlots(
      Array.from({ length: 10 }, () => 70),
      30,
    );
    expect(slots.reduce((a, b) => a + b, 0)).toBe(21);
    expect(slots.filter((n) => n === 3)).toHaveLength(1);
  });

  it('never gives a frame zero slots', () => {
    // 100 ms at 1 fps = 0.1 slot, but every source frame stays visible
    expect(computeFrameSlots([100, 100, 100], 1)).toEqual([1, 1, 1]);
    // 30 ms at 33 fps = 0.99 slot: every frame still gets its one slot
    const slots = computeFrameSlots(
      Array.from({ length: 100 }, () => 30),
      33,
    );
    expect(slots.every((n) => n === 1)).toBe(true);
  });

  it('lets a later frame absorb a slot forced onto a short frame', () => {
    // At 1 fps a 100 ms frame is forced up to one slot; the 1900 ms frame
    // then ends at slot 2, so it gets 1 slot and the clip stays 2 s long
    expect(computeFrameSlots([100, 1900], 1)).toEqual([1, 1]);
  });

  it('applies the 100 ms default to a frame without a duration', () => {
    // decode.js special-cases single-frame files to one slot; the formula
    // itself stays literal
    expect(computeFrameSlots([null], 30)).toEqual([3]);
  });
});

describe('limits', () => {
  it('checkTotalSlots refuses more than 3600 slots', () => {
    expect(checkTotalSlots(MAX_IMPORT_TOTAL_SLOTS, 30)).toBeNull();
    const error = checkTotalSlots(MAX_IMPORT_TOTAL_SLOTS + 1, 30);
    expect(error?.code).toBe('too-many-frames');
    expect(error?.message).toContain('3600');
  });

  it('checkSourceFrameCount refuses more source frames than slots allowed', () => {
    expect(checkSourceFrameCount(MAX_IMPORT_TOTAL_SLOTS)).toBeNull();
    expect(checkSourceFrameCount(MAX_IMPORT_TOTAL_SLOTS + 1)?.code).toBe('too-many-frames');
  });
});

describe('projectImportMemoryMB', () => {
  it('counts unique source frames at raw RGBA', () => {
    expect(projectImportMemoryMB(4, 1024, 256)).toBe(4);
    expect(projectImportMemoryMB(0, 1024, 256)).toBe(0);
  });
});

describe('hasTransparentPixel', () => {
  it('is false for a fully opaque buffer', () => {
    const pixels = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(hasTransparentPixel(pixels)).toBe(false);
  });

  it('finds partially and fully transparent pixels', () => {
    expect(hasTransparentPixel(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]))).toBe(true);
    expect(hasTransparentPixel(new Uint8ClampedArray([9, 9, 9, 254]))).toBe(true);
  });

  it('only reads alpha bytes', () => {
    // RGB bytes of 0 must not count as transparency
    expect(hasTransparentPixel(new Uint8Array([0, 0, 0, 255]))).toBe(false);
  });
});

describe('formatAlphaSupport', () => {
  it('classifies VideoFrame formats', () => {
    expect(formatAlphaSupport('RGBA')).toBe(true);
    expect(formatAlphaSupport('BGRA')).toBe(true);
    for (const format of ['RGBX', 'BGRX', 'I420', 'I422', 'I444', 'NV12']) {
      expect(formatAlphaSupport(format)).toBe(false);
    }
    expect(formatAlphaSupport('I420A')).toBeNull();
    expect(formatAlphaSupport(null)).toBeNull();
  });
});

describe('formatImportBusyLabel', () => {
  it('names the file, with a percentage once progress is known', () => {
    expect(formatImportBusyLabel('cat.gif')).toBe('Opening cat.gif…');
    expect(formatImportBusyLabel('cat.gif', 1, 4)).toBe('Opening cat.gif… 25%');
    expect(formatImportBusyLabel('cat.gif', 1, 1)).toBe('Opening cat.gif…');
  });
});
