import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearClipPayload,
  clearEditorPayload,
  clearScreenCaptureState,
  getClipPayload,
  getEditorPayload,
  registerScreenCaptureCleanup,
  resetAppStore,
  setClipPayload,
  setEditorPayload,
  setScreenCaptureState,
  validateClipPayload,
  validateEditorPayload,
} from '../../../src/shared/app-store.js';
import { getThumbnailCache } from '../../../src/shared/utils/thumbnail-cache.js';

// Mock frame for testing (use plain object instead of ImageData for Node.js compatibility)
function createMockFrame(id = '1') {
  return {
    id,
    data: { data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 },
    width: 100,
    height: 100,
    timestamp: Date.now(),
  };
}

describe('ClipPayload', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('returns null when no payload set', () => {
    expect(getClipPayload()).toBeNull();
  });

  it('stores and retrieves clip payload', () => {
    const payload = {
      frames: [createMockFrame()],
      fps: 30,
      capturedAt: Date.now(),
    };

    setClipPayload(payload);

    const result = getClipPayload();
    expect(result).toEqual(payload);
    expect(result?.fps).toBe(30);
  });

  it('clears clip payload', () => {
    setClipPayload({
      frames: [createMockFrame()],
      fps: 30,
      capturedAt: Date.now(),
    });

    clearClipPayload();

    expect(getClipPayload()).toBeNull();
  });

  it('preserves FPS value through storage', () => {
    const payload60fps = {
      frames: [createMockFrame()],
      fps: 60,
      capturedAt: Date.now(),
    };

    setClipPayload(payload60fps);

    expect(getClipPayload()?.fps).toBe(60);
  });
});

describe('ClipPayload thumbnail cache lifecycle', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('releases cached thumbnails when replacing the clip frames', () => {
    setClipPayload({ frames: [createMockFrame('old')], fps: 30, capturedAt: Date.now() });
    getThumbnailCache().cache.set('old', document.createElement('canvas'));

    setClipPayload({ frames: [createMockFrame('new')], fps: 30, capturedAt: Date.now() });

    expect(getThumbnailCache().size).toBe(0);
  });

  it('keeps cached thumbnails when only clip metadata changes', () => {
    const frames = [createMockFrame('same')];
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });
    getThumbnailCache().cache.set('same', document.createElement('canvas'));

    setClipPayload({
      frames,
      fps: 30,
      capturedAt: Date.now(),
      scenes: [{ id: 'scene-1', startFrame: 0, endFrame: 0 }],
    });

    expect(getThumbnailCache().size).toBe(1);
  });

  it('releases cached thumbnails when clearing the clip', () => {
    setClipPayload({ frames: [createMockFrame()], fps: 30, capturedAt: Date.now() });
    getThumbnailCache().cache.set('1', document.createElement('canvas'));

    clearClipPayload();

    expect(getThumbnailCache().size).toBe(0);
  });
});

describe('EditorPayload', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('returns null when no payload set', () => {
    expect(getEditorPayload()).toBeNull();
  });

  it('stores and retrieves editor payload', () => {
    const payload = {
      frames: [createMockFrame()],
      cropArea: null,
      clip: {
        id: 'test',
        frames: [createMockFrame()],
        selectedRange: { start: 0, end: 0 },
        cropArea: null,
        createdAt: Date.now(),
        fps: 30,
      },
      fps: 30,
    };

    setEditorPayload(payload);

    const result = getEditorPayload();
    expect(result).toEqual(payload);
  });

  it('clears editor payload', () => {
    setEditorPayload({
      frames: [createMockFrame()],
      cropArea: null,
      clip: {
        id: 'test',
        frames: [createMockFrame()],
        selectedRange: { start: 0, end: 0 },
        cropArea: null,
        createdAt: Date.now(),
        fps: 30,
      },
      fps: 30,
    });

    clearEditorPayload();

    expect(getEditorPayload()).toBeNull();
  });

  it('stores crop area correctly', () => {
    const cropArea = { x: 10, y: 20, width: 100, height: 80, aspectRatio: 'free' };
    const payload = {
      frames: [createMockFrame()],
      cropArea,
      clip: {
        id: 'test',
        frames: [createMockFrame()],
        selectedRange: { start: 0, end: 0 },
        cropArea,
        createdAt: Date.now(),
        fps: 30,
      },
      fps: 30,
    };

    setEditorPayload(payload);

    expect(getEditorPayload()?.cropArea).toEqual(cropArea);
  });
});

describe('validateClipPayload', () => {
  it('returns valid for correct payload', () => {
    const payload = {
      frames: [createMockFrame()],
      fps: 30,
      capturedAt: Date.now(),
    };

    const result = validateClipPayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns invalid for null payload', () => {
    const result = validateClipPayload(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns invalid for empty frames', () => {
    const payload = {
      frames: [],
      fps: 30,
      capturedAt: Date.now(),
    };

    const result = validateClipPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ClipPayload.frames cannot be empty');
  });

  it('returns invalid for non-array frames', () => {
    const payload = {
      frames: 'not an array',
      fps: 30,
      capturedAt: Date.now(),
    };

    const result = validateClipPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ClipPayload.frames must be an array');
  });

  it('returns invalid for invalid FPS', () => {
    const payload = {
      frames: [createMockFrame()],
      fps: 45, // Invalid FPS
      capturedAt: Date.now(),
    };

    const result = validateClipPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ClipPayload.fps must be 15, 30, or 60');
  });

  it('accepts all valid FPS values', () => {
    for (const fps of [15, 30, 60]) {
      const payload = {
        frames: [createMockFrame()],
        fps,
        capturedAt: Date.now(),
      };

      const result = validateClipPayload(payload);
      expect(result.valid).toBe(true);
    }
  });
});

describe('validateEditorPayload', () => {
  it('returns valid for correct payload', () => {
    const payload = {
      selectedRange: { start: 0, end: 10 },
      cropArea: null,
      clip: { frames: [createMockFrame()] },
      fps: 30,
    };

    const result = validateEditorPayload(payload);
    expect(result.valid).toBe(true);
  });

  it('returns invalid for missing selectedRange', () => {
    const payload = {
      cropArea: null,
      clip: { frames: [createMockFrame()] },
      fps: 30,
    };

    const result = validateEditorPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('EditorPayload.selectedRange must be an object');
  });

  it('returns invalid for invalid selectedRange', () => {
    const payload = {
      selectedRange: { start: 10, end: 5 }, // start > end
      cropArea: null,
      clip: { frames: [createMockFrame()] },
      fps: 30,
    };

    const result = validateEditorPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('EditorPayload.selectedRange.start must not exceed end');
  });

  it('accepts null crop area', () => {
    const payload = {
      selectedRange: { start: 0, end: 10 },
      cropArea: null,
      clip: { frames: [createMockFrame()] },
      fps: 30,
    };

    const result = validateEditorPayload(payload);
    expect(result.valid).toBe(true);
  });

  it('accepts valid crop area', () => {
    const payload = {
      selectedRange: { start: 0, end: 10 },
      cropArea: { x: 0, y: 0, width: 100, height: 100 },
      clip: { frames: [createMockFrame()] },
      fps: 30,
    };

    const result = validateEditorPayload(payload);
    expect(result.valid).toBe(true);
  });
});

describe('resetAppStore', () => {
  it('clears all payloads', () => {
    setClipPayload({
      frames: [createMockFrame()],
      fps: 30,
      capturedAt: Date.now(),
    });

    setEditorPayload({
      selectedRange: { start: 0, end: 10 },
      cropArea: null,
      clip: { frames: [createMockFrame()] },
      fps: 30,
    });

    resetAppStore();

    expect(getClipPayload()).toBeNull();
    expect(getEditorPayload()).toBeNull();
  });
});

describe('clearScreenCaptureState', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('resolves after the registered async cleanup completes', async () => {
    let cleanupDone = false;
    registerScreenCaptureCleanup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      cleanupDone = true;
    });
    setScreenCaptureState({ settings: { fps: 30 } });

    await clearScreenCaptureState();

    expect(cleanupDone).toBe(true);
  });

  it('passes the cleared state and stopStream option to the cleanup fn', async () => {
    const cleanupFn = vi.fn();
    registerScreenCaptureCleanup(cleanupFn);
    const captureState = { settings: { fps: 30 } };
    setScreenCaptureState(captureState);

    await clearScreenCaptureState(false);

    expect(cleanupFn).toHaveBeenCalledWith(captureState, { stopStream: false });
  });

  it('logs instead of throwing when the async cleanup rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerScreenCaptureCleanup(async () => {
      throw new Error('teardown boom');
    });
    setScreenCaptureState({ settings: { fps: 30 } });

    await expect(clearScreenCaptureState()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('resolves immediately when no capture state is stored', async () => {
    const cleanupFn = vi.fn();
    registerScreenCaptureCleanup(cleanupFn);

    await clearScreenCaptureState();

    expect(cleanupFn).not.toHaveBeenCalled();
  });
});
