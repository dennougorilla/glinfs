import { describe, expect, it, vi } from 'vitest';
import { getModelSpec } from '../../../src/features/ai-cutout/model-config.js';
import { SegmentationErrorCode } from '../../../src/features/ai-cutout/protocol.js';
import {
  combineBackends,
  createModelSession,
  getFetches,
  loadAndCreateSession,
  resetRecurrentState,
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
              const graphOutputs = ['output_image', 'mask', 'output', 'side_1'];
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

describe('runModel with a recurrent (video) model', () => {
  const VIDEO = { ...getModelSpec('video-person'), inputSize: SIZE };

  /** A session whose state outputs count the frames it has seen */
  function recurrentSession() {
    const { ort } = fakeOrt();
    /** @type {Record<string, any>[]} */
    const feedsSeen = [];
    /** @type {any[]} */
    const outputsMade = [];
    const session = {
      run: vi.fn(
        async (/** @type {Record<string, any>} */ feeds, /** @type {string[]} */ fetches) => {
          feedsSeen.push(feeds);
          const seen =
            feeds.r1i.dims.length === 4 && feeds.r1i.dims[1] === 1 ? 0 : feeds.r1i.frames;
          /** @type {Record<string, any>} */
          const outputs = {};
          for (const name of fetches) {
            outputs[name] = {
              name,
              frames: seen + 1,
              dims: [1, 16, 2, 2],
              getData: async () => new Float32Array(SIZE * SIZE).fill(0.5),
              dispose: vi.fn(),
            };
            outputsMade.push(outputs[name]);
          }
          return outputs;
        },
      ),
    };
    return { ort, session, feedsSeen, outputsMade };
  }

  it('fetches the matte and the state outputs', () => {
    expect(getFetches(VIDEO)).toEqual(['pha', 'r1o', 'r2o', 'r3o', 'r4o']);
  });

  it('starts from [1, 1, 1, 1] zeros and feeds each frame’s states to the next', async () => {
    const { ort, session, feedsSeen, outputsMade } = recurrentSession();
    const state = { tensors: null };
    const input = new Float32Array(3 * SIZE * SIZE);
    await runModel(/** @type {any} */ (ort), /** @type {any} */ (session), VIDEO, input, state);
    for (const name of ['r1i', 'r2i', 'r3i', 'r4i']) {
      expect(feedsSeen[0][name].dims).toEqual([1, 1, 1, 1]);
      expect([...feedsSeen[0][name].data]).toEqual([0]);
    }
    const first = /** @type {any} */ (state.tensors);
    expect(first.r1i.name).toBe('r1o');
    expect(first.r4i.name).toBe('r4o');

    await runModel(/** @type {any} */ (ort), /** @type {any} */ (session), VIDEO, input, state);
    expect(feedsSeen[1].r1i).toBe(first.r1i);
    expect(feedsSeen[1].r3i).toBe(first.r3i);
    // The previous state and every mask output are disposed; the new state is kept
    expect(first.r1i.dispose).toHaveBeenCalledTimes(1);
    const masks = outputsMade.filter((o) => o.name === 'pha');
    expect(masks.every((o) => o.dispose.mock.calls.length === 1)).toBe(true);
    expect(/** @type {any} */ (state.tensors).r1i.frames).toBe(2);
    expect(/** @type {any} */ (state.tensors).r1i.dispose).not.toHaveBeenCalled();

    resetRecurrentState(state);
    expect(state.tensors).toBeNull();
    expect(
      outputsMade.filter((o) => o.name !== 'pha').every((o) => o.dispose.mock.calls.length === 1),
    ).toBe(true);
  });

  it('keeps nothing without a state (the warm-up runs from zeros)', async () => {
    const { ort, session, outputsMade } = recurrentSession();
    await runModel(
      /** @type {any} */ (ort),
      /** @type {any} */ (session),
      VIDEO,
      new Float32Array(3 * SIZE * SIZE),
    );
    expect(outputsMade).toHaveLength(5);
    expect(outputsMade.every((o) => o.dispose.mock.calls.length === 1)).toBe(true);
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

  it('warms up the portrait model at its own 512 input side, not another model’s buffer', async () => {
    const { ort, sessions } = fakeOrt();
    const portrait = getModelSpec('portrait');
    expect(portrait.inputSize).toBe(512);
    // A buffer sized for a 1024 model is not reused for a 512 one
    const otherBuffer = new Float32Array(3 * 1024 * 1024).fill(7);
    const created = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: portrait,
      adapter: {},
      allowWasm: false,
      warmupInput: otherBuffer,
    });
    expect(created.backend).toBe('webgpu');
    expect(sessions[0].run.mock.calls[0][1]).toEqual(['output']);
    const feed = sessions[0].lastFeeds.input;
    expect(feed.dims).toEqual([1, 3, 512, 512]);
    expect(feed.data).not.toBe(otherBuffer);
    expect(feed.data).toHaveLength(3 * 512 * 512);
    expect(otherBuffer[0]).toBe(7);
  });

  it('treats a warm-up failure like a failed WebGPU session: WEBGPU_MODEL_FAILED without WASM', async () => {
    const { ort, sessions } = fakeOrt({ webgpu: 'run-fails' });
    const error = await createModelSession({
      ort: /** @type {any} */ (ort),
      bytes,
      spec: GENERAL,
      adapter: {},
      allowWasm: false,
    }).catch((e) => e);
    // This model failed on an adapter that exists: not "no WebGPU"
    expect(error.code).toBe(SegmentationErrorCode.WEBGPU_MODEL_FAILED);
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
    expect(error.code).toBe(SegmentationErrorCode.WEBGPU_MODEL_FAILED);
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

describe('loadAndCreateSession', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  /** @param {{ fromCache: boolean }[]} results */
  const loader = (results) => {
    const queue = [...results];
    return vi.fn(async () => ({ bytes, cached: true, .../** @type {any} */ (queue.shift()) }));
  };

  it('creates the session from a cached copy without hashing it', async () => {
    const load = loader([{ fromCache: true }]);
    const isIntact = vi.fn();
    const evict = vi.fn();
    const result = await loadAndCreateSession({
      load,
      create: async () => 'session',
      isIntact,
      evict,
    });
    expect(result).toMatchObject({ created: 'session', reloaded: false });
    expect(isIntact).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
  });

  it('evicts a damaged cached copy on session failure and retries once with a fresh download', async () => {
    const load = loader([{ fromCache: true }, { fromCache: false }]);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('protobuf parsing failed'))
      .mockResolvedValueOnce('session');
    const evict = vi.fn(async () => true);
    const onVerify = vi.fn();
    const result = await loadAndCreateSession({
      load,
      create,
      isIntact: async () => false,
      evict,
      onVerify,
    });
    expect(result).toMatchObject({ created: 'session', reloaded: true });
    expect(result.loaded.fromCache).toBe(false);
    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('only retries once: a second failure is thrown', async () => {
    const load = loader([{ fromCache: true }, { fromCache: false }]);
    const create = vi.fn(async () => {
      throw new Error('broken');
    });
    await expect(
      loadAndCreateSession({ load, create, isIntact: async () => false, evict: vi.fn() }),
    ).rejects.toThrow('broken');
    expect(load).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('keeps an intact cached copy and rethrows (e.g. the model cannot run on this adapter)', async () => {
    const load = loader([{ fromCache: true }]);
    const failure = new Error('webgpu failed');
    const evict = vi.fn();
    await expect(
      loadAndCreateSession({
        load,
        create: async () => {
          throw failure;
        },
        isIntact: async () => true,
        evict,
      }),
    ).rejects.toBe(failure);
    expect(evict).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never re-downloads a fresh download that fails, nor in cacheOnly mode', async () => {
    const failure = new Error('bad');
    const isIntact = vi.fn();
    await expect(
      loadAndCreateSession({
        load: loader([{ fromCache: false }]),
        create: async () => {
          throw failure;
        },
        isIntact,
        evict: vi.fn(),
      }),
    ).rejects.toBe(failure);
    expect(isIntact).not.toHaveBeenCalled();

    const load = loader([{ fromCache: true }]);
    const evict = vi.fn();
    await expect(
      loadAndCreateSession({
        load,
        create: async () => {
          throw failure;
        },
        isIntact: async () => false,
        evict,
        cacheOnly: true,
      }),
    ).rejects.toBe(failure);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('combineBackends', () => {
  it('is WebGPU only when every session runs there', () => {
    expect(combineBackends(['webgpu'])).toBe('webgpu');
    expect(combineBackends(['webgpu', 'webgpu'])).toBe('webgpu');
    expect(combineBackends(['webgpu', 'wasm'])).toBe('wasm');
    expect(combineBackends(['wasm', 'webgpu'])).toBe('wasm');
  });
});
