/**
 * The scene detection switch (Settings → Methods). Main thread only: the
 * worker gets the choice in the DETECT options.
 * @module features/scene-detection/method
 */

import { getMethod, METHODS, registerMethod } from '../../shared/methods.js';
import { SCENE_METHOD_DEFAULT } from './algorithms/scene-breaks.js';

/** @type {import('../../shared/methods.js').MethodEntry} */
export const SCENE_METHOD_ENTRY = {
  id: 'scenes',
  area: 'scenes',
  name: 'Scene detection',
  options: [
    { id: 'combined', name: 'Colour and shape' },
    { id: 'fixed', name: 'Fixed threshold' },
    { id: 'adaptive', name: 'Adaptive threshold' },
    { id: 'hash', name: 'Shape only' },
  ],
  default: SCENE_METHOD_DEFAULT,
};

if (!METHODS.some((e) => e.id === SCENE_METHOD_ENTRY.id)) registerMethod(SCENE_METHOD_ENTRY);

/**
 * The scene method in effect now (URL override, else Settings, else default)
 * @returns {string} An option id of SCENE_METHOD_ENTRY
 */
export function getSceneMethod() {
  return getMethod(SCENE_METHOD_ENTRY.id);
}
