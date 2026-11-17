/**
 * The frame differencing switch (Settings → Methods), PR #209:
 * - smallest: each opaque frame is encoded whole and differenced, and the
 *   smaller one is written (the GIF is never larger than without it)
 * - off: every frame whole, as before #209 (fastest)
 * @module features/export/method
 */

import { getMethod, METHODS, registerMethod } from '../../shared/methods.js';

/** @type {import('../../shared/methods.js').MethodEntry} */
export const DIFFERENCING_METHOD_ENTRY = {
  id: 'gif.differencing',
  area: 'export',
  name: 'Frame differencing',
  options: [
    { id: 'smallest', name: 'Smallest file' },
    { id: 'off', name: 'Off' },
  ],
  default: 'smallest',
};

if (!METHODS.some((e) => e.id === DIFFERENCING_METHOD_ENTRY.id)) {
  registerMethod(DIFFERENCING_METHOD_ENTRY);
}

/** @returns {boolean} Whether opaque gifenc GIFs are frame-differenced now */
export function isFrameDifferencingOn() {
  return getMethod(DIFFERENCING_METHOD_ENTRY.id) !== 'off';
}
