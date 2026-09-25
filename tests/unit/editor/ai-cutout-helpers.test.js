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
  DOWNLOAD_SIZE_LABEL,
  describeAnalysisError,
  describeAnalysisProgress,
  estimateRemainingMs,
  formatTimeLeft,
  getAnalysisCoverage,
  getAnalysisFraction,
  getBuildParamsKey,
  getClipProbSource,
  getSharedFinalMaskCache,
  isAbortError,
  isFrameAnalyzed,
  isWasmAllowed,
  peekClipMaskSource,
  setWasmAllowed,
  TYPICAL_FRAME_MS,
} from '../../../src/features/editor/ai-cutout.js';
import { normalizeEdits } from '../../../src/shared/edits/model.js';
import { createFinalMaskCache } from '../../../src/shared/masks/final-masks.js';

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

  it('says "about 200 MB" for the first download', () => {
    expect(DOWNLOAD_SIZE_LABEL).toBe('about 200 MB');
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
    store.set('f1', mask([255, 0, 0, 0, 0, 0, 0, 0]));
    const getProb = getClipProbSource(clip, store);
    expect(getProb(0)).toBeNull();
    expect(getProb(2)).toBe(getProb(1));
    expect(getProb(9)).toBeNull();
    expect(isFrameAnalyzed(clip[2], store)).toBe(true);
    expect(isFrameAnalyzed(clip[0], store)).toBe(false);
    expect(isFrameAnalyzed(null, store)).toBe(false);
  });

  it('reports the analysis coverage of the clip and the selection', () => {
    const store = createMaskStore();
    const clip = /** @type {any[]} */ (frames(4));
    clip[3] = { ...clip[3], sharedKey: 'shared' };
    clip[2] = { ...clip[2], sharedKey: 'shared' };
    store.set('f0', mask(new Array(8).fill(0)));
    const cover = getAnalysisCoverage(clip, { start: 1, end: 3 }, store);
    expect(cover.selectionFrames).toHaveLength(3);
    // f1 and one analysis for the shared hold
    expect(cover.pendingInSelection).toBe(2);
    expect(cover.analyzedInClip).toBe(1);
    expect(cover.clipFrames).toBe(4);
  });

  it('builds and memoizes the final masks of a clip', async () => {
    const store = createMaskStore();
    const cache = createFinalMaskCache();
    const clip = /** @type {any[]} */ (frames(2));
    store.set('f0', mask([255, 255, 0, 0, 0, 0, 0, 0]));
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache })).toBeNull();
    const source = await buildClipMaskSource({ frames: clip, ai, maskStore: store, cache });
    expect(source.getFinalMask(0)).not.toBeNull();
    expect(source.getFinalMask(1)).toBeNull();
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache })).toBe(source);
    // New masks invalidate the memo
    store.set('f1', mask(new Array(8).fill(255)));
    expect(peekClipMaskSource({ frames: clip, ai, maskStore: store, cache })).toBeNull();
  });

  it('keys builds on the parameters, not the masks', () => {
    const clip = /** @type {any[]} */ (frames(2));
    const key = getBuildParamsKey(clip, ai);
    expect(getBuildParamsKey(clip, { ...ai })).toBe(key);
    expect(getBuildParamsKey(clip, { ...ai, threshold: 0.6 })).not.toBe(key);
    expect(getBuildParamsKey(frames(3), ai)).not.toBe(key);
    expect(getBuildParamsKey([], ai)).toContain('0|0|');
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
      loadedBytes: 50 * 1024 * 1024,
      totalBytes: 200 * 1024 * 1024,
      framesDone: 3,
      framesTotal: 12,
      remainingMs: 9000,
    };
    expect(describeAnalysisProgress({ ...base, phase: 'downloading' })).toBe(
      'Downloading the model: 50.0 MB of 200.0 MB (25%)',
    );
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
      const described = describeAnalysisError(new SegmentationError(code, 'internal'));
      expect(described.code).toBe(code);
      expect(described.message).not.toContain('internal');
      expect(described.message.length).toBeGreaterThan(10);
    }
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
