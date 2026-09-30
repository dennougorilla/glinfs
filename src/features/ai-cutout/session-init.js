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
 * caller allowed it, otherwise WEBGPU_MODEL_FAILED (the UI then offers the
 * explicit slow choice for this model; without any adapter the error is
 * WEBGPU_UNAVAILABLE instead). The warm-up also moves WebGPU's one-time
 * shader compilation out of the first frame.
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
 * @param {(session: SessionLike) => Promise<unknown>} [options.warmup] - The
 *   warm-up run of a graph that does not take one image tensor (the
 *   click-to-select encoder and decoder); replaces the blank-image run
 * @param {() => number} [options.now]
 * @returns {Promise<CreatedSession>}
 * @throws {SegmentationError} WEBGPU_UNAVAILABLE (no adapter, WASM not
 *   allowed), WEBGPU_MODEL_FAILED (this model failed on the adapter, WASM
 *   not allowed) or MODEL_INIT_FAILED (the WASM session could not be created)
 */
export async function createModelSession({
  ort,
  bytes,
  spec,
  adapter,
  allowWasm,
  warmupInput,
  warmup,
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
      const warmupStart = now();
      if (warmup) {
        await warmup(session);
      } else {
        const size = spec.inputSize;
        const input =
          warmupInput?.length === 3 * size * size
            ? warmupInput.fill(0)
            : new Float32Array(3 * size * size);
        await runModel(ort, session, spec, input);
      }
      return { session, backend: 'webgpu', warmupMs: now() - warmupStart, webgpuError: null };
    } catch (error) {
      webgpuError = `The model could not ${stage} on WebGPU: ${messageOf(error)}`;
      await session?.release?.().catch(() => undefined);
    }
  }

  if (!allowWasm) {
    throw webgpuError
      ? new SegmentationError(SegmentationErrorCode.WEBGPU_MODEL_FAILED, webgpuError)
      : new SegmentationError(
          SegmentationErrorCode.WEBGPU_UNAVAILABLE,
          'WebGPU is not available in this browser',
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

/**
 * @typedef {Object} LoadedBytes
 * @property {Uint8Array} bytes
 * @property {boolean} fromCache
 * @property {boolean} cached
 */

/**
 * Load a model and create its session, recovering from a damaged cached
 * copy. A cached copy is not hashed on load (it was verified before it was
 * stored); when its session cannot be created the copy is hashed now: one
 * that no longer matches is evicted and a fresh copy downloaded (fully
 * verified) for one more attempt, so a corrupt entry can never wedge the
 * feature. An intact copy that fails (e.g. the model cannot run on this
 * adapter) fails as it is: downloading the same bytes again would not help.
 * @template S
 * @param {Object} options
 * @param {(options: { skipCache?: boolean }) => Promise<LoadedBytes>} options.load
 * @param {(model: LoadedBytes) => Promise<S>} options.create
 * @param {(bytes: Uint8Array) => Promise<boolean>} options.isIntact - Size and SHA-256 still match
 * @param {() => Promise<unknown>} options.evict - Delete the cached copy
 * @param {() => void} [options.onVerify] - The cached copy is being hashed
 * @param {boolean} [options.cacheOnly] - Never download (preloading): a
 *   damaged copy is evicted and the original error rethrown
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ loaded: LoadedBytes, created: S, reloaded: boolean }>}
 */
export async function loadAndCreateSession({
  load,
  create,
  isIntact,
  evict,
  onVerify,
  cacheOnly = false,
  signal,
}) {
  const loaded = await load({});
  try {
    return { loaded, created: await create(loaded), reloaded: false };
  } catch (error) {
    if (!loaded.fromCache || signal?.aborted) throw error;
    onVerify?.();
    if (await isIntact(loaded.bytes)) throw error;
    if (signal?.aborted) throw error;
    // The cached copy is damaged: never use it again
    await evict();
    if (cacheOnly) throw error;
    const fresh = await load({ skipCache: true });
    return { loaded: fresh, created: await create(fresh), reloaded: true };
  }
}

/**
 * The backend of a model made of several sessions (SAM's encoder and
 * decoder). Each file falls back to WASM on its own, so the model runs on
 * WebGPU only when every session does: the slow one sets the pace.
 * @template {string} B
 * @param {B[]} backends - One per session, at least one
 * @returns {B}
 */
export function combineBackends(backends) {
  return backends.find((b) => b !== 'webgpu') ?? backends[0];
}
