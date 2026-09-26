import { describe, expect, it, vi } from 'vitest';
import { getModelSpec } from '../../../src/features/ai-cutout/model-config.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';
import {
  createModelSession,
  getFetches,
  runModel,
} from '../../../src/features/ai-cutout/session-init.js';

const SIZE = 4;
const GENERAL = { ...getModelSpec('general'), inputSize: SIZE };
const ANIME = { ...getModelSpec('anime'), inputSize: SIZE };

/**
 * Fake ONNX Runtime: sessions per provider, scripted to fail at create or
 * at run.
 * @param {{ webgpu?: 'ok' | 'create-fails' | 'run-fails', wasm?: 'ok' | 'create-fails' }} [script]
 */
function fakeOrt(script = {}) {
  const { webgpu = 'ok', wasm = 'ok' } = script;
  /** @type {any[]} */
  const sessions = [];
  const ort = {
    env: { webgpu: /** @type {{ adapter?: unknown }} */ ({}) },
    Tensor: class {
      /**
       * @param {string} type
       * @param {Float32Array} data
       * @param {number[]} dims
       */
      constructor(type, data, dims) {
        Object.assign(this, { type, data, dims });
      }
    },
    InferenceSession: {
      create: vi.fn(async (_bytes, /** @type {any} */ options) => {
        const provider = options.executionProviders[0];
        const mode = provider === 'webgpu' ? webgpu : wasm;
        if (mode === 'create-fails') throw new Error(`${provider} create failed`);
        const session = {
          provider,
          run: vi.fn(
            async (/** @type {Record<string, any>} */ feeds, /** @type {any} */ fetches) => {
              if (mode === 'run-fails') {
                throw new Error('Too many storage buffers in shader. Current: 11, Max is 10');
              }
              const graphOutputs = ['output_image', 'mask', 'side_1'];
              const names = fetches
                ? fetches.filter((n) => graphOutputs.includes(n))
                : graphOutputs;
              /** @type {Record<string, any>} */
              const outputs = {};
              for (const name of names) {
                outputs[name] = {
                  getData: async () => new Float32Array(SIZE * SIZE).fill(0.25),
                  dispose: vi.fn(),
                };
              }
              session.lastFeeds = feeds;
              return outputs;
            },
          ),
          release: vi.fn(async () => {}),
          /** @type {any} */
          lastFeeds: null,
        };
        sessions.push(session);
        return session;
      }),
    },
  };
  return { ort, sessions };
}

const bytes = new Uint8Array([1, 2, 3]);

describe('getFetches / runModel', () => {
  it('fetches the mask output alone unless every output is asked for', () => {
    expect(getFetches(GENERAL)).toEqual(['output_image']);
    expect(getFetches({ ...GENERAL, fetchAllOutputs: true })).toBeUndefined();
  });

  it('feeds the input by name, returns the mask and disposes every output', async () => {
    const { ort, sessions } = fakeOrt();
    const { session } = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: {},
      allowWasm: false,
    });
    const input = new Float32Array(3 * SIZE * SIZE);
    const all = { ...GENERAL, fetchAllOutputs: true };
    const data = await runModel(/** @type {any} */ (ort), session, all, input);
    expect(data).toHaveLength(SIZE * SIZE);
    const s = sessions[0];
    expect(Object.keys(s.lastFeeds)).toEqual(['input_image']);
    expect(s.lastFeeds.input_image.dims).toEqual([1, 3, SIZE, SIZE]);
    const outputs = await s.run.mock.results.at(-1).value;
    expect(Object.values(outputs).every((o) => o.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('says so when the model has no such output', async () => {
    const { ort } = fakeOrt();
    const { session } = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: {},
      allowWasm: false,
    });
    await expect(
      runModel(
        /** @type {any} */ (ort),
        session,
        { ...GENERAL, outputName: 'nope' },
        new Float32Array(48),
      ),
    ).rejects.toThrow('no output named "nope"');
  });
});

describe('createModelSession', () => {
  it('runs a warm-up on WebGPU before reporting the session', async () => {
    const { ort, sessions } = fakeOrt();
    let t = 0;
    const warmupInput = new Float32Array(3 * SIZE * SIZE).fill(7);
    const created = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: ANIME,
      adapter: { name: 'gpu' },
      allowWasm: false,
      warmupInput,
      now: () => (t += 5),
    });
    expect(created).toMatchObject({ backend: 'webgpu', warmupMs: 5, webgpuError: null });
    expect(ort.env.webgpu.adapter).toEqual({ name: 'gpu' });
    expect(sessions).toHaveLength(1);
    // One blank warm-up run, fetching only the mask
    expect(sessions[0].run).toHaveBeenCalledTimes(1);
    expect(sessions[0].run.mock.calls[0][1]).toEqual(['mask']);
    expect(sessions[0].lastFeeds.img.data).toBe(warmupInput);
    expect(warmupInput.every((v) => v === 0)).toBe(true);
  });

  it('treats a warm-up failure like a failed WebGPU session: WEBGPU_UNAVAILABLE without WASM', async () => {
    const { ort, sessions } = fakeOrt({ webgpu: 'run-fails' });
    const error = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: {},
      allowWasm: false,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.WEBGPU_UNAVAILABLE);
    expect(error.message).toContain('could not run on WebGPU');
    expect(error.message).toContain('Too many storage buffers');
    // The broken session was released, and nothing fell back silently
    expect(sessions[0].release).toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
  });

  it('falls back to WASM after a warm-up failure when allowed (no WASM warm-up)', async () => {
    const { ort, sessions } = fakeOrt({ webgpu: 'run-fails' });
    const created = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: {},
      allowWasm: true,
    });
    expect(created.backend).toBe('wasm');
    expect(created.warmupMs).toBeNull();
    expect(created.webgpuError).toContain('could not run on WebGPU');
    expect(sessions[1].provider).toBe('wasm');
    expect(sessions[1].run).not.toHaveBeenCalled();
  });

  it('reports a failed WebGPU create the same way', async () => {
    const { ort } = fakeOrt({ webgpu: 'create-fails' });
    const error = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: {},
      allowWasm: false,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.WEBGPU_UNAVAILABLE);
    expect(error.message).toBe('The model could not start on WebGPU: webgpu create failed');
  });

  it('without an adapter: WASM when allowed, else WEBGPU_UNAVAILABLE', async () => {
    const { ort } = fakeOrt();
    const created = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: null,
      allowWasm: true,
    });
    expect(created).toMatchObject({ backend: 'wasm', webgpuError: null });
    const error = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: null,
      allowWasm: false,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.WEBGPU_UNAVAILABLE);
  });

  it('reports MODEL_INIT_FAILED when the WASM session cannot be created', async () => {
    const { ort } = fakeOrt({ wasm: 'create-fails' });
    const error = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: null,
      allowWasm: true,
    }).catch((e) => e);
    expect(error.code).toBe(SegmentationErrorCode.MODEL_INIT_FAILED);
    expect(error.message).toContain('wasm create failed');
  });
});
