/**
 * The worker's image-embedding cache with its model and clip indexes (#229,
 * audit B8 and Codex round 1): forgetting a clip or a model drops its
 * embeddings AND their index entries, and an eviction cleans the indexes
 * too, so nothing accumulates while other clips stay open.
 */

import { describe, expect, it } from 'vitest';
import { createEmbeddingCache } from '../../../src/features/ai-cutout/embedding-cache.js';

const value = (n) => new Float32Array(n);

describe('createEmbeddingCache', () => {
  it('stores and reads an embedding by key', () => {
    const cache = createEmbeddingCache(100);
    expect(cache.set('k1', value(4), 16, 1, { modelId: 'click', clipId: 'A' })).toBe(true);
    expect(cache.get('k1', 1)).toHaveLength(4);
    expect(cache.get('nope', 1)).toBeUndefined();
  });

  it('forgetClip drops the clip’s embeddings and leaves no index entry behind', () => {
    const cache = createEmbeddingCache(1000);
    cache.set('a1', value(4), 16, 1, { modelId: 'click', clipId: 'A' });
    cache.set('a2', value(4), 16, 1, { modelId: 'click', clipId: 'A' });
    cache.set('b1', value(4), 16, 1, { modelId: 'click', clipId: 'B' });

    cache.forgetClip('A');

    expect(cache.get('a1', 1)).toBeUndefined();
    expect(cache.get('a2', 1)).toBeUndefined();
    expect(cache.get('b1', 1)).toHaveLength(4);
    expect(cache.indexSizes()).toEqual({ byModel: 1, byClip: 1, clipOf: 1 });
  });

  it('repeated analyse-and-release cycles with another clip open keep the indexes flat', () => {
    const cache = createEmbeddingCache(1000);
    cache.set('keep', value(4), 16, 1, { modelId: 'click', clipId: 'open' });
    for (let i = 0; i < 50; i++) {
      cache.set(`c${i}:f0`, value(4), 16, 2, { modelId: 'click', clipId: `c${i}` });
      cache.set(`c${i}:f1`, value(4), 16, 2, { modelId: 'click', clipId: `c${i}` });
      cache.forgetClip(`c${i}`);
    }
    expect(cache.indexSizes()).toEqual({ byModel: 1, byClip: 1, clipOf: 1 });
  });

  it('forgetModel drops the model’s embeddings and their clip index entries', () => {
    const cache = createEmbeddingCache(1000);
    cache.set('m1', value(4), 16, 1, { modelId: 'click', clipId: 'A' });
    cache.set('m2', value(4), 16, 1, { modelId: 'other', clipId: 'A' });

    cache.forgetModel('click');

    expect(cache.get('m1', 1)).toBeUndefined();
    expect(cache.get('m2', 1)).toHaveLength(4);
    expect(cache.indexSizes()).toEqual({ byModel: 1, byClip: 1, clipOf: 1 });
  });

  it('an eviction cleans the indexes of the evicted embedding', () => {
    const cache = createEmbeddingCache(32);
    cache.set('x', value(4), 16, undefined, { modelId: 'click', clipId: 'A' });
    cache.set('y', value(4), 16, undefined, { modelId: 'click', clipId: 'B' });
    cache.set('z', value(4), 16, undefined, { modelId: 'click', clipId: 'C' }); // evicts x
    expect(cache.get('x', undefined)).toBeUndefined();
    expect(cache.indexSizes()).toEqual({ byModel: 1, byClip: 2, clipOf: 2 });
  });

  it('an embedding without a clip is indexed by model only', () => {
    const cache = createEmbeddingCache(1000);
    cache.set('n', value(4), 16, 1, { modelId: 'click' });
    expect(cache.indexSizes()).toEqual({ byModel: 1, byClip: 0, clipOf: 0 });
    cache.forgetModel('click');
    expect(cache.indexSizes()).toEqual({ byModel: 0, byClip: 0, clipOf: 0 });
  });
});
