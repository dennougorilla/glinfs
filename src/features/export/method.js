/**
 * The frame differencing switch (Settings → Methods), PR #209:
 * - smallest: each opaque frame is encoded whole and differenced, and the
 *   smaller one is written (the GIF is never larger than without it)
 * - off: every frame whole, as before #209 (fastest)
 *
 * The dither pattern switch, used when the export's Dithering box is on:
 * - bayer: an 8x8 cross-hatch (smaller GIF)
 * - blue-noise: a 64x64 irregular grain, no visible period (about 25 %
 *   larger at the same banding)
 *
 * The cutout edge switch, how a transparent GIF turns soft alpha into its
 * 1-bit transparency:
 * - threshold: kept where alpha >= 128 (as before)
 * - dither: a blue-noise stipple whose density follows alpha
 * - matte-white / matte-black: the edge blended into the page color first
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

/** @type {import('../../shared/methods.js').MethodEntry} */
export const DITHER_METHOD_ENTRY = {
  id: 'gif.dither',
  area: 'export',
  name: 'Dither pattern',
  options: [
    { id: 'bayer', name: 'Bayer' },
    { id: 'blue-noise', name: 'Blue noise' },
  ],
  default: 'bayer',
};

/** @type {import('../../shared/methods.js').MethodEntry} */
export const EDGE_METHOD_ENTRY = {
  id: 'gif.edge',
  area: 'export',
  name: 'Cutout edge',
  options: [
    { id: 'threshold', name: 'Hard' },
    { id: 'dither', name: 'Dithered' },
    { id: 'matte-white', name: 'White matte' },
    { id: 'matte-black', name: 'Black matte' },
  ],
  default: 'threshold',
};

for (const entry of [DIFFERENCING_METHOD_ENTRY, DITHER_METHOD_ENTRY, EDGE_METHOD_ENTRY]) {
  if (!METHODS.some((e) => e.id === entry.id)) registerMethod(entry);
}

/** @returns {boolean} Whether opaque gifenc GIFs are frame-differenced now */
export function isFrameDifferencingOn() {
  return getMethod(DIFFERENCING_METHOD_ENTRY.id) !== 'off';
}

/** @returns {'bayer' | 'blue-noise'} The dither pattern chosen now */
export function getDitherPattern() {
  return getMethod(DITHER_METHOD_ENTRY.id) === 'blue-noise' ? 'blue-noise' : 'bayer';
}

/** Matte colors of the cutout edge options */
const MATTES = /** @type {const} */ ({
  'matte-white': [255, 255, 255],
  'matte-black': [0, 0, 0],
});

/**
 * The cutout edge chosen now, as encoder config
 * @returns {{ edge: 'threshold' | 'dither' | 'matte', matteColor?: number[] }}
 */
export function getCutoutEdge() {
  const id = getMethod(EDGE_METHOD_ENTRY.id);
  if (id === 'dither') return { edge: 'dither' };
  if (id === 'matte-white' || id === 'matte-black') {
    return { edge: 'matte', matteColor: [...MATTES[id]] };
  }
  return { edge: 'threshold' };
}
