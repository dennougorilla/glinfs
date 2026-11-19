/**
 * The segmentation worker's click-to-select image embeddings: a byte-capped
 * LRU (see byte-lru.js; a tracking job scopes the embeddings it uses) with an
 * index of the embeddings of each model and of each clip, so an unloaded
 * model or a released clip drops its embeddings at once instead of keeping
 * them until the cap evicts them (audit B8). Every way out of the cache
 * (eviction, a forgotten clip, an unloaded model) also removes the key from
 * both indexes, so they never outgrow the cache.
 * @module features/ai-cutout/embedding-cache
 */

import { createByteLru } from './byte-lru.js';

/**
 * @template V
 * @param {number} capBytes
 */
export function createEmbeddingCache(capBytes) {
  /** @type {Map<string, Set<string>>} */
  const byModel = new Map();
  /** @type {Map<string, Set<string>>} */
  const byClip = new Map();
  /** @type {Map<string, { modelId: string, clipId?: string }>} */
  const owners = new Map();

  /**
   * @param {Map<string, Set<string>>} index
   * @param {string} id
   * @param {string} key
   */
  const unlink = (index, id, key) => {
    const keys = index.get(id);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) index.delete(id);
  };

  /** @param {string} key - Gone from the cache: forget it in both indexes */
  const forgetKey = (key) => {
    const owner = owners.get(key);
    if (!owner) return;
    owners.delete(key);
    unlink(byModel, owner.modelId, key);
    if (owner.clipId !== undefined) unlink(byClip, owner.clipId, key);
  };

  /** @type {import('./byte-lru.js').ByteLru<V>} */
  const lru = createByteLru(capBytes, { onEvict: (key) => forgetKey(key) });

  /** @param {Iterable<string>} keys */
  const drop = (keys) => {
    for (const key of [...keys]) {
      lru.delete(key);
      forgetKey(key);
    }
  };

  /**
   * @param {Map<string, Set<string>>} index
   * @param {string} id
   * @param {string} key
   */
  const link = (index, id, key) => {
    let keys = index.get(id);
    if (!keys) {
      keys = new Set();
      index.set(id, keys);
    }
    keys.add(key);
  };

  return {
    /**
     * @param {string} key
     * @param {number | undefined} scope - The tracking job reading it
     * @returns {V | undefined}
     */
    get(key, scope) {
      return lru.get(key, scope);
    },

    /**
     * @param {string} key
     * @param {V} value
     * @param {number} bytes
     * @param {number | undefined} scope
     * @param {{ modelId: string, clipId?: string | null }} owner
     * @returns {boolean} Stored (false: larger than what the cache can free)
     */
    set(key, value, bytes, scope, { modelId, clipId }) {
      forgetKey(key);
      if (!lru.set(key, value, bytes, scope)) return false;
      const clip = clipId ?? undefined;
      owners.set(key, { modelId, ...(clip !== undefined ? { clipId: clip } : {}) });
      link(byModel, modelId, key);
      if (clip !== undefined) link(byClip, clip, key);
      return true;
    },

    /** @param {string} clipId - Released for good */
    forgetClip(clipId) {
      drop(byClip.get(clipId) ?? []);
    },

    /** @param {string} modelId - Unloaded */
    forgetModel(modelId) {
      drop(byModel.get(modelId) ?? []);
    },

    /** Index sizes (tests): models, clips, and keys with an owner */
    indexSizes() {
      return {
        byModel: byModel.size,
        byClip: byClip.size,
        clipOf: [...owners.values()].filter((o) => o.clipId !== undefined).length,
      };
    },
  };
}
