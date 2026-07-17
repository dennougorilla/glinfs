import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearClipPayload,
  getClipPayload,
  getEditorPayload,
  getExportResult,
  releaseAllFramesAndReset,
  resetAppStore,
  setClipPayload,
  setEditorPayload,
  setExportResult,
} from '../../../src/shared/app-store.js';

// Mock VideoFrame-wrapping Frame object, matching the shape app-store expects:
// { id, frame: { close: vi.fn(), closed: false }, ... }
function createMockFrame(id = '1', closed = false) {
  return {
    id,
    frame: {
      close: vi.fn(),
      closed,
    },
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

function createMockFrames(count = 3) {
  return Array.from({ length: count }, (_, i) => createMockFrame(String(i)));
}

describe('setClipPayload frame lifecycle', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('closes the previous payload frames when a different frames array is set', () => {
    // Arrange
    const oldFrames = createMockFrames(2);
    setClipPayload({ frames: oldFrames, fps: 30, capturedAt: Date.now() });
    const newFrames = createMockFrames(2);

    // Act
    setClipPayload({ frames: newFrames, fps: 30, capturedAt: Date.now() });

    // Assert
    for (const f of oldFrames) {
      expect(f.frame.close).toHaveBeenCalledOnce();
    }
    for (const f of newFrames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }
  });

  it('does NOT close frames when the same frames array reference is passed again', () => {
    // Arrange - simulate a metadata-only update (e.g. adding scenes after capture)
    const frames = createMockFrames(2);
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });

    // Act
    setClipPayload({ frames, fps: 30, capturedAt: Date.now(), scenes: [{ start: 0, end: 1 }] });

    // Assert
    for (const f of frames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }
    expect(getClipPayload()?.scenes).toEqual([{ start: 0, end: 1 }]);
  });

  it('clears the editorPayload when a new (different) frames array is set', () => {
    // Arrange
    const oldFrames = createMockFrames(2);
    setClipPayload({ frames: oldFrames, fps: 30, capturedAt: Date.now() });
    setEditorPayload({
      selectedRange: { start: 0, end: 1 },
      cropArea: null,
      clip: { frames: oldFrames },
      fps: 30,
    });
    expect(getEditorPayload()).not.toBeNull();

    // Act
    const newFrames = createMockFrames(2);
    setClipPayload({ frames: newFrames, fps: 30, capturedAt: Date.now() });

    // Assert
    expect(getEditorPayload()).toBeNull();
  });

  it('does NOT clear the editorPayload on a metadata-only update (same frames reference)', () => {
    // Arrange
    const frames = createMockFrames(2);
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });
    setEditorPayload({
      selectedRange: { start: 0, end: 1 },
      cropArea: null,
      clip: { frames },
      fps: 30,
    });

    // Act
    setClipPayload({ frames, fps: 30, capturedAt: Date.now(), scenes: [] });

    // Assert
    expect(getEditorPayload()).not.toBeNull();
  });
});

describe('clearClipPayload frame lifecycle', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('closes frames when closeFrames=true', () => {
    // Arrange
    const frames = createMockFrames(3);
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });

    // Act
    clearClipPayload(true);

    // Assert
    for (const f of frames) {
      expect(f.frame.close).toHaveBeenCalledOnce();
    }
    expect(getClipPayload()).toBeNull();
  });

  it('does NOT close frames by default (closeFrames omitted)', () => {
    // Arrange
    const frames = createMockFrames(3);
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });

    // Act
    clearClipPayload();

    // Assert
    for (const f of frames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }
    expect(getClipPayload()).toBeNull();
  });

  it('does NOT close frames when closeFrames=false explicitly', () => {
    // Arrange
    const frames = createMockFrames(2);
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });

    // Act
    clearClipPayload(false);

    // Assert
    for (const f of frames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }
  });
});

describe('releaseAllFramesAndReset', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('closes BOTH clipPayload frames and editorPayload clip frames', () => {
    // Arrange - editorPayload stores its frames at payload.clip.frames
    const clipFrames = createMockFrames(2);
    const editorClipFrames = createMockFrames(2);
    setClipPayload({ frames: clipFrames, fps: 30, capturedAt: Date.now() });
    setEditorPayload({
      selectedRange: { start: 0, end: 1 },
      cropArea: null,
      clip: { frames: editorClipFrames },
      fps: 30,
    });

    // Act
    releaseAllFramesAndReset();

    // Assert
    for (const f of clipFrames) {
      expect(f.frame.close).toHaveBeenCalledOnce();
    }
    for (const f of editorClipFrames) {
      expect(f.frame.close).toHaveBeenCalledOnce();
    }
    expect(getClipPayload()).toBeNull();
    expect(getEditorPayload()).toBeNull();
  });

  it('clears the export result', () => {
    // Arrange
    setExportResult({ blob: new Blob(['x']), filename: 'clip.gif', completedAt: Date.now() });
    expect(getExportResult()).not.toBeNull();

    // Act
    releaseAllFramesAndReset();

    // Assert
    expect(getExportResult()).toBeNull();
  });

  it('handles null clipPayload and editorPayload without throwing', () => {
    // Act & Assert
    expect(() => releaseAllFramesAndReset()).not.toThrow();
    expect(getClipPayload()).toBeNull();
    expect(getEditorPayload()).toBeNull();
  });
});

describe('frames already marked closed', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('does not call close() again on frames already marked closed:true (setClipPayload)', () => {
    // Arrange
    const oldFrames = [createMockFrame('a', true), createMockFrame('b', false)];
    setClipPayload({ frames: oldFrames, fps: 30, capturedAt: Date.now() });

    // Act
    setClipPayload({ frames: createMockFrames(1), fps: 30, capturedAt: Date.now() });

    // Assert
    expect(oldFrames[0].frame.close).not.toHaveBeenCalled();
    expect(oldFrames[1].frame.close).toHaveBeenCalledOnce();
  });

  it('does not call close() again on frames already marked closed:true (clearClipPayload)', () => {
    // Arrange
    const frames = [createMockFrame('a', true), createMockFrame('b', true)];
    setClipPayload({ frames, fps: 30, capturedAt: Date.now() });

    // Act
    clearClipPayload(true);

    // Assert
    for (const f of frames) {
      expect(f.frame.close).not.toHaveBeenCalled();
    }
  });

  it('does not call close() again on frames already marked closed:true (releaseAllFramesAndReset)', () => {
    // Arrange
    const clipFrames = [createMockFrame('a', true)];
    const editorClipFrames = [createMockFrame('b', true)];
    setClipPayload({ frames: clipFrames, fps: 30, capturedAt: Date.now() });
    setEditorPayload({
      selectedRange: { start: 0, end: 0 },
      cropArea: null,
      clip: { frames: editorClipFrames },
      fps: 30,
    });

    // Act
    releaseAllFramesAndReset();

    // Assert
    expect(clipFrames[0].frame.close).not.toHaveBeenCalled();
    expect(editorClipFrames[0].frame.close).not.toHaveBeenCalled();
  });
});
