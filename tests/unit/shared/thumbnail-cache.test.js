/**
 * ThumbnailCache byte budget and release (issue #76).
 */
import { describe, expect, it } from 'vitest';
import {
  createGridThumbnailCache,
  ThumbnailCache,
} from '../../../src/shared/utils/thumbnail-cache.js';

/**
 * @param {number} width
 * @param {number} height
 */
function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

describe('ThumbnailCache byte budget', () => {
  it('evicts least-recently-used entries once the byte budget is exceeded', () => {
    const cache = new ThumbnailCache(100, { maxBytes: 250 });
    cache.addCanvas('a', 10, canvasOf(5, 5)); // 100 bytes
    cache.addCanvas('b', 10, canvasOf(5, 5));
    expect(cache.bytes).toBe(200);

    cache.get('a', 10); // 'b' is now the oldest
    cache.addCanvas('c', 10, canvasOf(5, 5));

    expect(cache.has('b', 10)).toBe(false);
    expect(cache.has('a', 10)).toBe(true);
    expect(cache.has('c', 10)).toBe(true);
    expect(cache.bytes).toBe(200);
  });

  it('keeps byte accounting right on replace, invalidate and clear', () => {
    const cache = new ThumbnailCache(100, { maxBytes: 1000 });
    cache.addCanvas('a', 10, canvasOf(5, 5));
    cache.addCanvas('a', 10, canvasOf(10, 5)); // replaces, 200 bytes
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(200);

    cache.addCanvas('a', 20, canvasOf(5, 5));
    cache.addCanvas('b', 10, canvasOf(5, 5));
    cache.invalidate('a');
    expect(cache.bytes).toBe(100);

    cache.clear();
    expect(cache.bytes).toBe(0);
  });

  it('stores a single entry larger than the whole budget on its own', () => {
    const cache = new ThumbnailCache(100, { maxBytes: 50 });
    cache.addCanvas('a', 10, canvasOf(5, 5));
    cache.addCanvas('b', 10, canvasOf(5, 5));
    expect(cache.size).toBe(1);
    expect(cache.has('b', 10)).toBe(true);
  });

  it('release() zeroes every cached canvas and empties the cache', () => {
    const cache = new ThumbnailCache();
    const canvas = canvasOf(8, 8);
    cache.addCanvas('a', 10, canvas);

    cache.release();

    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('creates an independent, byte-bounded cache per grid mount', () => {
    const first = createGridThumbnailCache();
    const second = createGridThumbnailCache();
    expect(first).not.toBe(second);
    expect(Number.isFinite(first.maxBytes)).toBe(true);
  });
});
