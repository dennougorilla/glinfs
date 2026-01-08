import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  register,
  acquire,
  release,
  releaseAll,
  getFrame,
  hasFrame,
  getOwners,
  getPoolStats,
  clearPool,
  getPoolSize,
} from '../../../src/shared/videoframe-pool.js';

// Helper to create mock VideoFrame
function createMockVideoFrame() {
  return {
    close: vi.fn(),
    codedWidth: 1920,
    codedHeight: 1080,
  };
}

describe('VideoFramePool', () => {
  // Clear pool before each test to ensure isolation
  beforeEach(() => {
    clearPool();
  });

  describe('register', () => {
    it('should register a new frame with initial owner', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      expect(hasFrame('frame-1')).toBe(true);
      expect(getFrame('frame-1')).toBe(frame);
      expect(getOwners('frame-1')).toEqual(new Set(['capture']));
    });

    it('should add owner to existing frame', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');
      register('frame-1', frame, 'editor');

      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor']));
    });

    it('should handle multiple frames', () => {
      const frame1 = createMockVideoFrame();
      const frame2 = createMockVideoFrame();

      register('frame-1', frame1, 'capture');
      register('frame-2', frame2, 'capture');

      expect(getPoolSize()).toBe(2);
      expect(getFrame('frame-1')).toBe(frame1);
      expect(getFrame('frame-2')).toBe(frame2);
    });
  });

  describe('acquire', () => {
    it('should add owner to existing frame', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      const result = acquire('frame-1', 'editor');

      expect(result).toBe(frame);
      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor']));
    });

    it('should return null for non-existent frame', () => {
      const result = acquire('non-existent', 'editor');

      expect(result).toBeNull();
    });

    it('should support multiple owners', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'editor');
      acquire('frame-1', 'export');

      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor', 'export']));
    });

    it('should not duplicate same owner', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'capture');
      acquire('frame-1', 'capture');

      expect(getOwners('frame-1')).toEqual(new Set(['capture']));
    });
  });

  describe('release', () => {
    it('should remove owner from frame', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'editor');

      release('frame-1', 'capture');

      expect(getOwners('frame-1')).toEqual(new Set(['editor']));
      expect(frame.close).not.toHaveBeenCalled();
    });

    it('should close and remove frame when last owner releases', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      const wasClosed = release('frame-1', 'capture');

      expect(wasClosed).toBe(true);
      expect(frame.close).toHaveBeenCalledOnce();
      expect(hasFrame('frame-1')).toBe(false);
    });

    it('should not close frame while other owners remain', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'editor');
      acquire('frame-1', 'export');

      release('frame-1', 'capture');
      release('frame-1', 'editor');

      expect(frame.close).not.toHaveBeenCalled();
      expect(hasFrame('frame-1')).toBe(true);
      expect(getOwners('frame-1')).toEqual(new Set(['export']));
    });

    it('should return false for non-existent frame', () => {
      const wasClosed = release('non-existent', 'capture');

      expect(wasClosed).toBe(false);
    });

    it('should handle releasing non-owner gracefully', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      release('frame-1', 'editor'); // editor is not an owner

      expect(getOwners('frame-1')).toEqual(new Set(['capture']));
      expect(frame.close).not.toHaveBeenCalled();
    });

    it('should handle close() throwing gracefully', () => {
      const frame = createMockVideoFrame();
      frame.close.mockImplementation(() => {
        throw new Error('Already closed');
      });
      register('frame-1', frame, 'capture');

      expect(() => release('frame-1', 'capture')).not.toThrow();
      expect(hasFrame('frame-1')).toBe(false);
    });
  });

  describe('releaseAll', () => {
    it('should release all frames for specific owner', () => {
      const frame1 = createMockVideoFrame();
      const frame2 = createMockVideoFrame();
      const frame3 = createMockVideoFrame();

      register('frame-1', frame1, 'capture');
      register('frame-2', frame2, 'capture');
      register('frame-3', frame3, 'editor');

      const closedCount = releaseAll('capture');

      expect(closedCount).toBe(2);
      expect(hasFrame('frame-1')).toBe(false);
      expect(hasFrame('frame-2')).toBe(false);
      expect(hasFrame('frame-3')).toBe(true); // editor still owns this
    });

    it('should not close frames with other owners', () => {
      const frame1 = createMockVideoFrame();
      const frame2 = createMockVideoFrame();

      register('frame-1', frame1, 'capture');
      acquire('frame-1', 'editor'); // frame-1 has two owners
      register('frame-2', frame2, 'capture');

      const closedCount = releaseAll('capture');

      expect(closedCount).toBe(1); // Only frame-2 was closed
      expect(hasFrame('frame-1')).toBe(true); // editor still owns
      expect(hasFrame('frame-2')).toBe(false);
      expect(frame1.close).not.toHaveBeenCalled();
      expect(frame2.close).toHaveBeenCalledOnce();
    });

    it('should return 0 when owner has no frames', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      const closedCount = releaseAll('editor');

      expect(closedCount).toBe(0);
      expect(hasFrame('frame-1')).toBe(true);
    });

    it('should handle empty pool', () => {
      const closedCount = releaseAll('capture');

      expect(closedCount).toBe(0);
    });
  });

  describe('getFrame', () => {
    it('should return VideoFrame for existing frame', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      expect(getFrame('frame-1')).toBe(frame);
    });

    it('should return null for non-existent frame', () => {
      expect(getFrame('non-existent')).toBeNull();
    });
  });

  describe('hasFrame', () => {
    it('should return true for existing frame', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');

      expect(hasFrame('frame-1')).toBe(true);
    });

    it('should return false for non-existent frame', () => {
      expect(hasFrame('non-existent')).toBe(false);
    });
  });

  describe('getOwners', () => {
    it('should return copy of owners set', () => {
      const frame = createMockVideoFrame();
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'editor');

      const owners = getOwners('frame-1');
      owners.add('export'); // Modify the returned set

      // Original should not be affected
      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor']));
    });

    it('should return null for non-existent frame', () => {
      expect(getOwners('non-existent')).toBeNull();
    });
  });

  describe('getPoolStats', () => {
    it('should return correct statistics', () => {
      const frame1 = createMockVideoFrame();
      const frame2 = createMockVideoFrame();

      register('frame-1', frame1, 'capture');
      acquire('frame-1', 'editor');
      register('frame-2', frame2, 'capture');

      const stats = getPoolStats();

      expect(stats.totalFrames).toBe(2);
      expect(stats.totalOwners).toBe(2); // capture and editor
      expect(stats.byOwner).toEqual({
        capture: 2, // owns both frames
        editor: 1, // owns frame-1
      });
    });

    it('should return zeros for empty pool', () => {
      const stats = getPoolStats();

      expect(stats.totalFrames).toBe(0);
      expect(stats.totalOwners).toBe(0);
      expect(stats.byOwner).toEqual({});
    });
  });

  describe('clearPool', () => {
    it('should close all frames and clear pool', () => {
      const frame1 = createMockVideoFrame();
      const frame2 = createMockVideoFrame();

      register('frame-1', frame1, 'capture');
      register('frame-2', frame2, 'editor');

      const closedCount = clearPool();

      expect(closedCount).toBe(2);
      expect(frame1.close).toHaveBeenCalledOnce();
      expect(frame2.close).toHaveBeenCalledOnce();
      expect(getPoolSize()).toBe(0);
    });

    it('should handle empty pool', () => {
      const closedCount = clearPool();

      expect(closedCount).toBe(0);
    });

    it('should handle close() errors gracefully', () => {
      const frame = createMockVideoFrame();
      frame.close.mockImplementation(() => {
        throw new Error('Already closed');
      });
      register('frame-1', frame, 'capture');

      expect(() => clearPool()).not.toThrow();
      expect(getPoolSize()).toBe(0);
    });
  });

  describe('ownership flow scenarios', () => {
    it('should handle Capture → Editor → Export flow correctly', () => {
      const frame = createMockVideoFrame();

      // 1. Capture creates frame
      register('frame-1', frame, 'capture');
      expect(getOwners('frame-1')).toEqual(new Set(['capture']));

      // 2. Editor acquires ownership (handleCreateClip)
      acquire('frame-1', 'editor');
      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor']));

      // 3. Export acquires ownership (handleExport)
      acquire('frame-1', 'export');
      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor', 'export']));

      // 4. Export cleanup
      releaseAll('export');
      expect(frame.close).not.toHaveBeenCalled();
      expect(getOwners('frame-1')).toEqual(new Set(['capture', 'editor']));

      // 5. Editor cleanup
      releaseAll('editor');
      expect(frame.close).not.toHaveBeenCalled();
      expect(getOwners('frame-1')).toEqual(new Set(['capture']));

      // 6. Capture cleanup
      releaseAll('capture');
      expect(frame.close).toHaveBeenCalledOnce();
      expect(hasFrame('frame-1')).toBe(false);
    });

    it('should handle buffer eviction while Editor owns frame', () => {
      const frame = createMockVideoFrame();

      // 1. Capture creates frame and Editor acquires
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'editor');

      // 2. Capture evicts frame (buffer full)
      release('frame-1', 'capture');

      // Frame should NOT be closed - Editor still owns it
      expect(frame.close).not.toHaveBeenCalled();
      expect(hasFrame('frame-1')).toBe(true);
      expect(getOwners('frame-1')).toEqual(new Set(['editor']));

      // 3. Editor cleanup
      releaseAll('editor');
      expect(frame.close).toHaveBeenCalledOnce();
    });

    it('should handle Export return to Editor correctly', () => {
      const frame = createMockVideoFrame();

      // Setup: Capture → Editor → Export
      register('frame-1', frame, 'capture');
      acquire('frame-1', 'editor');
      acquire('frame-1', 'export');

      // Export completes and user returns to Editor
      releaseAll('export');

      // Frame should still be valid for Editor
      expect(hasFrame('frame-1')).toBe(true);
      expect(getFrame('frame-1')).toBe(frame);
      expect(frame.close).not.toHaveBeenCalled();
    });
  });
});
