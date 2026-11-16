/**
 * Model probe worker: reads an ONNX file the user wants to add, inspects
 * its graph and runs a test frame through it (Settings → AI models → Add
 * model). One worker per Add model dialog; the dialog terminates it when
 * it closes, which frees the file and the session.
 * @module workers/model-probe-worker
 *
 * - 'open': read a local File (structured-cloned, read here) or download a
 *   URL (CORS, allowed hosts only: model-hosts.js), hash it (SHA-256), and
 *   create a session to read the graph's inputs and outputs. The session
 *   is created on WebGPU when the browser has an adapter (the backend the
 *   model will run on); when WebGPU cannot create it, the graph is read
 *   from a WASM session instead and the WebGPU error is kept for the test.
 *   Without any adapter the session is WASM (the test then says so).
 * - 'test': run one generated frame (custom-models.js createTestFrame)
 *   with the settings the user chose and judge the output (NaN, values
 *   outside 0..1, an empty or full mask: assessTestOutput).
 * - 'save': put the bytes into the model cache under the key the app
 *   loads the model with (nothing leaves the device).
 *
 * The file is never sent anywhere: a URL is only downloaded from.
 *
 * Messages in:  { type, id, ... }  (see the handlers below)
 * Messages out: { type: 'progress', id, loadedBytes, totalBytes }
 *               { type: 'result', id, ok: true, value } | { type: 'result', id, ok: false, error }
 */

import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import * as ort from 'onnxruntime-web/webgpu';
import {
  assessTestOutput,
  createTestFrame,
  LARGE_MODEL_BYTES,
  MAX_MODEL_BYTES,
  NORMALIZATIONS,
} from '../features/ai-cutout/custom-models.js';
import { MODEL_CACHE_NAME } from '../features/ai-cutout/model-config.js';
import { downloadUnpinnedModel, toHex } from '../features/ai-cutout/model-loader.js';
import { rgbaToChw } from '../features/ai-cutout/preprocess.js';
import {
  SegmentationError,
  SegmentationErrorCode,
  toErrorPayload,
} from '../features/ai-cutout/protocol.js';

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

/** Side of the mask preview the test sends back */
const PREVIEW_SIZE = 96;

/** Minimum interval between progress messages */
const PROGRESS_INTERVAL_MS = 100;

/**
 * @typedef {Object} ProbeState
 * @property {Uint8Array | null} bytes
 * @property {string} sha256
 * @property {any} session
 * @property {'webgpu' | 'wasm' | null} backend
 * @property {string | null} webgpuError - Why WebGPU could not create the session
 * @property {boolean} hasAdapter
 */

/** @type {ProbeState} */
const state = {
  bytes: null,
  sha256: '',
  session: null,
  backend: null,
  webgpuError: null,
  hasAdapter: false,
};

/** @type {AbortController | null} */
let downloadController = null;

/**
 * @param {Object} message
 * @param {Transferable[]} [transfer]
 */
function post(message, transfer = []) {
  self.postMessage(message, transfer);
}

/** @returns {Promise<GPUAdapter | null>} */
async function requestAdapter() {
  const gpu = /** @type {any} */ (self.navigator).gpu;
  if (!gpu) return null;
  try {
    return (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Plain description of ORT value metadata
 * @param {readonly any[] | undefined} metadata
 * @param {readonly string[]} names
 */
function describeValues(metadata, names) {
  return names.map((name, i) => {
    const meta = metadata?.[i] ?? {};
    const isTensor = meta.isTensor !== false;
    return {
      name,
      isTensor,
      type: isTensor ? String(meta.type ?? '') || undefined : undefined,
      shape:
        isTensor && Array.isArray(meta.shape)
          ? meta.shape.map((/** @type {unknown} */ dim) =>
              typeof dim === 'number' || typeof dim === 'string' ? dim : null,
            )
          : undefined,
    };
  });
}

async function releaseSession() {
  const session = state.session;
  state.session = null;
  await session?.release?.().catch(() => undefined);
}

/**
 * Read a local file with progress
 * @param {File} file
 * @param {(loaded: number) => void} onChunk
 * @returns {Promise<Uint8Array>}
 */
async function readFile(file, onChunk) {
  const bytes = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > bytes.length)
      throw new Error('The file changed while it was read');
    bytes.set(value, loaded);
    loaded += value.byteLength;
    onChunk(loaded);
  }
  return loaded === bytes.length ? bytes : bytes.slice(0, loaded);
}

/**
 * Create the session that is inspected and tested
 * @param {Uint8Array} bytes
 */
async function createSession(bytes) {
  const adapter = await requestAdapter();
  state.hasAdapter = Boolean(adapter);
  state.webgpuError = null;
  if (adapter) {
    try {
      ort.env.webgpu.adapter = /** @type {any} */ (adapter);
      state.session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      state.backend = 'webgpu';
      return;
    } catch (error) {
      state.webgpuError = `The model could not be loaded on WebGPU: ${messageOf(error)}`;
    }
  }
  try {
    state.session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'disabled',
    });
    state.backend = 'wasm';
  } catch (error) {
    throw new SegmentationError(
      SegmentationErrorCode.MODEL_INIT_FAILED,
      `This file could not be read as an ONNX model: ${messageOf(error)}`,
    );
  }
}

/**
 * Handle 'open'
 * @param {{ id: number, source: { kind: 'file', file: File } | { kind: 'url', url: string }, allowLarge?: boolean, expect?: { bytes: number, sha256: string } }} message
 */
async function open(message) {
  await releaseSession();
  state.bytes = null;
  state.sha256 = '';
  const { id, source, allowLarge = false, expect } = message;
  let lastProgressAt = 0;
  const progress = (/** @type {number} */ loadedBytes, /** @type {number | null} */ totalBytes) => {
    const now = performance.now();
    if (loadedBytes !== totalBytes && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    post({ type: 'progress', id, loadedBytes, totalBytes });
  };
  /** @type {Uint8Array} */
  let bytes;
  let sha256;
  if (source.kind === 'file') {
    const { size } = source.file;
    if (size > MAX_MODEL_BYTES) {
      throw new SegmentationError(
        SegmentationErrorCode.DOWNLOAD_FAILED,
        'The file is larger than 2 GB. ONNX files that large keep their weights in separate files, which this app cannot load.',
      );
    }
    if (size > LARGE_MODEL_BYTES && !allowLarge) return { needsConfirm: size };
    bytes = await readFile(source.file, (loaded) => progress(loaded, size));
    sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes));
  } else {
    downloadController = new AbortController();
    /** @type {number | null} */
    let announced = null;
    const downloaded = await downloadUnpinnedModel(source.url, {
      maxBytes: MAX_MODEL_BYTES,
      signal: downloadController.signal,
      confirmSize: (totalBytes) => {
        announced = totalBytes;
        return allowLarge || totalBytes === null || totalBytes <= LARGE_MODEL_BYTES;
      },
      onProgress: ({ loadedBytes, totalBytes }) => progress(loadedBytes, totalBytes),
    }).finally(() => {
      downloadController = null;
    });
    if (!downloaded) return { needsConfirm: announced };
    if (!allowLarge && downloaded.bytes.byteLength > LARGE_MODEL_BYTES) {
      // No size was announced: confirm now (the bytes are kept meanwhile)
      state.bytes = downloaded.bytes;
      state.sha256 = downloaded.sha256;
      return { needsConfirm: downloaded.bytes.byteLength, downloaded: true };
    }
    bytes = downloaded.bytes;
    sha256 = downloaded.sha256;
  }
  if (expect && (bytes.byteLength !== expect.bytes || sha256 !== expect.sha256)) {
    throw new SegmentationError(
      SegmentationErrorCode.HASH_MISMATCH,
      `This is not the file the model definition names: it has ${bytes.byteLength} bytes and the SHA-256 ${sha256}, the definition ${expect.bytes} bytes and ${expect.sha256}.`,
    );
  }
  state.bytes = bytes;
  state.sha256 = sha256;
  return inspect();
}

/** Create the session for the loaded bytes and describe the graph */
async function inspect() {
  const bytes = /** @type {Uint8Array} */ (state.bytes);
  await createSession(bytes);
  const session = state.session;
  return {
    bytes: bytes.byteLength,
    sha256: state.sha256,
    backend: state.backend,
    hasAdapter: state.hasAdapter,
    webgpuError: state.webgpuError,
    graph: {
      inputs: describeValues(session.inputMetadata, session.inputNames),
      outputs: describeValues(session.outputMetadata, session.outputNames),
    },
  };
}

/**
 * Handle 'test': one generated frame through the model with `settings`
 * @param {{ settings: { inputName: string, outputName: string, inputSize: number, normalization: 'unit' | 'imagenet' | 'symmetric', output: 'probability' | 'logits' } }} message
 */
async function test({ settings }) {
  if (!state.session) throw new Error('No model is open');
  if (state.webgpuError) {
    return {
      ok: false,
      problem: 'webgpu',
      message: describeWebgpuFailure(state.webgpuError),
      backend: state.backend,
    };
  }
  const size = settings.inputSize;
  const rgba = createTestFrame(size);
  const { mean, std } = NORMALIZATIONS[settings.normalization];
  const input = rgbaToChw(rgba, size, size, undefined, { scale: 1 / 255, mean, std });
  const start = performance.now();
  /** @type {Float32Array} */
  let values;
  try {
    const feeds = { [settings.inputName]: new ort.Tensor('float32', input, [1, 3, size, size]) };
    const outputs = await state.session.run(feeds, [settings.outputName]);
    const output = outputs[settings.outputName];
    try {
      if (!output) throw new Error(`The model has no output named "${settings.outputName}"`);
      if (output.type !== 'float32') {
        throw new Error(`The output "${settings.outputName}" is ${output.type}, not float32`);
      }
      values = /** @type {Float32Array} */ (await output.getData());
    } finally {
      for (const tensor of Object.values(outputs)) /** @type {any} */ (tensor)?.dispose?.();
    }
  } catch (error) {
    const message = messageOf(error);
    return {
      ok: false,
      problem: 'run',
      message:
        state.backend === 'webgpu'
          ? describeWebgpuFailure(`The model could not run on WebGPU: ${message}`)
          : `The model could not run: ${message}`,
      backend: state.backend,
    };
  }
  const inferenceMs = performance.now() - start;
  if (values.length !== size * size) {
    return {
      ok: false,
      problem: 'shape',
      message: `The output "${settings.outputName}" has ${values.length} values, not ${size} × ${size}. Choose the input size the model was made for.`,
      backend: state.backend,
    };
  }
  const assessment = assessTestOutput(values, settings.output);
  const preview = assessment.problem === 'nan' ? null : maskPreview(values, size, settings.output);
  return {
    ...assessment,
    backend: state.backend,
    inferenceMs,
    preview: preview ? { size: PREVIEW_SIZE, data: preview.buffer } : null,
  };
}

/**
 * Add what a WebGPU failure usually means for an exported model
 * @param {string} message
 * @returns {string}
 */
function describeWebgpuFailure(message) {
  if (/storage buffer/i.test(message)) {
    return `${message}. The graph needs more storage buffers in one shader than WebGPU allows (typically a Split or Concat of many tensors); this file cannot run in the browser as it is.`;
  }
  if (/out of memory|allocation|OOM/i.test(message)) {
    return `${message}. The GPU ran out of memory for this model.`;
  }
  return message;
}

/**
 * A PREVIEW_SIZE² 0..255 preview of the mask (nearest sample)
 * @param {Float32Array} values
 * @param {number} size
 * @param {'probability' | 'logits'} kind
 * @returns {Uint8Array}
 */
function maskPreview(values, size, kind) {
  const out = new Uint8Array(PREVIEW_SIZE * PREVIEW_SIZE);
  for (let y = 0; y < PREVIEW_SIZE; y++) {
    const sy = Math.min(size - 1, Math.floor(((y + 0.5) * size) / PREVIEW_SIZE));
    for (let x = 0; x < PREVIEW_SIZE; x++) {
      const sx = Math.min(size - 1, Math.floor(((x + 0.5) * size) / PREVIEW_SIZE));
      const raw = values[sy * size + sx];
      const p = kind === 'logits' ? 1 / (1 + Math.exp(-raw)) : raw;
      out[y * PREVIEW_SIZE + x] = p <= 0 ? 0 : p >= 1 ? 255 : Math.round(p * 255);
    }
  }
  return out;
}

/**
 * Handle 'save': keep the bytes in the model cache under `cacheKey`
 * @param {{ cacheKey: string }} message
 */
async function save({ cacheKey }) {
  if (!state.bytes) throw new Error('No model is open');
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.put(
      cacheKey,
      new Response(state.bytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(state.bytes.byteLength),
        },
      }),
    );
  } catch (error) {
    throw new SegmentationError(
      SegmentationErrorCode.DOWNLOAD_FAILED,
      `This browser could not store the model (${messageOf(error)}). Free some space and try again.`,
    );
  }
  return { cached: true };
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === 'cancel') {
    downloadController?.abort();
    return;
  }
  /** @type {Promise<unknown> | null} */
  let run = null;
  if (message?.type === 'open') run = open(message);
  else if (message?.type === 'confirm-downloaded') run = inspect();
  else if (message?.type === 'test') run = test(message);
  else if (message?.type === 'save') run = save(message);
  if (!run) return;
  run.then(
    (value) => post({ type: 'result', id: message.id, ok: true, value }),
    (error) =>
      post({
        type: 'result',
        id: message.id,
        ok: false,
        error: toErrorPayload(error, SegmentationErrorCode.MODEL_INIT_FAILED),
      }),
  );
};
