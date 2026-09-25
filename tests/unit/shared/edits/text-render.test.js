import { describe, expect, it } from 'vitest';
import { createTextLayer } from '../../../../src/shared/edits/model.js';
import {
  drawTextLayer,
  FONT_STACKS,
  getTextLayerFont,
  hitTestTextLayers,
  layoutTextLayer,
} from '../../../../src/shared/edits/text-render.js';
import { createFakeContext } from './fake-context.js';

/** @param {Partial<import('../../../../src/shared/edits/model.js').TextLayer>} over */
const layer = (over = {}) =>
  createTextLayer({ text: 'abcd', x: 0.5, y: 0.5, size: 0.1, outlineWidth: 0, ...over }, 10);

describe('getTextLayerFont', () => {
  it('builds a CSS font shorthand from weight, rounded px size and stack', () => {
    expect(getTextLayerFont(layer({ size: 0.1, bold: true }), 480)).toBe(
      `700 48px ${FONT_STACKS.sans}`,
    );
    expect(getTextLayerFont(layer({ size: 0.123, bold: false, font: 'mono' }), 100)).toBe(
      `400 12px ${FONT_STACKS.mono}`,
    );
  });

  it('never goes below 1px', () => {
    expect(getTextLayerFont(layer({ size: 0.02 }), 10)).toMatch(/ 1px /);
  });

  it('falls back to the sans stack for an unknown font', () => {
    const l = { ...layer(), font: /** @type {any} */ ('nope') };
    expect(getTextLayerFont(l, 100)).toContain(FONT_STACKS.sans);
  });
});

describe('layoutTextLayer', () => {
  it('centers the block on (x, y) and measures each line', () => {
    const ctx = createFakeContext();
    // 20px font on a 200px-tall output; fake measure = chars * px / 2
    const layout = layoutTextLayer(ctx, layer({ text: 'abcd\nab' }), 400, 200);
    expect(layout.lines).toEqual(['abcd', 'ab']);
    expect(layout.fontPx).toBe(20);
    expect(layout.lineHeight).toBe(24);
    expect(ctx.font).toBe(getTextLayerFont(layer(), 200));
    // widest line 40px, block height 48px, centered on (200, 100)
    expect(layout.bounds).toEqual({ x: 180, y: 76, width: 40, height: 48 });
  });

  it('anchors left/right alignment at x', () => {
    const ctx = createFakeContext();
    expect(layoutTextLayer(ctx, layer({ align: 'left' }), 400, 200).bounds.x).toBe(200);
    expect(layoutTextLayer(ctx, layer({ align: 'right' }), 400, 200).bounds.x).toBe(160);
  });

  it('pads the bounds for the outline and for the box (the larger one wins)', () => {
    const ctx = createFakeContext();
    const outlined = layoutTextLayer(ctx, layer({ outlineWidth: 0.1 }), 400, 200).bounds;
    expect(outlined).toEqual({ x: 178, y: 86, width: 44, height: 28 });

    const boxed = layoutTextLayer(ctx, layer({ outlineWidth: 0.1, boxColor: '#000000' }), 400, 200);
    // box padding = 0.25 * 20 = 5 > outline 2
    expect(boxed.bounds).toEqual({ x: 175, y: 83, width: 50, height: 34 });
  });
});

describe('drawTextLayer', () => {
  it('strokes then fills each line with the documented stroke settings', () => {
    const ctx = createFakeContext();
    drawTextLayer(ctx, layer({ text: 'ab\ncd', outlineWidth: 0.1 }), 400, 200);

    const names = ctx.names().filter((n) => n !== 'save' && n !== 'restore');
    expect(names).toEqual(['strokeText', 'fillText', 'strokeText', 'fillText']);
    expect(ctx.strokeText.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      ['ab', 200, 88],
      ['cd', 200, 112],
    ]);
    expect(ctx.names()[0]).toBe('save');
    expect(ctx.names().at(-1)).toBe('restore');
  });

  it('sets fill/stroke styles, line join and middle baseline', () => {
    const ctx = createFakeContext();
    /** @type {Record<string, unknown>} */
    const seen = {};
    ctx.strokeText.mockImplementation(() => {
      Object.assign(seen, {
        lineWidth: ctx.lineWidth,
        lineJoin: ctx.lineJoin,
        miterLimit: ctx.miterLimit,
        strokeStyle: ctx.strokeStyle,
        textBaseline: ctx.textBaseline,
        textAlign: ctx.textAlign,
      });
    });
    ctx.fillText.mockImplementation(() => {
      seen.fillStyle = ctx.fillStyle;
    });
    drawTextLayer(
      ctx,
      layer({ outlineWidth: 0.1, color: '#ff0000', outlineColor: '#0000ff', align: 'left' }),
      400,
      200,
    );
    expect(seen).toEqual({
      lineWidth: 4,
      lineJoin: 'round',
      miterLimit: 2,
      strokeStyle: '#0000ff',
      textBaseline: 'middle',
      textAlign: 'left',
      fillStyle: '#ff0000',
    });
  });

  it('skips the stroke when outlineWidth is 0', () => {
    const ctx = createFakeContext();
    drawTextLayer(ctx, layer({ outlineWidth: 0 }), 400, 200);
    expect(ctx.strokeText).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it('draws the box behind the text at the box opacity', () => {
    const ctx = createFakeContext();
    /** @type {number[]} */
    const alphas = [];
    const originalFillRect = ctx.fillRect;
    ctx.fillRect = (...args) => {
      alphas.push(ctx.globalAlpha);
      return originalFillRect(...args);
    };
    drawTextLayer(ctx, layer({ boxColor: '#123456', boxOpacity: 0.4 }), 400, 200);
    const names = ctx.names();
    expect(names.indexOf('fillRect')).toBeLessThan(names.indexOf('fillText'));
    expect(ctx.calls.find((c) => c.name === 'fillRect')?.args).toEqual([175, 83, 50, 34]);
    expect(alphas).toEqual([0.4]);
  });

  it('draws nothing for blank text', () => {
    const ctx = createFakeContext();
    drawTextLayer(ctx, layer({ text: '  ' }), 400, 200);
    expect(ctx.calls).toEqual([]);
  });
});

describe('hitTestTextLayers', () => {
  const bottom = layer({ id: 'bottom', x: 0.5, y: 0.5 });
  const top = layer({ id: 'top', x: 0.52, y: 0.5 });

  it('returns the topmost layer containing the point', () => {
    const ctx = createFakeContext();
    // bottom spans x 180..220, top spans x 188..228
    expect(hitTestTextLayers(ctx, [bottom, top], 400, 200, 200, 100)).toBe('top');
    expect(hitTestTextLayers(ctx, [bottom, top], 400, 200, 182, 100)).toBe('bottom');
    expect(hitTestTextLayers(ctx, [top, bottom], 400, 200, 200, 100)).toBe('bottom');
  });

  it('returns null outside every layer and ignores blank layers', () => {
    const ctx = createFakeContext();
    expect(hitTestTextLayers(ctx, [bottom], 400, 200, 10, 10)).toBeNull();
    expect(hitTestTextLayers(ctx, [layer({ id: 'blank', text: '' })], 400, 200, 200, 100)).toBe(
      null,
    );
  });
});
