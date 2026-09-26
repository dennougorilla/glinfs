/**
 * Editor reducers for the mask brush: the brush tool (validation, only
 * while removal is on, one preview tool at a time), stroke ranges, and
 * adding / undoing / clearing strokes.
 */

import { describe, expect, it } from 'vitest';
import {
  addTouchUp,
  canClearTouchUpsOnFrame,
  clearAllTouchUps,
  clearTouchUpsOnFrame,
  createBrushState,
  createEditorStore,
  getBrushStrokeRange,
  setAiPickTool,
  setBackground,
  setBrush,
  setPickingKeyColor,
  undoTouchUp,
  updateRange,
} from '../../../src/features/editor/state.js';
import { DEFAULT_TOUCH_UP_RADIUS, EDIT_LIMITS } from '../../../src/shared/edits/model.js';
import { removeTouchUpsFromFrame } from '../../../src/shared/edits/touch-ups.js';

function makeState({ removal = true } = {}) {
  const frames = Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}`,
    timestamp: i,
    width: 10,
    height: 10,
  }));
  const state = createEditorStore(/** @type {any} */ (frames), 30).getState();
  return removal ? setBackground(state, { enabled: true }) : state;
}

/**
 * @param {string} id
 * @param {number} start
 * @param {number} end
 * @param {'erase' | 'restore'} [mode]
 */
function stroke(id, start, end, mode = 'erase') {
  return {
    id,
    mode,
    radius: 0.05,
    points: [{ x: 0.5, y: 0.5 }],
    start,
    end,
  };
}

describe('brush tool', () => {
  it('starts off, erasing, at the default size, one frame per stroke', () => {
    expect(makeState().brush).toEqual({
      on: false,
      mode: 'erase',
      radius: DEFAULT_TOUCH_UP_RADIUS,
      scope: 'frame',
    });
    expect(createBrushState()).not.toBe(createBrushState());
  });

  it('validates mode, radius and scope and keeps identity when nothing changes', () => {
    const state = makeState();
    const next = setBrush(state, { mode: 'restore', radius: 5, scope: 'selection' });
    expect(next.brush).toMatchObject({
      mode: 'restore',
      radius: EDIT_LIMITS.touchUpRadius.max,
      scope: 'selection',
    });
    const ignored = setBrush(
      next,
      /** @type {any} */ ({ mode: 'paint', scope: 'all', radius: 'x' }),
    );
    expect(ignored).toBe(next);
    expect(setBrush(next, { radius: 0 }).brush.radius).toBe(EDIT_LIMITS.touchUpRadius.min);
  });

  it('turns on only while background removal is on', () => {
    const off = makeState({ removal: false });
    expect(setBrush(off, { on: true })).toBe(off);
    const on = setBrush(makeState(), { on: true });
    expect(on.brush.on).toBe(true);
  });

  it('turning removal off leaves the brush (the strokes stay)', () => {
    let state = setBrush(makeState(), { on: true });
    state = addTouchUp(state, stroke('a', 0, 0));
    state = setBackground(state, { enabled: false });
    expect(state.brush.on).toBe(false);
    expect(state.edits.touchUps).toHaveLength(1);
  });

  it('is exclusive with the pick tools and the eyedropper', () => {
    let state = makeState();
    state = setPickingKeyColor(state, true);
    state = setBrush(state, { on: true });
    expect(state).toMatchObject({ pickingKeyColor: false, aiPickTool: null });
    expect(state.brush.on).toBe(true);

    state = setAiPickTool(state, 'keep');
    expect(state.brush.on).toBe(false);
    state = setBrush(state, { on: true });
    expect(state.aiPickTool).toBeNull();

    state = setPickingKeyColor(state, true);
    expect(state.brush.on).toBe(false);
  });

  it('a stroke applies to the current frame or the IN..OUT selection', () => {
    let state = updateRange(makeState(), { start: 1, end: 4 });
    state = { ...state, currentFrame: 3 };
    expect(getBrushStrokeRange(state)).toEqual({ start: 3, end: 3 });
    state = setBrush(state, { scope: 'selection' });
    expect(getBrushStrokeRange(state)).toEqual({ start: 1, end: 4 });
  });
});

describe('strokes', () => {
  it('adds strokes up to the limit and undoes the last one', () => {
    let state = makeState();
    state = addTouchUp(state, stroke('a', 0, 0));
    state = addTouchUp(state, stroke('b', 1, 2, 'restore'));
    expect(state.edits.touchUps.map((s) => s.id)).toEqual(['a', 'b']);
    // Mirrored into the clip like every edit
    expect(state.clip?.edits?.touchUps).toBe(state.edits.touchUps);
    state = undoTouchUp(state);
    expect(state.edits.touchUps.map((s) => s.id)).toEqual(['a']);
    expect(undoTouchUp(undoTouchUp(state)).edits.touchUps).toEqual([]);
    const empty = undoTouchUp(state);
    expect(undoTouchUp(empty)).toBe(empty);

    let full = makeState();
    full = {
      ...full,
      edits: {
        ...full.edits,
        touchUps: Array.from({ length: EDIT_LIMITS.touchUps.max }, (_, i) => stroke(`s${i}`, 0, 0)),
      },
    };
    expect(addTouchUp(full, stroke('over', 0, 0))).toBe(full);
  });

  it('clear on this frame changes only that frame; clear all removes everything', () => {
    let state = makeState();
    state = addTouchUp(state, stroke('only', 2, 2));
    state = addTouchUp(state, stroke('span', 0, 5, 'restore'));
    state = addTouchUp(state, stroke('other', 4, 5));

    const cleared = clearTouchUpsOnFrame(state, 2);
    expect(cleared.edits.touchUps.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [3, 5],
      [4, 5],
    ]);
    // The split keeps the paint order and gives the second part its own id
    expect(cleared.edits.touchUps[0].id).toBe('span');
    expect(cleared.edits.touchUps[1].id).not.toBe('span');
    expect(cleared.edits.touchUps[1].mode).toBe('restore');

    // No stroke on the frame: unchanged
    const none = clearTouchUpsOnFrame(clearTouchUpsOnFrame(state, 3), 3);
    expect(clearTouchUpsOnFrame(none, 3)).toBe(none);

    const all = clearAllTouchUps(state);
    expect(all.edits.touchUps).toEqual([]);
    expect(clearAllTouchUps(all)).toBe(all);
  });

  it('refuses a clear whose split would pass the stroke limit', () => {
    let state = makeState();
    state = {
      ...state,
      edits: {
        ...state.edits,
        touchUps: Array.from({ length: EDIT_LIMITS.touchUps.max }, (_, i) => stroke(`s${i}`, 0, 5)),
      },
    };
    expect(canClearTouchUpsOnFrame(state, 2)).toBe(false);
    expect(clearTouchUpsOnFrame(state, 2)).toBe(state);
    // At an end of the range the strokes only shrink
    expect(canClearTouchUpsOnFrame(state, 0)).toBe(true);
    expect(clearTouchUpsOnFrame(state, 0).edits.touchUps[0]).toMatchObject({ start: 1, end: 5 });
  });
});

describe('removeTouchUpsFromFrame', () => {
  it('drops, shrinks or splits strokes covering the frame and leaves the others', () => {
    let n = 0;
    const out = removeTouchUpsFromFrame(
      [
        stroke('a', 3, 3),
        stroke('b', 3, 5),
        stroke('c', 1, 3),
        stroke('d', 1, 5),
        stroke('e', 4, 5),
      ],
      3,
      () => `new${++n}`,
    );
    expect(out.map((s) => `${s.id}:${s.start}-${s.end}`)).toEqual([
      'b:4-5',
      'c:1-2',
      'd:1-2',
      'new1:4-5',
      'e:4-5',
    ]);
  });
});
