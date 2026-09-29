import { describe, expect, it, vi } from 'vitest';
import {
  createMaskStore,
  DEFAULT_CLIP_ID,
  getSharedMaskStore,
  MASK_STORE_CAP_BYTES,
} from '../../../src/features/ai-cutout/mask-store.js';

/** @param {number} bytes */
function mask(bytes, width = bytes, height = 1) {
  return { data: new Uint8Array(bytes), width, height };
}

describe('createMaskStore', () => {
  it('stores, reads and deletes masks by frame key', () => {
    const store = createMaskStore();
    const m = mask(6, 3, 2);
    store.set('a', m, 'clip-1');
    expect(store.has('a')).toBe(true);
    expect(store.get('a')).toBe(m);
    expect(store.get('missing')).toBeNull();
    expect(store.size).toBe(1);
    expect(store.byteLength).toBe(6);

    expect(store.delete('a')).toBe(true);
    expect(store.delete('a')).toBe(false);
    expect(store.has('a')).toBe(false);
    expect(store.byteLength).toBe(0);
    expect(store.keysForClip('clip-1')).toEqual([]);
  });

  it('bumps version on every change and only on changes', () => {
    const store = createMaskStore();
    expect(store.version).toBe(0);
    store.set('a', mask(4));
    expect(store.version).toBe(1);
    store.get('a');
    store.has('a');
    expect(store.version).toBe(1);
    store.set('a', mask(4)); // replace
    expect(store.version).toBe(2);
    store.delete('nope');
    store.deleteClip('nope');
    expect(store.version).toBe(2);
    store.delete('a');
    expect(store.version).toBe(3);
    store.clear(); // already empty
    expect(store.version).toBe(3);
  });

  it('replacing a key keeps the byte total exact and can move it to another clip', () => {
    const store = createMaskStore();
    store.set('a', mask(10), 'clip-1');
    store.set('a', mask(4), 'clip-2');
    expect(store.byteLength).toBe(4);
    expect(store.keysForClip('clip-1')).toEqual([]);
    expect(store.keysForClip('clip-2')).toEqual(['a']);
  });

  it('uses the default clip id when none is given', () => {
    const store = createMaskStore();
    store.set('a', mask(1));
    expect(store.keysForClip(DEFAULT_CLIP_ID)).toEqual(['a']);
  });

  it('drops all of a clip’s masks', () => {
    const store = createMaskStore();
    store.set('a', mask(2), 'clip-1');
    store.set('b', mask(2), 'clip-1');
    store.set('c', mask(3), 'clip-2');
    expect(store.deleteClip('clip-1')).toBe(2);
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
    expect(store.byteLength).toBe(3);
  });

  it('clear() empties everything', () => {
    const store = createMaskStore();
    store.set('a', mask(2), 'clip-1');
    store.set('b', mask(2), 'clip-2');
    store.clear();
    expect(store.size).toBe(0);
    expect(store.byteLength).toBe(0);
    expect(store.keysForClip('clip-1')).toEqual([]);
  });

  it('evicts the least-recently-used clip when over the cap', () => {
    const store = createMaskStore({ capBytes: 10 });
    store.set('a1', mask(4), 'A');
    store.set('b1', mask(4), 'B');
    store.get('a1'); // A is now more recent than B
    store.set('c1', mask(4), 'C'); // 12 > 10: evict B
    expect(store.has('b1')).toBe(false);
    expect(store.has('a1')).toBe(true);
    expect(store.has('c1')).toBe(true);
    expect(store.byteLength).toBe(8);
  });

  it('touchClip marks a clip as recently used', () => {
    const store = createMaskStore({ capBytes: 10 });
    store.set('a1', mask(4), 'A');
    store.set('b1', mask(4), 'B');
    store.touchClip('A');
    store.touchClip('unknown'); // no-op
    store.set('c1', mask(4), 'C');
    expect(store.has('a1')).toBe(true);
    expect(store.has('b1')).toBe(false);
  });

  it('never evicts the clip being written, even when it alone exceeds the cap', () => {
    const store = createMaskStore({ capBytes: 5 });
    store.set('old', mask(2), 'old-clip');
    store.set('a1', mask(4), 'A');
    store.set('a2', mask(4), 'A');
    expect(store.has('old')).toBe(false);
    expect(store.keysForClip('A').sort()).toEqual(['a1', 'a2']);
    expect(store.byteLength).toBe(8);
  });

  it('notifies subscribers with the change and new version', () => {
    const store = createMaskStore({ capBytes: 4 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set('a', mask(4), 'A');
    store.set('b', mask(4), 'B'); // evicts A
    expect(listener).toHaveBeenCalledWith({ type: 'set', key: 'a', clipId: 'A', version: 1 });
    expect(listener).toHaveBeenCalledWith({ type: 'set', key: 'b', clipId: 'B', version: 2 });
    expect(listener).toHaveBeenCalledWith({ type: 'evict', clipId: 'A', version: 3 });
    store.delete('b');
    expect(listener).toHaveBeenLastCalledWith({
      type: 'delete',
      key: 'b',
      clipId: 'B',
      version: 4,
    });
    unsubscribe();
    store.set('c', mask(1));
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('rejects malformed masks', () => {
    const store = createMaskStore();
    expect(() => store.set('a', { data: [1, 2], width: 2, height: 1 })).toThrow(TypeError);
    expect(() => store.set('a', { data: new Uint8Array(3), width: 2, height: 1 })).toThrow(
      RangeError,
    );
    expect(store.version).toBe(0);
  });

  it('defaults to a 256 MB cap', () => {
    expect(createMaskStore().capBytes).toBe(MASK_STORE_CAP_BYTES);
    expect(MASK_STORE_CAP_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe('getSharedMaskStore', () => {
  it('returns one app-wide store', () => {
    expect(getSharedMaskStore()).toBe(getSharedMaskStore());
  });
});
