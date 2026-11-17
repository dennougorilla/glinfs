/**
 * AI cutout session of an editor mount: analysis status, cancellation, the
 * no-WebGPU path, and final-mask builds (one AbortController, rebuilds).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import {
  createAbortError,
  SegmentationError,
  SegmentationErrorCode,
} from '../../../src/features/ai-cutout/protocol.js';
import { getObjectSignature, setWasmAllowed } from '../../../src/features/editor/ai-cutout.js';
import {
  ANALYSIS_REBUILD_INTERVAL_MS,
  BUILDING_STATUS_DELAY_MS,
  createAiCutoutSession,
  STORE_REBUILD_DELAY_MS,
  SUGGESTIONS_DELAY_MS,
} from '../../../src/features/editor/ai-cutout-session.js';
import { normalizeEdits } from '../../../src/shared/edits/model.js';
import { createFinalMaskCache } from '../../../src/shared/masks/final-masks.js';

const W = 4;
const H = 2;

/** @param {number} count */
function makeFrames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    timestamp: i,
    width: W,
    height: H,
  }));
}

/** @param {number} [value] */
function prob(value = 255) {
  return { data: new Uint8Array(W * H).fill(value), width: W, height: H };
}

/**
 * Fake manager: writes a mask per frame, reporting progress; `hold` keeps
 * the analysis open until released or aborted
 */
function createFakeManager(maskStore) {
  const manager = {
    webgpu: true,
    /** @type {unknown} */
    fail: null,
    hold: false,
    /** @type {(() => void) | null} */
    release: null,
    calls: /** @type {any[]} */ ([]),
    getCapabilities: vi.fn(async () => ({ webgpu: manager.webgpu })),
    analyzeFrames: vi.fn(async (frames, options) => {
      manager.calls.push(options);
      if (manager.fail) throw manager.fail;
      const pending = frames.filter((f) => !maskStore.has(`anime:${f.id}`));
      options.onProgress?.({
        phase: 'downloading',
        loadedBytes: 5,
        totalBytes: 10,
        fromCache: false,
        framesDone: 0,
        framesTotal: pending.length,
        backend: null,
        frameMs: null,
      });
      let done = 0;
      for (const frame of pending) {
        if (manager.hold && done === 1) {
          await new Promise((resolve, reject) => {
            manager.release = () => resolve(undefined);
            options.signal?.addEventListener('abort', () => reject(createAbortError()));
          });
        }
        maskStore.set(`anime:${frame.id}`, prob(), options.clipId);
        done++;
        options.onProgress?.({
          phase: 'analyzing',
          loadedBytes: 10,
          totalBytes: 10,
          fromCache: false,
          framesDone: done,
          framesTotal: pending.length,
          backend: 'webgpu',
          frameMs: 5,
        });
      }
      return {
        analyzed: pending.length,
        skipped: frames.length - pending.length,
        backend: 'webgpu',
      };
    }),
  };
  return manager;
}

describe('AI cutout session', () => {
  /** @type {ReturnType<typeof createMaskStore>} */
  let maskStore;
  /** @type {ReturnType<typeof createFakeManager>} */
  let manager;
  /** @type {any} */
  let state;
  /** @type {Record<string, unknown>} */
  let status;
  /** @type {ReturnType<typeof createAiCutoutSession>} */
  let session;
  let clock = 0;

  /** @param {Record<string, unknown>} [background] */
  function setBackground(background = {}) {
    state = {
      ...state,
      edits: normalizeEdits({ background: { enabled: true, method: 'ai', ...background } }, 4),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    maskStore = createMaskStore();
    manager = createFakeManager(maskStore);
    state = { clip: { frames: makeFrames(4) } };
    setBackground();
    status = {};
    clock = 0;
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      getClipId: () => 'clip-1',
      manager: /** @type {any} */ (manager),
      maskStore,
      cache: createFinalMaskCache(),
      now: () => (clock += 100),
    });
  });

  afterEach(() => {
    session.dispose();
    setWasmAllowed(false);
    vi.useRealTimers();
  });

  it('reports capabilities and the WASM choice', async () => {
    manager.webgpu = false;
    await session.checkCapabilities();
    expect(status).toMatchObject({ webgpu: false, wasmAllowed: false });
    manager.getCapabilities.mockRejectedValueOnce(new Error('x'));
    status.webgpu = null;
    // A fresh check that throws counts as no WebGPU
    await session.checkCapabilities();
    expect(status.webgpu).toBe(false);
  });

  it('analyzes, reports progress with time left, and stores masks under the clip', async () => {
    await session.analyze(state.clip.frames.slice(0, 3));
    expect(manager.calls[0]).toMatchObject({ clipId: 'clip-1', allowWasm: false });
    expect(status).toMatchObject({
      phase: 'idle',
      framesDone: 3,
      framesTotal: 3,
      notice: 'Analyzed 3 frames.',
      backend: 'webgpu',
    });
    expect(maskStore.keysForClip('clip-1')).toHaveLength(3);
    // Measured: 3 frames done, none left
    expect(status.remainingMs).toBe(0);
    expect(session.analyzing).toBe(false);

    // Nothing left to do
    await session.analyze(state.clip.frames.slice(0, 3));
    expect(status.notice).toBe('These frames were already analyzed.');
  });

  it('keeps finished masks on cancel and finishes only the rest next time', async () => {
    manager.hold = true;
    const running = session.analyze(state.clip.frames);
    await vi.waitFor(() => expect(manager.release).not.toBeNull());
    expect(session.analyzing).toBe(true);
    expect(status.phase).toBe('analyzing');
    // A second analyze while one runs is ignored
    await session.analyze(state.clip.frames);
    expect(manager.analyzeFrames).toHaveBeenCalledTimes(1);

    session.cancel();
    await running;
    expect(status.phase).toBe('idle');
    expect(status.notice).toContain('Analysis cancelled');
    expect(maskStore.size).toBe(1);

    manager.hold = false;
    await session.analyze(state.clip.frames);
    expect(status.framesTotal).toBe(3);
    expect(maskStore.size).toBe(4);
  });

  it('asks for the slow choice when WebGPU is missing, then runs with WASM allowed', async () => {
    manager.fail = new SegmentationError(SegmentationErrorCode.WEBGPU_UNAVAILABLE, 'no adapter');
    await session.analyze(state.clip.frames);
    expect(status).toMatchObject({ phase: 'idle', needsWasmChoice: true, webgpu: false });
    expect(maskStore.size).toBe(0);

    manager.fail = null;
    await session.allowWasmAndAnalyze(state.clip.frames);
    expect(manager.calls.at(-1).allowWasm).toBe(true);
    expect(status).toMatchObject({ wasmAllowed: true, needsWasmChoice: false, phase: 'idle' });
    expect(maskStore.size).toBe(4);
  });

  it('a model that failed on WebGPU asks for the slow choice without marking WebGPU missing', async () => {
    manager.fail = new SegmentationError(
      SegmentationErrorCode.WEBGPU_MODEL_FAILED,
      'The model could not run on WebGPU: shader limits',
    );
    await session.checkCapabilities();
    await session.analyze(state.clip.frames);
    expect(status).toMatchObject({
      phase: 'idle',
      needsWasmChoice: true,
      webgpuModelFailed: true,
      webgpu: true,
      error: null,
    });

    // A retry that runs on WebGPU after all (the fake reports webgpu)
    // clears the model's failure
    manager.fail = null;
    await session.analyze(state.clip.frames);
    expect(status).toMatchObject({ needsWasmChoice: false, webgpuModelFailed: false });
  });

  it('shows other failures as errors (retry clears them)', async () => {
    manager.fail = new SegmentationError(SegmentationErrorCode.DOWNLOAD_FAILED, 'HTTP 404');
    await session.analyze(state.clip.frames);
    expect(status.phase).toBe('error');
    expect(status.error).toMatchObject({ code: SegmentationErrorCode.DOWNLOAD_FAILED });

    manager.fail = null;
    await session.analyze(state.clip.frames);
    expect(status).toMatchObject({ phase: 'idle', error: null });
  });

  it('builds final masks after an analysis and publishes them', async () => {
    const published = [];
    session.dispose();
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      onMaskSource: (source) => published.push(source),
      getClipId: () => undefined,
      manager: /** @type {any} */ (manager),
      maskStore,
      cache: createFinalMaskCache(),
    });
    await session.analyze(state.clip.frames);
    await vi.waitFor(() => expect(session.maskSource).not.toBeNull());
    expect(published).toHaveLength(1);
    expect(status.maskVersion).toBe(session.maskSource?.version);
    expect(status.building).toBe(false);
    expect(session.maskSource?.getFinalMask(0)).not.toBeNull();

    // Same inputs: the memo is published without work
    const before = session.maskSource;
    session.requestBuild();
    expect(session.maskSource).toBe(before);
  });

  it('finds clean-up suggestions a moment after a full build, and drops them when AI is off', async () => {
    // 100x60 masks: a character and a 3x3 speck on every frame
    const BW = 100;
    const BH = 60;
    state = {
      clip: {
        frames: makeFrames(4).map((f) => ({ ...f, width: BW, height: BH })),
      },
    };
    setBackground();
    for (const frame of state.clip.frames) {
      const data = new Uint8Array(BW * BH);
      for (let y = 10; y < 50; y++) data.fill(255, y * BW + 10, y * BW + 40);
      for (let y = 5; y < 8; y++) data.fill(255, y * BW + 70, y * BW + 73);
      maskStore.set(`anime:${frame.id}`, { data, width: BW, height: BH }, 'clip-1');
    }
    session.requestBuild();
    await vi.waitFor(() => expect(session.maskSource).not.toBeNull());
    expect(status.cleanupSuggestions).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SUGGESTIONS_DELAY_MS);
    await vi.waitFor(() =>
      expect(status.cleanupSuggestions).toEqual([
        { kind: 'specks', count: 1, minIslandArea: expect.any(Number) },
      ]),
    );

    // A new build aborts a pending pass; AI off stops it
    status.cleanupSuggestions = undefined;
    setBackground({ ai: { cleanup: { minIslandArea: 0.002, maxHoleArea: 0 } } });
    session.requestBuild();
    await vi.waitFor(() => expect(session.maskSource?.getFinalMask(0)).not.toBeNull());
    state = { ...state, edits: normalizeEdits({ background: { enabled: false } }, 4) };
    session.requestBuild();
    await vi.advanceTimersByTimeAsync(SUGGESTIONS_DELAY_MS * 2);
    expect(status.cleanupSuggestions).toBeUndefined();
  });

  it('aborts the build in flight when a parameter changes', async () => {
    for (const frame of state.clip.frames) maskStore.set(`anime:${frame.id}`, prob());
    const cache = createFinalMaskCache();
    const build = vi.spyOn(cache, 'build');
    session.dispose();
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      getClipId: () => undefined,
      manager: /** @type {any} */ (manager),
      maskStore,
      cache,
    });
    session.requestBuild();
    const firstSignal = build.mock.calls[0][0].signal;
    // Reported only once a build runs longer than BUILDING_STATUS_DELAY_MS
    expect(status.building).not.toBe(true);

    // Same parameters: no restart, only a queued rerun
    session.requestBuild();
    expect(build).toHaveBeenCalledTimes(1);

    setBackground({ ai: { threshold: 0.8 } });
    session.requestBuild();
    expect(firstSignal?.aborted).toBe(true);
    expect(build).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(session.maskSource).not.toBeNull());
    expect(status.building).toBe(false);
  });

  it('drops the build when the AI method is off', () => {
    for (const frame of state.clip.frames) maskStore.set(`anime:${frame.id}`, prob());
    const cache = createFinalMaskCache();
    const build = vi.spyOn(cache, 'build');
    session.dispose();
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      getClipId: () => undefined,
      manager: /** @type {any} */ (manager),
      maskStore,
      cache,
    });
    session.requestBuild();
    const signal = build.mock.calls[0][0].signal;
    setBackground({ method: 'color' });
    session.requestBuild();
    expect(signal?.aborted).toBe(true);
    expect(status.building).toBe(false);
  });

  it('analyzeNow stops a running analysis and then analyzes the new frames', async () => {
    manager.hold = true;
    session.analyzeNow(state.clip.frames.slice(0, 3));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.analyzing).toBe(true);
    const first = manager.calls[0];
    manager.hold = false;
    session.analyzeNow(state.clip.frames.slice(2, 4));
    expect(first.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(manager.calls).toHaveLength(2));
    await vi.waitFor(() => expect(session.analyzing).toBe(false));
    // The restart is not reported as a cancellation
    expect(status.notice).not.toContain('cancelled');
    expect(maskStore.has('anime:f3')).toBe(true);

    // cancel() drops a queued restart
    maskStore.clear();
    manager.hold = true;
    session.analyzeNow(state.clip.frames);
    await vi.advanceTimersByTimeAsync(0);
    session.analyzeNow(state.clip.frames);
    session.cancel();
    await vi.waitFor(() => expect(session.analyzing).toBe(false));
    expect(manager.calls).toHaveLength(3);
    expect(status.notice).toContain('cancelled');
  });

  describe('no status flicker, live drafts while dragging', () => {
    /** A cache whose builds stay pending until resolved by the test */
    function createPendingCache() {
      /** @type {{ resolve: (source: any) => void, signal: AbortSignal | undefined }[]} */
      const builds = [];
      const cache = {
        build: vi.fn(
          (/** @type {any} */ options) =>
            new Promise((resolve) => builds.push({ resolve, signal: options.signal })),
        ),
        peek: vi.fn(() => null),
      };
      return { cache, builds };
    }

    /** @param {any} cache */
    function sessionWith(cache) {
      session.dispose();
      session = createAiCutoutSession({
        getState: () => state,
        setStatus: (patch) => Object.assign(status, patch),
        getClipId: () => undefined,
        manager: /** @type {any} */ (manager),
        maskStore,
        cache,
      });
    }

    it('reports building only for builds slower than the delay', async () => {
      for (const frame of state.clip.frames) maskStore.set(`anime:${frame.id}`, prob());
      const { cache, builds } = createPendingCache();
      sessionWith(cache);

      // A fast build: never reported
      session.requestBuild();
      builds[0].resolve({ version: 1, getFinalMask: () => null });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(BUILDING_STATUS_DELAY_MS * 2);
      expect(status.building).not.toBe(true);

      // A slow one: reported after the delay, cleared when it lands
      setBackground({ ai: { threshold: 0.7 } });
      session.requestBuild();
      await vi.advanceTimersByTimeAsync(BUILDING_STATUS_DELAY_MS - 1);
      expect(status.building).not.toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(status.building).toBe(true);
      builds[1].resolve({ version: 2, getFinalMask: () => null });
      await vi.advanceTimersByTimeAsync(0);
      expect(status.building).toBe(false);
    });

    it('publishes per-frame drafts while interactive, the full build after', async () => {
      // Frame 0 is sure (255), frame 1 unsure (150)
      maskStore.set('anime:f0', prob(255));
      maskStore.set('anime:f1', prob(150));
      setBackground({ ai: { smoothing: false, threshold: 0.5 } });
      const { cache, builds } = createPendingCache();
      sessionWith(cache);

      session.setInteractive(true);
      expect(session.interactive).toBe(true);
      for (const threshold of [0.7, 0.4, 0.8]) {
        setBackground({ ai: { smoothing: false, threshold } });
        session.requestBuild();
      }
      // No whole-clip build while dragging, and nothing to report
      expect(cache.build).not.toHaveBeenCalled();
      expect(status.building).not.toBe(true);
      const draft = /** @type {any} */ (session.maskSource);
      expect(draft?.draft).toBe(true);
      expect(status.maskVersion).toBe(draft.version);
      // The draft already follows the latest threshold (0.8 drops frame 1)
      expect(draft.getFinalMask(0)?.bits[0]).toBe(0xff);
      expect(draft.getFinalMask(1)?.bits[0]).toBe(0);
      expect(draft.getFinalMask(2)).toBeNull();

      // Release: the full build runs; the draft stays until it lands
      session.setInteractive(false);
      expect(cache.build).toHaveBeenCalledTimes(1);
      expect(session.maskSource).toBe(draft);
      const full = { version: 99, getFinalMask: () => null };
      builds[0].resolve(full);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.maskSource).toBe(full);
    });
  });

  it('rebuilds (debounced) when masks arrive from elsewhere', async () => {
    const changed = vi.fn();
    session.dispose();
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      onMasksChanged: changed,
      getClipId: () => undefined,
      manager: /** @type {any} */ (manager),
      maskStore,
      cache: createFinalMaskCache(),
    });
    maskStore.set('anime:f0', prob());
    maskStore.set('anime:f1', prob());
    expect(status.storeVersion).toBe(maskStore.version);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STORE_REBUILD_DELAY_MS);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(session.maskSource?.getFinalMask(1)).not.toBeNull());
  });

  it('rebuilds at a coarse cadence while an analysis runs, and once more when it ends', async () => {
    const FRAME_EVERY_MS = 300;
    const BUILD_MS = 100;
    const frames = makeFrames(20);
    state = { ...state, clip: { frames } };
    /** @type {number[]} */
    const starts = [];
    let version = 0;
    // Takes BUILD_MS; memoizes the last build by store version
    /** @type {{ storeVersion: number, source: any } | null} */
    let memo = null;
    const cache = {
      peek: (/** @type {any} */ inputs) =>
        memo?.storeVersion === inputs.storeVersion ? memo.source : null,
      build: vi.fn((/** @type {any} */ options) => {
        starts.push(Date.now());
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            memo = {
              storeVersion: options.storeVersion,
              source: { version: ++version, getFinalMask: () => null },
            };
            resolve(memo.source);
          }, BUILD_MS);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
          });
        });
      }),
    };
    // One new mask every FRAME_EVERY_MS
    manager.analyzeFrames.mockImplementationOnce(async (/** @type {any[]} */ list, options) => {
      for (const frame of list) {
        await new Promise((resolve) => setTimeout(resolve, FRAME_EVERY_MS));
        maskStore.set(`anime:${frame.id}`, prob(), options.clipId);
      }
      return { analyzed: list.length, skipped: 0, backend: 'webgpu' };
    });
    session.dispose();
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      getClipId: () => undefined,
      manager: /** @type {any} */ (manager),
      maskStore,
      cache: /** @type {any} */ (cache),
    });

    const startedAt = Date.now();
    const running = session.analyze(frames);
    await vi.advanceTimersByTimeAsync(frames.length * FRAME_EVERY_MS);
    await running;
    const endedAt = Date.now();
    await vi.advanceTimersByTimeAsync(ANALYSIS_REBUILD_INTERVAL_MS * 3);

    const during = starts.filter((t) => t < endedAt);
    const after = starts.filter((t) => t >= endedAt);
    // The first masks show up quickly, then at most one start per interval
    expect(during[0] - startedAt).toBeLessThanOrEqual(FRAME_EVERY_MS + STORE_REBUILD_DELAY_MS);
    for (let i = 1; i < during.length; i++) {
      expect(during[i] - during[i - 1]).toBeGreaterThanOrEqual(ANALYSIS_REBUILD_INTERVAL_MS);
    }
    expect(during.length).toBeLessThanOrEqual(
      Math.ceil((frames.length * FRAME_EVERY_MS) / ANALYSIS_REBUILD_INTERVAL_MS) + 1,
    );
    // Once more when it ends, right away, and then nothing
    expect(after).toHaveLength(1);
    expect(after[0] - endedAt).toBeLessThanOrEqual(BUILD_MS);

    // Without an analysis, a store change rebuilds after the short debounce
    maskStore.set('extra', prob());
    const changedAt = Date.now();
    await vi.advanceTimersByTimeAsync(STORE_REBUILD_DELAY_MS);
    expect(starts.at(-1)).toBe(changedAt + STORE_REBUILD_DELAY_MS);
    expect(starts).toHaveLength(during.length + after.length + 1);
  });

  it('writes nothing after dispose', async () => {
    manager.hold = true;
    const running = session.analyze(state.clip.frames);
    await vi.waitFor(() => expect(manager.release).not.toBeNull());
    session.dispose();
    const snapshot = { ...status };
    await running;
    maskStore.set('x', prob());
    vi.advanceTimersByTime(STORE_REBUILD_DELAY_MS * 2);
    session.requestBuild();
    await session.analyze(state.clip.frames);
    expect(status).toEqual(snapshot);
    expect(session.maskSource).toBeNull();
  });
});

describe('AI cutout session: model availability and preload', () => {
  /**
   * @param {{ cached?: Record<string, boolean>, preload?: boolean, method?: string, model?: string }} [options]
   */
  function setup({
    cached = { anime: true, general: false },
    preload = true,
    method = 'ai',
    model,
  } = {}) {
    const maskStore = createMaskStore();
    /** @type {Set<string>} */
    const ready = new Set();
    /** @type {Set<() => void>} */
    const listeners = new Set();
    const manager = {
      ...createFakeManager(maskStore),
      getReadyInfo: (/** @type {string} */ id) => (ready.has(id) ? { modelId: id } : null),
      onModelStateChange: (/** @type {() => void} */ l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      preloadModel: vi.fn(async (/** @type {string} */ id) => {
        ready.add(id);
        for (const l of listeners) l();
        return true;
      }),
    };
    const state = {
      clip: { frames: makeFrames(2) },
      edits: normalizeEdits(
        { background: { enabled: true, method, ai: model ? { model } : {} } },
        2,
      ),
    };
    /** @type {Record<string, any>} */
    const status = {};
    const isModelCached = vi.fn(async (/** @type {string} */ id) => Boolean(cached[id]));
    const scheduleIdle = vi.fn((/** @type {() => void} */ task) => task());
    const session = createAiCutoutSession({
      getState: () => /** @type {any} */ (state),
      setStatus: (patch) => Object.assign(status, patch),
      getClipId: () => 'clip-1',
      manager: /** @type {any} */ (manager),
      maskStore,
      cache: createFinalMaskCache(),
      isModelCached,
      shouldPreload: () => preload,
      scheduleIdle,
    });
    return { session, manager, status, isModelCached, scheduleIdle };
  }

  it('preloads the clip’s model at idle time when it is downloaded', async () => {
    const { session, manager, status, scheduleIdle } = setup();
    await expect(session.preload()).resolves.toBe(true);
    expect(scheduleIdle).toHaveBeenCalledTimes(1);
    expect(manager.preloadModel).toHaveBeenCalledWith('anime', { allowWasm: false });
    await vi.waitFor(() =>
      expect(status.models).toEqual({
        general: 'missing',
        portrait: 'missing',
        anime: 'ready',
        click: 'missing',
        ben2: 'missing',
        'video-person': 'missing',
        'birefnet-general': 'missing',
        'birefnet-lite': 'missing',
        'birefnet-toonout': 'missing',
      }),
    );
    session.dispose();
  });

  it('never preloads a model that is not downloaded (no implicit download)', async () => {
    const { session, manager } = setup({ model: 'general' });
    await expect(session.preload()).resolves.toBe(false);
    expect(manager.preloadModel).not.toHaveBeenCalled();
    session.dispose();
  });

  it('does nothing when the setting is off or the AI method is not chosen', async () => {
    const off = setup({ preload: false });
    await expect(off.session.preload()).resolves.toBe(false);
    expect(off.isModelCached).not.toHaveBeenCalled();
    off.session.dispose();
    const color = setup({ method: 'color' });
    await expect(color.session.preload()).resolves.toBe(false);
    expect(color.manager.preloadModel).not.toHaveBeenCalled();
    color.session.dispose();
  });

  it('a superseded refresh resolves only after the latest one reported (#187)', async () => {
    const { session, status, isModelCached } = setup({ cached: { general: true } });
    /** @type {(() => void)[]} */
    const gates = [];
    isModelCached.mockImplementation(
      (/** @type {string} */ id) =>
        new Promise((resolve) => gates.push(() => resolve(id === 'general'))),
    );
    let firstDone = false;
    const first = session.refreshModels().then(() => {
      firstDone = true;
    });
    const count = gates.length;
    const second = session.refreshModels();
    // The first batch answers first: it is stale and must wait for the second
    for (const open of gates.splice(0, count)) open();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(firstDone).toBe(false);
    expect(status.models).toBeUndefined();
    for (const open of gates.splice(0)) open();
    await first;
    expect(status.models?.general).toBe('cached');
    await second;
    session.dispose();
  });

  it('reports each model as ready, downloaded or missing', async () => {
    const { session, status } = setup({ cached: { anime: true, general: false } });
    await session.refreshModels();
    expect(status.models).toEqual({
      general: 'missing',
      portrait: 'missing',
      anime: 'cached',
      click: 'missing',
      ben2: 'missing',
      'video-person': 'missing',
      'birefnet-general': 'missing',
      'birefnet-lite': 'missing',
      'birefnet-toonout': 'missing',
    });
    session.dispose();
  });
});

describe('AI cutout session: tracked objects', () => {
  /** @type {ReturnType<typeof createMaskStore>} */
  let maskStore;
  /** @type {any} */
  let state;
  /** @type {Record<string, any>} */
  let status;
  /** @type {ReturnType<typeof createAiCutoutSession>} */
  let session;
  /** @type {{ calls: any[], lostAt: Set<number>, fail: unknown, analyzeObject: import('vitest').Mock }} */
  let manager;

  const click = (frame = 1) => ({ frame, x: 0.5, y: 0.5, mode: 'keep' });
  /** @param {any[]} objects */
  function setObjects(objects) {
    state = {
      ...state,
      edits: normalizeEdits(
        { background: { enabled: true, method: 'ai', ai: { model: 'anime', objects } } },
        4,
      ),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    maskStore = createMaskStore();
    manager = {
      calls: [],
      lostAt: new Set(),
      fail: /** @type {unknown} */ (null),
      analyzeObject: vi.fn(async (frames, options) => {
        manager.calls.push(options);
        if (manager.fail) {
          const error = manager.fail;
          manager.fail = null;
          throw error;
        }
        const lost = [];
        for (let f = options.range.start; f <= options.range.end; f++) {
          // Like the manager: masks tagged with the object's signature,
          // frames it could not reach marked with it
          const key = `object:${options.objectId}:${frames[f].id}`;
          const group = `object:${options.objectId}`;
          if (manager.lostAt.has(f)) {
            lost.push(f);
            maskStore.mark(key, options.tag, options.clipId, group);
            continue;
          }
          maskStore.set(key, prob(), options.clipId, group, options.tag);
          options.onProgress?.({ phase: 'analyzing', framesDone: 1, framesTotal: 4 });
        }
        return { tracked: 4 - lost.length, lost, anchors: 1, backend: 'webgpu' };
      }),
    };
    state = {
      clip: { frames: makeFrames(4) },
      selectedRange: { start: 0, end: 3 },
      currentFrame: 1,
    };
    setObjects([]);
    status = {};
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      getClipId: () => 'clip-1',
      manager: /** @type {any} */ ({
        ...manager,
        getCapabilities: async () => ({ webgpu: true }),
        analyzeFrames: async () => ({ analyzed: 0, skipped: 0, backend: 'wasm' }),
        analyzeObject: manager.analyzeObject,
      }),
      maskStore,
      cache: createFinalMaskCache(),
    });
  });

  afterEach(() => {
    session.dispose();
    setWasmAllowed(false);
    vi.useRealTimers();
  });

  /** Let the queued tracking run to the end */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);
  };

  it('never tracks a Colour fix-up; back to Whole it tracks again', async () => {
    setObjects([{ id: 'o1', mode: 'remove', scope: 'colour', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(0);
    expect(status.objectTracking ?? null).toBeNull();
    setObjects([{ id: 'o1', mode: 'remove', scope: 'whole', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(1);
    // Turned to Colour while tracked: nothing new runs, the masks stay
    manager.calls = [];
    setObjects([{ id: 'o1', mode: 'remove', scope: 'colour', clicks: [click(), click(2)] }]);
    session.syncObjects({ force: true });
    await settle();
    expect(manager.calls).toHaveLength(0);
    expect(maskStore.get(`object:o1:${state.clip.frames[0].id}`)).not.toBeNull();
  });

  it('keeps lost frames through Colour, so they come back on a return to Part (review r3)', async () => {
    manager.lostAt = new Set([3]);
    setObjects([{ id: 'o1', mode: 'remove', scope: 'part', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(status.objectLost).toEqual({ o1: [3] });
    // Colour: not tracked; the lost frames stay (the panel and overlay skip them)
    setObjects([{ id: 'o1', mode: 'remove', scope: 'colour', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(status.objectLost).toEqual({ o1: [3] });
    // Back to Part with the same points: no new run, and frame 3 is still reported lost
    setObjects([{ id: 'o1', mode: 'remove', scope: 'part', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(status.objectLost).toEqual({ o1: [3] });
  });

  it('reports how far each fix-up reaches; frames it does not reach are short (cutout-ux 1)', async () => {
    manager.lostAt = new Set([3]);
    setObjects([
      { id: 'o1', mode: 'remove', clicks: [click()] },
      { id: 'o2', mode: 'remove', scope: 'colour', clicks: [click()] },
    ]);
    session.syncObjects();
    await settle();
    expect(status.objectCoverage).toEqual({ o1: { covered: 3, selection: 4 } });
    expect(status.objectShort).toBe(1);
    // New prompts: the masks of the old ones no longer count
    manager.lostAt = new Set();
    setObjects([{ id: 'o1', mode: 'remove', clicks: [click(), click(2)] }]);
    session.requestBuild();
    expect(status.objectCoverage).toEqual({ o1: { covered: 0, selection: 4 } });
    session.syncObjects();
    await settle();
    expect(status.objectCoverage).toEqual({ o1: { covered: 4, selection: 4 } });
    expect(status.objectShort).toBe(0);
  });

  it('shows the clicked frame from a draft as soon as its answer lands (cutout-ux 1)', async () => {
    session.dispose();
    /** @type {any[]} */
    const published = [];
    /** @type {any[]} */
    const atFirstAnswer = [];
    const tracker = {
      ...manager,
      analyzeObject: vi.fn(async (frames, options) => {
        const key = `object:${options.objectId}:${frames[1].id}`;
        maskStore.set(key, prob(), options.clipId, `object:${options.objectId}`, options.tag);
        options.onProgress?.({ phase: 'analyzing', framesDone: 1, framesTotal: 4 });
        // What the preview has right after the clicked frame's answer
        atFirstAnswer.push(...published);
        return { tracked: 1, lost: [], anchors: 1, backend: 'webgpu' };
      }),
    };
    // The base model's masks exist, so a build has something to show
    for (const frame of state.clip.frames) maskStore.set(`anime:${frame.id}`, prob(), 'clip-1');
    session = createAiCutoutSession({
      getState: () => state,
      setStatus: (patch) => Object.assign(status, patch),
      onMaskSource: (source) => published.push(source),
      getClipId: () => 'clip-1',
      manager: /** @type {any} */ ({
        ...tracker,
        getCapabilities: async () => ({ webgpu: true }),
        analyzeFrames: async () => ({ analyzed: 0, skipped: 0, backend: 'wasm' }),
      }),
      maskStore,
      cache: createFinalMaskCache(),
    });
    setObjects([{ id: 'o1', mode: 'remove', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(atFirstAnswer.some((source) => source.draft === true)).toBe(true);
    const draft = atFirstAnswer.find((source) => source.draft === true);
    // The removed object is in the draft's frame at once
    expect(draft.getFinalMask(1)).not.toBeNull();
    // The whole-clip build follows
    await vi.advanceTimersByTimeAsync(1000);
    expect(published.at(-1).draft).toBeUndefined();
  });

  it('prepares the tracker when asked (a tool turned on), only if it is downloaded (cutout-ux 1)', async () => {
    const preloadModel = vi.fn(async () => true);
    for (const cached of [true, false]) {
      const s = createAiCutoutSession({
        getState: () => state,
        setStatus: () => {},
        getClipId: () => 'clip-1',
        manager: /** @type {any} */ ({
          ...manager,
          preloadModel,
          getReadyInfo: () => null,
          getCapabilities: async () => ({ webgpu: true }),
        }),
        maskStore,
        cache: createFinalMaskCache(),
        isModelCached: async () => cached,
      });
      await s.preloadTracker();
      s.dispose();
    }
    expect(preloadModel).toHaveBeenCalledTimes(1);
    expect(preloadModel).toHaveBeenCalledWith('click', { allowWasm: false });
  });

  it('tracks a new object through the selection and reports its lost frames', async () => {
    manager.lostAt = new Set([3]);
    setObjects([{ id: 'o1', mode: 'remove', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]).toMatchObject({
      objectId: 'o1',
      clipId: 'clip-1',
      range: { start: 0, end: 3 },
      currentFrame: 1,
      clicks: [click()],
      scope: 'whole',
    });
    expect(status.objectLost).toEqual({ o1: [3] });
    expect(status.objectTracking).toBeNull();
  });

  it('does not retry lost frames on its own, but does on force or new clicks', async () => {
    manager.lostAt = new Set([3]);
    setObjects([{ id: 'o1', mode: 'remove', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(1);
    session.syncObjects({ force: true });
    await settle();
    expect(manager.calls).toHaveLength(2);
    manager.lostAt = new Set();
    setObjects([{ id: 'o1', mode: 'remove', clicks: [click(), click(3)] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(3);
    expect(manager.calls[2].clicks).toHaveLength(2);
    expect(status.objectLost).toEqual({ o1: [] });
  });

  it('leaves a remounted object with all its masks alone', async () => {
    setObjects([{ id: 'o1', mode: 'add', clicks: [click()] }]);
    const tag = getObjectSignature(state.edits.background.ai.objects[0]);
    for (const f of state.clip.frames) {
      maskStore.set(`object:o1:${f.id}`, prob(), 'clip-1', 'object:o1', tag);
    }
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(0);
  });

  it('drops the masks and lost frames of a deleted object', async () => {
    manager.lostAt = new Set([2]);
    setObjects([
      { id: 'o1', mode: 'remove', clicks: [click()] },
      { id: 'o2', mode: 'add', clicks: [click()] },
    ]);
    session.syncObjects();
    await settle();
    expect(manager.calls.map((c) => c.objectId)).toEqual(['o1', 'o2']);
    expect(maskStore.has('object:o1:f0')).toBe(true);
    setObjects([{ id: 'o2', mode: 'add', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(maskStore.has('object:o1:f0')).toBe(false);
    expect(maskStore.has('object:o2:f0')).toBe(true);
    expect(status.objectLost).toEqual({ o2: [2] });
  });

  it('tracks the object that asked for the CPU choice once the user takes it', async () => {
    manager.fail = new SegmentationError(SegmentationErrorCode.WEBGPU_UNAVAILABLE, 'no adapter');
    setObjects([{ id: 'o1', mode: 'remove', clicks: [click()] }]);
    session.syncObjects();
    await settle();
    expect(status.needsWasmChoice).toBe(true);
    expect(maskStore.has('object:o1:f0')).toBe(false);
    // Not marked as tried: the choice tracks it
    await session.allowWasmAndAnalyze(state.clip.frames);
    await settle();
    expect(manager.calls).toHaveLength(2);
    expect(manager.calls[1].allowWasm).toBe(true);
    for (const f of state.clip.frames) expect(maskStore.has(`object:o1:${f.id}`)).toBe(true);
  });

  it('drops masks outside the selection when the scope changes, so a wider selection tracks them', async () => {
    setObjects([{ id: 'o1', mode: 'remove', scope: 'whole', clicks: [click(0)] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(1);
    // Narrow the selection, then Part: frames 2-3 keep no Whole mask
    state = { ...state, selectedRange: { start: 0, end: 1 } };
    setObjects([{ id: 'o1', mode: 'remove', scope: 'part', clicks: [click(0)] }]);
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(2);
    expect(manager.calls[1]).toMatchObject({ scope: 'part', range: { start: 0, end: 1 } });
    expect(maskStore.has('object:o1:f2')).toBe(false);
    expect(maskStore.has('object:o1:f3')).toBe(false);
    // Back to the whole clip: tracked again with Part over all of it
    state = { ...state, selectedRange: { start: 0, end: 3 } };
    session.syncObjects();
    await settle();
    expect(manager.calls).toHaveLength(3);
    expect(manager.calls[2]).toMatchObject({ scope: 'part', range: { start: 0, end: 3 } });
  });
});
