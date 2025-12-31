import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getThumbnailCache, resetThumbnailCache, ThumbnailCache } from '../../../src/shared/utils/thumbnail-cache.js';

// Mock OffscreenCanvas for JSDOM environment
class MockOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    };
  }
}

// Mock document.createElement for canvas
const originalCreateElement = document.createElement.bind(document);

describe('Timeline thumbnail caching', () => {
  beforeEach(() => {
    resetThumbnailCache();
    // Mock OffscreenCanvas globally
    globalThis.OffscreenCanvas = MockOffscreenCanvas;
  });

  describe('ThumbnailCache singleton', () => {
    it('should return same instance on multiple calls', () => {
      const cache1 = getThumbnailCache();
      const cache2 = getThumbnailCache();

      expect(cache1).toBe(cache2);
    });

    it('should reset to new instance after resetThumbnailCache', () => {
      const cache1 = getThumbnailCache();
      resetThumbnailCache();
      const cache2 = getThumbnailCache();

      expect(cache1).not.toBe(cache2);
    });
  });

  describe('Cache basic operations', () => {
    it('should report has() as false for uncached frame', () => {
      const cache = getThumbnailCache();
      expect(cache.has('frame-1')).toBe(false);
    });

    it('should return null for uncached frame with get()', () => {
      const cache = getThumbnailCache();
      expect(cache.get('frame-1')).toBeNull();
    });

    it('should track size correctly', () => {
      const cache = new ThumbnailCache(10);
      expect(cache.size).toBe(0);

      // Manually add to cache using internal method
      const mockCanvas = document.createElement('canvas');
      cache._addToCache('frame-1', mockCanvas);

      expect(cache.size).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entry when maxSize exceeded', () => {
      const cache = new ThumbnailCache(3); // Max 3 entries

      // Add 4 entries
      for (let i = 0; i < 4; i++) {
        const mockCanvas = document.createElement('canvas');
        cache._addToCache(`frame-${i}`, mockCanvas);
      }

      // First frame should be evicted
      expect(cache.has('frame-0')).toBe(false);
      expect(cache.has('frame-1')).toBe(true);
      expect(cache.has('frame-2')).toBe(true);
      expect(cache.has('frame-3')).toBe(true);
      expect(cache.size).toBe(3);
    });

    it('should move accessed entry to end (LRU update)', () => {
      const cache = new ThumbnailCache(3);

      // Add 3 entries
      for (let i = 0; i < 3; i++) {
        const mockCanvas = document.createElement('canvas');
        cache._addToCache(`frame-${i}`, mockCanvas);
      }

      // Access frame-0 to make it "recently used"
      cache.get('frame-0');

      // Add new entry - should evict frame-1 (oldest unused)
      const newCanvas = document.createElement('canvas');
      cache._addToCache('frame-3', newCanvas);

      expect(cache.has('frame-0')).toBe(true); // Was accessed, not evicted
      expect(cache.has('frame-1')).toBe(false); // Should be evicted
      expect(cache.has('frame-2')).toBe(true);
      expect(cache.has('frame-3')).toBe(true);
    });
  });

  describe('Cache invalidation', () => {
    it('should remove specific frame on invalidate', () => {
      const cache = new ThumbnailCache(10);
      const mockCanvas = document.createElement('canvas');
      cache._addToCache('frame-1', mockCanvas);

      expect(cache.has('frame-1')).toBe(true);

      cache.invalidate('frame-1');
      expect(cache.has('frame-1')).toBe(false);
    });

    it('should not throw when invalidating non-existent frame', () => {
      const cache = new ThumbnailCache(10);
      expect(() => cache.invalidate('non-existent')).not.toThrow();
    });

    it('should remove all frames on clear', () => {
      const cache = new ThumbnailCache(10);

      for (let i = 0; i < 5; i++) {
        const mockCanvas = document.createElement('canvas');
        cache._addToCache(`frame-${i}`, mockCanvas);
      }

      expect(cache.size).toBe(5);

      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe('Generate method', () => {
    it('should return cached canvas if already cached', async () => {
      const cache = new ThumbnailCache(10);
      const mockCanvas = document.createElement('canvas');
      cache._addToCache('frame-1', mockCanvas);

      const mockFrame = {
        id: 'frame-1',
        frame: {},
        width: 100,
        height: 100,
      };

      const result = await cache.generate(mockFrame, 80);
      expect(result).toBe(mockCanvas);
    });
  });
});
