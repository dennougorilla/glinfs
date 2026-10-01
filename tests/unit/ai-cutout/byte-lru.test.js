import { describe, expect, it, vi } from 'vitest';
import { createByteLru } from '../../../src/features/ai-cutout/byte-lru.js';

describe('createByteLru', () => {
  it('keeps entries under the byte cap, dropping the least recently used first', () => {
    const onEvict = vi.fn();
    const lru = createByteLru(10, { onEvict });
    lru.set('a', 'A', 4);
    lru.set('b', 'B', 4);
    expect(lru.bytes).toBe(8);
    // Using 'a' makes 'b' the oldest
    expect(lru.get('a')).toBe('A');
    lru.set('c', 'C', 4);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('c')).toBe(true);
    expect(onEvict).toHaveBeenCalledWith('b', 'B');
    expect(lru.bytes).toBe(8);
    expect(lru.size).toBe(2);
  });

  it('replaces an entry of the same key without counting it twice', () => {
    const lru = createByteLru(10);
    lru.set('a', 1, 6);
    lru.set('a', 2, 3);
    expect(lru.bytes).toBe(3);
    expect(lru.get('a')).toBe(2);
  });

  it('never keeps an entry larger than the cap, and deletes/clears', () => {
    const lru = createByteLru(10);
    lru.set('a', 1, 5);
    expect(lru.set('huge', 2, 11)).toBe(false);
    expect(lru.has('huge')).toBe(false);
    expect(lru.has('a')).toBe(true);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    expect(lru.bytes).toBe(0);
    lru.set('b', 1, 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.capBytes).toBe(10);
  });

  it('a scan of more entries than fit finds the first ones again on the next scan', () => {
    const lru = createByteLru(4);
    /** @param {number} job */
    const scan = (job) => {
      let hits = 0;
      for (let f = 0; f < 10; f++) {
        if (lru.get(`f${f}`, job) !== undefined) hits++;
        else lru.set(`f${f}`, f, 1, job);
      }
      return hits;
    };
    expect(scan(1)).toBe(0);
    // Plain LRU would have kept f6..f9 and dropped each just before use
    expect([0, 1, 2, 3].every((f) => lru.has(`f${f}`))).toBe(true);
    expect(scan(2)).toBe(4);
    expect(scan(3)).toBe(4);
  });

  it("a scan that starts with a miss elsewhere still finds the earlier scan's first entries", () => {
    const lru = createByteLru(4);
    for (let f = 0; f < 4; f++) lru.set(`f${f}`, f, 1, 1);
    // Job 2 starts on frame 9 (not cached), then walks 0, 1, 2
    expect(lru.set('f9', 9, 1, 2)).toBe(true);
    expect(lru.has('f3')).toBe(false);
    expect(['f0', 'f1', 'f2'].map((k) => lru.get(k, 2))).toEqual([0, 1, 2]);
    // Everything is job 2's now: a new entry of job 2 is not kept
    expect(lru.set('f4', 4, 1, 2)).toBe(false);
    expect(lru.size).toBe(4);
    // Another scope (or none) may push job 2's entries out
    expect(lru.set('g', 0, 1, 3)).toBe(true);
    expect(lru.set('h', 0, 1)).toBe(true);
  });

  it('holds 24 MobileSAM embeddings (48 as float16) in 96 MB', () => {
    const embedding = 256 * 64 * 64 * 4;
    const lru = createByteLru(96 * 1024 * 1024);
    for (let i = 0; i < 30; i++) lru.set(`f${i}`, i, embedding);
    expect(lru.size).toBe(24);
    expect(lru.has('f5')).toBe(false);
    expect(lru.has('f6')).toBe(true);
    const half = createByteLru(96 * 1024 * 1024);
    for (let i = 0; i < 60; i++) half.set(`f${i}`, i, embedding / 2, 1);
    expect(half.size).toBe(48);
  });
});
