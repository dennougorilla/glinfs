import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGifsicleEncoder } from '../../../src/features/export/encoders/gifsicle-encoder.js';

/** @type {PropertyDescriptor | undefined} */
const originalProcessDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
/** @type {PropertyDescriptor | undefined} */
const originalModuleDescriptor = Object.getOwnPropertyDescriptor(self, 'Module');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalProcessDescriptor) {
    Object.defineProperty(globalThis, 'process', originalProcessDescriptor);
  }
  if (originalModuleDescriptor) {
    Object.defineProperty(self, 'Module', originalModuleDescriptor);
  } else {
    delete self.Module;
  }
});

function createFrame() {
  return {
    rgba: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]),
    width: 2,
    height: 2,
  };
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function readNetscapeLoopCount(bytes) {
  const identifier = new TextEncoder().encode('NETSCAPE2.0');

  outer: for (let i = 0; i <= bytes.length - identifier.length; i++) {
    for (let offset = 0; offset < identifier.length; offset++) {
      if (bytes[i + offset] !== identifier[offset]) continue outer;
    }
    return bytes[i + 13] | (bytes[i + 14] << 8);
  }

  throw new Error('NETSCAPE2.0 extension not found');
}

describe('Gifsicle compiled WASM integration (#50)', () => {
  it('reuses callback table slots and writes loopCount into the real GIF output', async () => {
    const encoderJs = await readFile(resolve('public/encoder/encoder.js'), 'utf8');
    const wasmFile = await readFile(resolve('public/encoder/encoder.wasm'));
    const wasmBytes = new Uint8Array(wasmFile);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('.js')) {
          return /** @type {Response} */ ({ ok: true, text: async () => encoderJs });
        }
        return /** @type {Response} */ ({
          ok: true,
          arrayBuffer: async () => wasmBytes.slice().buffer,
        });
      }),
    );

    // Emscripten's browser/worker environment detection sees Vitest's Node
    // process otherwise. The production module worker has no process global.
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const firstEncoder = createGifsicleEncoder();
      await firstEncoder.init({
        width: 2,
        height: 2,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 513,
      });

      const table = /** @type {{asm: {__indirect_function_table: WebAssembly.Table}}} */ (
        self.Module
      ).asm.__indirect_function_table;
      const initialTableLength = table.length;
      const frame = createFrame();

      for (let i = 0; i < 25; i++) firstEncoder.addFrame(frame, i);
      expect(table.length).toBe(initialTableLength + 1);

      const firstGif = firstEncoder.finish();
      expect(table.length).toBe(initialTableLength + 2);
      expect(readNetscapeLoopCount(firstGif)).toBe(513);

      // A second encoder in the same loaded module reuses both callbacks;
      // neither frames nor finish may grow the indirect function table.
      const secondEncoder = createGifsicleEncoder();
      await secondEncoder.init({
        width: 2,
        height: 2,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 7,
      });
      for (let i = 0; i < 25; i++) secondEncoder.addFrame(frame, i);
      const secondGif = secondEncoder.finish();

      expect(table.length).toBe(initialTableLength + 2);
      expect(readNetscapeLoopCount(secondGif)).toBe(7);
    } finally {
      if (originalProcessDescriptor) {
        Object.defineProperty(globalThis, 'process', originalProcessDescriptor);
      }
    }
  });
});
