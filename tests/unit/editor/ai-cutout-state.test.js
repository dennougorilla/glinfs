/**
 * Editor reducers for the AI cutout: parameters, picks, method switch,
 * pick tool vs eyedropper, runtime status.
 */

import { describe, expect, it } from 'vitest';
import {
  addAiPick,
  clearAiPicks,
  createAiCutoutStatus,
  createEditorStore,
  removeAiPick,
  setAiParams,
  setAiPickTool,
  setBackgroundMethod,
  setPickingKeyColor,
  updateAiCutoutStatus,
} from '../../../src/features/editor/state.js';
import { EDIT_LIMITS } from '../../../src/shared/edits/model.js';

function makeState() {
  const frames = Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}`,
    timestamp: i,
    width: 10,
    height: 10,
  }));
  return createEditorStore(/** @type {any} */ (frames), 30).getState();
}

describe('AI cutout editor state', () => {
  it('starts with no pick tool and an idle status', () => {
    const state = makeState();
    expect(state.aiPickTool).toBeNull();
    expect(state.aiCutout).toEqual(createAiCutoutStatus());
    expect(state.aiCutout).toMatchObject({ phase: 'idle', webgpu: null, maskVersion: 0 });
  });

  it('setAiParams keeps the other AI fields (the ai object is replaced as a whole)', () => {
    let state = makeState();
    state = addAiPick(state, { frame: 2, x: 0.5, y: 0.5, mode: 'keep' });
    state = setAiParams(state, { threshold: 0.7 });
    state = setAiParams(state, { edge: 3, smoothing: false });
    expect(state.edits.background.ai).toEqual({
      threshold: 0.7,
      smoothing: false,
      edge: 3,
      picks: [{ frame: 2, x: 0.5, y: 0.5, mode: 'keep' }],
    });
    // Mirrored into the clip like every edit
    expect(state.clip?.edits).toBe(state.edits);
  });

  it('clamps parameters through normalization', () => {
    const state = setAiParams(makeState(), { threshold: 2, edge: -20 });
    expect(state.edits.background.ai.threshold).toBe(EDIT_LIMITS.aiThreshold.max);
    expect(state.edits.background.ai.edge).toBe(EDIT_LIMITS.aiEdge.min);
  });

  it('adds picks up to the limit, removes one, clears all', () => {
    let state = makeState();
    for (let i = 0; i < EDIT_LIMITS.aiPicks.max + 2; i++) {
      state = addAiPick(state, { frame: 1, x: i / 100, y: 0.1, mode: i % 2 ? 'remove' : 'keep' });
    }
    expect(state.edits.background.ai.picks).toHaveLength(EDIT_LIMITS.aiPicks.max);
    const full = state;
    expect(addAiPick(full, { frame: 0, x: 0, y: 0, mode: 'keep' })).toBe(full);

    state = removeAiPick(state, 1);
    expect(state.edits.background.ai.picks).toHaveLength(EDIT_LIMITS.aiPicks.max - 1);
    expect(state.edits.background.ai.picks[1].x).toBe(0.02);
    expect(removeAiPick(state, 99)).toBe(state);
    expect(removeAiPick(state, -1)).toBe(state);

    state = clearAiPicks(state);
    expect(state.edits.background.ai.picks).toEqual([]);
    expect(clearAiPicks(state)).toBe(state);
  });

  it('choosing the AI method turns removal on and leaves the eyedropper', () => {
    let state = setPickingKeyColor(makeState(), true);
    state = setBackgroundMethod(state, 'ai');
    expect(state.edits.background).toMatchObject({ method: 'ai', enabled: true });
    expect(state.pickingKeyColor).toBe(false);
    // The color key's color is untouched
    expect(state.edits.background.color).toBe('#00ff00');
    expect(state.edits.background.colorChosen).toBe(false);
  });

  it('choosing Color keeps the switch, uses a detected color and leaves the pick tool', () => {
    let state = setAiPickTool(setBackgroundMethod(makeState(), 'ai'), 'keep');
    state = setBackgroundMethod(state, 'color', '#112233');
    expect(state.edits.background).toMatchObject({
      method: 'color',
      enabled: true,
      color: '#112233',
      colorChosen: true,
    });
    expect(state.aiPickTool).toBeNull();

    const plain = setBackgroundMethod(setBackgroundMethod(makeState(), 'ai'), 'color');
    expect(plain.edits.background.color).toBe('#00ff00');
    expect(plain.edits.background.colorChosen).toBe(false);
  });

  it('a pick tool and the eyedropper exclude each other', () => {
    let state = setPickingKeyColor(makeState(), true);
    state = setAiPickTool(state, 'remove');
    expect(state).toMatchObject({ aiPickTool: 'remove', pickingKeyColor: false });
    expect(setAiPickTool(state, 'remove')).toBe(state);
    state = setPickingKeyColor(state, true);
    expect(state).toMatchObject({ aiPickTool: null, pickingKeyColor: true });
    // Leaving a tool leaves the eyedropper alone
    expect(setAiPickTool(state, null).pickingKeyColor).toBe(true);
  });

  it('updateAiCutoutStatus merges and keeps identity when nothing changes', () => {
    const state = makeState();
    const next = updateAiCutoutStatus(state, { phase: 'analyzing', framesDone: 1 });
    expect(next.aiCutout).toMatchObject({ phase: 'analyzing', framesDone: 1, webgpu: null });
    expect(updateAiCutoutStatus(next, { phase: 'analyzing', framesDone: 1 })).toBe(next);
    // A state without the slice (older test fixtures) gets the defaults
    const bare = /** @type {any} */ ({ ...state, aiCutout: undefined });
    expect(updateAiCutoutStatus(bare, { notice: 'x' }).aiCutout).toMatchObject({
      phase: 'idle',
      notice: 'x',
    });
  });
});
