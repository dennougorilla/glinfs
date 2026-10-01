/**
 * Least-recently-used cache bounded by bytes
 * @module features/ai-cutout/byte-lru
 *
 * The segmentation worker keeps click-to-select image embeddings per
 * frame, so refining a click or tracking again after a change only runs the
 * small decoder on frames it has seen. Memory is bounded: storing past the
 * cap drops the least recently used entries first. An entry larger than the
 * whole cap is not kept.
 *
 * Scopes make a scan of more entries than fit useful: plain LRU drops each
 * entry just before a second scan in the same order needs it, so that scan
 * finds nothing. An entry stored or read with a scope (a tracking job) is
 * never dropped to make room for another entry of the same scope: once
 * those fill the cache, the scan's later entries are not kept, and the
 * next scan (a new scope, re-scoping each entry it reads) finds the first
 * ones. To make room for a scoped entry, entries of other scopes go most
 * recently used first: an earlier scan's last entries, so a new scan that
 * starts with a miss still finds that scan's first ones.
 */

/**
 * @template V
 * @typedef {Object} ByteLru
 * @property {(key: string, scope?: unknown) => V | undefined} get - Also marks the
 *   entry recently used (and as the scope's, when one is given)
 * @property {(key: string) => boolean} has
 * @property {(key: string, value: V, bytes: number, scope?: unknown) => boolean} set -
 *   false when not kept: too large, or the room is held by the same scope
 * @property {(key: string) => boolean} delete
 * @property {() => void} clear
 * @property {number} bytes - Bytes held
 * @property {number} size - Entries held
 * @property {number} capBytes
 */

/**
 * @template V
 * @param {number} capBytes
 * @param {{ onEvict?: (key: string, value: V) => void }} [options] - onEvict:
 *   an entry was dropped to make room (not on delete/clear)
 * @returns {ByteLru<V>}
 */
export function createByteLru(capBytes, { onEvict } = {}) {
  /**
   * Insertion order = use order (a Map iterates oldest first)
   * @type {Map<string, { value: V, bytes: number, scope: unknown }>}
   */
  const entries = new Map();
  let bytes = 0;

  /** @param {string} key */
  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.bytes;
    return true;
  };

  return {
    get(key, scope) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (scope !== undefined) entry.scope = scope;
      entries.set(key, entry);
      return entry.value;
    },
    has(key) {
      return entries.has(key);
    },
    set(key, value, size, scope) {
      remove(key);
      if (size > capBytes) return false;
      if (bytes + size > capBytes) {
        // Entries this one may push out: any, least recently used first; or,
        // for a scoped entry, those of other scopes, most recently used first
        let freeable = capBytes - bytes;
        /** @type {string[]} */
        const victims = [];
        const order = scope === undefined ? [...entries] : [...entries].reverse();
        for (const [k, entry] of order) {
          if (freeable >= size) break;
          if (scope !== undefined && entry.scope === scope) continue;
          victims.push(k);
          freeable += entry.bytes;
        }
        if (freeable < size) return false;
        for (const k of victims) {
          const entry = /** @type {{ value: V }} */ (entries.get(k));
          remove(k);
          onEvict?.(k, entry.value);
        }
      }
      entries.set(key, { value, bytes: size, scope });
      bytes += size;
      return true;
    },
    delete(key) {
      return remove(key);
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    get bytes() {
      return bytes;
    },
    get size() {
      return entries.size;
    },
    get capBytes() {
      return capBytes;
    },
  };
}
