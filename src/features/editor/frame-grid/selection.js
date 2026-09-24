/**
 * Frame Grid Selection Model
 * Pure Start/End (IN/OUT) selection transitions for the frame grid modal.
 * Every transition returns a new selection; nothing here touches the DOM.
 * @module features/editor/frame-grid/selection
 */

import { isFrameInRange } from '../core.js';

/**
 * @typedef {Object} GridSelection
 * @property {number | null} start - Start (IN) frame index
 * @property {number | null} end - End (OUT) frame index; null while only Start is set
 */

/**
 * @typedef {Object} FrameSelectionState
 * @property {boolean} isStart
 * @property {boolean} isEnd
 * @property {boolean} inRange
 * @property {Array<{ variant: 'single' | 'start' | 'end', label: string }>} badges
 */

/**
 * Clamp a frame index into [0, frameCount - 1].
 * @param {number} index
 * @param {number} frameCount
 * @returns {number}
 */
export function clampFrameIndex(index, frameCount) {
  return Math.max(0, Math.min(frameCount - 1, index));
}

/**
 * Set the Start frame. An End that would precede the new Start is cleared.
 * @param {GridSelection} selection
 * @param {number} index
 * @returns {GridSelection}
 */
export function selectStart(selection, index) {
  const end = selection.end !== null && selection.end < index ? null : selection.end;
  return { start: index, end };
}

/**
 * Set the End frame. With no Start, or a Start after the new End, the
 * selection collapses to the single frame (IN=OUT).
 * @param {GridSelection} selection
 * @param {number} index
 * @returns {GridSelection}
 */
export function selectEnd(selection, index) {
  const start = selection.start === null || selection.start > index ? index : selection.start;
  return { start, end: index };
}

/**
 * Plain click sets Start; Shift+click sets End once a Start exists.
 * @param {GridSelection} selection
 * @param {number} index
 * @param {boolean} shiftKey
 * @returns {GridSelection}
 */
export function selectByClick(selection, index, shiftKey) {
  if (shiftKey && selection.start !== null) {
    return selectEnd(selection, index);
  }
  return selectStart(selection, index);
}

/**
 * Select exactly one frame (double-click).
 * @param {number} index
 * @returns {GridSelection}
 */
export function selectSingleFrame(index) {
  return { start: index, end: index };
}

/**
 * Check whether the selection exactly matches a scene.
 * @param {GridSelection} selection
 * @param {{ startFrame: number, endFrame: number }} scene
 * @returns {boolean}
 */
export function isSceneSelected(selection, scene) {
  return selection.start === scene.startFrame && selection.end === scene.endFrame;
}

/**
 * Classes and badges for one grid item under the current selection.
 * @param {number} index
 * @param {GridSelection} selection
 * @returns {FrameSelectionState}
 */
export function getFrameSelectionState(index, selection) {
  const { start, end } = selection;
  const isStart = index === start;
  const isEnd = index === end && end !== null;
  const effectiveEnd = end ?? start;
  const inRange = start !== null && isFrameInRange(index, start, effectiveEnd);

  /** @type {FrameSelectionState['badges']} */
  const badges = [];
  if (isStart && isEnd && start === end) {
    badges.push({ variant: 'single', label: 'IN=OUT' });
  } else {
    if (isStart) badges.push({ variant: 'start', label: 'IN' });
    if (isEnd) badges.push({ variant: 'end', label: 'OUT' });
  }

  return { isStart, isEnd, inRange, badges };
}

/**
 * Get all indices affected by range change
 * @param {number | null} oldStart
 * @param {number | null} oldEnd
 * @param {number | null} newStart
 * @param {number | null} newEnd
 * @returns {Set<number>}
 */
export function getAffectedRangeIndices(oldStart, oldEnd, newStart, newEnd) {
  const affected = new Set();

  // Add old range
  if (oldStart !== null) {
    const oldEffectiveEnd = oldEnd ?? oldStart;
    const min = Math.min(oldStart, oldEffectiveEnd);
    const max = Math.max(oldStart, oldEffectiveEnd);
    for (let i = min; i <= max; i++) {
      affected.add(i);
    }
  }

  // Add new range
  if (newStart !== null) {
    const newEffectiveEnd = newEnd ?? newStart;
    const min = Math.min(newStart, newEffectiveEnd);
    const max = Math.max(newStart, newEffectiveEnd);
    for (let i = min; i <= max; i++) {
      affected.add(i);
    }
  }

  return affected;
}

/**
 * Footer text describing the current selection.
 * @param {GridSelection} selection
 * @returns {string}
 */
export function formatSelectionInfo(selection) {
  const { start, end } = selection;
  if (start === null) {
    return 'Click [S] to set Start, [E] to set End';
  }
  if (end === null) {
    return `Start: Frame ${start + 1} — Click [E] on another frame`;
  }
  const count = Math.abs(end - start) + 1;
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  return `Selection: Frame ${min + 1} → Frame ${max + 1} (${count} frame${count !== 1 ? 's' : ''})`;
}
