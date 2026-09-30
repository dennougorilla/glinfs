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

  it('holds 24 MobileSAM embeddings in 96 MB', () => {
    const embedding = 256 * 64 * 64 * 4;
    const lru = createByteLru(96 * 1024 * 1024);
    for (let i = 0; i < 30; i++) lru.set(`f${i}`, i, embedding);
    expect(lru.size).toBe(24);
    expect(lru.has('f5')).toBe(false);
    expect(lru.has('f6')).toBe(true);
  });
});
