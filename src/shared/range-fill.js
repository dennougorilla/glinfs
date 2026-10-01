/**
 * Range track fill
 * @module shared/range-fill
 *
 * Chromium has no pseudo-element for the filled part of a range track, so
 * form-controls.css paints it with a gradient stopped at `--range-fill`.
 * This keeps that property in step with every `<input type="range">` in the
 * document: on user input, on re-renders (observing added nodes and `value`,
 * `min` and `max` attribute changes), on scripts assigning `value` directly
 * (which fires no event and changes no attribute), and at startup.
 */

/**
 * Fill percentage of a range input
 * @param {HTMLInputElement} input
 * @returns {number} 0-100
 */
export function rangeFillPercent(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
/** @type {WeakSet<HTMLInputElement>} */
const tracked = new WeakSet();
/** Running initRangeFill calls: scripted values sync only while one runs */
let running = 0;

/**
 * Sync the fill whenever a script assigns `input.value`: the input gets its
 * own `value` accessor that defers to the native one, then syncs
 * @param {HTMLInputElement} input
 */
function track(input) {
  if (tracked.has(input) || !valueProperty?.get || !valueProperty.set) return;
  tracked.add(input);
  const { get, set } = valueProperty;
  Object.defineProperty(input, 'value', {
    configurable: true,
    enumerable: valueProperty.enumerable,
    get() {
      return get.call(this);
    },
    set(value) {
      set.call(this, value);
      if (running) sync(this);
    },
  });
}

/**
 * @param {Element} el
 */
function sync(el) {
  if (el instanceof HTMLInputElement && el.type === 'range') {
    track(el);
    el.style.setProperty('--range-fill', `${rangeFillPercent(el)}%`);
  }
}

/**
 * @param {ParentNode} root
 */
function syncAll(root) {
  for (const el of root.querySelectorAll('input[type="range"]')) sync(el);
}

/**
 * Start syncing range fills for the whole document
 * @param {Document} [doc=document]
 * @returns {() => void} Stop function
 */
export function initRangeFill(doc = document) {
  running++;
  let stopped = false;
  const onInput = (/** @type {Event} */ event) => {
    if (event.target instanceof Element) sync(event.target);
  };
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('change', onInput, true);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        sync(/** @type {Element} */ (record.target));
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        sync(node);
        syncAll(node);
      }
    }
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['value', 'min', 'max'],
  });
  syncAll(doc);

  return () => {
    if (stopped) return;
    stopped = true;
    running--;
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('change', onInput, true);
    observer.disconnect();
  };
}
