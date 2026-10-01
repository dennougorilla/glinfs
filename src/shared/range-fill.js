/**
 * Range track fill
 * @module shared/range-fill
 *
 * Chromium has no pseudo-element for the filled part of a range track, so
 * global.css paints it with a gradient stopped at `--range-fill`. This keeps
 * that property in step with every `<input type="range">` in the document:
 * on user input, on programmatic value changes made by re-renders (caught by
 * observing added nodes and `value` attribute changes), and at startup.
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

/**
 * @param {Element} el
 */
function sync(el) {
  if (el instanceof HTMLInputElement && el.type === 'range') {
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
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('change', onInput, true);
    observer.disconnect();
  };
}
