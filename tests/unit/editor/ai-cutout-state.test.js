/**
 * Editor reducers for the AI cutout: parameters, picks, method switch,
 * pick tool vs eyedropper, runtime status.
 */

import { describe, expect, it } from 'vitest';
import {
  addAiObject,
  addAiObjectBox,
  addAiObjectClick,
  addAiPick,
  clearAiPicks,
  createAiCutoutStatus,
  createEditorStore,
  getActiveAiObject,
  getObjectTool,
  PICK_NEEDS_ANALYSIS_NOTICE,
  PICK_NO_CHARACTER_NOTICE,
  removeAiObject,
  removeAiPick,
  setActiveAiObject,
  setAiObjectCandidate,
  setAiObjectScope,
  setAiObjectTolerance,
  setAiParams,
  setAiPickTool,
  setAiRemoveScope,
  setBackgroundMethod,
  setBrush,
  setPickingKeyColor,
  updateAiCutoutStatus,
} from '../../../src/features/editor/state.js';
import {
  DEFAULT_OBJECT_CANDIDATE,
  EDIT_LIMITS,
  normalizeEdits,
  OBJECT_CANDIDATES,
} from '../../../src/shared/edits/model.js';

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
      model: 'anime',
      threshold: 0.7,
      smoothing: false,
      edge: 3,
      clickScope: 'whole',
      objects: [],
      cleanup: { minIslandArea: 0, maxHoleArea: 0 },
      subject: null,
      picks: [{ frame: 2, x: 0.5, y: 0.5, mode: 'keep' }],
    });
    // Mirrored into the clip like every edit
    expect(state.clip?.edits).toBe(state.edits);
  });

  it('switching the model keeps the parameters and the picks', () => {
    let state = makeState();
    state = addAiPick(state, { frame: 2, x: 0.5, y: 0.5, mode: 'keep' });
    state = setAiParams(state, { threshold: 0.7 });
    state = setAiParams(state, { model: 'general' });
    expect(state.edits.background.ai).toMatchObject({
      model: 'general',
      threshold: 0.7,
      picks: [{ frame: 2, x: 0.5, y: 0.5, mode: 'keep' }],
    });
    expect(state.clip?.edits.background.ai.model).toBe('general');
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

  it('leaving the pick tool or taking the eyedropper ends a refused-pick notice, not others', () => {
    for (const notice of [PICK_NEEDS_ANALYSIS_NOTICE, PICK_NO_CHARACTER_NOTICE]) {
      const refused = updateAiCutoutStatus(setAiPickTool(makeState(), 'keep'), { notice });
      expect(setAiPickTool(refused, null).aiCutout.notice).toBe('');
      expect(setPickingKeyColor(refused, true).aiCutout.notice).toBe('');
    }
    const outcome = updateAiCutoutStatus(setAiPickTool(makeState(), 'keep'), {
      notice: 'Analyzed 3 frames.',
    });
    expect(setAiPickTool(outcome, null).aiCutout.notice).toBe('Analyzed 3 frames.');
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

describe('tracked objects', () => {
  const click = (frame = 1) => ({ frame, x: 0.6, y: 0.4, mode: /** @type {const} */ ('keep') });
  const box = (frame = 2) => ({ frame, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.5 });

  it('adds an object from a click or a box, not selected, keeping the largest answer (cutout-ux 2)', () => {
    let state = addAiObject(makeState(), 'remove', { click: { ...click(), mode: 'remove' } }, 'o1');
    state = addAiObject(state, 'add', { box: box() }, 'o2');
    expect(state.edits.background.ai.objects).toEqual([
      {
        id: 'o1',
        mode: 'remove',
        scope: 'whole',
        // A Remove click: the second smallest answer (the larger ones hold the subject)
        candidate: 1,
        clicks: [click()],
        boxes: [],
        tolerance: 32,
      },
      {
        id: 'o2',
        mode: 'add',
        scope: 'whole',
        candidate: DEFAULT_OBJECT_CANDIDATE,
        clicks: [],
        boxes: [box()],
        tolerance: 32,
      },
    ]);
    // The next click of a tool adds another fix-up
    expect(state.aiActiveObjectId).toBeNull();
    // Whole / Part falls back to the last one
    expect(getActiveAiObject(state)?.id).toBe('o2');
    expect(addAiObject(state, 'add', {})).toBe(state);
    expect(
      addAiObject(state, 'remove', { box: box() }, 'o3').edits.background.ai.objects[2].scope,
    ).toBe('whole');
    expect(
      addAiObject(state, 'add', { click: click() }, 'o4').edits.background.ai.objects[2].scope,
    ).toBe('whole');
  });

  it('stops at the object, click and box limits', () => {
    let state = makeState();
    for (let i = 0; i < EDIT_LIMITS.aiObjects.max + 1; i++) {
      state = addAiObject(state, 'add', { click: click() }, `o${i}`);
    }
    expect(state.edits.background.ai.objects).toHaveLength(EDIT_LIMITS.aiObjects.max);
    for (let i = 0; i < EDIT_LIMITS.aiObjectClicks.max + 1; i++) {
      state = addAiObjectClick(state, 'o0', click(i % 6));
    }
    expect(state.edits.background.ai.objects[0].clicks).toHaveLength(
      EDIT_LIMITS.aiObjectClicks.max,
    );
    for (let i = 0; i < EDIT_LIMITS.aiObjectBoxes.max + 1; i++) {
      state = addAiObjectBox(state, 'o1', box(2));
    }
    // Boxes add up, also on one frame
    expect(state.edits.background.ai.objects[1].boxes).toHaveLength(EDIT_LIMITS.aiObjectBoxes.max);
    expect(state.aiActiveObjectId).toBe('o0');
  });

  it('sets the scope of one object and ignores unknown ids', () => {
    let state = addAiObject(makeState(), 'remove', { click: click() }, 'o1');
    state = addAiObject(state, 'add', { click: click() }, 'o2');
    const before = state;
    expect(setAiObjectScope(state, 'nope', 'part')).toBe(before);
    state = setAiObjectScope(state, 'o1', 'whole');
    expect(state.edits.background.ai.objects.map((o) => o.scope)).toEqual(['whole', 'whole']);
  });

  it('removes an object; the selected one takes its correction tool with it', () => {
    let state = addAiObject(makeState(), 'remove', { click: click() }, 'o1');
    state = addAiObject(state, 'remove', { click: click() }, 'o2');
    state = setAiPickTool(setActiveAiObject(state, 'o1'), 'remove');
    state = removeAiObject(state, 'o2');
    expect(state.aiPickTool).toBe('remove');
    expect(state.aiActiveObjectId).toBe('o1');
    state = removeAiObject(state, 'o1');
    expect(state.edits.background.ai.objects).toEqual([]);
    expect(state.aiPickTool).toBeNull();
    expect(state.aiActiveObjectId).toBeNull();
  });

  it('Brush and the eyedropper deselect the object too (review #195)', () => {
    const enabled = {
      ...makeState(),
      edits: {
        ...makeState().edits,
        background: { ...makeState().edits.background, enabled: true },
      },
    };
    let state = addAiObject(enabled, 'remove', { click: click() }, 'o1');
    state = setAiPickTool(setActiveAiObject(state, 'o1'), 'remove');
    const brushed = setBrush(state, { on: true });
    expect(brushed.brush.on).toBe(true);
    expect(brushed.aiActiveObjectId).toBeNull();
    // Brush off again, then Remove: a new fix-up, not a point on o1
    expect(setAiPickTool(setBrush(brushed, { on: false }), 'remove').aiActiveObjectId).toBeNull();
    const picking = setPickingKeyColor(state, true);
    expect(picking.aiPickTool).toBeNull();
    expect(picking.aiActiveObjectId).toBeNull();
  });

  it('leaving the tool deselects the object; its own tool is Remove or Keep', () => {
    let state = addAiObject(makeState(), 'add', { click: click() }, 'o1');
    state = setAiPickTool(setActiveAiObject(state, 'o1'), 'keep');
    expect(setAiPickTool(state, 'remove').aiActiveObjectId).toBe('o1');
    state = setAiPickTool(state, null);
    expect(state.aiActiveObjectId).toBeNull();
    const [object] = state.edits.background.ai.objects;
    expect(getObjectTool(object)).toBe('keep');
    expect(getObjectTool({ ...object, mode: 'remove' })).toBe('remove');
  });
});

describe('Colour fix-ups', () => {
  const click = { frame: 1, x: 0.6, y: 0.4, mode: /** @type {const} */ ('keep') };

  it('Colour is a scope of Remove fix-ups only, with a clamped whole tolerance', () => {
    let state = addAiObject(makeState(), 'remove', { click }, 'r');
    state = addAiObject(state, 'add', { click }, 'a');
    state = setAiObjectScope(state, 'r', 'colour');
    expect(setAiObjectScope(state, 'a', 'colour')).toBe(state);
    expect(state.edits.background.ai.objects[0]).toMatchObject({ scope: 'colour', tolerance: 32 });
    state = setAiObjectTolerance(state, 'r', 47.4);
    expect(state.edits.background.ai.objects[0].tolerance).toBe(47);
    expect(setAiObjectTolerance(state, 'r', 500).edits.background.ai.objects[0].tolerance).toBe(96);
    expect(setAiObjectTolerance(state, 'r', 47)).toBe(state);
    // Back to Part keeps the tolerance for later
    state = setAiObjectScope(state, 'r', 'part');
    expect(state.edits.background.ai.objects[0]).toMatchObject({ scope: 'part', tolerance: 47 });
  });

  it('refuses Colour for a fix-up with no point to sample (a box alone; review r3)', () => {
    const box = { frame: 1, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 };
    let state = addAiObject(makeState(), 'remove', { box }, 'b');
    expect(setAiObjectScope(state, 'b', 'colour')).toBe(state);
    // A protect point alone samples nothing to remove either
    state = addAiObjectClick(state, 'b', { frame: 1, x: 0.2, y: 0.2, mode: 'remove' });
    expect(setAiObjectScope(state, 'b', 'colour')).toBe(state);
    expect(state.aiRemoveScope).toBe('part');
    // With a point on what to remove it can be Colour
    state = addAiObjectClick(state, 'b', { frame: 1, x: 0.25, y: 0.25, mode: 'keep' });
    state = setAiObjectScope(state, 'b', 'colour');
    expect(state.edits.background.ai.objects[0].scope).toBe('colour');
  });

  it('the next Remove fix-up starts in the scope chosen last (Colour: never tracked first)', () => {
    let state = makeState();
    expect(state.aiRemoveScope).toBe('part');
    state = addAiObject(state, 'remove', { click }, 'r1');
    state = setAiObjectScope(state, 'r1', 'colour');
    expect(state.aiRemoveScope).toBe('colour');
    state = addAiObject(state, 'remove', { click }, 'r2');
    expect(state.edits.background.ai.objects[1].scope).toBe('colour');
    // An Add fix-up's scope is not remembered, and an Add never starts in Colour
    state = addAiObject(state, 'add', { click }, 'a');
    expect(state.edits.background.ai.objects[2].scope).toBe('whole');
    state = setAiObjectScope(state, 'a', 'part');
    expect(state.aiRemoveScope).toBe('colour');
    // A box is Whole: Colour needs points
    const box = { frame: 1, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 };
    state = addAiObject(state, 'remove', { box }, 'b');
    expect(state.edits.background.ai.objects[3].scope).toBe('whole');
    // Restored from the user setting; unknown values are ignored
    const restored = setAiRemoveScope(makeState(), 'whole');
    expect(restored.aiRemoveScope).toBe('whole');
    expect(setAiRemoveScope(restored, 'everything')).toBe(restored);
  });

  it('a Colour fix-up takes keep (sample) and remove (protect) points like a tracked one', () => {
    let state = addAiObject(makeState(), 'remove', { click }, 'r');
    state = setAiObjectScope(state, 'r', 'colour');
    state = addAiObjectClick(state, 'r', { frame: 3, x: 0.2, y: 0.2, mode: 'keep' });
    state = addAiObjectClick(state, 'r', { frame: 3, x: 0.7, y: 0.1, mode: 'remove' });
    expect(state.edits.background.ai.objects[0].clicks.map((c) => c.mode)).toEqual([
      'keep',
      'keep',
      'remove',
    ]);
    expect(removeAiObject(state, 'r').edits.background.ai.objects).toEqual([]);
  });
});

describe('picking among the answers (cutout-ux 2)', () => {
  const click = (frame = 1) => ({ frame, x: 0.6, y: 0.4, mode: /** @type {const} */ ('keep') });
  it('stores the pick as a rank that survives normalization (reload, export); old Part edits read as before', () => {
    let state = addAiObject(makeState(), 'remove', { click: click() }, 'o1');
    state = setAiObjectCandidate(state, 'o1', 1);
    expect(state.edits.background.ai.objects[0]).toMatchObject({ candidate: 1, scope: 'whole' });
    const saved = JSON.parse(JSON.stringify(state.edits));
    expect(normalizeEdits(saved, 10).background.ai.objects[0].candidate).toBe(1);
    // Clamped to the answers there are
    expect(setAiObjectCandidate(state, 'o1', 9).edits.background.ai.objects[0].candidate).toBe(
      OBJECT_CANDIDATES - 1,
    );
    // An edit from before the picker: no candidate, Part kept
    const old = normalizeEdits(
      {
        background: {
          enabled: true,
          method: 'ai',
          ai: { objects: [{ id: 'x', mode: 'remove', scope: 'part', clicks: [click()] }] },
        },
      },
      10,
    );
    expect(old.background.ai.objects[0].scope).toBe('part');
    expect('candidate' in old.background.ai.objects[0]).toBe(false);
  });
});
