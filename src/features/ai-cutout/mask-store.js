/**
 * Probability mask store
 * @module features/ai-cutout/mask-store
 *
 * Holds the AI cutout's per-frame probability masks (Uint8, 0-255) keyed by
 * frame key (`frame.sharedKey ?? frame.id`, so imported holds that share
 * pixels share one mask). Masks are grouped by clip so a deleted clip's
 * masks can be dropped, and the store stays under a memory cap by evicting
 * the least-recently-used clip's masks.
 *
 * Only plain byte arrays live here — never VideoFrames — so nothing in the
 * store needs closing.
 *
 * `version` bumps on every change; preview/export caches key on it.
 */

/** @typedef {import('./preprocess.js').ProbabilityMask} ProbabilityMask */

/** Default memory cap for all stored masks */
export const MASK_STORE_CAP_BYTES = 256 * 1024 * 1024;

/** Clip id used when a caller does not name one */
export const DEFAULT_CLIP_ID = '';

/**
 * @typedef {Object} MaskStoreChange
 * @property {'set' | 'delete' | 'delete-clip' | 'evict' | 'clear'} type
 * @property {number} version - Store version after the change
 * @property {string} [key] - Frame key ('set' / 'delete')
 * @property {string} [clipId] - Affected clip ('set' / 'delete-clip' / 'evict')
 */

/**
 * @typedef {Object} MaskStore
 * @property {(key: string) => ProbabilityMask | null} get - Also marks the clip recently used
 * @property {(key: string) => boolean} has
 * @property {(key: string, mask: ProbabilityMask, clipId?: string) => void} set
 * @property {(key: string) => boolean} delete
 * @property {(clipId: string) => number} deleteClip - Drop every mask of a clip; returns how many
 * @property {(clipId: string) => void} touchClip - Mark a clip recently used (e.g. the active clip)
 * @property {(clipId: string) => string[]} keysForClip
 * @property {() => void} clear
 * @property {(listener: (change: MaskStoreChange) => void) => () => void} subscribe
 * @property {number} version - Bumps on every change
 * @property {number} byteLength - Bytes held by all masks
 * @property {number} size - Number of masks
 * @property {number} capBytes
 */

/**
 * Create a mask store.
 *
 * Eviction never touches the clip that is being written: a single clip whose
 * masks alone exceed the cap is kept whole (its analysis would otherwise be
 * lost while it is still being produced), and older clips are dropped first.
 *
 * @param {{ capBytes?: number }} [options]
 * @returns {MaskStore}
 */
export function createMaskStore({ capBytes = MASK_STORE_CAP_BYTES } = {}) {
  /** @type {Map<string, { mask: ProbabilityMask, clipId: string }>} */
  const entries = new Map();
  /** @type {Map<string, Set<string>>} clip id -> frame keys */
  const clips = new Map();
  /** @type {Map<string, number>} clip id -> last-use tick */
  const lastUsed = new Map();
  /** @type {Set<(change: MaskStoreChange) => void>} */
  const listeners = new Set();

  let version = 0;
  let byteLength = 0;
  let tick = 0;

  /** @param {Omit<MaskStoreChange, 'version'>} change */
  function changed(change) {
    version++;
    const event = { ...change, version };
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** @param {string} clipId */
  function touch(clipId) {
    tick++;
    lastUsed.set(clipId, tick);
  }

  /**
   * Remove one entry without notifying.
   * @param {string} key
   * @returns {boolean}
   */
  function removeEntry(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    byteLength -= entry.mask.data.byteLength;
    const keys = clips.get(entry.clipId);
    keys?.delete(key);
    if (keys && keys.size === 0) {
      clips.delete(entry.clipId);
      lastUsed.delete(entry.clipId);
    }
    return true;
  }

  /**
   * Remove all of a clip's entries without notifying.
   * @param {string} clipId
   * @returns {number}
   */
  function removeClip(clipId) {
    const keys = clips.get(clipId);
    if (!keys) return 0;
    let removed = 0;
    for (const key of [...keys]) {
      if (removeEntry(key)) removed++;
    }
    clips.delete(clipId);
    lastUsed.delete(clipId);
    return removed;
  }

  /**
   * Evict least-recently-used clips (never `keepClipId`) until under the cap.
   * @param {string} keepClipId
   */
  function evictOverCap(keepClipId) {
    while (byteLength > capBytes) {
      let victim = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [clipId, used] of lastUsed) {
        if (clipId !== keepClipId && used < oldest) {
          oldest = used;
          victim = clipId;
        }
      }
      if (victim === null) return;
      removeClip(victim);
      changed({ type: 'evict', clipId: victim });
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      touch(entry.clipId);
      return entry.mask;
    },

    has(key) {
      return entries.has(key);
    },

    set(key, mask, clipId = DEFAULT_CLIP_ID) {
      if (!(mask?.data instanceof Uint8Array)) {
        throw new TypeError('mask.data must be a Uint8Array');
      }
      if (mask.data.length !== mask.width * mask.height) {
        throw new RangeError(
          `mask.data holds ${mask.data.length} bytes, expected ${mask.width}×${mask.height}`,
        );
      }
      removeEntry(key);
      entries.set(key, { mask, clipId });
      byteLength += mask.data.byteLength;
      let keys = clips.get(clipId);
      if (!keys) {
        keys = new Set();
        clips.set(clipId, keys);
      }
      keys.add(key);
      touch(clipId);
      changed({ type: 'set', key, clipId });
      evictOverCap(clipId);
    },

    delete(key) {
      const clipId = entries.get(key)?.clipId;
      if (!removeEntry(key)) return false;
      changed({ type: 'delete', key, clipId });
      return true;
    },

    deleteClip(clipId) {
      const removed = removeClip(clipId);
      if (removed > 0) changed({ type: 'delete-clip', clipId });
      return removed;
    },

    touchClip(clipId) {
      if (clips.has(clipId)) touch(clipId);
    },

    keysForClip(clipId) {
      return [...(clips.get(clipId) ?? [])];
    },

    clear() {
      if (entries.size === 0) return;
      entries.clear();
      clips.clear();
      lastUsed.clear();
      byteLength = 0;
      changed({ type: 'clear' });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get version() {
      return version;
    },

    get byteLength() {
      return byteLength;
    },

    get size() {
      return entries.size;
    },

    get capBytes() {
      return capBytes;
    },
  };
}

/** @type {MaskStore | null} */
let sharedStore = null;

/**
 * The app-wide mask store (masks survive navigation between screens).
 * @returns {MaskStore}
 */
export function getSharedMaskStore() {
  sharedStore ??= createMaskStore();
  return sharedStore;
}
