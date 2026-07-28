import { describe, expect, it, vi } from 'vitest';
import { calculateEffectiveMaxFrames } from '../../../src/features/capture/core.js';
import { fitWithinLongEdge } from '../../../src/shared/utils/geometry.js';
import { CaptureWorkerManager } from '../../../src/workers/capture-worker-manager.js';

/**
 * #96: memory safety. A Retina fullscreen capture at defaults nominally
 * needs ~10 GB of raw RGBA and crashed a real machine — these tests pin
 * the two defenses: downscale-at-grab and the budget-clamped ring buffer.
 */

describe('fitWithinLongEdge (#96 downscale math)', () => {
  it('scales a Retina landscape frame down to the limit, preserving aspect', () => {
    const r = fitWithinLongEdge(3024, 1964, 1920);
    expect(r.scaled).toBe(true);
    expect(r.width).toBe(1920);
    // 1964 * (1920/3024) = 1247.2 -> floored to even
    expect(r.height).toBe(1246);
    expect(Math.abs(r.width / r.height - 3024 / 1964)).toBeLessThan(0.01);
  });

  it('scales portrait frames by their long edge (height)', () => {
    const r = fitWithinLongEdge(1080, 2340, 1920);
    expect(r.scaled).toBe(true);
    expect(r.height).toBe(1920);
    expect(r.width).toBeLessThan(1080);
  });

  it('never upscales', () => {
    expect(fitWithinLongEdge(1280, 720, 1920)).toEqual({
      width: 1280,
      height: 720,
      scaled: false,
    });
  });

  it('0 disables the limit (native)', () => {
    expect(fitWithinLongEdge(5120, 2880, 0)).toEqual({
      width: 5120,
      height: 2880,
      scaled: false,
    });
  });

  it('always returns even dimensions when scaling', () => {
    const r = fitWithinLongEdge(3025, 1963, 1280);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
  });
});

describe('calculateEffectiveMaxFrames (#96 budget clamp)', () => {
  const settings = /** @type {any} */ ({ fps: 30, bufferDuration: 15 });

  it('honors the requested size when it fits the budget', () => {
    // 640x480 RGBA = ~1.2 MB/frame; 450 frames = ~527 MB < 60% of 2000 MB
    const r = calculateEffectiveMaxFrames(settings, { width: 640, height: 480 }, 2000);
    expect(r).toMatchObject({ maxFrames: 450, requestedFrames: 450, clamped: false });
    expect(r.effectiveDuration).toBe(15);
  });

  it('clamps the buffer when the frame size blows the budget', () => {
    // 3024x1964 native Retina ≈ 23.8 MB/frame; 60% of 2000 MB fits ~52 frames
    const r = calculateEffectiveMaxFrames(settings, { width: 3024, height: 1964 }, 2000);
    expect(r.clamped).toBe(true);
    expect(r.maxFrames).toBeLessThan(60);
    expect(r.maxFrames).toBeGreaterThan(0);
    expect(r.effectiveDuration).toBeCloseTo(r.maxFrames / 30, 5);
  });

  it('skips the clamp when dimensions are not yet known', () => {
    const r = calculateEffectiveMaxFrames(settings, null, 2000);
    expect(r).toMatchObject({ maxFrames: 450, clamped: false });
  });

  it('never clamps to zero frames', () => {
    const r = calculateEffectiveMaxFrames(settings, { width: 8000, height: 8000 }, 500);
    expect(r.maxFrames).toBeGreaterThanOrEqual(1);
  });
});

describe('CaptureWorkerManager downscale-at-grab (#96)', () => {
  it('reports effective dimensions honoring the maxEdge option', () => {
    const manager = new CaptureWorkerManager();
    const video = /** @type {any} */ ({ videoWidth: 3024, videoHeight: 1964, readyState: 2 });
    vi.stubGlobal(
      'Worker',
      class {
        postMessage() {}
        terminate() {}
      },
    );
    try {
      manager.init(video, { maxEdge: 1920 });
      const dims = manager.getEffectiveFrameDimensions();
      expect(dims).toMatchObject({ width: 1920, height: 1246, scaled: true });
    } finally {
      vi.unstubAllGlobals();
      manager.terminate();
    }
  });

  it('returns null before video metadata is available', () => {
    const manager = new CaptureWorkerManager();
    const video = /** @type {any} */ ({ videoWidth: 0, videoHeight: 0, readyState: 0 });
    vi.stubGlobal(
      'Worker',
      class {
        postMessage() {}
        terminate() {}
      },
    );
    try {
      manager.init(video, { maxEdge: 1920 });
      expect(manager.getEffectiveFrameDimensions()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      manager.terminate();
    }
  });
});
