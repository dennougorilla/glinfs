/**
 * The user's custom models: definitions in IndexedDB, entries in the registry
 * @module features/ai-cutout/custom-model-store
 *
 * Each definition (custom-models.js) is one IndexedDB record; the model's
 * bytes are in the model cache (Cache Storage) under the key the app loads
 * it with, so a model added from a local file survives a reload. The
 * settings store is not used on purpose: "Reset all settings" must not
 * delete models.
 *
 * Every change updates the registry (setCustomModelEntries), so the
 * editor's cards, Settings and the worker see it at once, and tells the
 * other tabs (BroadcastChannel), which read the records again.
 *
 * The app reads the records once before the first screen renders
 * (main.js awaits loadCustomModels), so an edit that names a custom model
 * finds it.
 */

import { normalizeCustomModelDefinition, toModelEntry } from './custom-models.js';
import { deleteDownloadedModel } from './model-cache.js';
import { setCustomModelEntries } from './model-registry.js';

/** @typedef {import('./custom-models.js').CustomModelDefinition} CustomModelDefinition */

const DB_NAME = 'glinfs-custom-models';
const STORE = 'definitions';
const CHANNEL = 'glinfs-custom-models';

/** How long the first read may take before the app starts without the models */
export const LOAD_TIMEOUT_MS = 3000;

/**
 * @typedef {Object} StoredRecord
 * @property {string} id
 * @property {CustomModelDefinition} definition
 * @property {number} addedAt - Date.now() when added (the list order)
 */

/** Definitions in list order @type {CustomModelDefinition[]} */
let definitions = [];

/** @type {Promise<IDBDatabase | null> | null} */
let dbPromise = null;

/** @type {BroadcastChannel | null} */
let channel = null;

/** @returns {Promise<IDBDatabase | null>} null when IndexedDB is unavailable */
function openDb() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = globalThis.indexedDB?.open(DB_NAME, 1);
      if (!request) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/**
 * Run one request in a transaction
 * @template T
 * @param {'readonly' | 'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} make
 * @returns {Promise<T>}
 */
async function request(mode, make) {
  const db = await openDb();
  if (!db) throw new Error('This browser cannot store custom models (IndexedDB is unavailable)');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = make(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('The change was not stored'));
  });
}

/** Push the definitions into the registry */
function publish() {
  setCustomModelEntries(definitions.map(toModelEntry));
}

/** Tell the other tabs */
function broadcast() {
  try {
    channel?.postMessage('changed');
  } catch {
    // Another tab picks the change up on its next reload
  }
}

/** Read every stored definition (dropping any that no longer validate) */
async function readAll() {
  /** @type {StoredRecord[]} */
  const records = await request('readonly', (store) => store.getAll());
  return records
    .filter((record) => record && typeof record === 'object')
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
    .map((record) => normalizeCustomModelDefinition(record.definition))
    .filter((result) => result.ok)
    .map(
      (result) =>
        /** @type {{ ok: true, definition: CustomModelDefinition }} */ (result).definition,
    );
}

/**
 * Read the stored custom models into the registry (once at start; again
 * when another tab changed them). Never rejects: without IndexedDB, or
 * when it takes longer than LOAD_TIMEOUT_MS, the app starts without them.
 * @returns {Promise<CustomModelDefinition[]>}
 */
export async function loadCustomModels() {
  if (!channel && typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      void loadCustomModels();
    };
  }
  try {
    const read = readAll();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), LOAD_TIMEOUT_MS));
    const result = /** @type {CustomModelDefinition[] | null} */ (
      await Promise.race([read, timeout])
    );
    if (result) {
      definitions = result;
      publish();
    } else {
      // Slow storage: the models appear once it answers
      void read.then(
        (late) => {
          definitions = late;
          publish();
        },
        () => undefined,
      );
    }
  } catch (error) {
    console.warn('[ai-cutout] The custom models could not be read:', error);
  }
  return definitions;
}

/** @returns {CustomModelDefinition[]} The custom models, in list order */
export function getCustomModelDefinitions() {
  return [...definitions];
}

/**
 * @param {string} id
 * @returns {CustomModelDefinition | null}
 */
export function getCustomModelDefinition(id) {
  return definitions.find((d) => d.id === id) ?? null;
}

/**
 * Add a model, or replace the one with the same id (its bytes are already
 * in the model cache)
 * @param {CustomModelDefinition} definition
 * @returns {Promise<void>}
 */
export async function saveCustomModel(definition) {
  const existing = definitions.findIndex((d) => d.id === definition.id);
  /** @type {StoredRecord} */
  const record = { id: definition.id, definition, addedAt: Date.now() };
  if (existing !== -1) {
    /** @type {StoredRecord | undefined} */
    const old = await request('readonly', (store) => store.get(definition.id));
    record.addedAt = old?.addedAt ?? record.addedAt;
  }
  await request('readwrite', (store) => store.put(record));
  definitions =
    existing === -1
      ? [...definitions, definition]
      : definitions.map((d) => (d.id === definition.id ? definition : d));
  publish();
  broadcast();
}

/**
 * Rename a model (its id, masks and file stay)
 * @param {string} id
 * @param {string} label
 * @returns {Promise<CustomModelDefinition | null>} The renamed definition
 */
export async function renameCustomModel(id, label) {
  const current = getCustomModelDefinition(id);
  if (!current) return null;
  const clean = label.replace(/\s+/g, ' ').trim();
  if (!clean) return current;
  const next = { ...current, label: clean.slice(0, 60) };
  await saveCustomModel(next);
  return next;
}

/**
 * Delete a model: its definition and its bytes in the model cache. Clips
 * that use it keep its id; analyzing them fails with MODEL_UNAVAILABLE.
 * @param {string} id
 * @returns {Promise<boolean>} It existed
 */
export async function deleteCustomModel(id) {
  if (!getCustomModelDefinition(id)) return false;
  // The cache keys come from the registry entry: delete the bytes first
  await deleteDownloadedModel(id).catch(() => false);
  await request('readwrite', (store) => store.delete(id));
  definitions = definitions.filter((d) => d.id !== id);
  publish();
  broadcast();
  return true;
}
