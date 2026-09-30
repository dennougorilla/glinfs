/**
 * Persistent storage for downloaded models (main thread)
 * @module features/ai-cutout/model-storage
 *
 * Models live in Cache Storage, which a browser may clear on its own when
 * the disk runs low ("best-effort" storage). Once the user has downloaded a
 * model, the app asks for persistent storage (`navigator.storage.persist()`)
 * so that does not happen behind their back. Browsers decide on their own
 * (Chrome grants it to sites the user engages with, Firefox may ask, Safari
 * has no prompt), so every call here is guarded and a refusal is fine.
 *
 * StorageManager is injectable for unit tests.
 */

/**
 * @typedef {Pick<StorageManager, 'persist' | 'persisted' | 'estimate'>} StorageLike
 */

/** @returns {Partial<StorageLike> | undefined} */
function defaultStorage() {
  return globalThis.navigator?.storage;
}

/**
 * Ask the browser to keep this site's storage (the model cache) when space
 * is low. Asks only when it is not persistent already.
 * @param {Partial<StorageLike> | undefined} [storage]
 * @returns {Promise<boolean | null>} Persistent now (null: the browser cannot tell)
 */
export async function requestPersistentStorage(storage = defaultStorage()) {
  if (typeof storage?.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return Boolean(await storage.persist());
  } catch {
    return null;
  }
}

/**
 * Whether this site's storage is persistent.
 * @param {Partial<StorageLike> | undefined} [storage]
 * @returns {Promise<boolean | null>} null: unknown
 */
export async function isStoragePersistent(storage = defaultStorage()) {
  if (typeof storage?.persisted !== 'function') return null;
  try {
    return Boolean(await storage.persisted());
  } catch {
    return null;
  }
}

/**
 * Bytes this site stores (every storage type), or null when unknown.
 * @param {Partial<StorageLike> | undefined} [storage]
 * @returns {Promise<number | null>}
 */
export async function estimateStorageUsage(storage = defaultStorage()) {
  if (typeof storage?.estimate !== 'function') return null;
  try {
    const { usage } = await storage.estimate();
    return typeof usage === 'number' && Number.isFinite(usage) ? usage : null;
  } catch {
    return null;
  }
}
