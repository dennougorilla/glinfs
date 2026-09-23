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

describe('ThumbnailCache disposal', () => {
  it('zeroes evicted and replaced canvases when disposeOnEvict is set', () => {
    const cache = new ThumbnailCache(2, { disposeOnEvict: true });
    const a = canvasOf(5, 5);
    const b = canvasOf(5, 5);
    const replacement = canvasOf(5, 5);
    cache.addCanvas('a', 10, a);
    cache.addCanvas('b', 10, b);

    cache.get('a', 10); // 'b' is now the oldest
    cache.addCanvas('c', 10, canvasOf(5, 5));
    expect(b.width).toBe(0);
    expect(b.height).toBe(0);
    expect(a.width).toBe(5);

    cache.addCanvas('a', 10, replacement);
    expect(a.width).toBe(0);
    expect(replacement.width).toBe(5);

    // Re-adding the same canvas must not dispose it.
    cache.addCanvas('a', 10, replacement);
    expect(replacement.width).toBe(5);
    expect(cache.get('a', 10)).toBe(replacement);
  });

  it('never zeroes evicted or replaced canvases by default (shared cache)', () => {
    const cache = new ThumbnailCache(2);
    const a = canvasOf(5, 5);
    const b = canvasOf(5, 5);
    cache.addCanvas('a', 10, a);
    cache.addCanvas('b', 10, b);
    cache.addCanvas('c', 10, canvasOf(5, 5)); // evicts 'a'
    cache.addCanvas('b', 10, canvasOf(5, 5)); // replaces 'b'

    expect(cache.has('a', 10)).toBe(false);
    expect(a.width).toBe(5);
    expect(a.height).toBe(5);
    expect(b.width).toBe(5);
    expect(b.height).toBe(5);
  });

  it('disposes grid cache entries evicted by the byte budget', () => {
    const cache = createGridThumbnailCache();
    // 4096 * 4096 * 4 = 64 MiB, so the second entry evicts the first.
    const first = canvasOf(4096, 4096);
    cache.addCanvas('a', 10, first);
    cache.addCanvas('b', 10, canvasOf(4096, 4096));

    expect(cache.has('a', 10)).toBe(false);
    expect(first.width).toBe(0);
    expect(first.height).toBe(0);
  });

  it('take() removes the entry without disposing it', () => {
    const cache = new ThumbnailCache(10, { disposeOnEvict: true });
    const canvas = canvasOf(5, 5);
    cache.addCanvas('a', 10, canvas);

    expect(cache.take('a', 10)).toBe(canvas);
    expect(canvas.width).toBe(5);
    expect(canvas.height).toBe(5);
    expect(cache.has('a', 10)).toBe(false);
    expect(cache.bytes).toBe(0);
    expect(cache.take('a', 10)).toBeNull();
  });
});
