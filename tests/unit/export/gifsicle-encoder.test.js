import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeEncoderJsSha256Hex } from '../../../scripts/compute-encoder-hash.js';

/**
 * Convert a lowercase hex string into an ArrayBuffer, matching the shape
 * crypto.subtle.digest() resolves with.
 * @param {string} hex
 * @returns {ArrayBuffer}
 */
function hexToArrayBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Build a minimal GIF-like byte array containing a NETSCAPE2.0 application
 * extension with the given loop value, surrounded by filler bytes.
 * Layout: 21 FF 0B "NETSCAPE2.0" 03 01 <lo> <hi> 00
 * @param {number} lo
 * @param {number} hi
 */
function gifWithNetscapeBlock(lo = 0, hi = 0) {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // "GIF89a"
  const filler = [0x00, 0x11, 0x22, 0x33];
  const marker = [0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30];
  const block = [0x21, 0xff, 0x0b, ...marker, 0x03, 0x01, lo, hi, 0x00];
  const trailer = [0x3b];
  return new Uint8Array([...header, ...filler, ...block, ...trailer]);
}

describe('patchGifLoopCount', () => {
  /** @type {typeof import('../../../src/features/export/encoders/gifsicle-encoder.js')} */
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
  });

  it('patches the loop value little-endian and returns true', () => {
    const bytes = gifWithNetscapeBlock(0, 0);
    const before = Array.from(bytes);

    expect(mod.patchGifLoopCount(bytes, 300)).toBe(true);

    const lo = before.length - 4; // layout tail: 03 01 <lo> <hi> 00 3b
    expect(bytes[lo]).toBe(300 & 0xff);
    expect(bytes[lo + 1]).toBe(300 >> 8);
    // Everything except the two count bytes is untouched
    const mutated = before.map((b, i) => (bytes[i] !== b ? i : -1)).filter((i) => i >= 0);
    expect(mutated).toEqual([lo, lo + 1]);
  });

  it('patches an existing non-zero count down to 0 (infinite)', () => {
    const bytes = gifWithNetscapeBlock(0x05, 0x00);
    expect(mod.patchGifLoopCount(bytes, 0)).toBe(true);
    expect(Array.from(bytes.slice(-4, -1))).toEqual([0x00, 0x00, 0x00]);
  });

  it('clamps values above u16 range', () => {
    const bytes = gifWithNetscapeBlock();
    expect(mod.patchGifLoopCount(bytes, 1_000_000)).toBe(true);
    expect(bytes[bytes.length - 4]).toBe(0xff);
    expect(bytes[bytes.length - 3]).toBe(0xff);
  });

  it('returns false and leaves bytes untouched when no NETSCAPE block exists', () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x3b]);
    const before = Array.from(bytes);
    expect(mod.patchGifLoopCount(bytes, 3)).toBe(false);
    expect(Array.from(bytes)).toEqual(before);
  });

  it('ignores a marker without the 03 01 sub-block introducer', () => {
    const bytes = gifWithNetscapeBlock();
    bytes[bytes.length - 6] = 0x04; // corrupt the 0x03 sub-block size
    expect(mod.patchGifLoopCount(bytes, 3)).toBe(false);
  });

  it('does not read out of bounds when the block is truncated at the end', () => {
    const full = gifWithNetscapeBlock();
    const truncated = full.slice(0, full.length - 5); // cut inside the sub-block
    expect(mod.patchGifLoopCount(truncated, 3)).toBe(false);
  });
});

describe('isGifsicleAvailable (issue #46: no main-thread WASM load)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('probes both assets with HEAD and returns true when both exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
    await expect(mod.isGifsicleAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toMatch(/encoder\/encoder\.(js|wasm)$/);
      expect(call[1]).toEqual({ method: 'HEAD' });
    }
    // The Emscripten module must NOT be executed by an availability probe
    expect(globalThis.Module).toBeUndefined();
  });

  it('caches a positive probe result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
    await mod.isGifsicleAvailable();
    await mod.isGifsicleAvailable();

    expect(fetchMock).toHaveBeenCalledTimes(2); // one probe, not two
  });

  it('returns false on 404 and allows a retry on the next call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
    await expect(mod.isGifsicleAvailable()).resolves.toBe(false);
    await expect(mod.isGifsicleAvailable()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(4); // negative result is not cached
  });

  it('returns false when the probe throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
    await expect(mod.isGifsicleAvailable()).resolves.toBe(false);
  });
});

describe('encoder.js integrity check (issue #50: SRI-style hash before new Function())', () => {
  const FAKE_JS_CODE =
    'self.__encoderExecuted = true;\n' +
    'Module._encoder_new = function () { return 1; };\n' +
    'Module.onRuntimeInitialized();\n';
  const EXPECTED_HASH = computeEncoderJsSha256Hex();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete globalThis.__encoderExecuted;
    // @ts-expect-error test cleanup
    delete globalThis.Module;
  });

  /** Stub fetch to serve FAKE_JS_CODE for encoder.js and empty bytes for encoder.wasm */
  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (/** @type {string} */ url) => {
        if (String(url).endsWith('.wasm')) {
          return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return { ok: true, text: async () => FAKE_JS_CODE };
      }),
    );
  }

  it('executes the glue when the computed hash matches the expected hash', async () => {
    stubFetch();
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(hexToArrayBuffer(EXPECTED_HASH));

    const mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
    const encoder = mod.createGifsicleEncoder();

    await expect(
      encoder.init({ width: 10, height: 10, frameDelayMs: 100, loopCount: 0 }),
    ).resolves.toBeUndefined();

    expect(globalThis.__encoderExecuted).toBe(true);
  });

  it('rejects and never executes the glue when the computed hash mismatches', async () => {
    stubFetch();
    // A digest that (overwhelmingly) will not equal the real expected hash.
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(32).fill(0xaa).buffer);

    const mod = await import('../../../src/features/export/encoders/gifsicle-encoder.js');
    const encoder = mod.createGifsicleEncoder();

    await expect(
      encoder.init({ width: 10, height: 10, frameDelayMs: 100, loopCount: 0 }),
    ).rejects.toThrow(/integrity/i);

    expect(globalThis.__encoderExecuted).toBeUndefined();
  });
});
