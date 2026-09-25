/**
 * Editor state reducers for clip edits (text layers, background removal)
 */

import { describe, expect, it } from 'vitest';
import { createClip } from '../../../src/features/editor/core.js';
import {
  addTextLayer,
  createEditorStore,
  createEditorStoreFromClip,
  initEditorState,
  moveTextLayer,
  removeTextLayer,
  selectTextLayer,
  setBackground,
  setEdits,
  setPickingKeyColor,
  updateRange,
  updateTextLayer,
} from '../../../src/features/editor/state.js';

/** @param {number} count */
function frames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    frame: null,
    timestamp: i,
    width: 100,
    height: 50,
  }));
}

function freshState(count = 10) {
  return initEditorState(createClip(/** @type {any} */ (frames(count)), 30));
}

describe('createClip with edits', () => {
  it('defaults to no edits and no alpha', () => {
    const clip = createClip(/** @type {any} */ (frames(3)), 30);
    expect(clip.hasAlpha).toBe(false);
    expect(clip.edits).toEqual({
      textLayers: [],
      background: {
        enabled: false,
        color: '#00ff00',
        tolerance: 20,
        mode: 'connected',
        colorChosen: false,
      },
    });
  });

  it('normalizes the edits it is given against the clip length', () => {
    const clip = createClip(/** @type {any} */ (frames(4)), 30, {
      hasAlpha: 1,
      edits: { textLayers: [{ id: 'a', text: 'x', end: 50 }], background: { enabled: true } },
    });
    expect(clip.hasAlpha).toBe(true);
    expect(clip.edits.textLayers[0]).toMatchObject({ id: 'a', start: 0, end: 3 });
    expect(clip.edits.background.enabled).toBe(true);
  });
});

describe('initEditorState', () => {
  it('starts with the clip edits, nothing selected, eyedropper off', () => {
    const state = freshState();
    expect(state.edits).toBe(state.clip?.edits);
    expect(state.selectedTextId).toBeNull();
    expect(state.pickingKeyColor).toBe(false);
  });

  it('falls back to default edits for a clip without them', () => {
    const clip = { ...createClip(/** @type {any} */ (frames(2)), 30) };
    delete clip.edits;
    expect(initEditorState(clip).edits.textLayers).toEqual([]);
  });
});

describe('text layer reducers', () => {
  it('addTextLayer spans the current selection and selects the new layer', () => {
    const state = addTextLayer(updateRange(freshState(), { start: 2, end: 6 }));
    expect(state.edits.textLayers).toHaveLength(1);
    const [layer] = state.edits.textLayers;
    expect(layer).toMatchObject({ text: 'Your text', start: 2, end: 6, x: 0.5, y: 0.85 });
    expect(state.selectedTextId).toBe(layer.id);
    // Mirrored into the clip (export and return-from-export read it there)
    expect(state.clip?.edits).toBe(state.edits);
  });

  it('addTextLayer accepts partial overrides', () => {
    const state = addTextLayer(freshState(), { text: 'Hi', color: '#FF0000' });
    expect(state.edits.textLayers[0]).toMatchObject({ text: 'Hi', color: '#ff0000' });
  });

  it('updateTextLayer patches one layer and clamps values', () => {
    let state = addTextLayer(freshState());
    state = addTextLayer(state);
    const [first, second] = state.edits.textLayers;
    state = updateTextLayer(state, first.id, { text: 'New', size: 9, id: 'hijack' });
    expect(state.edits.textLayers[0]).toMatchObject({ id: first.id, text: 'New', size: 0.5 });
    expect(state.edits.textLayers[1].text).toBe(second.text);
    expect(state.clip?.edits).toBe(state.edits);
  });

  it('updateTextLayer ignores unknown ids', () => {
    const state = addTextLayer(freshState());
    expect(updateTextLayer(state, 'nope', { text: 'x' })).toBe(state);
  });

  it('an end before the start follows the start', () => {
    let state = addTextLayer(freshState());
    const { id } = state.edits.textLayers[0];
    state = updateTextLayer(state, id, { start: 7, end: 3 });
    expect(state.edits.textLayers[0]).toMatchObject({ start: 7, end: 7 });
  });

  it('moveTextLayer clamps the position to the output', () => {
    let state = addTextLayer(freshState());
    const { id } = state.edits.textLayers[0];
    state = moveTextLayer(state, id, 1.4, -0.2);
    expect(state.edits.textLayers[0]).toMatchObject({ x: 1, y: 0 });
    state = moveTextLayer(state, id, 0.25, 0.75);
    expect(state.edits.textLayers[0]).toMatchObject({ x: 0.25, y: 0.75 });
  });

  it('removeTextLayer drops the layer and its selection', () => {
    let state = addTextLayer(freshState());
    const { id } = state.edits.textLayers[0];
    state = removeTextLayer(state, id);
    expect(state.edits.textLayers).toEqual([]);
    expect(state.selectedTextId).toBeNull();
    expect(removeTextLayer(state, id)).toBe(state);
  });

  it('removing another layer keeps the selection', () => {
    let state = addTextLayer(freshState());
    const firstId = state.edits.textLayers[0].id;
    state = addTextLayer(state);
    const secondId = state.edits.textLayers[1].id;
    state = removeTextLayer(state, firstId);
    expect(state.selectedTextId).toBe(secondId);
  });

  it('selectTextLayer selects known layers only', () => {
    let state = addTextLayer(freshState());
    const { id } = state.edits.textLayers[0];
    state = selectTextLayer(state, null);
    expect(state.selectedTextId).toBeNull();
    expect(selectTextLayer(state, null)).toBe(state);
    state = selectTextLayer(state, id);
    expect(state.selectedTextId).toBe(id);
    expect(selectTextLayer(state, 'unknown').selectedTextId).toBeNull();
  });
});

describe('background reducers', () => {
  it('setBackground patches and validates the settings', () => {
    let state = setBackground(freshState(), { enabled: true, color: '#ABCDEF', tolerance: 250 });
    expect(state.edits.background).toEqual({
      enabled: true,
      color: '#abcdef',
      tolerance: 100,
      mode: 'connected',
      colorChosen: true,
    });
    state = setBackground(state, { mode: 'global', color: 'bad' });
    expect(state.edits.background).toMatchObject({ mode: 'global', color: '#00ff00' });
    expect(state.clip?.edits).toBe(state.edits);
  });

  it('setBackground marks a set color as chosen, even the default one', () => {
    let state = setBackground(freshState(), { enabled: true, tolerance: 30 });
    expect(state.edits.background.colorChosen).toBe(false);
    state = setBackground(freshState(), { color: '#00ff00' });
    expect(state.edits.background).toMatchObject({ color: '#00ff00', colorChosen: true });
    // Later patches without a color keep it chosen
    state = setBackground(state, { enabled: false });
    expect(state.edits.background.colorChosen).toBe(true);
  });

  it('setPickingKeyColor toggles eyedropper mode', () => {
    const state = setPickingKeyColor(freshState(), true);
    expect(state.pickingKeyColor).toBe(true);
    expect(setPickingKeyColor(state, true)).toBe(state);
    expect(setPickingKeyColor(state, false).pickingKeyColor).toBe(false);
  });
});

describe('setEdits', () => {
  it('normalizes arbitrary input and keeps a valid selection', () => {
    let state = addTextLayer(freshState(5));
    const { id } = state.edits.textLayers[0];
    state = setEdits(state, { textLayers: [{ id, text: 'k', end: 40 }, 3] });
    expect(state.edits.textLayers).toHaveLength(1);
    expect(state.edits.textLayers[0].end).toBe(4);
    expect(state.selectedTextId).toBe(id);
    state = setEdits(state, null);
    expect(state.edits.textLayers).toEqual([]);
    expect(state.selectedTextId).toBeNull();
  });

  it('is a no-op without a clip', () => {
    const state = { ...freshState(), clip: null };
    expect(setEdits(/** @type {any} */ (state), {})).toBe(state);
    expect(addTextLayer(/** @type {any} */ (state))).toBe(state);
  });
});

describe('store creation', () => {
  it('createEditorStore passes alpha and edits to the clip', () => {
    const store = createEditorStore(/** @type {any} */ (frames(3)), 10, {
      hasAlpha: true,
      edits: { background: { enabled: true } },
    });
    expect(store.getState().clip?.hasAlpha).toBe(true);
    expect(store.getState().edits.background.enabled).toBe(true);
  });

  it('createEditorStoreFromClip normalizes the clip edits', () => {
    const clip = {
      ...createClip(/** @type {any} */ (frames(3)), 10),
      edits: /** @type {any} */ ({ textLayers: [{ text: 'a', end: 10 }] }),
    };
    const state = createEditorStoreFromClip(clip).getState();
    expect(state.edits.textLayers[0].end).toBe(2);
    expect(state.clip?.edits).toBe(state.edits);
    expect(state.clip?.hasAlpha).toBe(false);
  });
});
