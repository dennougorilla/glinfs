/**
 * Text property panel: controls call the handlers, and updateEditsPanel
 * applies state in place without disturbing the control the user is typing
 * in. (The Background panel: background-panel.test.js.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderBackgroundPanel } from '../../../src/features/editor/panels/background-panel.js';
import {
  getTextLayerLabel,
  renderTextPanel,
  updateEditsPanel,
} from '../../../src/features/editor/panels/edits-panel.js';
import { createDefaultEdits, createTextLayer } from '../../../src/shared/edits/model.js';

/** @param {Partial<import('../../../src/features/editor/types.js').EditorState>} over */
function makeState(over = {}) {
  return /** @type {any} */ ({
    clip: { frames: new Array(20).fill(null), hasAlpha: false },
    currentFrame: 5,
    selectedRange: { start: 0, end: 19 },
    edits: createDefaultEdits(),
    selectedTextId: null,
    pickingKeyColor: false,
    ...over,
  });
}

const layerA = createTextLayer({ id: 'a', text: 'First\nsecond line', start: 2, end: 8 }, 20);
const layerB = createTextLayer({ id: 'b', text: '  ', color: '#112233' }, 20);

/** @type {any} */
let state;
/** @type {Record<string, import('vitest').Mock>} */
let handlers;
/** @type {HTMLElement} */
let root;

/**
 * @param {string} selector
 * @returns {any}
 */
const $ = (selector) => root.querySelector(selector);

/** @param {Element} el @param {string} type */
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

beforeEach(() => {
  state = makeState({
    edits: { ...createDefaultEdits(), textLayers: [layerA, layerB] },
    selectedTextId: 'a',
  });
  handlers = {
    getState: vi.fn(() => state),
    onAddText: vi.fn(),
    onSelectText: vi.fn(),
    onUpdateText: vi.fn(),
    onRemoveText: vi.fn(),
    onSetBackground: vi.fn(),
    onToggleBackground: vi.fn(),
    onSetPickingKeyColor: vi.fn(),
  };
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.appendChild(renderTextPanel(/** @type {any} */ (handlers)).element);
  root.appendChild(renderBackgroundPanel(/** @type {any} */ (handlers)).element);
  document.body.appendChild(root);
  updateEditsPanel(root, state, 10);
});

describe('getTextLayerLabel', () => {
  it('uses the first non-blank line', () => {
    expect(getTextLayerLabel(layerA)).toBe('First');
    expect(getTextLayerLabel({ ...layerA, text: '\n  Two ' })).toBe('Two');
    expect(getTextLayerLabel(layerB)).toBe('(empty)');
  });
});

describe('Text panel', () => {
  it('shows the empty hint and hides the editor without layers', () => {
    updateEditsPanel(root, makeState(), 10);
    expect($('#text-layer-list').hidden).toBe(true);
    expect($('.editor-text-empty').hidden).toBe(false);
    expect($('#text-layer-editor').hidden).toBe(true);
  });

  it('lists layers with the selection marked and applies the selected layer', () => {
    const items = root.querySelectorAll('#text-layer-list .editor-text-item');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.editor-text-item-select')?.textContent).toBe('First');
    expect(items[0].classList.contains('editor-text-item--selected')).toBe(true);
    expect(items[0].querySelector('[aria-current="true"]')).not.toBeNull();
    expect(items[1].querySelector('.editor-text-item-delete')?.getAttribute('aria-label')).toBe(
      'Delete text layer "(empty)"',
    );

    expect($('#text-layer-editor').hidden).toBe(false);
    expect($('#text-layer-text').value).toBe('First\nsecond line');
    expect($('#text-layer-size').value).toBe('10');
    expect($('#text-layer-size-value').textContent).toBe('10%');
    expect($('#text-layer-bold').checked).toBe(true);
    expect($('#text-layer-align-center').checked).toBe(true);
    expect($('#text-layer-box').checked).toBe(false);
    expect($('#text-layer-box-opacity').disabled).toBe(true);
    expect($('#text-layer-start').dataset.frame).toBe('2');
    expect($('#text-layer-end').dataset.frame).toBe('8');
    expect($('#text-layer-start').textContent).not.toBe('');
  });

  it('every control has a label', () => {
    for (const control of root.querySelectorAll('input, select, textarea')) {
      const label = root.querySelector(`label[for="${control.id}"]`) ?? control.closest('label');
      expect(label, `label for #${control.id}`).not.toBeNull();
    }
  });

  it('patches the list in place when only labels or selection change', () => {
    const firstItem = $('#text-layer-list .editor-text-item');
    state = {
      ...state,
      edits: { ...state.edits, textLayers: [{ ...layerA, text: 'Renamed' }, layerB] },
    };
    updateEditsPanel(root, { ...state, selectedTextId: 'b' }, 10);
    expect($('#text-layer-list .editor-text-item')).toBe(firstItem);
    expect(firstItem.textContent).toContain('Renamed');
    expect(firstItem.classList.contains('editor-text-item--selected')).toBe(false);
  });

  it('never resets the textarea the user is typing in', () => {
    const textarea = $('#text-layer-text');
    textarea.focus();
    textarea.value = 'First\nsecond line!';
    textarea.setSelectionRange(3, 3);
    const typed = { ...layerA, text: 'First\nsecond line!' };
    updateEditsPanel(
      root,
      { ...state, edits: { ...state.edits, textLayers: [typed, layerB] } },
      10,
    );
    expect(textarea.selectionStart).toBe(3);
  });

  it('controls call the handlers for the selected layer', () => {
    $('#text-add').click();
    expect(handlers.onAddText).toHaveBeenCalled();

    $('#text-layer-text').value = 'Typed';
    fire($('#text-layer-text'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { text: 'Typed' });

    $('#text-layer-font').value = 'mono';
    fire($('#text-layer-font'), 'change');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { font: 'mono' });

    $('#text-layer-bold').checked = false;
    fire($('#text-layer-bold'), 'change');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { bold: false });

    $('#text-layer-size').value = '25';
    fire($('#text-layer-size'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { size: 0.25 });

    $('#text-layer-color').value = '#123456';
    fire($('#text-layer-color'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { color: '#123456' });

    $('#text-layer-outline-color').value = '#654321';
    fire($('#text-layer-outline-color'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { outlineColor: '#654321' });

    $('#text-layer-outline-width').value = '5';
    fire($('#text-layer-outline-width'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { outlineWidth: 0.05 });

    $('#text-layer-box').checked = true;
    fire($('#text-layer-box'), 'change');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { boxColor: '#000000' });
    $('#text-layer-box').checked = false;
    fire($('#text-layer-box'), 'change');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { boxColor: null });

    $('#text-layer-box-color').value = '#ffffff';
    fire($('#text-layer-box-color'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { boxColor: '#ffffff' });

    $('#text-layer-box-opacity').value = '30';
    fire($('#text-layer-box-opacity'), 'input');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { boxOpacity: 0.3 });

    $('#text-layer-align-right').checked = true;
    fire($('#text-layer-align-right'), 'change');
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { align: 'right' });
  });

  it('timing buttons use the playhead and the whole clip', () => {
    $('#text-layer-start-playhead').click();
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { start: 5 });
    $('#text-layer-end-playhead').click();
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { end: 5 });
    // An end before the start moves both
    state = { ...state, currentFrame: 1 };
    $('#text-layer-end-playhead').click();
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { start: 1, end: 1 });
    $('#text-layer-whole-clip').click();
    expect(handlers.onUpdateText).toHaveBeenLastCalledWith('a', { start: 0, end: 19 });
  });

  it('list buttons select and delete', () => {
    const second = root.querySelectorAll('#text-layer-list .editor-text-item')[1];
    /** @type {HTMLElement} */ (second.querySelector('.editor-text-item-select')).click();
    expect(handlers.onSelectText).toHaveBeenCalledWith('b');
    /** @type {HTMLElement} */ (second.querySelector('.editor-text-item-delete')).click();
    expect(handlers.onRemoveText).toHaveBeenCalledWith('b');
  });

  it('keeps keyboard focus in the list when a layer is deleted from it', () => {
    const layerC = createTextLayer({ id: 'c', text: 'Third' }, 20);
    const withLayers = (/** @type {any[]} */ layers) =>
      makeState({ edits: { ...createDefaultEdits(), textLayers: layers }, selectedTextId: null });
    updateEditsPanel(root, withLayers([layerA, layerB, layerC]), 10);
    const deleteButtons = () =>
      /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.editor-text-item-delete')));
    const selectButtons = () =>
      /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.editor-text-item-select')));

    // Delete the middle layer: focus moves to the layer now in its place
    deleteButtons()[1].focus();
    updateEditsPanel(root, withLayers([layerA, layerC]), 10);
    expect(document.activeElement).toBe(selectButtons()[1]);
    expect(document.activeElement?.textContent).toBe('Third');

    // Delete the last layer: focus moves to the one before it
    deleteButtons()[1].focus();
    updateEditsPanel(root, withLayers([layerA]), 10);
    expect(document.activeElement).toBe(selectButtons()[0]);

    // A rebuild that keeps the focused layer keeps focus on the same button
    deleteButtons()[0].focus();
    updateEditsPanel(root, withLayers([layerA, layerB]), 10);
    expect(document.activeElement).toBe(deleteButtons()[0]);

    // The list empties: focus goes to "Add text"
    deleteButtons()[1].focus();
    updateEditsPanel(root, withLayers([layerA]), 10);
    deleteButtons()[0].focus();
    updateEditsPanel(root, withLayers([]), 10);
    expect(document.activeElement).toBe($('#text-add'));
  });

  it('does nothing without a selected layer', () => {
    state = { ...state, selectedTextId: null };
    fire($('#text-layer-text'), 'input');
    $('#text-layer-end-playhead').click();
    expect(handlers.onUpdateText).not.toHaveBeenCalled();
  });
});

describe('updateEditsPanel', () => {
  it('tolerates a container without the panels', () => {
    expect(() => updateEditsPanel(document.createElement('div'), state, 10)).not.toThrow();
  });
});
