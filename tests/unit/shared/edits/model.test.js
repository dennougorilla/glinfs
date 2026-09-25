import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAiCutout,
  createDefaultEdits,
  createTextLayer,
  EDIT_LIMITS,
  getActiveTextLayers,
  isAiCutoutActive,
  isColorKeyActive,
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
        method: 'color',
        color: '#00ff00',
        tolerance: 20,
        mode: 'connected',
        colorChosen: false,
        ai: { threshold: 0.5, smoothing: true, edge: 0, picks: [] },
      },
    });
  });

  it('returns a fresh object each call', () => {
    const a = createDefaultEdits();
    a.background.enabled = true;
    a.background.ai.picks.push({ frame: 0, x: 0, y: 0, mode: 'keep' });
    expect(createDefaultEdits().background.enabled).toBe(false);
    expect(createDefaultEdits().background.ai.picks).toEqual([]);
    expect(createDefaultAiCutout()).not.toBe(createDefaultAiCutout());
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

describe('background method and AI cutout', () => {
  it('reads v0.7.0 edits (no method, no ai) as the color key with default AI params', () => {
    const legacy = {
      textLayers: [],
      background: {
        enabled: true,
        color: '#123456',
        tolerance: 30,
        mode: 'global',
        colorChosen: true,
      },
    };
    const { background } = normalizeEdits(legacy, 10);
    expect(background).toEqual({
      ...legacy.background,
      method: 'color',
      ai: createDefaultAiCutout(),
    });
    expect(isColorKeyActive(background)).toBe(true);
    expect(isAiCutoutActive(background)).toBe(false);
  });

  it('keeps a valid method and falls back to color on garbage', () => {
    expect(normalizeEdits({ background: { method: 'ai' } }, 5).background.method).toBe('ai');
    expect(normalizeEdits({ background: { method: 'magic' } }, 5).background.method).toBe('color');
    expect(normalizeEdits({ background: { method: 3 } }, 5).background.method).toBe('color');
  });

  it('clamps threshold and edge, rounds edge, and validates smoothing', () => {
    const ai = (/** @type {Record<string, unknown>} */ input) =>
      normalizeEdits({ background: { ai: input } }, 5).background.ai;
    expect(ai({ threshold: 0 }).threshold).toBe(EDIT_LIMITS.aiThreshold.min);
    expect(ai({ threshold: 2 }).threshold).toBe(EDIT_LIMITS.aiThreshold.max);
    expect(ai({ threshold: 0.3 }).threshold).toBe(0.3);
    expect(ai({ threshold: Number.NaN }).threshold).toBe(0.5);
    expect(ai({ edge: -20 }).edge).toBe(-8);
    expect(ai({ edge: 20 }).edge).toBe(8);
    expect(ai({ edge: 2.6 }).edge).toBe(3);
    expect(ai({ edge: '4' }).edge).toBe(0);
    expect(ai({ smoothing: false }).smoothing).toBe(false);
    expect(ai({ smoothing: 'no' }).smoothing).toBe(true);
    expect(normalizeEdits({ background: { ai: 'bad' } }, 5).background.ai).toEqual(
      createDefaultAiCutout(),
    );
  });

  it('validates picks: drops unusable ones, clamps the rest, caps the count', () => {
    const picks = (/** @type {unknown} */ input, frameCount = 10) =>
      normalizeEdits({ background: { ai: { picks: input } } }, frameCount).background.ai.picks;

    expect(
      picks([
        null,
        'x',
        [],
        { frame: 2, x: 0.5 },
        { frame: 'a', x: 0.5, y: 0.5 },
        { frame: 1, x: Number.NaN, y: 0.2 },
        { frame: 3, x: 0.25, y: 0.75, mode: 'remove' },
        { frame: 99, x: -1, y: 4, mode: 'other' },
        { frame: 2.4, x: 1, y: 0 },
      ]),
    ).toEqual([
      { frame: 3, x: 0.25, y: 0.75, mode: 'remove' },
      { frame: 9, x: 0, y: 1, mode: 'keep' },
      { frame: 2, x: 1, y: 0, mode: 'keep' },
    ]);
    expect(picks('nope')).toEqual([]);

    const many = Array.from({ length: 20 }, (_, i) => ({ frame: i, x: 0.5, y: 0.5 }));
    const kept = picks(many, 30);
    expect(kept).toHaveLength(EDIT_LIMITS.aiPicks.max);
    expect(kept.map((p) => p.frame)).toEqual(many.slice(0, 16).map((p) => p.frame));
  });

  it('returns new pick objects', () => {
    const pick = { frame: 0, x: 0.5, y: 0.5, mode: 'keep' };
    const result = normalizeEdits({ background: { ai: { picks: [pick] } } }, 5).background.ai;
    expect(result.picks[0]).toEqual(pick);
    expect(result.picks[0]).not.toBe(pick);
  });

  it('treats an enabled AI cutout like an enabled color key', () => {
    const edits = createDefaultEdits();
    edits.background.method = 'ai';
    expect(isEditsEmpty(edits)).toBe(true);
    expect(requiresTransparency({ edits, hasAlpha: false })).toBe(false);
    expect(isAiCutoutActive(edits.background)).toBe(false);

    edits.background.enabled = true;
    expect(isEditsEmpty(edits)).toBe(false);
    expect(requiresTransparency({ edits, hasAlpha: false })).toBe(true);
    expect(isAiCutoutActive(edits.background)).toBe(true);
    expect(isColorKeyActive(edits.background)).toBe(false);
    expect(isAiCutoutActive(null)).toBe(false);
    expect(isColorKeyActive(undefined)).toBe(false);
  });
});
