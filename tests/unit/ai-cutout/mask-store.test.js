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

  it('groups masks by clip and model: the unused model’s set of the active clip can be evicted', () => {
    const store = createMaskStore({ capBytes: 10 });
    store.set('anime:a', mask(4), 'A', 'anime');
    store.set('anime:b', mask(4), 'A', 'anime');
    // Same clip, the other model: writing it evicts the anime set, which
    // nothing reads any more, instead of growing past the cap
    store.set('general:a', mask(4), 'A', 'general');
    expect(store.has('anime:a')).toBe(false);
    expect(store.has('anime:b')).toBe(false);
    expect(store.keysForClip('A')).toEqual(['general:a']);
    expect(store.byteLength).toBe(4);
  });

  it('reading or touching one model’s masks keeps that set, not the clip’s other one', () => {
    const store = createMaskStore({ capBytes: 12 });
    store.set('anime:a', mask(4), 'A', 'anime');
    store.set('general:a', mask(4), 'A', 'general');
    store.set('b', mask(4), 'B');
    store.get('anime:a');
    store.touchClip('B');
    store.set('c', mask(4), 'C'); // 16 > 12: the least recently used set goes
    expect(store.has('general:a')).toBe(false);
    expect(store.has('anime:a')).toBe(true);
    expect(store.has('b')).toBe(true);

    // touchClip with a model touches only that set; without one, every set
    store.set('general:a', mask(4), 'A', 'general'); // evicts anime:a (oldest)
    expect(store.has('anime:a')).toBe(false);
    store.set('anime:a', mask(4), 'A', 'anime'); // evicts b
    store.touchClip('A', 'general');
    store.set('d', mask(8), 'D'); // evicts c, then anime:a (older than general:a)
    expect(store.keysForClip('A')).toEqual(['general:a']);
  });

  it('deleteClip drops every model’s masks of the clip', () => {
    const store = createMaskStore();
    store.set('anime:a', mask(2), 'A', 'anime');
    store.set('general:a', mask(2), 'A', 'general');
    store.set('anime:b', mask(2), 'B', 'anime');
    expect(store.keysForClip('A').sort()).toEqual(['anime:a', 'general:a']);
    expect(store.deleteClip('A')).toBe(2);
    expect(store.keysForClip('A')).toEqual([]);
    expect(store.keysForClip('B')).toEqual(['anime:b']);
    expect(store.byteLength).toBe(2);
  });

  it('notifies subscribers with the change and new version', () => {
    const store = createMaskStore({ capBytes: 4 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set('a', mask(4), 'A');
    store.set('b', mask(4), 'B'); // evicts A
    expect(listener).toHaveBeenCalledWith({ type: 'set', key: 'a', clipId: 'A', version: 1 });
    expect(listener).toHaveBeenCalledWith({ type: 'set', key: 'b', clipId: 'B', version: 2 });
    expect(listener).toHaveBeenCalledWith({ type: 'evict', clipId: 'A', model: '', version: 3 });
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

describe('the active clip (task 13: export failed after fix-ups on a 15 s clip)', () => {
  it('never evicts the base masks of the active clip when its fix-ups write theirs', () => {
    // A clip whose base masks fill the cap, then a tracked fix-up: before,
    // the fix-up's masks evicted the base set, and export found no masks
    const store = createMaskStore({ capBytes: 12 });
    store.setActiveClip('A', { frames: 3, models: ['anime', 'object:1'] });
    for (const f of ['0', '1', '2']) store.set(`anime:${f}`, mask(4), 'A', 'anime');
    for (const f of ['0', '1', '2']) store.set(`object:1:${f}`, mask(4), 'A', 'object:1');

    expect(store.keysForClip('A')).toHaveLength(6);
    expect(store.byteLength).toBe(24);
  });

  it('evicts other clips first, then the models the active clip no longer uses', () => {
    const store = createMaskStore({ capBytes: 12 });
    store.set('old:b', mask(4), 'B', 'anime');
    store.set('general:a', mask(4), 'A', 'general'); // the active clip's earlier model
    store.setActiveClip('A', { frames: 1, models: ['anime'] });
    store.set('anime:a', mask(4), 'A', 'anime');
    store.set('x:c', mask(4), 'C', 'anime'); // 16 > 12: the oldest evictable group goes

    expect(store.has('old:b')).toBe(false);
    expect(store.has('general:a')).toBe(true);
    store.set('anime:a2', mask(4), 'A', 'anime'); // 16 > 12: other clips go before A's general set
    expect(store.has('x:c')).toBe(false);
    expect(store.has('general:a')).toBe(true);
    store.set('anime:a3', mask(4), 'A', 'anime'); // 16 > 12, no other clip left
    expect(store.has('general:a')).toBe(false);
    expect(store.keysForClip('A').sort()).toEqual(['anime:a', 'anime:a2', 'anime:a3']);
  });

  it('sizes each pool’s cap from the active clip: frames x mask bytes per group of that pool', () => {
    const store = createMaskStore({ capBytes: 8, objectCapBytes: 2 });
    store.setActiveClip('A', { frames: 4, models: ['anime', 'object:1'] });
    store.set('anime:0', mask(4), 'A', 'anime');
    // Base pool: 4 frames x 4 bytes = 16 bytes of room
    expect(store.capBytes).toBe(16);
    store.set('b', mask(4), 'B', 'anime');
    store.set('c', mask(4), 'C', 'anime');
    expect(store.has('b')).toBe(true); // 4 + 4 + 4 = 12 <= 16
    store.set('d', mask(8), 'D', 'anime'); // 20 > 16: B goes
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
    // Fix-up pool: no fix-up mask yet, so nothing is reserved; then 4 x 1 byte
    expect(store.objectCapBytes).toBe(2);
    store.set('object:1:0', mask(1), 'A', 'object:1');
    expect(store.objectCapBytes).toBe(4);
    // Never below the defaults
    store.setActiveClip('A', { frames: 1, models: ['anime'] });
    expect(store.capBytes).toBe(8);
    expect(store.objectCapBytes).toBe(2);
  });

  it('a fix-up of the active clip never evicts its base masks, and its own masks stay too', () => {
    const store = createMaskStore({ capBytes: 8, objectCapBytes: 4 });
    store.setActiveClip('A', { frames: 3, models: ['anime', 'object:1'] });
    for (const f of ['0', '1', '2']) store.set(`anime:${f}`, mask(4), 'A', 'anime');
    for (const f of ['0', '1', '2']) store.set(`object:1:${f}`, mask(2), 'A', 'object:1');
    expect(store.keysForClip('A')).toHaveLength(6);
  });

  it('stops protecting a clip once the active clip is set to null', () => {
    const store = createMaskStore({ capBytes: 8 });
    store.setActiveClip('A', { frames: 1, models: ['anime'] });
    store.set('anime:a', mask(4), 'A', 'anime');
    store.setActiveClip(null);
    store.set('b', mask(8), 'B', 'anime'); // 12 > 8: A is no longer protected
    expect(store.has('anime:a')).toBe(false);
  });

  it('reclaims at once when the active clip changes to one that needs less (Codex P2 on #228)', () => {
    // A clip with a fix-up held 16 bytes in each pool, over default caps of 8
    const store = createMaskStore({ capBytes: 8, objectCapBytes: 8 });
    store.setActiveClip('A', { frames: 4, models: ['anime', 'object:1'] });
    for (const f of ['0', '1', '2', '3']) store.set(`anime:${f}`, mask(4), 'A', 'anime');
    for (const f of ['0', '1', '2', '3']) store.set(`object:1:${f}`, mask(4), 'A', 'object:1');
    expect(store.byteLength).toBe(32);
    const listener = vi.fn();
    store.subscribe(listener);

    // Another clip, nothing analyzed yet: A's masks are no longer protected
    // and must not stay over the cap until the next analysis writes a mask
    store.setActiveClip('B', { frames: 4, models: ['anime'] });

    // Both pools are reclaimed
    expect(store.byteLength).toBeLessThanOrEqual(16);
    expect(store.keysForClip('A').filter((k) => k.startsWith('anime:'))).toHaveLength(0);
    expect(store.keysForClip('A').filter((k) => k.startsWith('object:'))).toHaveLength(0);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'evict', clipId: 'A' }));
  });
});

describe('getSharedMaskStore', () => {
  it('returns one app-wide store', () => {
    expect(getSharedMaskStore()).toBe(getSharedMaskStore());
  });
});

describe('mask provenance (tags and unreachable marks)', () => {
  it('keeps the tag a mask was set with; a mark replaces the mask and a mask the mark', () => {
    const store = createMaskStore();
    store.set('object:o1:a', mask(4), 'clip', 'object:o1', 'whole|x');
    expect(store.getTag('object:o1:a')).toBe('whole|x');
    store.set('object:o1:a', mask(4), 'clip', 'object:o1');
    expect(store.getTag('object:o1:a')).toBe('');
    store.mark('object:o1:a', 'part|x', 'clip', 'object:o1');
    expect(store.has('object:o1:a')).toBe(false);
    expect(store.getMark('object:o1:a')).toBe('part|x');
    store.set('object:o1:a', mask(4), 'clip', 'object:o1', 'part|x');
    expect(store.getMark('object:o1:a')).toBeUndefined();
    store.mark('object:o1:b', 'part|x', 'clip', 'object:o1');
    expect(store.delete('object:o1:b')).toBe(false);
    expect(store.getMark('object:o1:b')).toBeUndefined();
  });

  it('drops marks with their group on eviction, deleteClip and clear', () => {
    const store = createMaskStore({ capBytes: 10, objectCapBytes: 10 });
    store.set('object:o1:a', mask(4), 'clip', 'object:o1', 't');
    store.mark('object:o1:b', 't', 'clip', 'object:o1');
    // Another fix-up's group over the cap evicts the object's group, marks too
    store.set('object:o9:a', mask(8), 'clip', 'object:o9');
    expect(store.has('object:o1:a')).toBe(false);
    expect(store.getMark('object:o1:b')).toBeUndefined();

    store.mark('object:o2:a', 't', 'other', 'object:o2');
    store.deleteClip('other');
    expect(store.getMark('object:o2:a')).toBeUndefined();
    store.mark('object:o3:a', 't', 'clip', 'object:o3');
    store.clear();
    expect(store.getMark('object:o3:a')).toBeUndefined();
  });
});

describe('fix-up masks have their own budget; retag (cutout-ux 5)', () => {
  /** @param {number} n */
  const m = (n) => ({ data: new Uint8Array(n), width: n, height: 1 });

  it('a fix-up never evicts a base mask, a base mask never evicts a fix-up', () => {
    const store = createMaskStore({ capBytes: 10, objectCapBytes: 10 });
    store.set('anime:a', m(8), 'clip', 'anime');
    store.set('object:o1:a', m(8), 'clip', 'object:o1');
    expect(store.has('anime:a')).toBe(true);
    store.set('object:o2:a', m(8), 'clip', 'object:o2');
    expect(store.has('object:o1:a')).toBe(false);
    expect(store.has('anime:a')).toBe(true);
    store.set('general:a', m(8), 'clip', 'general');
    expect(store.has('anime:a')).toBe(false);
    expect(store.has('object:o2:a')).toBe(true);
  });

  it('retags masks and marks of one tag, once', () => {
    const store = createMaskStore();
    store.set('object:o1:a', m(2), 'clip', 'object:o1', 'old');
    store.set('object:o1:b', m(2), 'clip', 'object:o1', 'other');
    store.mark('object:o1:c', 'old', 'clip', 'object:o1');
    const v = store.version;
    expect(
      store.retag(['object:o1:a', 'object:o1:b', 'object:o1:c', 'object:o1:x'], 'old', 'new'),
    ).toBe(2);
    expect(store.getTag('object:o1:a')).toBe('new');
    expect(store.getTag('object:o1:b')).toBe('other');
    expect(store.getMark('object:o1:c')).toBe('new');
    expect(store.version).toBe(v + 1);
  });
});
