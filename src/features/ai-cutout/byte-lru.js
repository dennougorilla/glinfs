/**
 * Least-recently-used cache bounded by bytes
 * @module features/ai-cutout/byte-lru
 *
 * The segmentation worker keeps click-to-select image embeddings (4 MB
 * each: 256 × 64 × 64 float32) per frame, so refining a click or tracking
 * again after a change only runs the small decoder on frames it has seen.
 * Memory is bounded: storing past the cap drops the least recently used
 * entries first. An entry larger than the whole cap is not kept.
 */

/**
 * @template V
 * @typedef {Object} ByteLru
 * @property {(key: string) => V | undefined} get - Also marks the entry recently used
 * @property {(key: string) => boolean} has
 * @property {(key: string, value: V, bytes: number) => boolean} set - false when too large to keep
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
  /** Insertion order = use order (a Map iterates oldest first) @type {Map<string, { value: V, bytes: number }>} */
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
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    has(key) {
      return entries.has(key);
    },
    set(key, value, size) {
      remove(key);
      if (size > capBytes) return false;
      while (bytes + size > capBytes && entries.size > 0) {
        const [oldest, entry] = /** @type {[string, { value: V, bytes: number }]} */ (
          entries.entries().next().value
        );
        remove(oldest);
        onEvict?.(oldest, entry.value);
      }
      entries.set(key, { value, bytes: size });
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
