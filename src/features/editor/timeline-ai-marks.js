/**
 * Timeline AI marks: a thin track along the bottom of the timeline's
 * filmstrip that shows which frames the current AI model has analyzed
 * @module features/editor/timeline-ai-marks
 *
 * While an AI subject (Background tab: Anime / Person / Anything) is chosen,
 * each frame of the selection is drawn as analyzed (accent) or not analyzed
 * yet (muted); frames outside the selection stay transparent. The track
 * redraws as the mask store fills, at most once per animation frame.
 *
 * Long clips (thousands of frames) never become per-frame DOM: the frame
 * states are run-length encoded into segments (bucketed per device pixel
 * column when frames are denser than pixels) and painted into one canvas.
 */

import { isAiCutoutActive } from '../../shared/edits/model.js';
import { getSharedMaskStore } from '../ai-cutout/mask-store.js';
import { maskKey } from '../ai-cutout/segmentation-manager.js';
import { getAiModelId } from './ai-cutout.js';

/** @typedef {import('../capture/types.js').Frame} Frame */
/** @typedef {import('../ai-cutout/mask-store.js').MaskStore} MaskStore */

/** State of one frame (or pixel column) on the marks track */
export const AI_MARK = /** @type {const} */ ({ OUTSIDE: 0, PENDING: 1, ANALYZED: 2 });

/**
 * @typedef {Object} MarkRun
 * @property {number} start - First index (inclusive)
 * @property {number} end - Last index (inclusive)
 * @property {number} state - AI_MARK value
 */

/**
 * @typedef {Object} MarkSegment
 * @property {number} x0 - Left edge as a fraction [0, 1] of the track
 * @property {number} x1 - Right edge as a fraction [0, 1] of the track
 * @property {number} state - AI_MARK.PENDING or AI_MARK.ANALYZED
 */

/**
 * Per-frame mark states of a clip for one model
 * @param {Frame[]} frames - The whole clip
 * @param {{ start: number, end: number }} range - Selection (inclusive)
 * @param {(frame: Frame) => boolean} isAnalyzed
 * @returns {{ states: Uint8Array, analyzed: number, selected: number }}
 *   analyzed/selected: frames of the selection
 */
export function computeFrameMarkStates(frames, range, isAnalyzed) {
  const states = new Uint8Array(frames.length);
  const start = Math.max(0, range.start);
  const end = Math.min(frames.length - 1, range.end);
  let analyzed = 0;
  for (let i = start; i <= end; i++) {
    if (isAnalyzed(frames[i])) {
      states[i] = AI_MARK.ANALYZED;
      analyzed++;
    } else {
      states[i] = AI_MARK.PENDING;
    }
  }
  return { states, analyzed, selected: Math.max(0, end - start + 1) };
}

/**
 * Run-length encode states: consecutive equal values become one run
 * @param {ArrayLike<number>} states
 * @returns {MarkRun[]}
 */
export function runLengthEncode(states) {
  /** @type {MarkRun[]} */
  const runs = [];
  for (let i = 0; i < states.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.state === states[i]) {
      last.end = i;
    } else {
      runs.push({ start: i, end: i, state: states[i] });
    }
  }
  return runs;
}

/**
 * Bucket frame states into `columns` pixel columns (frames denser than
 * pixels). A frame spans half a frame either side of its timeline position
 * (`i / (n - 1)`, the playhead's mapping), so every column covers at least
 * one frame. A column is PENDING when any frame it covers still needs
 * analysis, else ANALYZED when any is analyzed, else OUTSIDE.
 * @param {ArrayLike<number>} states - Per-frame AI_MARK values
 * @param {number} columns
 * @returns {Uint8Array}
 */
export function bucketMarkStates(states, columns) {
  const n = states.length;
  const width = Math.max(1, Math.floor(columns));
  const buckets = new Uint8Array(width);
  if (n === 0) return buckets;
  const span = Math.max(1, n - 1);
  for (let c = 0; c < width; c++) {
    const lo = Math.max(0, Math.floor((c / width) * span + 0.5));
    const hi = Math.min(n - 1, Math.max(lo, Math.ceil(((c + 1) / width) * span - 0.5)));
    let state = AI_MARK.OUTSIDE;
    for (let f = lo; f <= hi; f++) {
      if (states[f] === AI_MARK.PENDING) {
        state = AI_MARK.PENDING;
        break;
      }
      if (states[f] === AI_MARK.ANALYZED) state = AI_MARK.ANALYZED;
    }
    buckets[c] = state;
  }
  return buckets;
}

/**
 * Segments to paint: per-frame runs while frames fit the columns, else runs
 * of pixel-column buckets. OUTSIDE runs are left out (transparent).
 * @param {ArrayLike<number>} states - Per-frame AI_MARK values
 * @param {number} columns - Track width in device pixels
 * @returns {MarkSegment[]}
 */
export function computeAiMarkSegments(states, columns) {
  const n = states.length;
  if (n === 0 || columns <= 0) return [];
  /** @type {MarkSegment[]} */
  const segments = [];
  if (n <= columns) {
    const span = n - 1;
    /** @param {number} i */
    const edge = (i) =>
      span === 0 ? (i <= 0 ? 0 : 1) : Math.min(1, Math.max(0, (i - 0.5) / span));
    for (const run of runLengthEncode(states)) {
      if (run.state === AI_MARK.OUTSIDE) continue;
      segments.push({ x0: edge(run.start), x1: edge(run.end + 1), state: run.state });
    }
    return segments;
  }
  const width = Math.max(1, Math.floor(columns));
  for (const run of runLengthEncode(bucketMarkStates(states, width))) {
    if (run.state === AI_MARK.OUTSIDE) continue;
    segments.push({ x0: run.start / width, x1: (run.end + 1) / width, state: run.state });
  }
  return segments;
}

/**
 * Accessible description of the coverage ("34 of 60 frames analyzed")
 * @param {number} analyzed
 * @param {number} selected
 * @returns {string}
 */
export function describeAiMarks(analyzed, selected) {
  return `${analyzed} of ${selected} frame${selected === 1 ? '' : 's'} analyzed`;
}

/**
 * @typedef {Object} AiMarksEditorState
 * @property {{ frames: Frame[] } | null} clip
 * @property {{ start: number, end: number }} selectedRange
 * @property {import('../../shared/edits/model.js').ClipEdits} edits
 */

/**
 * Attach the marks track to a rendered timeline (renderTimeline's
 * `.tl-track`) and keep it in step with the editor state and the mask store
 * @param {HTMLElement} timelineContainer - Holds the rendered timeline
 * @param {{ getState: () => AiMarksEditorState, subscribe: (listener: (state: AiMarksEditorState, prevState: AiMarksEditorState) => void) => () => void, maskStore?: MaskStore }} options
 *   subscribe: editor store changes (only clip, selection and background
 *   changes repaint, so playback ticks cost nothing)
 * @returns {() => void} Cleanup
 */
export function attachTimelineAiMarks(
  timelineContainer,
  { getState, subscribe, maskStore = getSharedMaskStore() },
) {
  const track = timelineContainer.querySelector('.tl-track');
  if (!(track instanceof HTMLElement)) return () => {};

  const holder = document.createElement('div');
  holder.className = 'editor-timeline-ai-marks';
  holder.hidden = true;
  const canvas = document.createElement('canvas');
  canvas.className = 'editor-timeline-ai-marks-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  holder.appendChild(canvas);
  // Above the thumbnails, below the selection dims, handles and playhead
  const filmstrip = track.querySelector('.tl-filmstrip');
  track.insertBefore(holder, filmstrip ? filmstrip.nextSibling : track.firstChild);

  let frameRequest = 0;
  /** Inputs of the last paint: skip identical repaints */
  let lastKey = '';

  const schedule = () => {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      paint();
    });
  };

  function paint() {
    const state = getState();
    const frames = state.clip?.frames;
    const active = Boolean(frames?.length) && isAiCutoutActive(state.edits?.background);
    if (!active || !frames) {
      if (!holder.hidden) {
        holder.hidden = true;
        holder.removeAttribute('aria-description');
        delete holder.dataset.analyzed;
        delete holder.dataset.selected;
      }
      lastKey = '';
      return;
    }
    holder.hidden = false;

    const modelId = getAiModelId(state.edits.background.ai);
    const { states, analyzed, selected } = computeFrameMarkStates(
      frames,
      state.selectedRange,
      (frame) => maskStore.has(maskKey(frame, modelId)),
    );

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = holder.clientWidth;
    const cssHeight = holder.clientHeight;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    const { start, end } = state.selectedRange;
    const key = `${width}x${height}|${modelId}|${start}-${end}|${frames.length}|${analyzed}|${maskStore.version}`;
    if (key === lastKey) return;
    lastKey = key;

    holder.dataset.analyzed = String(analyzed);
    holder.dataset.selected = String(selected);
    holder.setAttribute('aria-description', describeAiMarks(analyzed, selected));

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(holder);
    const colors = {
      [AI_MARK.ANALYZED]:
        styles.getPropertyValue('--editor-timeline-ai-analyzed').trim() || '#22d3ee',
      [AI_MARK.PENDING]:
        styles.getPropertyValue('--editor-timeline-ai-pending').trim() || 'rgba(200,200,200,0.55)',
    };

    // Frame i sits at i / (n - 1) (the playhead's mapping); clip to the
    // selection box so the marks line up with its edges
    const span = Math.max(1, frames.length - 1);
    const clipLeft = frames.length > 1 ? (Math.max(0, start) / span) * width : 0;
    const clipRight = frames.length > 1 ? (Math.min(frames.length - 1, end) / span) * width : width;
    for (const segment of computeAiMarkSegments(states, width)) {
      const x0 = Math.max(clipLeft, segment.x0 * width);
      const x1 = Math.min(clipRight, segment.x1 * width);
      const left = Math.floor(x0);
      const w = Math.max(1, Math.ceil(x1) - left);
      ctx.fillStyle = colors[segment.state];
      ctx.fillRect(left, 0, w, height);
    }
  }

  const unsubscribeStore = subscribe((next, prev) => {
    if (
      next.clip !== prev?.clip ||
      next.selectedRange !== prev?.selectedRange ||
      next.edits?.background !== prev?.edits?.background
    ) {
      schedule();
    }
  });
  const unsubscribeMasks = maskStore.subscribe(schedule);
  /** @type {ResizeObserver | null} */
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (!holder.hidden) schedule();
        })
      : null;
  resizeObserver?.observe(holder);
  // Nothing to draw (and no frame to request) until an AI subject is on
  const initial = getState();
  if (initial.clip?.frames?.length && isAiCutoutActive(initial.edits?.background)) schedule();

  return () => {
    unsubscribeStore();
    unsubscribeMasks();
    resizeObserver?.disconnect();
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = 0;
    holder.remove();
  };
}
