import { describe, expect, it } from 'vitest';
import { getPreviewTool, getPreviewToolHint } from '../../../src/features/editor/panels/preview.js';

/**
 * @param {Record<string, unknown>} over
 * @returns {any}
 */
function stateWith(over) {
  return {
    brush: { on: false },
    pickingKeyColor: false,
    aiPickTool: null,
    aiActiveObjectId: null,
    edits: {
      background: {
        enabled: true,
        ai: {
          model: 'general',
          picks: [],
          objects: [{ id: 'o1', mode: 'remove', scope: 'whole', clicks: [], boxes: [] }],
        },
      },
    },
    ...over,
  };
}

describe('preview tool hint', () => {
  it('Keep and Remove name clicks and drags', () => {
    expect(getPreviewToolHint(stateWith({ aiPickTool: 'keep' }))).toContain('Drag a box to add');
    expect(getPreviewToolHint(stateWith({ aiPickTool: 'remove' }))).toBe(
      'Click or drag a box over what to remove from every frame · Esc to cancel',
    );
    expect(getPreviewTool(stateWith({ aiPickTool: 'remove' }))).toBe('remove');
  });

  it('a selected fix-up: clicks add to it, Alt takes away', () => {
    const hint = getPreviewToolHint(stateWith({ aiPickTool: 'keep', aiActiveObjectId: 'o1' }));
    expect(hint).toContain('Alt-click to take away');
    // Selected without a tool on is not a correction
    expect(getPreviewToolHint(stateWith({ aiActiveObjectId: 'o1' }))).toBe('');
  });
});
