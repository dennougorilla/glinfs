/**
 * ONNX Runtime session creation with a warm-up run (segmentation worker)
 * @module features/ai-cutout/session-init
 *
 * Creating an InferenceSession on ['webgpu'] is not proof the model runs
 * there: several models create fine and only fail on their first run (a
 * shader that exceeds the adapter's limits, an invalid pipeline, an
 * allocation failure). So the WebGPU session runs one warm-up inference on
 * a blank input before the worker reports ready; a warm-up failure is
 * handled exactly like a failed WebGPU create — the WASM fallback when the
 * caller allowed it, otherwise WEBGPU_UNAVAILABLE (the UI then offers the
 * explicit slow choice). The warm-up also moves WebGPU's one-time shader
 * compilation out of the first frame.
 *
 * The WASM session gets no warm-up: a 1024×1024 run takes about 14 s on
 * the CPU, which would double the wait for the first frame, and the WASM
 * EP has no first-run-only failure mode to catch.
 *
 * `ort` is injected so this is unit-tested without ONNX Runtime.
 */

import { SegmentationError, SegmentationErrorCode } from './protocol.js';

/** @typedef {import('./model-config.js').ModelSpec} ModelSpec */

/**
 * The subset of ONNX Runtime this module uses.
 * @typedef {Object} OrtLike
 * @property {{ create: (bytes: Uint8Array, options: Object) => Promise<SessionLike> }} InferenceSession
 * @property {new (type: 'float32', data: Float32Array, dims: number[]) => unknown} Tensor
 * @property {{ webgpu: { adapter?: unknown } }} env
 */

/**
 * @typedef {Object} SessionLike
 * @property {(feeds: Record<string, unknown>, fetches?: string[]) => Promise<Record<string, { getData?: () => Promise<unknown>, dispose?: () => void }>>} run
 * @property {() => Promise<void>} [release]
 */

/**
 * @typedef {Object} CreatedSession
 * @property {SessionLike} session
 * @property {'webgpu' | 'wasm'} backend
 * @property {number | null} warmupMs - Time of the WebGPU warm-up run (null on WASM)
 * @property {string | null} webgpuError - Why WebGPU was not used, when an adapter existed
 */

/**
 * Output names to fetch: the mask alone, unless the DEV-only
 * `fetchAllOutputs` asks for every graph output. Models with side outputs
 * (the general IS-Net has 12) would otherwise copy all of them back from
 * the GPU on every frame.
 * @param {ModelSpec} spec
 * @returns {string[] | undefined}
 */
export function getFetches(spec) {
  return spec.fetchAllOutputs ? undefined : [spec.outputName];
}

/**
 * Run the model once and return its mask output's data. Every output
 * tensor is disposed.
 * @param {OrtLike} ort
 * @param {SessionLike} session
 * @param {ModelSpec} spec
 * @param {Float32Array} inputData - 3 × inputSize × inputSize values
 * @returns {Promise<Float32Array>}
 */
export async function runModel(ort, session, spec, inputData) {
  const size = spec.inputSize;
  const input = new ort.Tensor('float32', inputData, [1, 3, size, size]);
  const fetches = getFetches(spec);
  const outputs = fetches
    ? await session.run({ [spec.inputName]: input }, fetches)
    : await session.run({ [spec.inputName]: input });
  try {
    const output = outputs[spec.outputName];
    if (!output?.getData) {
      throw new Error(`The model has no output named "${spec.outputName}"`);
    }
    return /** @type {Float32Array} */ (await output.getData());
  } finally {
    for (const tensor of Object.values(outputs)) {
      tensor?.dispose?.();
    }
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
 * Create the session: WebGPU (verified by a warm-up run) when an adapter
 * exists, else — or when WebGPU fails — WASM if allowed.
 * @param {Object} options
 * @param {OrtLike} options.ort
 * @param {Uint8Array} options.bytes - Verified model bytes
 * @param {ModelSpec} options.spec
 * @param {unknown} options.adapter - The GPUAdapter, or null
 * @param {boolean} options.allowWasm
 * @param {Float32Array} [options.warmupInput] - Reused buffer for the blank input (zeroed here)
 * @param {() => number} [options.now]
 * @returns {Promise<CreatedSession>}
 * @throws {SegmentationError} WEBGPU_UNAVAILABLE (WebGPU failed, WASM not
 *   allowed) or MODEL_INIT_FAILED (the WASM session could not be created)
 */
export async function createModelSession({
  ort,
  bytes,
  spec,
  adapter,
  allowWasm,
  warmupInput,
  now = () => performance.now(),
}) {
  /** @type {string | null} */
  let webgpuError = null;
  if (adapter) {
    /** @type {SessionLike | null} */
    let session = null;
    let stage = 'start';
    try {
      ort.env.webgpu.adapter = adapter;
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      stage = 'run';
      const size = spec.inputSize;
      const input =
        warmupInput?.length === 3 * size * size
          ? warmupInput.fill(0)
          : new Float32Array(3 * size * size);
      const warmupStart = now();
      await runModel(ort, session, spec, input);
      return { session, backend: 'webgpu', warmupMs: now() - warmupStart, webgpuError: null };
    } catch (error) {
      webgpuError = `The model could not ${stage} on WebGPU: ${messageOf(error)}`;
      await session?.release?.().catch(() => undefined);
    }
  }

  if (!allowWasm) {
    throw new SegmentationError(
      SegmentationErrorCode.WEBGPU_UNAVAILABLE,
      webgpuError ?? 'WebGPU is not available in this browser',
    );
  }
  try {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { session, backend: 'wasm', warmupMs: null, webgpuError };
  } catch (error) {
    throw new SegmentationError(
      SegmentationErrorCode.MODEL_INIT_FAILED,
      `The model could not be loaded: ${messageOf(error)}`,
    );
  }
}
