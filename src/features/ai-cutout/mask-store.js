/**
 * Probability mask store
 * @module features/ai-cutout/mask-store
 *
 * Holds the AI cutout's per-frame probability masks (Uint8, 0-255) keyed by
 * mask key (the model plus `frame.sharedKey ?? frame.id`, so imported holds
 * that share pixels share one mask). Masks are grouped by clip AND model: a
 * deleted clip's masks (every model's) can be dropped, and the store stays
 * under a memory cap by evicting the least-recently-used group — so the set
 * of a model the clip no longer uses goes before the one it reads.
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
 * @property {string} [model] - Model of the evicted group ('evict')
 */

/**
 * @typedef {Object} MaskStore
 * @property {(key: string) => ProbabilityMask | null} get - Also marks the clip recently used
 * @property {(key: string) => boolean} has
 * @property {(key: string, mask: ProbabilityMask, clipId?: string, model?: string) => void} set
 * @property {(key: string) => boolean} delete
 * @property {(clipId: string) => number} deleteClip - Drop every mask of a clip (all models); returns how many
 * @property {(clipId: string, model?: string) => void} touchClip - Mark a clip's masks of one
 *   model (default: of every model) recently used (e.g. the active clip)
 * @property {(clipId: string) => string[]} keysForClip - Every model's
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
 * Eviction never touches the group (clip and model) that is being written: a
 * single group whose masks alone exceed the cap is kept whole (its analysis
 * would otherwise be lost while it is still being produced), and older
 * groups are dropped first.
 *
 * @param {{ capBytes?: number }} [options]
 * @returns {MaskStore}
 */
export function createMaskStore({ capBytes = MASK_STORE_CAP_BYTES } = {}) {
  /** @type {Map<string, { mask: ProbabilityMask, group: string }>} */
  const entries = new Map();
  /** @type {Map<string, { clipId: string, model: string, keys: Set<string> }>} group id -> masks */
  const groups = new Map();
  /** @type {Map<string, number>} group id -> last-use tick */
  const lastUsed = new Map();
  /** @type {Set<(change: MaskStoreChange) => void>} */
  const listeners = new Set();

  let version = 0;
  let byteLength = 0;
  let tick = 0;

  /**
   * @param {string} clipId
   * @param {string} model
   * @returns {string}
   */
  const groupId = (clipId, model) => `${clipId}\u0000${model}`;

  /** @param {Omit<MaskStoreChange, 'version'>} change */
  function changed(change) {
    version++;
    const event = { ...change, version };
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** @param {string} id */
  function touch(id) {
    tick++;
    lastUsed.set(id, tick);
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
    const group = groups.get(entry.group);
    group?.keys.delete(key);
    if (group && group.keys.size === 0) {
      groups.delete(entry.group);
      lastUsed.delete(entry.group);
    }
    return true;
  }

  /**
   * Remove all of a group's entries without notifying.
   * @param {string} id
   * @returns {number}
   */
  function removeGroup(id) {
    const group = groups.get(id);
    if (!group) return 0;
    let removed = 0;
    for (const key of [...group.keys]) {
      if (removeEntry(key)) removed++;
    }
    groups.delete(id);
    lastUsed.delete(id);
    return removed;
  }

  /**
   * Group ids of a clip (every model).
   * @param {string} clipId
   * @returns {string[]}
   */
  function groupsOfClip(clipId) {
    return [...groups].filter(([, group]) => group.clipId === clipId).map(([id]) => id);
  }

  /**
   * Evict least-recently-used groups (never `keepGroup`) until under the cap.
   * @param {string} keepGroup
   */
  function evictOverCap(keepGroup) {
    while (byteLength > capBytes) {
      let victim = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, used] of lastUsed) {
        if (id !== keepGroup && used < oldest) {
          oldest = used;
          victim = id;
        }
      }
      if (victim === null) return;
      const { clipId, model } = /** @type {{ clipId: string, model: string }} */ (
        groups.get(victim)
      );
      removeGroup(victim);
      changed({ type: 'evict', clipId, model });
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      touch(entry.group);
      return entry.mask;
    },

    has(key) {
      return entries.has(key);
    },

    set(key, mask, clipId = DEFAULT_CLIP_ID, model = '') {
      if (!(mask?.data instanceof Uint8Array)) {
        throw new TypeError('mask.data must be a Uint8Array');
      }
      if (mask.data.length !== mask.width * mask.height) {
        throw new RangeError(
          `mask.data holds ${mask.data.length} bytes, expected ${mask.width}×${mask.height}`,
        );
      }
      removeEntry(key);
      const id = groupId(clipId, model);
      entries.set(key, { mask, group: id });
      byteLength += mask.data.byteLength;
      let group = groups.get(id);
      if (!group) {
        group = { clipId, model, keys: new Set() };
        groups.set(id, group);
      }
      group.keys.add(key);
      touch(id);
      changed({ type: 'set', key, clipId });
      evictOverCap(id);
    },

    delete(key) {
      const entry = entries.get(key);
      const clipId = entry ? groups.get(entry.group)?.clipId : undefined;
      if (!removeEntry(key)) return false;
      changed({ type: 'delete', key, clipId });
      return true;
    },

    deleteClip(clipId) {
      let removed = 0;
      for (const id of groupsOfClip(clipId)) removed += removeGroup(id);
      if (removed > 0) changed({ type: 'delete-clip', clipId });
      return removed;
    },

    touchClip(clipId, model) {
      if (model !== undefined) {
        const id = groupId(clipId, model);
        if (groups.has(id)) touch(id);
        return;
      }
      for (const id of groupsOfClip(clipId)) touch(id);
    },

    keysForClip(clipId) {
      return groupsOfClip(clipId).flatMap((id) => [
        .../** @type {{ keys: Set<string> }} */ (groups.get(id)).keys,
      ]);
    },

    clear() {
      if (entries.size === 0) return;
      entries.clear();
      groups.clear();
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
