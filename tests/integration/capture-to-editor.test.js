import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setClipPayload,
  getClipPayload,
  clearClipPayload,
  validateClipPayload,
  resetAppStore,
} from '../../src/shared/app-store.js';
import { closeAllFrames } from '../../src/shared/utils/videoframe.js';

/**
 * Integration tests for Capture → Editor data flow
 *
 * These tests verify the contract between Capture and Editor features:
 * 1. Capture creates cloned VideoFrames and stores in ClipPayload
 * 2. Editor receives ClipPayload and validates it
 * 3. Editor owns the cloned frames and is responsible for cleanup
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

describe('Capture → Editor Integration', () => {
  beforeEach(() => {
    resetAppStore();
  });

  afterEach(() => {
    resetAppStore();
  });

  describe('ClipPayload Data Transfer', () => {
    it('should store ClipPayload with valid structure', () => {
      // Arrange - Capture creates cloned frames
      const originalFrame = createMockFrame('orig-1');
      const clonedFrame = {
        ...originalFrame,
        id: 'clone-1',
        frame: originalFrame.frame.clone(),
      };

      const payload = {
        frames: [clonedFrame],
        fps: 30,
        capturedAt: Date.now(),
      };

      // Act - Capture stores payload
      setClipPayload(payload);

      // Assert - Editor can retrieve it
      const retrieved = getClipPayload();
      expect(retrieved).toBe(payload);
      expect(retrieved.frames).toHaveLength(1);
      expect(retrieved.fps).toBe(30);
    });

    it('should validate ClipPayload structure correctly', () => {
      // Arrange
      const validPayload = {
        frames: [createMockFrame('1')],
        fps: 30,
        capturedAt: Date.now(),
      };

      const invalidPayload = {
        frames: [], // Empty frames
        fps: 30,
        capturedAt: Date.now(),
      };

      // Act & Assert
      expect(validateClipPayload(validPayload).valid).toBe(true);
      expect(validateClipPayload(invalidPayload).valid).toBe(false);
      expect(validateClipPayload(invalidPayload).errors).toContain(
        'ClipPayload.frames cannot be empty'
      );
    });

    it('should reject invalid FPS values', () => {
      // Arrange
      const invalidFpsPayload = {
        frames: [createMockFrame('1')],
        fps: 25, // Invalid - must be 15, 30, or 60
        capturedAt: Date.now(),
      };

      // Act
      const result = validateClipPayload(invalidFpsPayload);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('ClipPayload.fps must be 15, 30, or 60');
    });

    it('should handle null payload gracefully', () => {
      // Act
      const result = validateClipPayload(null);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('ClipPayload must be an object');
    });
  });

  describe('VideoFrame Ownership', () => {
    it('should clone frames before transfer (simulating Capture behavior)', () => {
      // Arrange - Original frames in Capture buffer
      const originalFrames = [
        createMockFrame('orig-1'),
        createMockFrame('orig-2'),
      ];

      // Act - Capture clones frames for Editor
      const clonedFrames = originalFrames.map((frame, i) => ({
        ...frame,
        id: `clone-${i}`,
        frame: frame.frame.clone(),
      }));

      // Assert - clone() was called for each frame
      originalFrames.forEach((f) => {
        expect(f.frame.clone).toHaveBeenCalledOnce();
      });

      // Clones are independent objects
      expect(clonedFrames[0].frame).not.toBe(originalFrames[0].frame);
    });

    it('should allow independent cleanup of original and cloned frames', () => {
      // Arrange
      const originalFrame = createMockFrame('orig-1');
      const clonedFrame = {
        ...originalFrame,
        id: 'clone-1',
        frame: createMockVideoFrame(), // Independent clone
      };

      // Act - Close original (simulating Capture cleanup)
      originalFrame.frame.close();

      // Assert - Cloned frame still usable
      expect(originalFrame.frame.close).toHaveBeenCalled();
      expect(clonedFrame.frame.close).not.toHaveBeenCalled();

      // Act - Close clone (simulating Editor cleanup)
      clonedFrame.frame.close();
      expect(clonedFrame.frame.close).toHaveBeenCalled();
    });

    it('should clear ClipPayload after Editor cleanup', () => {
      // Arrange
      const frames = [createMockFrame('1'), createMockFrame('2')];
      setClipPayload({
        frames,
        fps: 30,
        capturedAt: Date.now(),
      });

      // Act - Simulate Editor cleanup
      const payload = getClipPayload();
      closeAllFrames(payload.frames);
      clearClipPayload();

      // Assert
      expect(getClipPayload()).toBeNull();
      frames.forEach((f) => {
        expect(f.frame.close).toHaveBeenCalled();
      });
    });
  });

  describe('Multiple Clip Creation', () => {
    it('should close old frames when creating new clip', () => {
      // Arrange - First clip
      const oldFrames = [createMockFrame('old-1'), createMockFrame('old-2')];
      setClipPayload({
        frames: oldFrames,
        fps: 30,
        capturedAt: Date.now(),
      });

      // Act - Create new clip (simulating Capture's handleCreateClip)
      const oldPayload = getClipPayload();
      if (oldPayload) {
        closeAllFrames(oldPayload.frames);
        clearClipPayload();
      }

      const newFrames = [createMockFrame('new-1')];
      setClipPayload({
        frames: newFrames,
        fps: 60,
        capturedAt: Date.now(),
      });

      // Assert - Old frames closed, new payload set
      oldFrames.forEach((f) => {
        expect(f.frame.close).toHaveBeenCalled();
      });
      newFrames.forEach((f) => {
        expect(f.frame.close).not.toHaveBeenCalled();
      });
      expect(getClipPayload().frames).toBe(newFrames);
    });
  });
});
