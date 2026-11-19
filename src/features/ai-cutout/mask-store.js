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

/** Default memory cap for the base models' masks */
export const MASK_STORE_CAP_BYTES = 256 * 1024 * 1024;

/**
 * Memory cap of the tracked fix-ups' masks (groups whose model starts with
 * OBJECT_GROUP_PREFIX), apart from the base masks: a fix-up never evicts a
 * base mask (which would make the clip analyze again), only another
 * fix-up's. 300 frames of a fix-up at 256 px long side take 11-16 MB, so
 * this holds 8 fix-ups of a 300-frame clip.
 */
export const OBJECT_MASK_CAP_BYTES = 128 * 1024 * 1024;

/** Groups of tracked fix-ups' masks (see objectMaskGroup) */
export const OBJECT_GROUP_PREFIX = 'object:';

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
 * @property {(key: string, mask: ProbabilityMask, clipId?: string, model?: string, tag?: string) => void} set
 *   tag: what produced the mask (e.g. a tracked object's signature)
 * @property {(key: string) => string | undefined} getTag - The tag a mask was set with
 * @property {(key: string, tag: string, clipId?: string, model?: string) => void} mark - A
 *   maskless entry in the group: `tag` tried this frame and could not make a
 *   mask (dropped with the group, like its masks; a mask set at `key` replaces it)
 * @property {(key: string) => string | undefined} getMark
 * @property {(keys: Iterable<string>, from: string, to: string) => number} retag - Give the
 *   masks and marks at `keys` that carry tag `from` the tag `to` (unchanged
 *   pixels; one change event); returns how many
 * @property {(key: string) => boolean} delete - The mask and the mark at `key`
 * @property {(clipId: string) => number} deleteClip - Drop every mask of a clip (all models); returns how many
 * @property {(clipId: string, model?: string) => void} touchClip - Mark a clip's masks of one
 *   model (default: of every model) recently used (e.g. the active clip)
 * @property {(clipId: string) => string[]} keysForClip - Every model's
 * @property {(clipId: string | null, need?: { frames: number, models: string[] }) => void} setActiveClip -
 *   The clip being edited and the groups ("models") it reads now: its base
 *   model and `object:<id>` per fix-up. Those groups are never evicted, and
 *   the cap grows to hold them (frames x mask bytes x groups)
 * @property {() => void} clear
 * @property {(listener: (change: MaskStoreChange) => void) => () => void} subscribe
 * @property {number} version - Bumps on every change
 * @property {number} byteLength - Bytes held by all masks
 * @property {number} size - Number of masks
 * @property {number} capBytes - The base masks' cap now: the larger of the default and the active clip's need
 * @property {number} objectCapBytes - The fix-ups' cap now, the same way
 */

/**
 * Create a mask store.
 *
 * Eviction never touches the group (clip and model) that is being written: a
 * single group whose masks alone exceed the cap is kept whole (its analysis
 * would otherwise be lost while it is still being produced), and older
 * groups are dropped first.
 *
 * Nor does it touch the groups the active clip reads (setActiveClip): a 15 s
 * clip's base masks alone fill the default cap, so its fix-ups' masks used
 * to evict them, and export then found no masks at all. Other clips' groups
 * go first, then the active clip's groups of models it no longer uses.
 *
 * @param {{ capBytes?: number }} [options]
 * @returns {MaskStore}
 */
export function createMaskStore({
  capBytes = MASK_STORE_CAP_BYTES,
  objectCapBytes = OBJECT_MASK_CAP_BYTES,
} = {}) {
  /** @type {Map<string, { mask: ProbabilityMask, group: string, tag: string }>} */
  const entries = new Map();
  /** @type {Map<string, { group: string, tag: string }>} key -> mark (no mask) */
  const marks = new Map();
  /** @type {Map<string, { clipId: string, model: string, keys: Set<string>, marks: Set<string> }>} group id -> masks and marks */
  const groups = new Map();
  /** @type {Map<string, number>} group id -> last-use tick */
  const lastUsed = new Map();
  /** @type {Set<(change: MaskStoreChange) => void>} */
  const listeners = new Set();

  let version = 0;
  let byteLength = 0;
  /** Bytes of the fix-ups' groups (inside byteLength too) */
  let objectBytes = 0;
  let tick = 0;
  /** @type {{ clipId: string, frames: number, models: Set<string> } | null} */
  let active = null;

  /** @param {string} id - A group id: one of a tracked fix-up's masks */
  const isObjectGroup = (id) => (groups.get(id)?.model ?? '').startsWith(OBJECT_GROUP_PREFIX);

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

  /** @param {string} id - Forget a group once it holds nothing */
  function dropIfEmpty(id) {
    const group = groups.get(id);
    if (group && group.keys.size === 0 && group.marks.size === 0) {
      groups.delete(id);
      lastUsed.delete(id);
    }
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
    if (isObjectGroup(entry.group)) objectBytes -= entry.mask.data.byteLength;
    groups.get(entry.group)?.keys.delete(key);
    dropIfEmpty(entry.group);
    return true;
  }

  /**
   * Remove one mark without notifying.
   * @param {string} key
   * @returns {boolean}
   */
  function removeMark(key) {
    const mark = marks.get(key);
    if (!mark) return false;
    marks.delete(key);
    groups.get(mark.group)?.marks.delete(key);
    dropIfEmpty(mark.group);
    return true;
  }

  /**
   * The group of (clip, model), created when missing
   * @param {string} clipId
   * @param {string} model
   */
  function ensureGroup(clipId, model) {
    const id = groupId(clipId, model);
    let group = groups.get(id);
    if (!group) {
      group = { clipId, model, keys: new Set(), marks: new Set() };
      groups.set(id, group);
    }
    return { id, group };
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
    for (const key of [...group.marks]) marks.delete(key);
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
   * Bytes of one pool: the tracked fix-ups' masks, or the base models' masks
   * @param {boolean} objects
   */
  const bytesOf = (objects) => (objects ? objectBytes : byteLength - objectBytes);

  /**
   * The cap of one pool now: its default, or what the active clip's groups of
   * that pool need when that is more. Each group needs frames x the size of
   * one of its masks; a group with no mask yet is counted at the largest mask
   * of its pool in the clip
   * @param {boolean} objects - The fix-ups' pool (else the base masks')
   * @returns {number}
   */
  function currentCap(objects) {
    const cap = objects ? objectCapBytes : capBytes;
    if (!active || active.frames <= 0) return cap;
    const { clipId, frames } = active;
    /** @type {(number | null)[]} */
    const sizes = [...active.models]
      .filter((model) => model.startsWith(OBJECT_GROUP_PREFIX) === objects)
      .map((model) => {
        const key = groups.get(groupId(clipId, model))?.keys.values().next().value;
        if (key === undefined) return null;
        return /** @type {{ mask: ProbabilityMask }} */ (entries.get(key)).mask.data.byteLength;
      });
    const largest = Math.max(0, ...sizes.map((size) => size ?? 0));
    const need = sizes.reduce((sum, size) => sum + frames * (size ?? largest), 0);
    return Math.max(cap, need);
  }

  /**
   * Least-recently-used group that may go: another clip's first, then one of
   * the active clip's groups it no longer reads; never `keepGroup` and never
   * a group the active clip reads
   * @param {string | null} keepGroup
   * @param {boolean} objects - Pick from the fix-ups' pool (else the base masks')
   * @returns {string | null}
   */
  function pickVictim(keepGroup, objects) {
    let other = null;
    let otherUsed = Number.POSITIVE_INFINITY;
    let stale = null;
    let staleUsed = Number.POSITIVE_INFINITY;
    for (const [id, used] of lastUsed) {
      if (id === keepGroup || isObjectGroup(id) !== objects) continue;
      const group = /** @type {{ clipId: string, model: string }} */ (groups.get(id));
      if (active && group.clipId === active.clipId) {
        if (!active.models.has(group.model) && used < staleUsed) {
          staleUsed = used;
          stale = id;
        }
      } else if (used < otherUsed) {
        otherUsed = used;
        other = id;
      }
    }
    return other ?? stale;
  }

  /**
   * Evict groups (see pickVictim) until each pool is under its cap. Fix-ups
   * and base masks each stay under their own cap, evicting only their own
   * kind (a fix-up never evicts a base mask); the active clip's groups are
   * never evicted (#228). Without a group being written (the active clip
   * changed), both pools are checked.
   * @param {string | null} keepGroup - The group being written, if any
   */
  function evictOverCap(keepGroup) {
    const pools = keepGroup === null ? [false, true] : [isObjectGroup(keepGroup)];
    for (const objects of pools) {
      const cap = currentCap(objects);
      while (bytesOf(objects) > cap) {
        const victim = pickVictim(keepGroup, objects);
        if (victim === null) break;
        const { clipId, model } = /** @type {{ clipId: string, model: string }} */ (
          groups.get(victim)
        );
        removeGroup(victim);
        changed({ type: 'evict', clipId, model });
      }
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

    set(key, mask, clipId = DEFAULT_CLIP_ID, model = '', tag = '') {
      if (!(mask?.data instanceof Uint8Array)) {
        throw new TypeError('mask.data must be a Uint8Array');
      }
      if (mask.data.length !== mask.width * mask.height) {
        throw new RangeError(
          `mask.data holds ${mask.data.length} bytes, expected ${mask.width}×${mask.height}`,
        );
      }
      removeEntry(key);
      removeMark(key);
      const { id, group } = ensureGroup(clipId, model);
      entries.set(key, { mask, group: id, tag });
      byteLength += mask.data.byteLength;
      if (isObjectGroup(id)) objectBytes += mask.data.byteLength;
      group.keys.add(key);
      touch(id);
      changed({ type: 'set', key, clipId });
      evictOverCap(id);
    },

    getTag(key) {
      return entries.get(key)?.tag;
    },

    mark(key, tag, clipId = DEFAULT_CLIP_ID, model = '') {
      const hadMask = removeEntry(key);
      removeMark(key);
      const { id, group } = ensureGroup(clipId, model);
      marks.set(key, { group: id, tag });
      group.marks.add(key);
      touch(id);
      if (hadMask) changed({ type: 'delete', key, clipId });
    },

    getMark(key) {
      return marks.get(key)?.tag;
    },

    retag(keys, from, to) {
      let n = 0;
      for (const key of keys) {
        const entry = entries.get(key);
        if (entry && entry.tag === from) {
          entry.tag = to;
          n++;
        }
        const mark = marks.get(key);
        if (mark && mark.tag === from) {
          mark.tag = to;
          n++;
        }
      }
      if (n > 0) changed({ type: 'set' });
      return n;
    },

    delete(key) {
      const entry = entries.get(key);
      const clipId = entry ? groups.get(entry.group)?.clipId : undefined;
      removeMark(key);
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

    setActiveClip(clipId, need) {
      active =
        clipId === null
          ? null
          : { clipId, frames: need?.frames ?? 0, models: new Set(need?.models ?? []) };
      // The groups protected until now may be over the new cap: reclaim at
      // once, not at the next write (a switch to an unanalyzed clip has none)
      evictOverCap(null);
    },

    keysForClip(clipId) {
      return groupsOfClip(clipId).flatMap((id) => [
        .../** @type {{ keys: Set<string> }} */ (groups.get(id)).keys,
      ]);
    },

    clear() {
      active = null;
      marks.clear();
      if (entries.size === 0) {
        groups.clear();
        lastUsed.clear();
        return;
      }
      entries.clear();
      groups.clear();
      lastUsed.clear();
      byteLength = 0;
      objectBytes = 0;
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
      return currentCap(false);
    },

    get objectCapBytes() {
      return currentCap(true);
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
