/**
 * Editor status bar: shortcut hints and output dimensions
 * @module features/editor/panels/status-bar
 */

import { createElement } from '../../../shared/utils/dom.js';

/**
 * What the Delete key removes: the selected text layer, else the clip
 * @param {string | null} selectedTextId
 * @returns {string}
 */
export function getDeleteHintLabel(selectedTextId) {
  return selectedTextId ? ' Delete Text' : ' Delete Clip';
}

/**
 * Point the Delete shortcut hint at what the key removes now
 * @param {ParentNode} container
 * @param {string | null} selectedTextId
 */
export function updateDeleteHint(container, selectedTextId) {
  const label = container.querySelector('[data-delete-hint]');
  if (label) label.textContent = getDeleteHintLabel(selectedTextId);
}

/**
 * Render the status bar
 * @param {{ width: number, height: number }} dimensions - Output dimensions at render time
 * @param {string | null} [selectedTextId] - Selected text layer at render time
 * @returns {HTMLElement}
 */
export function renderEditorStatusBar(dimensions, selectedTextId = null) {
  return createElement('div', { className: 'editor-status-bar' }, [
    createElement('div', { className: 'status-section' }, [
      createElement('div', { className: 'shortcuts-hint' }, [
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['Space']),
          ' Play',
        ]),
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['\u2190\u2192']),
          ' Frames',
        ]),
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['F']),
          ' Frame Grid',
        ]),
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['G']),
          ' Grid',
        ]),
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['1-9']),
          ' Switch Clip',
        ]),
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['Del']),
          createElement('span', { 'data-delete-hint': 'true' }, [
            getDeleteHintLabel(selectedTextId),
          ]),
        ]),
        createElement('span', { className: 'shortcut' }, [
          createElement('span', { className: 'kbd' }, ['Shift+C']),
          ' Clip Now',
        ]),
      ]),
    ]),
    createElement('div', { className: 'status-section' }, [
      createElement('div', { className: 'status-item' }, [
        'Output: ',
        createElement('span', { className: 'value' }, [
          `${dimensions.width}\u00D7${dimensions.height}`,
        ]),
      ]),
    ]),
  ]);
}
