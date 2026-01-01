import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setClipPayload,
  getClipPayload,
  clearClipPayload,
  setEditorPayload,
  getEditorPayload,
  clearEditorPayload,
  setExportResult,
  getExportResult,
  clearExportResult,
  resetAppStore,
} from '../../src/shared/app-store.js';
import { closeAllFrames } from '../../src/shared/utils/videoframe.js';

/**
 * Integration tests for the full Capture → Editor → Export workflow
 *
 * These tests verify the complete data flow and VideoFrame lifecycle
 * across all three features, simulating real user scenarios.
 */

// Track all created frames for verification
let allCreatedFrames = [];

// Helper to create mock VideoFrame with tracking
function createMockVideoFrame() {
  const frame = {
    close: vi.fn(),
    clone: vi.fn(() => {
      const cloned = createMockVideoFrame();
      allCreatedFrames.push(cloned);
      return cloned;
    }),
    codedWidth: 1920,
    codedHeight: 1080,
  };
  allCreatedFrames.push(frame);
  return frame;
}

// Helper to create mock Frame object
function createMockFrame(id) {
  return {
    id,
    frame: createMockVideoFrame(),
    timestamp: Date.now() * 1000,
    width: 1920,
    height: 1080,
  };
}

describe('Full Workflow Integration', () => {
  beforeEach(() => {
    resetAppStore();
    allCreatedFrames = [];
  });

  afterEach(() => {
    resetAppStore();
    allCreatedFrames = [];
  });

  describe('Complete Capture → Editor → Export Flow', () => {
    it('should maintain proper VideoFrame ownership through entire workflow', () => {
      // === CAPTURE PHASE ===
      // Capture creates original frames in buffer
      const captureOriginals = [
        createMockFrame('capture-1'),
        createMockFrame('capture-2'),
        createMockFrame('capture-3'),
      ];

      // Capture clones frames for Editor
      const captureToEditorClones = captureOriginals.map((f, i) => ({
        ...f,
        id: `editor-${i}`,
        frame: f.frame.clone(),
      }));

      // Store in ClipPayload
      setClipPayload({
        frames: captureToEditorClones,
        fps: 30,
        capturedAt: Date.now(),
      });

      // Verify: Originals and clones are independent
      expect(captureOriginals[0].frame).not.toBe(captureToEditorClones[0].frame);

      // === EDITOR PHASE ===
      // Editor receives ClipPayload
      const clipPayload = getClipPayload();
      expect(clipPayload.frames).toHaveLength(3);

      // Editor selects subset (first 2 frames)
      const selectedFrames = clipPayload.frames.slice(0, 2);

      // Editor clones for Export
      const editorToExportClones = selectedFrames.map((f, i) => ({
        ...f,
        id: `export-${i}`,
        frame: f.frame.clone(),
      }));

      // Store in EditorPayload
      setEditorPayload({
        frames: editorToExportClones,
        cropArea: { x: 0, y: 0, width: 1920, height: 1080, aspectRatio: 'free' },
        clip: {
          frames: clipPayload.frames,
          fps: 30,
          selectedRange: { start: 0, end: 1 },
          cropArea: null,
        },
        fps: 30,
      });

      // === EXPORT PHASE ===
      // Export receives EditorPayload
      const editorPayload = getEditorPayload();
      expect(editorPayload.frames).toHaveLength(2);

      // Export processes frames and creates result
      const mockBlob = new Blob(['GIF89a...'], { type: 'image/gif' });
      setExportResult({
        blob: mockBlob,
        filename: 'recording.gif',
        completedAt: Date.now(),
      });

      // Export cleanup - close its frames
      closeAllFrames(editorPayload.frames);

      // Verify: Export frames closed, Editor frames unaffected
      editorToExportClones.forEach((f) => {
        expect(f.frame.close).toHaveBeenCalled();
      });

      // Editor's original frames should NOT be closed yet
      captureToEditorClones.forEach((f) => {
        expect(f.frame.close).not.toHaveBeenCalled();
      });

      // === EDITOR CLEANUP ===
      // When navigating away from Editor
      closeAllFrames(clipPayload.frames);
      clearClipPayload();

      // Verify: Editor's frames now closed
      captureToEditorClones.forEach((f) => {
        expect(f.frame.close).toHaveBeenCalled();
      });

      // === CAPTURE CLEANUP ===
      // Capture cleans up its originals (e.g., on clearBuffer)
      captureOriginals.forEach((f) => f.frame.close());

      // Verify: All frames closed
      allCreatedFrames.forEach((f) => {
        expect(f.close).toHaveBeenCalled();
      });
    });

    it('should handle navigation back from Export to Editor', () => {
      // Setup: Complete flow to Export
      const captureFrames = [createMockFrame('1'), createMockFrame('2')];
      const editorFrames = captureFrames.map((f, i) => ({
        ...f,
        id: `editor-${i}`,
        frame: f.frame.clone(),
      }));

      setClipPayload({
        frames: editorFrames,
        fps: 30,
        capturedAt: Date.now(),
      });

      const exportFrames = editorFrames.map((f, i) => ({
        ...f,
        id: `export-${i}`,
        frame: f.frame.clone(),
      }));

      setEditorPayload({
        frames: exportFrames,
        cropArea: null,
        clip: { frames: editorFrames, fps: 30, selectedRange: { start: 0, end: 1 }, cropArea: null },
        fps: 30,
      });

      // User navigates back to Editor
      // Export should close its frames but preserve EditorPayload
      closeAllFrames(exportFrames);

      // EditorPayload should still be available (for state restoration)
      expect(getEditorPayload()).not.toBeNull();
      expect(getEditorPayload().clip.frames).toBe(editorFrames);

      // Editor frames should still be valid (not closed)
      editorFrames.forEach((f) => {
        expect(f.frame.close).not.toHaveBeenCalled();
      });
    });

    it('should handle creating new clip while in Editor', () => {
      // Initial flow
      const firstClipFrames = [createMockFrame('first-1')];
      const firstEditorFrames = firstClipFrames.map((f) => ({
        ...f,
        frame: f.frame.clone(),
      }));

      setClipPayload({
        frames: firstEditorFrames,
        fps: 30,
        capturedAt: Date.now(),
      });

      // User creates new clip (simulating Capture's handleCreateClip)
      // This should clean up old payloads
      const oldClipPayload = getClipPayload();
      const oldEditorPayload = getEditorPayload();

      if (oldClipPayload) {
        closeAllFrames(oldClipPayload.frames);
        clearClipPayload();
      }
      if (oldEditorPayload) {
        closeAllFrames(oldEditorPayload.frames);
        clearEditorPayload();
      }
      clearExportResult();

      // Verify old frames closed
      firstEditorFrames.forEach((f) => {
        expect(f.frame.close).toHaveBeenCalled();
      });

      // Create new clip
      const secondClipFrames = [createMockFrame('second-1'), createMockFrame('second-2')];
      const secondEditorFrames = secondClipFrames.map((f) => ({
        ...f,
        frame: f.frame.clone(),
      }));

      setClipPayload({
        frames: secondEditorFrames,
        fps: 60,
        capturedAt: Date.now(),
      });

      // Verify new clip is available
      expect(getClipPayload().frames).toHaveLength(2);
      expect(getClipPayload().fps).toBe(60);

      // New frames should not be closed
      secondEditorFrames.forEach((f) => {
        expect(f.frame.close).not.toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling in Workflow', () => {
    it('should handle already-closed frames gracefully', () => {
      // Arrange
      const frames = [createMockFrame('1')];
      setClipPayload({
        frames,
        fps: 30,
        capturedAt: Date.now(),
      });

      // First close
      closeAllFrames(frames);
      expect(frames[0].frame.close).toHaveBeenCalledOnce();

      // Make close throw on second call
      frames[0].frame.close.mockImplementation(() => {
        throw new Error('Frame already closed');
      });

      // Second close should not throw
      expect(() => closeAllFrames(frames)).not.toThrow();
    });

    it('should handle partial frame failures', () => {
      // Arrange - One frame will fail to close
      const frames = [
        createMockFrame('1'),
        createMockFrame('2'),
        createMockFrame('3'),
      ];

      frames[1].frame.close.mockImplementation(() => {
        throw new Error('Close failed');
      });

      // Act - Should continue despite failure
      const closedCount = closeAllFrames(frames);

      // Assert - 2 closed successfully, 1 failed
      expect(closedCount).toBe(2);
      expect(frames[0].frame.close).toHaveBeenCalled();
      expect(frames[1].frame.close).toHaveBeenCalled();
      expect(frames[2].frame.close).toHaveBeenCalled();
    });
  });

  describe('Export Result Lifecycle', () => {
    it('should store and retrieve export result', () => {
      // Arrange
      const mockBlob = new Blob(['GIF data'], { type: 'image/gif' });
      const result = {
        blob: mockBlob,
        filename: 'test.gif',
        completedAt: Date.now(),
      };

      // Act
      setExportResult(result);

      // Assert
      const retrieved = getExportResult();
      expect(retrieved.blob).toBe(mockBlob);
      expect(retrieved.filename).toBe('test.gif');
      expect(retrieved.completedAt).toBe(result.completedAt);
    });

    it('should clear export result on new clip creation', () => {
      // Arrange
      setExportResult({
        blob: new Blob(['test']),
        filename: 'old.gif',
        completedAt: Date.now(),
      });

      // Act - Clear as part of new clip flow
      clearExportResult();

      // Assert
      expect(getExportResult()).toBeNull();
    });
  });
});
