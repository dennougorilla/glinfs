/**
 * Switchable methods ("labs"): where the app has more than one way to do a
 * job, the choice lives here so it can be compared in the real app.
 *
 * One entry = one object in METHODS. The code path that branches asks
 * getMethod(id) at the moment it branches, so a change in Settings takes
 * effect on the next call without a reload.
 *
 * The choice in effect is, in order:
 * 1. a URL override `?method.<id>=<option>`, read once when the page loads:
 *    it lasts for the page session and is never written to the settings
 * 2. the stored choice (user settings `methods`), if it names an option
 * 3. the entry's default
 *
 * @module shared/methods
 */

import { loadSettings, updateSetting } from './user-settings.js';

/**
 * @typedef {Object} MethodOption
 * @property {string} id - Stored value
 * @property {string} name - What Settings shows
 */

/**
 * @typedef {Object} MethodEntry
 * @property {string} id - Key in the settings and in the URL override
 * @property {'capture' | 'scenes' | 'editor' | 'cutout' | 'export'} area -
 *   The part of the app it changes (Settings lists entries in this order)
 * @property {string} name - Row label in Settings
 * @property {MethodOption[]} options
 * @property {string} default - Option id used when nothing valid is chosen
 */

/** Order of the areas in Settings */
export const METHOD_AREAS = /** @type {const} */ ([
  'capture',
  'scenes',
  'editor',
  'cutout',
  'export',
]);

/** @type {MethodEntry[]} The registry: one object per switch */
export const METHODS = [];

/** Prefix of a URL override parameter */
const URL_PREFIX = 'method.';

/**
 * Throws when an entry is malformed or its id is taken
 * @param {MethodEntry} entry
 * @param {MethodEntry[]} [registry]
 */
export function validateMethodEntry(entry, registry = METHODS) {
  const where = `Method "${entry?.id}"`;
  if (!entry || typeof entry.id !== 'string' || entry.id === '') {
    throw new Error('Method entry needs a string id');
  }
  if (!METHOD_AREAS.includes(entry.area)) throw new Error(`${where}: unknown area "${entry.area}"`);
  if (typeof entry.name !== 'string' || entry.name === '')
    throw new Error(`${where}: needs a name`);
  if (!Array.isArray(entry.options) || entry.options.length < 2) {
    throw new Error(`${where}: needs at least two options`);
  }
  const ids = entry.options.map((o) => o?.id);
  if (ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) {
    throw new Error(`${where}: option ids must be distinct non-empty strings`);
  }
  if (entry.options.some((o) => typeof o.name !== 'string' || o.name === '')) {
    throw new Error(`${where}: every option needs a name`);
  }
  if (!ids.includes(entry.default)) throw new Error(`${where}: default is not one of its options`);
  if (registry.some((e) => e.id === entry.id && e !== entry)) {
    throw new Error(`${where}: id is already registered`);
  }
}

/**
 * Add an entry to the registry (tests, and code that registers a switch at
 * start-up instead of listing it in METHODS)
 * @param {MethodEntry} entry
 */
export function registerMethod(entry) {
  validateMethodEntry(entry);
  METHODS.push(entry);
}

/**
 * Remove an entry (tests)
 * @param {string} id
 */
export function unregisterMethod(id) {
  const i = METHODS.findIndex((e) => e.id === id);
  if (i >= 0) METHODS.splice(i, 1);
}

/**
 * @param {string} id
 * @returns {MethodEntry}
 */
function entryOf(id) {
  const entry = METHODS.find((e) => e.id === id);
  if (!entry) throw new Error(`Unknown method "${id}"`);
  return entry;
}

/**
 * @param {MethodEntry} entry
 * @param {unknown} value
 * @returns {value is string}
 */
const isOption = (entry, value) => entry.options.some((o) => o.id === value);

/**
 * URL overrides `?method.<id>=<option>` in a query string. Values are kept
 * as given: they are checked against the registry when read, so an entry
 * registered after the page loaded is overridden too.
 * @param {string} search - e.g. location.search
 * @returns {Record<string, string>}
 */
export function parseMethodOverrides(search) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (key.startsWith(URL_PREFIX) && key.length > URL_PREFIX.length) {
      out[key.slice(URL_PREFIX.length)] = value;
    }
  }
  return out;
}

/** @type {Record<string, string>} The page's URL overrides, read once */
let overrides = parseMethodOverrides(typeof location === 'undefined' ? '' : location.search);

/**
 * Replace the URL overrides (tests; the app reads them once at load)
 * @param {string} search
 */
export function setMethodOverridesFromSearch(search) {
  overrides = parseMethodOverrides(search);
}

/**
 * The option a URL override sets for an entry, or null (none, or not one
 * of its options)
 * @param {string} id
 * @returns {string | null}
 */
export function getMethodOverride(id) {
  const value = overrides[id];
  return isOption(entryOf(id), value) ? value : null;
}

/**
 * The stored choices, each validated against the registry: an unknown or
 * missing value is the entry's default. URL overrides are not applied.
 * @param {{ methods?: Record<string, string> }} [settings]
 * @returns {Record<string, string>}
 */
export function getStoredMethods(settings = loadSettings()) {
  const stored = settings.methods ?? {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const entry of METHODS) {
    const value = stored[entry.id];
    out[entry.id] = isOption(entry, value) ? value : entry.default;
  }
  return out;
}

/**
 * The option in effect for a method: URL override, else the stored choice
 * if valid, else the default. Throws for an id that is not registered.
 * @param {string} id
 * @returns {string}
 */
export function getMethod(id) {
  const entry = entryOf(id);
  const override = getMethodOverride(id);
  if (override !== null) return override;
  const stored = loadSettings().methods?.[id];
  return isOption(entry, stored) ? stored : entry.default;
}

/**
 * Store a choice (ignored unless it is one of the entry's options)
 * @param {string} id
 * @param {string} option
 */
export function setMethod(id, option) {
  if (!isOption(entryOf(id), option)) return;
  updateSetting('methods', id, option);
}

/**
 * The registry in Settings order: by area, then as registered; each
 * entry's options with the default first
 * @returns {MethodEntry[]}
 */
export function listMethods() {
  const area = (/** @type {MethodEntry} */ e) => METHOD_AREAS.indexOf(e.area);
  return METHODS.map((entry, i) => ({ entry, i }))
    .sort((a, b) => area(a.entry) - area(b.entry) || a.i - b.i)
    .map(({ entry }) => ({
      ...entry,
      options: [
        ...entry.options.filter((o) => o.id === entry.default),
        ...entry.options.filter((o) => o.id !== entry.default),
      ],
    }));
}
