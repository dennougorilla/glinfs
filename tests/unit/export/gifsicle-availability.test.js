import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEncoderStatus } from '../../../src/features/export/api.js';
import { isGifsicleAvailable } from '../../../src/features/export/encoders/gifsicle-encoder.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Gifsicle availability probe (#46)', () => {
  it('uses a lightweight HEAD request instead of initializing Emscripten on the main thread', async () => {
    globalThis.fetch = vi.fn(async () => /** @type {Response} */ ({ ok: true }));

    await expect(isGifsicleAvailable()).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith('/glinfs/encoder/encoder.wasm', {
      method: 'HEAD',
      cache: 'force-cache',
    });
  });

  it('reports the WASM encoder only when the asset probe succeeds', async () => {
    globalThis.fetch = vi.fn(async () => /** @type {Response} */ ({ ok: true }));
    await expect(checkEncoderStatus()).resolves.toBe('gifsicle-wasm');

    globalThis.fetch = vi.fn(async () => /** @type {Response} */ ({ ok: false }));
    await expect(checkEncoderStatus()).resolves.toBe('gifenc-js');
  });

  it('falls back to gifenc when the availability request fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network unavailable');
    });

    await expect(checkEncoderStatus()).resolves.toBe('gifenc-js');
  });
});
