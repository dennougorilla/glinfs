/**
 * Gifsicle WASM Encoder Implementation
 * High-quality GIF encoder using libimagequant + gifsicle compiled to WASM
 * @module features/export/encoders/gifsicle-encoder
 */

/**
 * @typedef {import('./types.js').EncoderInterface} EncoderInterface
 * @typedef {import('./types.js').EncoderConfig} EncoderConfig
 * @typedef {import('./types.js').FrameData} FrameData
 * @typedef {import('./types.js').EncoderMetadata} EncoderMetadata
 */

/** @type {EncoderMetadata} */
const METADATA = {
  id: 'gifsicle-wasm',
  name: 'libimagequant (WASM)',
  description: 'Blazing fast, best quality color quantization',
  isWasm: true,
  version: '1.0.0',
  capabilities: {
    supportsMaxColors: false,
    supportsQuantizeFormat: false,
    supportsDithering: false,
  },
};

/**
 * @typedef {Object} WasmModule
 * @property {function(number, number): number} _encoder_new
 * @property {function(number, number, number, number, number, number, number): void} _encoder_add_frame
 * @property {function(number, number): void} _encoder_finish
 * @property {function(number, number, number, number): void} _quantize_image
 * @property {function(number): number} _malloc
 * @property {function(number): void} _free
 * @property {function(function, string): number} addFunction
 * @property {function(number): void} [removeFunction] - Absent from the current shipped build
 * @property {Uint8Array} HEAPU8
 */

/** @type {WasmModule | null} */
let wasmModule = null;

/** @type {Promise<WasmModule> | null} */
let wasmLoadPromise = null;

/**
 * Base path for encoder files, derived from Vite's base so it cannot drift
 * from vite.config.js (previously hardcoded '/glinfs/encoder').
 * BASE_URL always ends with '/'.
 */
const ENCODER_BASE_PATH = `${import.meta.env?.BASE_URL ?? '/'}encoder`;

/**
 * Load WASM module using fetch and dynamic execution
 * Works in ES module workers where importScripts is not available
 *
 * Security note: new Function() is used here to execute Emscripten-generated
 * code fetched from same-origin static files. This is necessary because
 * ES module workers don't support importScripts().
 *
 * @returns {Promise<WasmModule>}
 */
async function loadWasmModule() {
  if (wasmModule) {
    return wasmModule;
  }

  if (wasmLoadPromise) {
    return wasmLoadPromise;
  }

  wasmLoadPromise = (async () => {
    try {
      // Fetch both JS and WASM files in parallel
      const [jsResponse, wasmResponse] = await Promise.all([
        fetch(`${ENCODER_BASE_PATH}/encoder.js`),
        fetch(`${ENCODER_BASE_PATH}/encoder.wasm`),
      ]);

      if (!jsResponse.ok) {
        throw new Error(`Failed to fetch encoder.js: ${jsResponse.status}`);
      }
      if (!wasmResponse.ok) {
        throw new Error(`Failed to fetch encoder.wasm: ${wasmResponse.status}`);
      }

      const jsCode = await jsResponse.text();
      const wasmBinary = await wasmResponse.arrayBuffer();

      // Create Module configuration before executing Emscripten code
      // Provide wasmBinary to skip the fetch in Emscripten's loader
      /** @type {any} */
      const Module = {
        wasmBinary: new Uint8Array(wasmBinary),
        onRuntimeInitialized: null,
      };

      // Create promise that resolves when WASM runtime is ready
      /** @type {Promise<WasmModule>} */
      const readyPromise = new Promise((resolve) => {
        Module.onRuntimeInitialized = () => {
          wasmModule = Module;
          resolve(Module);
        };
      });

      // Inject Module into the code scope
      // new Function() creates isolated scope, so we need to prepend Module definition
      // The Emscripten code checks: var Module=typeof Module!="undefined"?Module:{}
      // By setting it before, the code will use our pre-configured Module
      // @ts-expect-error - self is WorkerGlobalScope
      self.Module = Module;

      // Prepend code to reference the global Module we set
      // This ensures Emscripten picks up our pre-configured Module with wasmBinary
      const wrappedCode = `var Module = self.Module;\n${jsCode}`;

      // Execute the Emscripten-generated code from same-origin static files
      // eslint-disable-next-line no-new-func
      const executeCode = new Function(wrappedCode);
      executeCode();

      // Wait for initialization to complete
      return await readyPromise;
    } catch (error) {
      wasmLoadPromise = null; // Reset so retry is possible
      throw new Error(`Failed to load WASM encoder: ${error}`);
    }
  })();

  return wasmLoadPromise;
}

/**
 * Reusable function-table slot for the quantize callback.
 *
 * quantizeFrame runs once per encoded frame, and the shipped Emscripten
 * build exports addFunction but NOT removeFunction — so a per-call
 * addFunction would leak one table slot per frame until the table growth
 * limit is hit. Instead one slot is registered per module and reused;
 * per-call state is passed through quantizeCall.
 *
 * Safe because the callback runs synchronously inside _quantize_image and
 * the worker is single-threaded: quantizeCall cannot be reentered.
 * @type {number | null}
 */
let quantizeCbSlot = null;

/** @type {WasmModule | null} Module the cached slot was registered on */
let quantizeCbModule = null;

/** @type {{ imageLength: number, result: ArrayBuffer | null } | null} */
let quantizeCall = null;

/**
 * Quantize a frame using libimagequant
 * @param {WasmModule} module - WASM module
 * @param {Uint8ClampedArray} rgba - RGBA pixel data
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @returns {ArrayBuffer} Combined palette and indexed image data
 */
function quantizeFrame(module, rgba, width, height) {
  const inputSize = rgba.byteLength;
  const ptr = module._malloc(inputSize);

  // Copy input data to WASM memory
  const input = new Uint8Array(module.HEAPU8.buffer, ptr, inputSize);
  input.set(rgba);

  // Register the shared callback once per module instance
  if (quantizeCbSlot === null || quantizeCbModule !== module) {
    quantizeCbSlot = module.addFunction(
      (
        /** @type {number} */ palettePtr,
        /** @type {number} */ paletteLength,
        /** @type {number} */ imagePtr,
      ) => {
        if (!quantizeCall) return;
        const buffer = new ArrayBuffer(paletteLength + quantizeCall.imageLength);
        const resultArray = new Uint8Array(buffer);
        resultArray.set(new Uint8Array(module.HEAPU8.buffer, palettePtr, paletteLength));
        resultArray.set(
          new Uint8Array(module.HEAPU8.buffer, imagePtr, quantizeCall.imageLength),
          paletteLength,
        );
        quantizeCall.result = buffer;
      },
      'viii',
    );
    quantizeCbModule = module;
  }

  // Call quantize_image (the callback runs synchronously inside this call)
  quantizeCall = { imageLength: width * height, result: null };
  module._quantize_image(width, height, ptr, quantizeCbSlot);
  const result = quantizeCall.result;
  quantizeCall = null;

  // Free input memory
  module._free(ptr);

  if (!result) {
    throw new Error('Quantization failed: no result returned');
  }

  return result;
}

/**
 * Create Gifsicle WASM encoder
 * @returns {EncoderInterface}
 */
export function createGifsicleEncoder() {
  /** @type {WasmModule | null} */
  let module = null;

  /** @type {number} */
  let encoderPtr = 0;

  /** @type {EncoderConfig | null} */
  let config = null;

  /** @type {Array<{buffer: ArrayBuffer, paletteLength: number, width: number, height: number, delay: number}>} */
  const pendingFrames = [];

  return {
    metadata: METADATA,

    /**
     * Initialize encoder
     * @param {EncoderConfig} encoderConfig
     */
    async init(encoderConfig) {
      config = encoderConfig;

      // Load WASM module
      module = await loadWasmModule();

      // Create encoder instance
      encoderPtr = module._encoder_new(encoderConfig.width, encoderConfig.height);

      if (!encoderPtr) {
        throw new Error('Failed to create Gifsicle encoder');
      }
    },

    /**
     * Add frame
     * @param {FrameData} frameData
     * @param {number} _frameIndex - Unused; frames are appended in call order
     */
    addFrame(frameData, _frameIndex) {
      if (!module || !encoderPtr || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const { rgba, width, height } = frameData;

      // Quantize the frame. The buffer starts with the liq_palette struct
      // (count + 256 colors ≈ 1028 bytes) followed by the indexed image;
      // _encoder_add_frame consumes the combined layout as-is.
      const quantizedBuffer = quantizeFrame(module, rgba, width, height);

      // Copy quantized data to WASM memory
      const dataSize = quantizedBuffer.byteLength;
      const ptr = module._malloc(dataSize);
      const input = new Uint8Array(module.HEAPU8.buffer, ptr, dataSize);
      input.set(new Uint8Array(quantizedBuffer));

      // Add frame to encoder
      // Note: delay is in centiseconds (1/100th of a second)
      const delayCentiseconds = Math.round(config.frameDelayMs / 10);
      module._encoder_add_frame(encoderPtr, 0, 0, width, height, ptr, delayCentiseconds);

      // Free memory
      module._free(ptr);
    },

    /**
     * Complete encoding and get byte array
     * @returns {Uint8Array}
     */
    finish() {
      if (!module || !encoderPtr) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      /** @type {Uint8Array | null} */
      let result = null;

      // Create callback for encoder_finish
      const cb = module.addFunction((/** @type {number} */ ptr, /** @type {number} */ length) => {
        result = new Uint8Array(length);
        result.set(new Uint8Array(module.HEAPU8.buffer, ptr, length));
      }, 'vii');

      // Finish encoding (the callback runs synchronously inside this call)
      module._encoder_finish(encoderPtr, cb);

      // Release the function-table slot when the build exports
      // removeFunction (the current shipped glue does not — this runs once
      // per encode, so the fallback leak is a single slot per worker)
      module.removeFunction?.(cb);

      if (!result) {
        throw new Error('Encoding failed: no result returned');
      }

      // Reset encoder pointer (it's deleted in C code)
      encoderPtr = 0;

      // The WASM API (_encoder_new/_encoder_add_frame/_encoder_finish) has
      // no loop-count parameter, so honor the setting by patching the
      // NETSCAPE application extension in the produced bytes (issue #46/#50).
      const loopCount = config?.loopCount;
      if (typeof loopCount === 'number' && loopCount >= 0) {
        const patched = patchGifLoopCount(result, loopCount);
        if (!patched && loopCount > 0) {
          console.warn(
            '[gifsicle-encoder] NETSCAPE loop block not found; loopCount setting ignored',
          );
        }
      }

      return result;
    },

    /**
     * Release resources
     */
    dispose() {
      // Note: encoder is deleted in encoder_finish, so we don't need to free it here
      encoderPtr = 0;
      config = null;
      pendingFrames.length = 0;
      // Keep module loaded for reuse
    },
  };
}

/** Bytes of the "NETSCAPE2.0" application identifier */
const NETSCAPE_MARKER = [0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30];

/**
 * Patch the loop count of an encoded GIF in place.
 *
 * GIF stores looping in the NETSCAPE2.0 application extension:
 *   21 FF 0B "NETSCAPE2.0" 03 01 <count u16 LE> 00
 * where count 0 means loop forever — the same semantics as the app's
 * loopCount setting and gifenc's `repeat`.
 *
 * @param {Uint8Array} bytes - Encoded GIF (mutated in place)
 * @param {number} loopCount - 0 for infinite, 1+ for a specific count
 * @returns {boolean} true if a NETSCAPE block was found and patched
 */
export function patchGifLoopCount(bytes, loopCount) {
  const value = Math.max(0, Math.min(0xffff, Math.floor(loopCount)));
  // Extension introducer (21) + label (FF) + block size (0B) + 11-byte
  // identifier + sub-block (03 01 lo hi) must all fit before the end.
  for (let i = 0; i + 17 < bytes.length; i++) {
    if (bytes[i] !== 0x21 || bytes[i + 1] !== 0xff || bytes[i + 2] !== 0x0b) continue;

    let matches = true;
    for (let j = 0; j < NETSCAPE_MARKER.length; j++) {
      if (bytes[i + 3 + j] !== NETSCAPE_MARKER[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    if (bytes[i + 14] !== 0x03 || bytes[i + 15] !== 0x01) continue;

    bytes[i + 16] = value & 0xff;
    bytes[i + 17] = (value >> 8) & 0xff;
    return true;
  }
  return false;
}

/**
 * Get Gifsicle encoder metadata
 * @returns {EncoderMetadata}
 */
export function getGifsicleMetadata() {
  return METADATA;
}

/** @type {Promise<boolean> | null} */
let availabilityPromise = null;

/**
 * Check if Gifsicle WASM encoder is available.
 *
 * This runs on the export screen's main thread (via checkEncoderStatus), so
 * it must stay cheap: probe the static assets with HEAD requests instead of
 * downloading and compiling the whole Emscripten module here (issue #46 —
 * the old implementation double-loaded the WASM and polluted the global
 * Module). The real load happens inside the encoder worker on first use.
 *
 * @returns {Promise<boolean>}
 */
export async function isGifsicleAvailable() {
  if (wasmModule) {
    return true;
  }

  if (!availabilityPromise) {
    availabilityPromise = (async () => {
      try {
        const [js, wasm] = await Promise.all([
          fetch(`${ENCODER_BASE_PATH}/encoder.js`, { method: 'HEAD' }),
          fetch(`${ENCODER_BASE_PATH}/encoder.wasm`, { method: 'HEAD' }),
        ]);
        const ok = js.ok && wasm.ok;
        if (!ok) {
          // Allow a later retry (e.g. transient 5xx during deploy)
          availabilityPromise = null;
        }
        return ok;
      } catch {
        availabilityPromise = null;
        return false;
      }
    })();
  }

  return availabilityPromise;
}
