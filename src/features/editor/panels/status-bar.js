/**
 * Editor status bar: shortcut hints and output dimensions
 * @module features/editor/panels/status-bar
 */

import { createElement } from '../../../shared/utils/dom.js';

/**
 * Render the status bar
 * @param {{ width: number, height: number }} dimensions - Output dimensions at render time
 * @returns {HTMLElement}
 */
export function renderEditorStatusBar(dimensions) {
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
          ' Delete Clip',
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
