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
 * @property {{__indirect_function_table?: WebAssembly.Table}} [asm]
 * @property {Uint8Array} HEAPU8
 */

/** @type {WasmModule | null} */
let wasmModule = null;

/** @type {Promise<WasmModule> | null} */
let wasmLoadPromise = null;

/**
 * The bundled Emscripten runtime exports addFunction but not removeFunction.
 * Keep one callback of each shape for the lifetime of the loaded module so
 * the indirect function table cannot grow once per frame/export.
 *
 * @type {number | null}
 */
let quantizeCallbackPtr = null;

/** @type {number | null} */
let finishCallbackPtr = null;

/** @type {{ imageLength: number, result: ArrayBuffer | null } | null} */
let activeQuantizeCallback = null;

/** @type {{ result: Uint8Array | null } | null} */
let activeFinishCallback = null;

/** Base path for encoder files */
const ENCODER_BASE_PATH = '/glinfs/encoder';

/** NETSCAPE2.0 application-extension prefix through the application identifier. */
const NETSCAPE_LOOP_PREFIX = /** @type {const} */ ([
  0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
]);

/**
 * Register the quantization callback once for the module lifetime.
 * Calls into the encoder are synchronous in its dedicated worker, so the
 * active context is safe to swap around each call.
 *
 * @param {WasmModule} module
 * @returns {number}
 */
function getQuantizeCallbackPtr(module) {
  if (quantizeCallbackPtr !== null) return quantizeCallbackPtr;

  quantizeCallbackPtr = module.addFunction(
    (
      /** @type {number} */ palettePtr,
      /** @type {number} */ paletteLength,
      /** @type {number} */ imagePtr,
    ) => {
      const context = activeQuantizeCallback;
      if (!context) return;

      const buffer = new ArrayBuffer(paletteLength + context.imageLength);
      const resultArray = new Uint8Array(buffer);
      resultArray.set(new Uint8Array(module.HEAPU8.buffer, palettePtr, paletteLength));
      resultArray.set(
        new Uint8Array(module.HEAPU8.buffer, imagePtr, context.imageLength),
        paletteLength,
      );
      context.result = buffer;
    },
    'viii',
  );

  return quantizeCallbackPtr;
}

/**
 * Register the finish callback once for the module lifetime.
 *
 * @param {WasmModule} module
 * @returns {number}
 */
function getFinishCallbackPtr(module) {
  if (finishCallbackPtr !== null) return finishCallbackPtr;

  finishCallbackPtr = module.addFunction(
    (/** @type {number} */ ptr, /** @type {number} */ length) => {
      const context = activeFinishCallback;
      if (!context) return;

      const bytes = new Uint8Array(length);
      bytes.set(new Uint8Array(module.HEAPU8.buffer, ptr, length));
      context.result = bytes;
    },
    'vii',
  );

  return finishCallbackPtr;
}

/**
 * Apply the configured repeat count to the GIF application extension.
 * The bundled C encoder always emits NETSCAPE2.0 with an infinite loop;
 * patching those two defined bytes avoids requiring a new C/WASM ABI.
 * If a future encoder omits the extension, insert a valid one immediately
 * after the logical screen descriptor and global color table.
 *
 * @param {Uint8Array} bytes
 * @param {number} loopCount 0 means infinite; otherwise the GIF repeat count
 * @returns {Uint8Array}
 */
function applyLoopCount(bytes, loopCount) {
  if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 0xffff) {
    throw new RangeError('Loop count must be an integer between 0 and 65535');
  }

  const low = loopCount & 0xff;
  const high = (loopCount >> 8) & 0xff;

  for (let i = 0; i <= bytes.length - NETSCAPE_LOOP_PREFIX.length; i++) {
    if (!NETSCAPE_LOOP_PREFIX.every((byte, offset) => bytes[i + offset] === byte)) continue;

    // Prefix is followed by: block size 3, sub-block ID 1, low, high, terminator 0.
    if (i + 18 >= bytes.length || bytes[i + 14] !== 0x03 || bytes[i + 15] !== 0x01) {
      throw new Error('Invalid NETSCAPE2.0 loop extension');
    }

    bytes[i + 16] = low;
    bytes[i + 17] = high;
    return bytes;
  }

  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    throw new Error('Invalid GIF output: missing header');
  }

  const hasGlobalColorTable = (bytes[10] & 0x80) !== 0;
  const colorTableBytes = hasGlobalColorTable ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0;
  const insertAt = 13 + colorTableBytes;
  if (insertAt > bytes.length) {
    throw new Error('Invalid GIF output: truncated global color table');
  }

  const extension = new Uint8Array([...NETSCAPE_LOOP_PREFIX, 0x03, 0x01, low, high, 0x00]);
  const output = new Uint8Array(bytes.length + extension.length);
  output.set(bytes.subarray(0, insertAt));
  output.set(extension, insertAt);
  output.set(bytes.subarray(insertAt), insertAt + extension.length);
  return output;
}

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

  const context = { imageLength: width * height, result: null };
  activeQuantizeCallback = context;

  try {
    module._quantize_image(width, height, ptr, getQuantizeCallbackPtr(module));
  } finally {
    activeQuantizeCallback = null;
    module._free(ptr);
  }

  if (!context.result) {
    throw new Error('Quantization failed: no result returned');
  }

  return context.result;
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
    addFrame(frameData, _frameIndex) {
      if (!module || !encoderPtr || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const { rgba, width, height } = frameData;

      // Quantize the frame
      const quantizedBuffer = quantizeFrame(module, rgba, width, height);

      // Copy quantized data to WASM memory
      const dataSize = quantizedBuffer.byteLength;
      const ptr = module._malloc(dataSize);
      const input = new Uint8Array(module.HEAPU8.buffer, ptr, dataSize);
      input.set(new Uint8Array(quantizedBuffer));

      // Add frame to encoder
      // Note: delay is in centiseconds (1/100th of a second)
      const delayCentiseconds = Math.round(config.frameDelayMs / 10);
      try {
        module._encoder_add_frame(encoderPtr, 0, 0, width, height, ptr, delayCentiseconds);
      } finally {
        module._free(ptr);
      }
    },

    /**
     * Complete encoding and get byte array
     * @returns {Uint8Array}
     */
    finish() {
      if (!module || !encoderPtr || !config) {
        throw new Error('Encoder not initialized. Call init() first.');
      }

      const context = { result: null };
      activeFinishCallback = context;

      try {
        module._encoder_finish(encoderPtr, getFinishCallbackPtr(module));
      } finally {
        activeFinishCallback = null;
        // The C ABI exposes no separate destroy function. Once finish is
        // attempted, do not reuse a pointer that encoder_finish may consume;
        // the worker itself is terminated by the caller on failure.
        encoderPtr = 0;
      }

      if (!context.result) {
        throw new Error('Encoding failed: no result returned');
      }

      return applyLoopCount(context.result, config.loopCount);
    },

    /**
     * Release resources
     */
    dispose() {
      // Note: encoder is deleted in encoder_finish, so we don't need to free it here
      encoderPtr = 0;
      config = null;
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
    // Availability checks run on the main thread. Only probe the static
    // asset here; the worker owns fetching and initializing Emscripten/WASM
    // for a real encoding job.
    const response = await fetch(`${ENCODER_BASE_PATH}/encoder.wasm`, {
      method: 'HEAD',
      cache: 'force-cache',
    });
    return response.ok;
  } catch {
    return false;
  }
}
