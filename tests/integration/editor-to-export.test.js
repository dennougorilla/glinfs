import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setEditorPayload,
  getEditorPayload,
  clearEditorPayload,
  validateEditorPayload,
  resetAppStore,
} from '../../src/shared/app-store.js';
import { closeAllFrames } from '../../src/shared/utils/videoframe.js';

/**
 * Integration tests for Editor → Export data flow
 *
 * These tests verify the contract between Editor and Export features:
 * 1. Editor clones selected frames for Export
 * 2. Export receives EditorPayload and validates it
 * 3. Export owns its cloned frames and is responsible for cleanup
 * 4. EditorPayload may be preserved for re-entry from Export
 */

// Helper to create mock VideoFrame
function createMockVideoFrame() {
  const frame = {
    close: vi.fn(),
    clone: vi.fn(() => createMockVideoFrame()),
    codedWidth: 1920,
    codedHeight: 1080,
  };
  return frame;
}

// Helper to create mock Frame object
function createMockFrame(id, videoFrame = createMockVideoFrame()) {
  return {
    id,
    frame: videoFrame,
    timestamp: Date.now() * 1000,
    width: 1920,
    height: 1080,
  };
}

// Helper to create mock Clip
function createMockClip(frameCount = 3) {
  const frames = Array.from({ length: frameCount }, (_, i) =>
    createMockFrame(`frame-${i}`)
  );
  return {
    frames,
    fps: 30,
    selectedRange: { start: 0, end: frameCount - 1 },
    cropArea: null,
  };
}

describe('Editor → Export Integration', () => {
  beforeEach(() => {
    resetAppStore();
  });

  afterEach(() => {
    resetAppStore();
  });

  describe('EditorPayload Data Transfer', () => {
    it('should store EditorPayload with all required fields', () => {
      // Arrange - Editor prepares payload
      const selectedFrames = [createMockFrame('1'), createMockFrame('2')];
      const clip = createMockClip(5);
      const cropArea = { x: 10, y: 20, width: 100, height: 80, aspectRatio: 'free' };

      const payload = {
        frames: selectedFrames,
        cropArea,
        clip,
        fps: 30,
      };

      // Act
      setEditorPayload(payload);

      // Assert
      const retrieved = getEditorPayload();
      expect(retrieved).toBe(payload);
      expect(retrieved.frames).toHaveLength(2);
      expect(retrieved.cropArea).toBe(cropArea);
      expect(retrieved.clip).toBe(clip);
      expect(retrieved.fps).toBe(30);
    });

    it('should allow null cropArea', () => {
      // Arrange
      const payload = {
        frames: [createMockFrame('1')],
        cropArea: null,
        clip: createMockClip(1),
        fps: 30,
      };

      // Act
      setEditorPayload(payload);

      // Assert
      const retrieved = getEditorPayload();
      expect(retrieved.cropArea).toBeNull();
    });

    it('should validate EditorPayload structure', () => {
      // Arrange
      const validPayload = {
        frames: [createMockFrame('1')],
        cropArea: null,
        fps: 30,
      };

      const invalidPayload = {
        frames: [], // Empty
        fps: 30,
      };

      // Act & Assert
      expect(validateEditorPayload(validPayload).valid).toBe(true);
      expect(validateEditorPayload(invalidPayload).valid).toBe(false);
    });

    it('should reject invalid FPS', () => {
      // Arrange
      const invalidPayload = {
        frames: [createMockFrame('1')],
        fps: 0, // Invalid
      };

      // Act
      const result = validateEditorPayload(invalidPayload);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('EditorPayload.fps must be a positive number');
    });
  });

  describe('Frame Cloning for Export', () => {
    it('should clone selected frames before transfer', () => {
      // Arrange - Editor has frames
      const editorFrames = [
        createMockFrame('editor-1'),
        createMockFrame('editor-2'),
        createMockFrame('editor-3'),
      ];

      // Simulate getSelectedFrames and cloning
      const selectedIndices = [0, 2]; // Select first and last
      const selectedFrames = selectedIndices.map((i) => editorFrames[i]);

      // Act - Clone for Export
      const clonedForExport = selectedFrames.map((frame) => ({
        ...frame,
        frame: frame.frame.clone(),
      }));

      // Assert
      selectedFrames.forEach((f) => {
        expect(f.frame.clone).toHaveBeenCalledOnce();
      });
      expect(clonedForExport).toHaveLength(2);
    });

    it('should maintain independent lifecycle for Editor and Export frames', () => {
      // Arrange
      const editorFrame = createMockFrame('editor-1');
      const exportFrame = {
        ...editorFrame,
        frame: createMockVideoFrame(), // Independent clone
      };

      setEditorPayload({
        frames: [exportFrame],
        cropArea: null,
        clip: createMockClip(1),
        fps: 30,
      });

      // Act - Export closes its frames
      closeAllFrames([exportFrame]);

      // Assert - Editor frame unaffected
      expect(exportFrame.frame.close).toHaveBeenCalled();
      expect(editorFrame.frame.close).not.toHaveBeenCalled();
    });
  });

  describe('Export Cleanup', () => {
    it('should close Export frames on cleanup', () => {
      // Arrange
      const exportFrames = [
        createMockFrame('export-1'),
        createMockFrame('export-2'),
      ];

      // Act - Simulate Export cleanup
      closeAllFrames(exportFrames);

      // Assert
      exportFrames.forEach((f) => {
        expect(f.frame.close).toHaveBeenCalled();
      });
    });

    it('should preserve EditorPayload for re-entry', () => {
      // Arrange
      const clip = createMockClip(3);
      const payload = {
        frames: [createMockFrame('1')],
        cropArea: { x: 0, y: 0, width: 100, height: 100, aspectRatio: '1:1' },
        clip,
        fps: 30,
      };
      setEditorPayload(payload);

      // Act - Export finishes but doesn't clear payload
      // (EditorPayload preserved for re-entry)

      // Assert - Payload still available
      expect(getEditorPayload()).toBe(payload);
      expect(getEditorPayload().clip).toBe(clip);
    });
  });

  describe('Crop Area Transfer', () => {
    it('should transfer crop area dimensions correctly', () => {
      // Arrange
      const cropArea = {
        x: 50,
        y: 100,
        width: 640,
        height: 480,
        aspectRatio: '4:3',
      };

      const payload = {
        frames: [createMockFrame('1')],
        cropArea,
        clip: createMockClip(1),
        fps: 30,
      };

      // Act
      setEditorPayload(payload);

      // Assert
      const retrieved = getEditorPayload();
      expect(retrieved.cropArea).toEqual(cropArea);
      expect(retrieved.cropArea.x).toBe(50);
      expect(retrieved.cropArea.y).toBe(100);
      expect(retrieved.cropArea.width).toBe(640);
      expect(retrieved.cropArea.height).toBe(480);
    });

    it('should handle different aspect ratios', () => {
      // Arrange
      const aspectRatios = ['free', '1:1', '16:9', '4:3', '9:16'];

      aspectRatios.forEach((ratio) => {
        const cropArea = { x: 0, y: 0, width: 100, height: 100, aspectRatio: ratio };
        const payload = {
          frames: [createMockFrame('1')],
          cropArea,
          clip: createMockClip(1),
          fps: 30,
        };

        // Act
        setEditorPayload(payload);

        // Assert
        expect(getEditorPayload().cropArea.aspectRatio).toBe(ratio);
      });
    });
  });
});
