import { describe, expect, it } from 'vitest';
import {
  applyColorKey,
  detectEdgeColor,
  MAX_RGB_DISTANCE,
  parseHexColor,
  toHexColor,
} from '../../../../src/shared/edits/color-key.js';

/** @typedef {[number, number, number, number]} RGBA */

/**
 * Build an RGBA buffer from a character map: each char picks a color
 * @param {string[]} rows
 * @param {Record<string, RGBA>} colors
 */
function fromMap(rows, colors) {
  const height = rows.length;
  const width = rows[0].length;
  const rgba = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      rgba.set(colors[ch], (y * width + x) * 4);
    });
  });
  return { rgba, width, height };
}

/**
 * Alpha map as strings: '.' transparent, '#' opaque
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 */
function alphaMap(rgba, width) {
  const rows = [];
  for (let p = 0; p < rgba.length / 4; p += width) {
    let row = '';
    for (let x = 0; x < width; x++) row += rgba[(p + x) * 4 + 3] < 128 ? '.' : '#';
    rows.push(row);
  }
  return rows;
}

/** @type {RGBA} */
const GREEN = [0, 255, 0, 255];
/** @type {RGBA} */
const RED = [255, 0, 0, 255];
/** @type {RGBA} */
const CLEAR = [9, 9, 9, 0];

/**
 * @param {Partial<import('../../../../src/shared/edits/model.js').BackgroundRemoval>} [over]
 * @returns {import('../../../../src/shared/edits/model.js').BackgroundRemoval}
 */
const bg = (over = {}) => ({
  enabled: true,
  color: '#00ff00',
  tolerance: 0,
  mode: 'connected',
  ...over,
});

describe('parseHexColor / toHexColor', () => {
  it('round-trips colors', () => {
    expect(parseHexColor('#0a1B2c')).toEqual({ r: 10, g: 27, b: 44 });
    expect(toHexColor({ r: 10, g: 27, b: 44 })).toBe('#0a1b2c');
  });

  it('rejects malformed input', () => {
    expect(parseHexColor('0a1b2c')).toBeNull();
    expect(parseHexColor('#abc')).toBeNull();
    expect(parseHexColor(/** @type {any} */ (null))).toBeNull();
  });

  it('clamps and rounds channels', () => {
    expect(toHexColor({ r: -5, g: 300, b: 127.6 })).toBe('#00ff80');
  });
});

describe('applyColorKey', () => {
  it('is a no-op when disabled, missing or with an invalid key color', () => {
    const { rgba, width, height } = fromMap(['gg'], { g: GREEN });
    expect(applyColorKey(rgba, width, height, null)).toBe(0);
    expect(applyColorKey(rgba, width, height, bg({ enabled: false }))).toBe(0);
    expect(applyColorKey(rgba, width, height, bg({ color: 'nope' }))).toBe(0);
    expect(alphaMap(rgba, width)).toEqual(['##']);
  });

  it('connected mode clears only key pixels reachable from the border', () => {
    const { rgba, width, height } = fromMap(['ggggg', 'grrrg', 'grgrg', 'grrrg', 'ggggg'], {
      g: GREEN,
      r: RED,
    });
    const cleared = applyColorKey(rgba, width, height, bg());
    // 16 border greens; the enclosed center green survives
    expect(cleared).toBe(16);
    expect(alphaMap(rgba, width)).toEqual(['.....', '.###.', '.###.', '.###.', '.....']);
    // Cleared pixels are RGBA 0
    expect(Array.from(rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    // The enclosed pixel keeps its color
    expect(Array.from(rgba.subarray(12 * 4, 12 * 4 + 4))).toEqual(GREEN);
  });

  it('global mode clears every matching pixel', () => {
    const { rgba, width, height } = fromMap(['ggggg', 'grrrg', 'grgrg', 'grrrg', 'ggggg'], {
      g: GREEN,
      r: RED,
    });
    expect(applyColorKey(rgba, width, height, bg({ mode: 'global' }))).toBe(17);
    expect(alphaMap(rgba, width)[2]).toBe('.#.#.');
  });

  it('tolerance 0 matches only the exact color; tolerance scales with RGB distance', () => {
    /** @type {RGBA} */
    const near = [0, 245, 0, 255];
    const exact = fromMap(['gn'], { g: GREEN, n: near });
    expect(applyColorKey(exact.rgba, 2, 1, bg({ mode: 'global' }))).toBe(1);

    // distance 10 -> needs tolerance >= 10 / 441.673 * 100 ~= 2.264
    const below = fromMap(['n'], { n: near });
    expect(applyColorKey(below.rgba, 1, 1, bg({ mode: 'global', tolerance: 2.2 }))).toBe(0);
    const above = fromMap(['n'], { n: near });
    expect(applyColorKey(above.rgba, 1, 1, bg({ mode: 'global', tolerance: 2.3 }))).toBe(1);

    // tolerance 100 reaches the opposite corner of the RGB cube
    expect(MAX_RGB_DISTANCE).toBeCloseTo(Math.sqrt(3 * 255 * 255), 2);
    const far = fromMap(['k'], { k: [255, 0, 255, 255] });
    expect(applyColorKey(far.rgba, 1, 1, bg({ mode: 'global', tolerance: 100 }))).toBe(1);
  });

  it('lets source transparency join regions without counting it', () => {
    // A transparent channel connects the border to the inner green pocket
    const { rgba, width, height } = fromMap(['rrrrr', 'r.ggr', 'r.rrr', 'r...r', 'rrr.r'], {
      g: GREEN,
      r: RED,
      '.': CLEAR,
    });
    const cleared = applyColorKey(rgba, width, height, bg());
    expect(cleared).toBe(2);
    expect(alphaMap(rgba, width)[1]).toBe('#...#');
  });

  it('leaves enclosed key pixels alone when nothing connects them to the border', () => {
    const { rgba, width, height } = fromMap(['rrr', 'rgr', 'rrr'], { g: GREEN, r: RED });
    expect(applyColorKey(rgba, width, height, bg())).toBe(0);
  });

  it('handles 1-pixel-wide and 1-pixel-tall buffers', () => {
    const col = fromMap(['g', 'r', 'g'], { g: GREEN, r: RED });
    expect(applyColorKey(col.rgba, 1, 3, bg())).toBe(2);
    const row = fromMap(['grg'], { g: GREEN, r: RED });
    expect(applyColorKey(row.rgba, 3, 1, bg())).toBe(2);
  });

  it('floods a large buffer iteratively without overflowing the stack', () => {
    const width = 1000;
    const height = 1000;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) rgba.set(GREEN, p * 4);
    expect(applyColorKey(rgba, width, height, bg())).toBe(width * height);
  });

  it('returns 0 for an empty buffer', () => {
    expect(applyColorKey(new Uint8ClampedArray(0), 0, 0, bg())).toBe(0);
  });
});

describe('detectEdgeColor', () => {
  it('returns the most frequent border color', () => {
    const { rgba, width, height } = fromMap(['grrg', 'grrg', 'gggg'], { g: GREEN, r: RED });
    expect(detectEdgeColor(rgba, width, height)).toBe('#00ff00');
  });

  it('groups near colors by 5-bit quantization and returns the first exact color', () => {
    const { rgba, width, height } = fromMap(['abab', 'rrra'], {
      a: [0, 250, 1, 255],
      b: [3, 253, 4, 255],
      r: RED,
    });
    // a and b share a bucket (5 pixels) and beat red (3)
    expect(detectEdgeColor(rgba, width, height)).toBe('#00fa01');
  });

  it('breaks ties by the bucket seen first', () => {
    const { rgba, width, height } = fromMap(['rg', 'gr'], { g: GREEN, r: RED });
    expect(detectEdgeColor(rgba, width, height)).toBe('#ff0000');
  });

  it('ignores the interior and transparent border pixels', () => {
    const { rgba, width, height } = fromMap(['..r..', '.ggg.', '.ggg.', '.....'], {
      g: GREEN,
      r: RED,
      '.': CLEAR,
    });
    expect(detectEdgeColor(rgba, width, height)).toBe('#ff0000');
  });

  it('falls back to black without opaque border pixels', () => {
    expect(detectEdgeColor(new Uint8ClampedArray(0), 0, 0)).toBe('#000000');
    const { rgba } = fromMap(['..'], { '.': CLEAR });
    expect(detectEdgeColor(rgba, 2, 1)).toBe('#000000');
  });

  it('handles a single pixel', () => {
    const { rgba } = fromMap(['r'], { r: RED });
    expect(detectEdgeColor(rgba, 1, 1)).toBe('#ff0000');
  });
});
