/**
 * Document-level hotkey dispatcher (#102)
 *
 * One bubble-phase `keydown` listener on document routes every app
 * shortcut through a scoped registry, so precedence ("popover open vs.
 * editor vs. global") and the "typing in a field" guard live in one place.
 *
 * Rules, in order:
 * - IME composition keystrokes (isComposing, or keyCode 229 in browsers
 *   that report the composition that way) are never shortcuts: Escape
 *   while converting Japanese text cancels the conversion, not the crop.
 * - An event another listener already consumed (defaultPrevented) is left
 *   alone. Bubble phase is deliberate: element-level and capture-phase
 *   handlers run first and can claim a key by preventing its default.
 * - Scopes are tried modal > overlay > route > global; within a scope the
 *   most recent registration is tried first. The first handler that does
 *   not return `false` wins and nothing else runs.
 * - A modal is exclusive: while any modal-scope hotkey is registered (the
 *   frame grid registers its keys for as long as it is open), the overlay
 *   and route scopes are skipped entirely, so keys the modal does not own
 *   (Delete, 1-9, G...) cannot reach the page underneath. Global shortcuts
 *   (Shift+C) stay live.
 * - Focus in an input/textarea/select/contenteditable suppresses every
 *   hotkey that did not opt in with `allowInEditable`.
 * - Ctrl/Meta/Alt must match exactly (default: not pressed), so browser and
 *   OS shortcuts such as Cmd+F or Alt+ArrowLeft are never swallowed. Shift
 *   is exact too unless the hotkey passes `shift: 'any'`.
 *
 * Handlers own `preventDefault()`: several shortcuts only claim the key
 * conditionally (e.g. Shift+C without a live capture, a digit with no clip
 * at that position).
 *
 * @module shared/hotkeys
 */

/** @typedef {'modal' | 'overlay' | 'route' | 'global'} HotkeyScope */

/**
 * @typedef {Object} HotkeyModifiers
 * @property {boolean | 'any'} [shift] - Default false; 'any' ignores Shift
 * @property {boolean} [ctrl] - Default false
 * @property {boolean} [meta] - Default false
 * @property {boolean} [alt] - Default false
 */

/**
 * @typedef {Object} HotkeyOptions
 * @property {string} [key] - KeyboardEvent.key, compared case-insensitively
 * @property {string} [code] - KeyboardEvent.code (layout-independent), e.g. 'Digit1'
 * @property {HotkeyModifiers} [modifiers]
 * @property {HotkeyScope} scope
 * @property {(e: KeyboardEvent) => boolean | void} handler - Return false to
 *   decline the event and let lower-priority hotkeys try it
 * @property {boolean} [allowInEditable] - Also fire while a form field or
 *   contenteditable element has focus
 */

/** @type {readonly HotkeyScope[]} */
const SCOPE_ORDER = ['modal', 'overlay', 'route', 'global'];

/** Scopes skipped while a modal has hotkeys registered */
const MODAL_YIELDING_SCOPES = new Set(['overlay', 'route']);

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** @type {Map<HotkeyScope, HotkeyOptions[]>} */
const registry = new Map(SCOPE_ORDER.map((scope) => [scope, []]));

let installed = false;

/**
 * Register a hotkey. The dispatcher's document listener is installed with
 * the first registration and removed when the last one unsubscribes.
 * @param {HotkeyOptions} options
 * @returns {() => void} Unsubscribe (idempotent)
 */
export function registerHotkey(options) {
  const entries = registry.get(options.scope);
  if (!entries) {
    throw new Error(`Unknown hotkey scope: ${options.scope}`);
  }
  if (!options.key && !options.code) {
    throw new Error('registerHotkey needs a key or a code');
  }

  // Copy so a caller mutating its options object can't change matching
  const entry = { ...options };
  entries.push(entry);
  install();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = entries.indexOf(entry);
    if (index !== -1) entries.splice(index, 1);
    if (countHotkeys() === 0) uninstall();
  };
}

/**
 * Number of registered hotkeys, optionally for one scope (leak checks)
 * @param {HotkeyScope} [scope]
 * @returns {number}
 */
export function countHotkeys(scope) {
  if (scope) return registry.get(scope)?.length ?? 0;
  let total = 0;
  for (const entries of registry.values()) total += entries.length;
  return total;
}

/**
 * Whether keyboard focus is in a text-entry control
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Whether a keydown belongs to an IME composition session. Listeners outside
 * the dispatcher use this too, so no shortcut fires mid-conversion.
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isComposingEvent(e) {
  return e.isComposing || e.keyCode === 229;
}

/** @param {KeyboardEvent} e */
function dispatch(e) {
  if (isComposingEvent(e) || e.defaultPrevented) return;

  // Test-dispatched events target document; real ones target the focused
  // element. Either way the focused element decides "is the user typing".
  const target = e.target instanceof Element ? e.target : document.activeElement;
  const editable = isEditableTarget(target);
  // Snapshot like the entries below: a handler may close the modal mid-dispatch
  const modalOpen = countHotkeys('modal') > 0;

  for (const scope of SCOPE_ORDER) {
    if (modalOpen && MODAL_YIELDING_SCOPES.has(scope)) continue;

    // Snapshot: a handler may unregister (e.g. closing the popover)
    const entries = [.../** @type {HotkeyOptions[]} */ (registry.get(scope))].reverse();
    for (const entry of entries) {
      if (!matches(entry, e)) continue;
      if (editable && !entry.allowInEditable) continue;
      if (entry.handler(e) !== false) return;
    }
  }
}

/**
 * @param {HotkeyOptions} entry
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function matches(entry, e) {
  if (entry.code !== undefined && e.code !== entry.code) return false;
  if (entry.key !== undefined && e.key?.toLowerCase() !== entry.key.toLowerCase()) return false;

  const { shift = false, ctrl = false, meta = false, alt = false } = entry.modifiers ?? {};
  if (shift !== 'any' && e.shiftKey !== shift) return false;
  return e.ctrlKey === ctrl && e.metaKey === meta && e.altKey === alt;
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', dispatch);
}

function uninstall() {
  if (!installed) return;
  installed = false;
  document.removeEventListener('keydown', dispatch);
}
