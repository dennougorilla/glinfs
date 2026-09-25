import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultEdits,
  createTextLayer,
  getActiveTextLayers,
  isEditsEmpty,
  normalizeEdits,
  requiresTransparency,
} from '../../../../src/shared/edits/model.js';

describe('createDefaultEdits', () => {
  it('has no text and background removal off with the documented defaults', () => {
    expect(createDefaultEdits()).toEqual({
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

  it('returns a fresh object each call', () => {
    const a = createDefaultEdits();
    a.background.enabled = true;
    expect(createDefaultEdits().background.enabled).toBe(false);
  });
});

describe('createTextLayer', () => {
  it('applies the documented defaults spanning the whole clip', () => {
    const layer = createTextLayer({}, 30);
    expect(layer).toMatchObject({
      text: 'Your text',
      x: 0.5,
      y: 0.85,
      size: 0.1,
      font: 'sans',
      bold: true,
      align: 'center',
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 0.12,
      boxColor: null,
      boxOpacity: 0.6,
      start: 0,
      end: 29,
    });
    expect(typeof layer.id).toBe('string');
    expect(layer.id.length).toBeGreaterThan(0);
  });

  it('keeps partial overrides and generates unique ids', () => {
    const a = createTextLayer({ text: 'Hi', start: 5, end: 9, color: '#FF0000' }, 30);
    const b = createTextLayer({}, 30);
    expect(a).toMatchObject({ text: 'Hi', start: 5, end: 9, color: '#ff0000' });
    expect(a.id).not.toBe(b.id);
  });

  it('keeps an explicit id', () => {
    expect(createTextLayer({ id: 'fixed' }, 3).id).toBe('fixed');
  });

  it('falls back to a counter-based id without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {});
    try {
      const a = createTextLayer({}, 1);
      const b = createTextLayer({}, 1);
      expect(a.id).toMatch(/^text-/);
      expect(a.id).not.toBe(b.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('normalizeEdits', () => {
  it('keeps an explicit colorChosen flag and infers it for input without one', () => {
    const bg = (/** @type {Record<string, unknown>} */ background) =>
      normalizeEdits({ background }, 10).background.colorChosen;
    // A deliberately chosen default color survives a round trip
    expect(bg({ color: '#00ff00', colorChosen: true })).toBe(true);
    expect(bg({ enabled: true, color: '#123456', colorChosen: false })).toBe(false);
    // Without the flag: a removal in use or a non-default color was chosen
    expect(bg({ color: '#00ff00' })).toBe(false);
    expect(bg({ color: '#123456' })).toBe(true);
    expect(bg({ enabled: true })).toBe(true);
    expect(bg({ colorChosen: 'yes' })).toBe(false);
  });

  it('returns defaults for undefined, null and garbage input', () => {
    for (const input of [undefined, null, 42, 'x', []]) {
      expect(normalizeEdits(input, 10)).toEqual(createDefaultEdits());
    }
  });

  it('returns a new object', () => {
    const edits = createDefaultEdits();
    expect(normalizeEdits(edits, 10)).not.toBe(edits);
    expect(normalizeEdits(edits, 10).background).not.toBe(edits.background);
  });

  it('drops non-object layers but keeps layers with empty text', () => {
    const result = normalizeEdits(
      { textLayers: [null, 3, 'str', [], { id: 'a', text: '' }, { id: 'b', text: 'ok' }] },
      10,
    );
    expect(result.textLayers.map((l) => l.id)).toEqual(['a', 'b']);
    expect(result.textLayers[0].text).toBe('');
  });

  it('clamps numbers into their ranges and falls back on non-finite values', () => {
    const [layer] = normalizeEdits(
      {
        textLayers: [{ id: 'a', text: 't', x: -1, y: 5, size: 9, outlineWidth: 1, boxOpacity: -3 }],
      },
      10,
    ).textLayers;
    expect(layer).toMatchObject({ x: 0, y: 1, size: 0.5, outlineWidth: 0.3, boxOpacity: 0 });

    const [nanLayer] = normalizeEdits(
      {
        textLayers: [
          {
            id: 'b',
            text: 't',
            x: Number.NaN,
            size: '0.3',
            outlineWidth: Number.POSITIVE_INFINITY,
          },
        ],
      },
      10,
    ).textLayers;
    expect(nanLayer).toMatchObject({ x: 0.5, size: 0.1, outlineWidth: 0.12 });

    expect(normalizeEdits({ background: { tolerance: -5 } }, 10).background.tolerance).toBe(0);
    expect(normalizeEdits({ background: { tolerance: 500 } }, 10).background.tolerance).toBe(100);
  });

  it('clamps the minimum font size', () => {
    const [layer] = normalizeEdits({ textLayers: [{ text: 'a', size: 0 }] }, 5).textLayers;
    expect(layer.size).toBe(0.02);
  });

  it('validates colors and lower-cases them', () => {
    const result = normalizeEdits(
      {
        textLayers: [
          { text: 'a', color: 'red', outlineColor: '#ABCDEF', boxColor: '#12345' },
          { text: 'b', boxColor: '#AA00BB' },
        ],
        background: { color: 'blue' },
      },
      5,
    );
    expect(result.textLayers[0]).toMatchObject({
      color: '#ffffff',
      outlineColor: '#abcdef',
      boxColor: '#000000',
    });
    expect(result.textLayers[1].boxColor).toBe('#aa00bb');
    expect(result.background.color).toBe('#00ff00');
  });

  it('keeps a null box color as no box', () => {
    const [layer] = normalizeEdits({ textLayers: [{ text: 'a', boxColor: null }] }, 5).textLayers;
    expect(layer.boxColor).toBeNull();
  });

  it('coerces enums and booleans', () => {
    const result = normalizeEdits(
      {
        textLayers: [{ text: 'a', font: 'comic', align: 'justify', bold: 'yes' }],
        background: { enabled: 'true', mode: 'flood' },
      },
      5,
    );
    expect(result.textLayers[0]).toMatchObject({ font: 'sans', align: 'center', bold: true });
    expect(result.background).toMatchObject({ enabled: false, mode: 'connected' });

    const valid = normalizeEdits(
      {
        textLayers: [{ text: 'a', font: 'mono', align: 'right', bold: false }],
        background: { enabled: true, mode: 'global' },
      },
      5,
    );
    expect(valid.textLayers[0]).toMatchObject({ font: 'mono', align: 'right', bold: false });
    expect(valid.background).toMatchObject({ enabled: true, mode: 'global' });
  });

  it('clamps start/end into the clip and keeps start <= end', () => {
    const layers = normalizeEdits(
      {
        textLayers: [
          { text: 'a', start: -4, end: 99 },
          { text: 'b', start: 7, end: 3 },
          { text: 'c', start: 2.6, end: 4.2 },
          { text: 'd' },
        ],
      },
      10,
    ).textLayers;
    expect(layers.map((l) => [l.start, l.end])).toEqual([
      [0, 9],
      [7, 7],
      [3, 4],
      [0, 9],
    ]);
  });

  it('handles a zero frame count', () => {
    const [layer] = normalizeEdits({ textLayers: [{ text: 'a', start: 3, end: 8 }] }, 0).textLayers;
    expect([layer.start, layer.end]).toEqual([0, 0]);
  });

  it('replaces a missing id', () => {
    const [layer] = normalizeEdits({ textLayers: [{ text: 'a', id: '' }] }, 5).textLayers;
    expect(layer.id).not.toBe('');
  });

  it('replaces non-string text with empty text', () => {
    const [layer] = normalizeEdits({ textLayers: [{ text: 12 }] }, 5).textLayers;
    expect(layer.text).toBe('');
  });
});

describe('isEditsEmpty', () => {
  it('is true for null/undefined and default edits', () => {
    expect(isEditsEmpty(null)).toBe(true);
    expect(isEditsEmpty(undefined)).toBe(true);
    expect(isEditsEmpty(createDefaultEdits())).toBe(true);
  });

  it('is true when every layer is blank', () => {
    const edits = createDefaultEdits();
    edits.textLayers.push(createTextLayer({ text: '  \n ' }, 5));
    expect(isEditsEmpty(edits)).toBe(true);
  });

  it('is false with visible text or background removal on', () => {
    const withText = createDefaultEdits();
    withText.textLayers.push(createTextLayer({ text: 'Hi' }, 5));
    expect(isEditsEmpty(withText)).toBe(false);

    const withKey = createDefaultEdits();
    withKey.background.enabled = true;
    expect(isEditsEmpty(withKey)).toBe(false);
  });
});

describe('getActiveTextLayers', () => {
  const edits = {
    ...createDefaultEdits(),
    textLayers: [
      createTextLayer({ id: 'a', text: 'A', start: 0, end: 4 }, 10),
      createTextLayer({ id: 'blank', text: ' ', start: 0, end: 9 }, 10),
      createTextLayer({ id: 'b', text: 'B', start: 3, end: 9 }, 10),
    ],
  };

  it('returns non-blank layers covering the frame, in draw order', () => {
    expect(getActiveTextLayers(edits, 0).map((l) => l.id)).toEqual(['a']);
    expect(getActiveTextLayers(edits, 3).map((l) => l.id)).toEqual(['a', 'b']);
    expect(getActiveTextLayers(edits, 4).map((l) => l.id)).toEqual(['a', 'b']);
    expect(getActiveTextLayers(edits, 5).map((l) => l.id)).toEqual(['b']);
    expect(getActiveTextLayers(edits, 10)).toEqual([]);
  });

  it('tolerates missing edits', () => {
    expect(getActiveTextLayers(null, 0)).toEqual([]);
    expect(getActiveTextLayers(undefined, 0)).toEqual([]);
  });
});

describe('requiresTransparency', () => {
  it('is true when the source has alpha or removal is enabled', () => {
    const on = createDefaultEdits();
    on.background.enabled = true;
    expect(requiresTransparency({ edits: null, hasAlpha: true })).toBe(true);
    expect(requiresTransparency({ edits: on, hasAlpha: false })).toBe(true);
    expect(requiresTransparency({ edits: createDefaultEdits(), hasAlpha: false })).toBe(false);
    expect(requiresTransparency({ edits: undefined, hasAlpha: undefined })).toBe(false);
  });
});
