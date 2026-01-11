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
 * @property {Uint8Array} HEAPU8
 */

/** @type {WasmModule | null} */
let wasmModule = null;

/** @type {Promise<WasmModule> | null} */
let wasmLoadPromise = null;

/** Base path for encoder files */
const ENCODER_BASE_PATH = '/glinfs/encoder';

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
      // @ts-ignore - self is WorkerGlobalScope
      self.Module = Module;

      // Prepend code to reference the global Module we set
      // This ensures Emscripten picks up our pre-configured Module with wasmBinary
      const wrappedCode = 'var Module = self.Module;\n' + jsCode;

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

  const imageLength = width * height;
  /** @type {ArrayBuffer | null} */
  let result = null;

  // Create callback for quantize_image
  const cb = module.addFunction(
    (/** @type {number} */ palettePtr, /** @type {number} */ paletteLength, /** @type {number} */ imagePtr) => {
      const buffer = new ArrayBuffer(paletteLength + imageLength);
      const resultArray = new Uint8Array(buffer);
      resultArray.set(new Uint8Array(module.HEAPU8.buffer, palettePtr, paletteLength));
      resultArray.set(new Uint8Array(module.HEAPU8.buffer, imagePtr, imageLength), paletteLength);
      result = buffer;
    },
    'viii'
  );

  // Call quantize_image
  module._quantize_image(width, height, ptr, cb);

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
     * @param {number} frameIndex
     */
    addFrame(frameData, frameIndex) {
      if (!module || !encoderPtr || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const { rgba, width, height } = frameData;

      // Quantize the frame
      const quantizedBuffer = quantizeFrame(module, rgba, width, height);

      // Palette is at the beginning of the buffer (liq_palette struct size)
      // Based on libimagequant: liq_palette has count (4 bytes) + 256 * liq_color (4 bytes each) = 1028 bytes max
      // But actual size varies, let's use 1028 as standard
      const paletteLength = 1028;

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
      const cb = module.addFunction(
        (/** @type {number} */ ptr, /** @type {number} */ length) => {
          result = new Uint8Array(length);
          result.set(new Uint8Array(module.HEAPU8.buffer, ptr, length));
        },
        'vii'
      );

      // Finish encoding
      module._encoder_finish(encoderPtr, cb);

      if (!result) {
        throw new Error('Encoding failed: no result returned');
      }

      // Reset encoder pointer (it's deleted in C code)
      encoderPtr = 0;

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

/**
 * Get Gifsicle encoder metadata
 * @returns {EncoderMetadata}
 */
export function getGifsicleMetadata() {
  return METADATA;
}

/**
 * Check if Gifsicle WASM encoder is available
 * @returns {Promise<boolean>}
 */
export async function isGifsicleAvailable() {
  try {
    await loadWasmModule();
    return true;
  } catch {
    return false;
  }
}
