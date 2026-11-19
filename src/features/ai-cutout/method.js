/**
 * The cutout switches (Settings → Methods; URL override `?method.<id>=`),
 * task 8 item 5. Each default is the behaviour the app had before the
 * switch existed.
 * - Tracker after a lost frame: keep trying the next frames from the last
 *   frame kept (cutout-ux 5), or stop the pass there
 * - Re-track after a correction: only the span a new point or box can
 *   change (cutout-ux 5), or the whole selection
 * - Click answer: which of the decoder's answers a new click fix-up starts
 *   with: by size (cutout-ux 2: the largest for Keep, the second smallest
 *   for Remove) or scored when the answers arrive (task 7 item 2: Keep by
 *   border agreement with the base mask x score, Remove by stability x
 *   score; see scoredAnswerRank)
 * @module features/ai-cutout/method
 */

import { getMethod, METHODS, registerMethod } from '../../shared/methods.js';

/** @type {import('../../shared/methods.js').MethodEntry} */
export const TRACK_LOST_METHOD_ENTRY = {
  id: 'cutout.track-lost',
  area: 'cutout',
  name: 'Tracker after a lost frame',
  options: [
    { id: 'resume', name: 'Keep trying' },
    { id: 'stop', name: 'Stop there' },
  ],
  default: 'resume',
};

/** @type {import('../../shared/methods.js').MethodEntry} */
export const RETRACK_METHOD_ENTRY = {
  id: 'cutout.retrack',
  area: 'cutout',
  name: 'Re-track after a correction',
  options: [
    { id: 'span', name: 'Only the frames it changes' },
    { id: 'all', name: 'The whole selection' },
  ],
  default: 'span',
};

/** @type {import('../../shared/methods.js').MethodEntry} */
export const CLICK_ANSWER_METHOD_ENTRY = {
  id: 'cutout.click-answer',
  area: 'cutout',
  name: 'Click answer',
  options: [
    { id: 'size', name: 'By size' },
    { id: 'scored', name: 'Scored' },
  ],
  default: 'size',
};

export const CUTOUT_METHOD_ENTRIES = [
  TRACK_LOST_METHOD_ENTRY,
  RETRACK_METHOD_ENTRY,
  CLICK_ANSWER_METHOD_ENTRY,
];

for (const entry of CUTOUT_METHOD_ENTRIES) {
  if (!METHODS.some((e) => e.id === entry.id)) registerMethod(entry);
}

/** @returns {'resume' | 'stop'} What a tracking pass does at a lost frame now */
export function getTrackAfterLost() {
  return getMethod(TRACK_LOST_METHOD_ENTRY.id) === 'stop' ? 'stop' : 'resume';
}

/** @returns {'size' | 'scored'} How a new click fix-up's answer is chosen now */
export function getClickAnswerRule() {
  return getMethod(CLICK_ANSWER_METHOD_ENTRY.id) === 'scored' ? 'scored' : 'size';
}

/** @returns {'span' | 'all'} What a correction re-tracks now */
export function getRetrackScope() {
  return getMethod(RETRACK_METHOD_ENTRY.id) === 'all' ? 'all' : 'span';
}
