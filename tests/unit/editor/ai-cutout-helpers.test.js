/**
 * AI cutout glue shared by the editor and the export (features/editor/ai-cutout.js)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import {
  SegmentationError,
  SegmentationErrorCode,
} from '../../../src/features/ai-cutout/protocol.js';
import {
  buildClipMaskSource,
  buildClipMaskSourceSettled,
  chooseFixUp,
  countUntrackedObjectFrames,
  describeAnalysisError,
  describeAnalysisProgress,
  estimateRemainingMs,
  formatTimeLeft,
  getAiModelId,
  getAnalysisCoverage,
  getAnalysisFraction,
  getBuildParamsKey,
  getClipProbSource,
  getModelSizeLabel,
  getObjectSignature,
  getObjectsToTrack,
  getSharedFinalMaskCache,
  isAbortError,
  isFrameAnalyzed,
  isWasmAllowed,
  peekClipMaskSource,
  pickFindsCharacter,
  RUNTIME_SIZE_LABEL,
  setWasmAllowed,
  TYPICAL_FRAME_MS,
} from '../../../src/features/editor/ai-cutout.js';
import { normalizeEdits } from '../../../src/shared/edits/model.js';
import {
  createFinalMaskCache,
  getFinalMaskParamsKey,
} from '../../../src/shared/masks/final-masks.js';

/** @param {number} count */
function frames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    timestamp: i,
    width: 4,
    height: 2,
  }));
}

/** @param {number[]} values */
function mask(values) {
  return { data: Uint8Array.from(values), width: 4, height: 2 };
}

const ai = normalizeEdits({}, 4).background.ai;

describe('AI cutout helpers', () => {
  afterEach(() => setWasmAllowed(false));

  it('labels each model’s download size and the shared runtime', () => {
    expect(getModelSizeLabel('anime')).toBe('88 MB');
    expect(getModelSizeLabel('general')).toBe('90 MB');
    expect(RUNTIME_SIZE_LABEL).toBe('about 27 MB');
  });

  it('reads the model of the AI parameters (anime when missing or unknown)', () => {
    expect(getAiModelId({ model: 'general' })).toBe('general');
    expect(getAiModelId({ model: 'nope' })).toBe('anime');
    expect(getAiModelId({})).toBe('anime');
    expect(getAiModelId(null)).toBe('anime');
    expect(ai.model).toBe('anime');
  });

  it('remembers the explicit WASM choice', () => {
    expect(isWasmAllowed()).toBe(false);
    setWasmAllowed();
    expect(isWasmAllowed()).toBe(true);
    setWasmAllowed(false);
    expect(isWasmAllowed()).toBe(false);
  });

  it('shares one final-mask cache', () => {
    expect(getSharedFinalMaskCache()).toBe(getSharedFinalMaskCache());
  });

  it('looks probability masks up by frame key (holds share one)', () => {
    const store = createMaskStore();
    const clip = /** @type {any[]} */ (frames(3));
    clip[2] = { ...clip[2], sharedKey: 'f1' };
    clip[1] = { ...clip[1], sharedKey: 'f1' };
    store.set('anime:f1', mask([255, 0, 0, 0, 0, 0, 0, 0]));
    const getProb = getClipProbSource(clip, store);
    expect(getProb(0)).toBeNull();
    expect(getProb(2)).toBe(getProb(1));
    expect(getProb(9)).toBeNull();
    expect(isFrameAnalyzed(clip[2], { maskStore: store })).toBe(true);
    expect(isFrameAnalyzed(clip[0], { maskStore: store })).toBe(false);
    expect(isFrameAnalyzed(null, { maskStore: store })).toBe(false);
    // The general model has not analyzed anything
    expect(getClipProbSource(clip, store, 'general')(1)).toBeNull();
    expect(isFrameAnalyzed(clip[2], { maskStore: store, modelId: 'general' })).toBe(false);
  });

  it('reports the analysis coverage of the clip and the selection', () => {
    const store = createMaskStore();
    const clip = /** @type {any[]} */ (frames(4));
    clip[3] = { ...clip[3], sharedKey: 'shared' };
    clip[2] = { ...clip[2], sharedKey: 'shared' };
    store.set('anime:f0', mask(new Array(8).fill(0)));
    const cover = getAnalysisCoverage(clip, { start: 1, end: 3 }, { maskStore: store });
    expect(cover.selectionFrames).toHaveLength(3);
    // f1 and one analysis for the shared hold
    expect(cover.pendingInSelection).toBe(2);
    expect(cover.analyzedInClip).toBe(1);
    expect(cover.clipFrames).toBe(4);
    // Coverage is per model
    const general = getAnalysisCoverage(
      clip,
      { start: 0, end: 3 },
      { maskStore: store, modelId: 'general' },
    );
    expect(general.analyzedInClip).toBe(0);
    expect(general.pendingInSelection).toBe(3);
  });

  it('builds and memoizes the final masks of a clip', async () => {
    const store = createMaskStore();
    const cache = createFinalMaskCache();
    const clip = /** @type {any[]} */ (frames(2));
    store.set('anime:f0', mask([255, 255, 0, 0, 0, 0, 0, 0]));
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache })).toBeNull();
    const source = await buildClipMaskSource({ frames: clip, ai, maskStore: store, cache });
    expect(source.getFinalMask(0)).not.toBeNull();
    expect(source.getFinalMask(1)).toBeNull();
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache })).toBe(source);
    // New masks invalidate the memo
    store.set('anime:f1', mask(new Array(8).fill(255)));
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache })).toBeNull();
  });

  it('builds from the chosen model’s masks only and never reuses another model’s build', async () => {
    const store = createMaskStore();
    const cache = createFinalMaskCache();
    const clip = /** @type {any[]} */ (frames(2));
    store.set('anime:f0', mask(new Array(8).fill(255)));
    store.set('general:f1', mask(new Array(8).fill(255)));
    const anime = await buildClipMaskSource({ frames: clip, ai, maskStore: store, cache });
    expect(anime.getFinalMask(0)).not.toBeNull();
    expect(anime.getFinalMask(1)).toBeNull();
    const generalAi = { ...ai, model: 'general' };
    expect(peekClipMaskSource({ frames: clip, ai: generalAi, maskStore: store, cache })).toBeNull();
    const general = await buildClipMaskSource({
      frames: clip,
      ai: generalAi,
      maskStore: store,
      cache,
    });
    expect(general.getFinalMask(0)).toBeNull();
    expect(general.getFinalMask(1)).not.toBeNull();
  });

  it('never shares memoized masks between clips of the same shape', async () => {
    const store = createMaskStore();
    const cache = createFinalMaskCache();
    const clip = /** @type {any[]} */ (frames(2));
    store.set('anime:f0', mask(new Array(8).fill(255)));
    const a = await buildClipMaskSource({ frames: clip, ai, maskStore: store, cache, clipId: 'a' });
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache, clipId: 'a' })).toBe(a);
    expect(
      peekClipMaskSource({ frames: clip, ai, maskStore: store, cache, clipId: 'b' }),
    ).toBeNull();
    const b = await buildClipMaskSource({ frames: clip, ai, maskStore: store, cache, clipId: 'b' });
    expect(b).not.toBe(a);
    expect(getBuildParamsKey(clip, ai, 'a')).not.toBe(getBuildParamsKey(clip, ai, 'b'));
  });

  it('a settled build starts again when another caller supersedes it', async () => {
    const store = createMaskStore();
    const cache = createFinalMaskCache();
    const clip = /** @type {any[]} */ (frames(2));
    store.set('anime:f0', mask(new Array(8).fill(255)));
    const settled = buildClipMaskSourceSettled({
      frames: clip,
      ai,
      maskStore: store,
      cache,
      clipId: 'a',
    });
    // Another screen asks for different inputs while the first build runs:
    // the shared cache aborts the first one
    const other = buildClipMaskSource({ frames: clip, ai, maskStore: store, cache, clipId: 'b' });
    other.catch(() => {});
    const source = await settled;
    expect(source.getFinalMask(0)).not.toBeNull();
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache, clipId: 'a' })).toBe(
      source,
    );
  });

  it('a settled build still stops at its own signal', async () => {
    const store = createMaskStore();
    const cache = createFinalMaskCache();
    const clip = /** @type {any[]} */ (frames(2));
    store.set('anime:f0', mask(new Array(8).fill(255)));
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildClipMaskSourceSettled({
        frames: clip,
        ai,
        maskStore: store,
        cache,
        clipId: 'a',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('tells whether a pick lands on a character of the frame', () => {
    const store = createMaskStore();
    const clip = /** @type {any[]} */ (frames(3));
    // Left half foreground on frame 1 only; frame 2 not analyzed
    store.set('anime:f0', mask(new Array(8).fill(0)));
    store.set('anime:f1', mask([200, 200, 0, 0, 200, 200, 0, 0]));
    const at = (/** @type {number} */ frameIndex, /** @type {number} */ x, over = {}) =>
      pickFindsCharacter({
        frames: clip,
        ai: { ...ai, smoothing: false, ...over },
        frameIndex,
        point: { x, y: 0.5 },
        maskStore: store,
      });
    expect(at(1, 0.1)).toBe(true);
    expect(at(1, 0.9)).toBe(false);
    expect(at(0, 0.1)).toBe(false);
    expect(at(2, 0.1)).toBe(false);
    // The build's smoothing averages frame 1 with its empty neighbour
    expect(at(1, 0.1, { smoothing: true })).toBe(false);
  });

  it('keys builds on the parameters, not the masks', () => {
    const clip = /** @type {any[]} */ (frames(2));
    const key = getBuildParamsKey(clip, ai);
    expect(getBuildParamsKey(clip, { ...ai })).toBe(key);
    expect(getBuildParamsKey(clip, { ...ai, threshold: 0.6 })).not.toBe(key);
    expect(getBuildParamsKey(frames(3), ai)).not.toBe(key);
    // The same key the shared cache memoizes under (minus the store version)
    expect(getBuildParamsKey(clip, ai, 'a')).toBe(
      getFinalMaskParamsKey({ clipId: 'a', frameCount: 2, sourceWidth: 4, ai }),
    );
    expect(getBuildParamsKey([], ai)).toBe(getFinalMaskParamsKey({ frameCount: 0, ai }));
  });

  it('estimates the time left from the measured speed, else the typical one', () => {
    expect(
      estimateRemainingMs({ framesDone: 2, framesTotal: 10, elapsedMs: 1000, backend: 'wasm' }),
    ).toBe(4000);
    expect(
      estimateRemainingMs({ framesDone: 0, framesTotal: 3, elapsedMs: 0, backend: 'webgpu' }),
    ).toBe(3 * TYPICAL_FRAME_MS.webgpu);
    expect(
      estimateRemainingMs({ framesDone: 0, framesTotal: 3, elapsedMs: 0, backend: null }),
    ).toBeNull();
    expect(
      estimateRemainingMs({ framesDone: 3, framesTotal: 3, elapsedMs: 10, backend: null }),
    ).toBe(0);
  });

  it('formats the time left', () => {
    expect(formatTimeLeft(null)).toBe('estimating time left');
    expect(formatTimeLeft(500)).toBe('less than a second left');
    expect(formatTimeLeft(12_100)).toBe('about 13 s left');
    expect(formatTimeLeft(125_000)).toBe('about 3 min left');
  });

  it('describes each progress phase', () => {
    const base = {
      loadedBytes: 50_000_000,
      totalBytes: 200_000_000,
      framesDone: 3,
      framesTotal: 12,
      remainingMs: 9000,
    };
    expect(describeAnalysisProgress({ ...base, phase: 'downloading' })).toBe(
      'Downloading the model: 50.0 MB of 200.0 MB (25%)',
    );
    // Decimal megabytes, like the "88 MB" of the README and credits
    expect(
      describeAnalysisProgress({
        ...base,
        phase: 'downloading',
        loadedBytes: 12_000_000,
        totalBytes: 88_070_957,
      }),
    ).toBe('Downloading the model: 12.0 MB of 88.1 MB (13%)');
    expect(describeAnalysisProgress({ ...base, phase: 'downloading', fromCache: true })).toContain(
      'cache',
    );
    expect(describeAnalysisProgress({ ...base, phase: 'verifying' })).toContain('Checking');
    expect(describeAnalysisProgress({ ...base, phase: 'initializing' })).toContain('Starting');
    expect(describeAnalysisProgress({ ...base, phase: 'analyzing' })).toBe(
      'Analyzed 3 of 12 frames · about 9 s left',
    );
    expect(describeAnalysisProgress({ ...base, phase: 'starting' })).toBe('Preparing…');
    expect(
      describeAnalysisProgress({ ...base, phase: 'downloading', loadedBytes: 0, totalBytes: 0 }),
    ).toContain('(0%)');

    expect(getAnalysisFraction({ ...base, phase: 'downloading' })).toBe(0.25);
    expect(getAnalysisFraction({ ...base, phase: 'analyzing' })).toBe(0.25);
    expect(getAnalysisFraction({ ...base, phase: 'verifying' })).toBe(0);
    expect(getAnalysisFraction({ ...base, phase: 'analyzing', framesTotal: 0 })).toBe(0);
    expect(getAnalysisFraction({ ...base, phase: 'downloading', totalBytes: 0 })).toBe(0);
  });

  it('turns failures into user copy', () => {
    for (const code of Object.values(SegmentationErrorCode)) {
      if (code === SegmentationErrorCode.MODEL_UNAVAILABLE) continue;
      const described = describeAnalysisError(new SegmentationError(code, 'internal'));
      expect(described.code).toBe(code);
      expect(described.message).not.toContain('internal');
      expect(described.message.length).toBeGreaterThan(10);
    }
    // A missing custom model: its own message says which one and what to do
    const gone = 'The file of the custom model "Mine" is no longer in this browser.';
    expect(
      describeAnalysisError(new SegmentationError(SegmentationErrorCode.MODEL_UNAVAILABLE, gone)),
    ).toEqual({ code: SegmentationErrorCode.MODEL_UNAVAILABLE, message: gone });
    expect(
      describeAnalysisError(new SegmentationError(SegmentationErrorCode.MODEL_UNAVAILABLE, ''))
        .message,
    ).toMatch(/Settings → AI models/);
    expect(describeAnalysisError(new Error('boom'))).toEqual({
      code: 'unknown',
      message: 'The analysis failed: boom',
    });
    expect(describeAnalysisError(undefined).message).toBe('The analysis failed.');
  });

  it('recognizes cancellations', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe('getObjectsToTrack (export with tracked objects)', () => {
  const frames = /** @type {any[]} */ (
    Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, width: 4, height: 2 }))
  );
  const range = { start: 0, end: 3 };
  const whole = /** @type {any} */ ({
    id: 'o1',
    mode: 'remove',
    scope: 'whole',
    clicks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
  });
  const part = /** @type {any} */ ({ ...whole, scope: 'part' });
  const mask = () => ({ data: new Uint8Array(8).fill(255), width: 4, height: 2 });
  /**
   * A finished run of `object`: masks on `tracked`, the rest marked unreachable
   * @param {ReturnType<typeof createMaskStore>} store
   * @param {any} object
   * @param {number[]} tracked
   */
  const finishRun = (store, object, tracked) => {
    const tag = getObjectSignature(object);
    for (const [f, frame] of frames.entries()) {
      const key = `object:o1:${frame.id}`;
      if (tracked.includes(f)) store.set(key, mask(), 'clip', 'object:o1', tag);
      else store.mark(key, tag, 'clip', 'object:o1');
    }
  };

  it('tracks an object with a mask on only some frames (a run in flight or cancelled)', () => {
    const store = createMaskStore();
    store.set('object:o1:f0', mask(), 'clip', 'object:o1', getObjectSignature(whole));
    expect(getObjectsToTrack(frames, range, [whole], store)).toEqual([whole]);
  });

  it('skips an object whose frames all have a mask or an unreachable mark of it as it is now', () => {
    const store = createMaskStore();
    finishRun(store, whole, [0, 1]);
    expect(getObjectsToTrack(frames, range, [whole], store)).toEqual([]);
    // An explicit retry counts the marked frames
    expect(countUntrackedObjectFrames(frames, range, whole, store, { retryLost: true })).toBe(2);
  });

  it('tracks again after eviction drops a finished run’s masks and marks', () => {
    // Room for the object's masks, then a base-model group evicts them
    const store = createMaskStore({ capBytes: 40 });
    finishRun(store, whole, [0, 1, 2]);
    expect(getObjectsToTrack(frames, range, [whole], store)).toEqual([]);
    for (const frame of frames) {
      store.set(`general:${frame.id}`, mask(), 'clip', 'general');
    }
    expect(store.has('object:o1:f0')).toBe(false);
    expect(store.getMark('object:o1:f3')).toBeUndefined();
    expect(getObjectsToTrack(frames, range, [whole], store)).toEqual([whole]);
  });

  it('tracks during a Whole to Part retrack, though every frame still has a (Whole) mask', () => {
    const store = createMaskStore();
    finishRun(store, whole, [0, 1, 2, 3]);
    expect(getObjectsToTrack(frames, range, [whole], store)).toEqual([]);
    // Part chosen; its run has not replaced the Whole masks yet
    expect(getObjectsToTrack(frames, range, [part], store)).toEqual([part]);
    finishRun(store, part, [0, 1]);
    expect(getObjectsToTrack(frames, range, [part], store)).toEqual([]);
  });

  it('is lost with a clear of the store', () => {
    const store = createMaskStore();
    finishRun(store, whole, [0]);
    store.clear();
    expect(countUntrackedObjectFrames(frames, range, whole, store)).toBe(4);
  });
});

describe('chooseFixUp', () => {
  it('Remove: a separate piece is a pick, the subject a tracked fix-up, nothing nothing', () => {
    expect(chooseFixUp('separate', 'remove')).toBe('remove-pick');
    expect(chooseFixUp('main', 'remove')).toBe('remove-object');
    expect(chooseFixUp('none', 'remove')).toBe('none');
  });

  it('Keep: any piece is a pick, an empty spot a tracked fix-up', () => {
    expect(chooseFixUp('main', 'keep')).toBe('keep-pick');
    expect(chooseFixUp('separate', 'keep')).toBe('keep-pick');
    expect(chooseFixUp('none', 'keep')).toBe('add-object');
  });
});

describe('getObjectSignature with boxes', () => {
  it('changes when a box is added, so the masks of the old prompts go stale', () => {
    const object = /** @type {any} */ ({
      id: 'o1',
      mode: 'remove',
      scope: 'whole',
      clicks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }],
      boxes: [],
    });
    const boxed = { ...object, boxes: [{ frame: 0, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }] };
    expect(getObjectSignature(boxed)).not.toBe(getObjectSignature(object));
    expect(getObjectSignature({ ...object, boxes: undefined })).toBe(getObjectSignature(object));
  });
});
