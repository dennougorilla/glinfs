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
import { setWasmAllowed } from '../../../src/features/editor/ai-cutout.js';
import {
  createAiCutoutSession,
  STORE_REBUILD_DELAY_MS,
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
      const pending = frames.filter((f) => !maskStore.has(f.id));
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
        maskStore.set(frame.id, prob(), options.clipId);
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

  it('aborts the build in flight when a parameter changes', async () => {
    for (const frame of state.clip.frames) maskStore.set(frame.id, prob());
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
    expect(status.building).toBe(true);

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
    for (const frame of state.clip.frames) maskStore.set(frame.id, prob());
    session.requestBuild();
    expect(status.building).toBe(true);
    setBackground({ method: 'color' });
    session.requestBuild();
    expect(status.building).toBe(false);
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
    maskStore.set('f0', prob());
    maskStore.set('f1', prob());
    expect(status.storeVersion).toBe(maskStore.version);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STORE_REBUILD_DELAY_MS);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(session.maskSource?.getFinalMask(1)).not.toBeNull());
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
