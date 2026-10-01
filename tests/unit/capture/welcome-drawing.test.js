import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKDROPS } from '../../../src/features/capture/welcome/backdrops.js';
import { CAST } from '../../../src/features/capture/welcome/cast.js';
import {
  drawBaked,
  drawPlain,
  LH,
  LW,
  makeCanvas,
  Sprite,
} from '../../../src/features/capture/welcome/pixel.js';
import {
  drawStage,
  renderVideo,
  StageBuffers,
} from '../../../src/features/capture/welcome/stage.js';
import { CYCLE } from '../../../src/features/capture/welcome/timeline.js';
import { createFakeContext2d, installFakeCanvas, putImages } from './fake-context-2d.js';

/**
 * The welcome scene's drawing code, against a fake 2D context: the pixel
 * toolkit's geometry, and the whole scene played through for every
 * character and backdrop. What it looks like is checked in the browser
 * (tests/e2e/welcome-scene.spec.js and by eye).
 */

const PLATES = { cyan: '#22d3ee', magenta: '#f0468f' };
const PALETTE = {
  paper: '#ececef',
  onPaper: '#0c0d10',
  cyan: PLATES.cyan,
  magenta: PLATES.magenta,
  rec: '#ff3d71',
  panel: '#121317',
  window: '#17181d',
  line: '#24262c',
  lineStrong: '#33353c',
  text2: '#a3a5ad',
  muted: '#85878f',
  track: '#292b32',
  mono: 'monospace',
  sans: 'sans-serif',
};
/** The ground shadow under the cast (cast.js) */
const SHADOW = 'rgba(10, 0, 20, 0.55)';

let getContext;
beforeAll(() => {
  getContext = installFakeCanvas();
});
afterAll(() => {
  getContext.mockRestore();
});

/** RGBA of the pixel at box coordinates (x, y) in a baked canvas's ImageData */
function pixelAt(canvas, margin, x, y) {
  const put = putImages.findLast((p) => p.canvas === canvas);
  const { data, width } = put.image;
  const i = ((y + margin) * width + x + margin) * 4;
  return Array.from(data.slice(i, i + 4));
}

describe('Sprite', () => {
  const painted = (s) => {
    const out = [];
    for (let y = -2; y < s.h + 2; y++) {
      for (let x = -2; x < s.w + 2; x++) if (s.get(x, y)) out.push([x, y]);
    }
    return out;
  };

  it('keeps shapes to its box, give or take a pixel', () => {
    const s = new Sprite(4, 3);
    s.set(-1, -1, '#ffffff');
    s.set(4, 3, '#ffffff');
    s.set(-2, 0, '#ff0000');
    s.set(0, 5, '#ff0000');
    expect(painted(s)).toEqual([
      [-1, -1],
      [4, 3],
    ]);
  });

  it('outlines a shape on all four sides, even past the edge of its box', () => {
    const s = new Sprite(3, 3);
    s.set(-1, 1, '#ffffff');
    s.outline('#000000');
    expect(s.get(-1, 1)).toBe('#ffffff');
    for (const [x, y] of [
      [-2, 1],
      [0, 1],
      [-1, 0],
      [-1, 2],
    ]) {
      expect(s.get(x, y)).toBe('#000000');
    }
    expect(painted(s)).toHaveLength(5);
  });

  it('fills rectangles, ellipses, thick lines and polygons on the grid', () => {
    const rect = new Sprite(8, 8);
    rect.rect(1, 2, 3, 2, '#ffffff');
    expect(painted(rect)).toHaveLength(6);

    const ell = new Sprite(9, 9);
    ell.ell(4.5, 4.5, 3, 3, '#ffffff');
    const cells = painted(ell);
    // symmetric about its centre
    for (const [x, y] of cells) expect(ell.get(8 - x, 8 - y)).toBe('#ffffff');
    expect(cells.length).toBeGreaterThan(20);

    const line = new Sprite(10, 10);
    // 2px thick from x 1 to 8: columns 1..9, rows 1..2
    line.line(1, 1, 8, 1, '#ffffff', 2);
    expect(painted(line)).toHaveLength(18);

    const tri = new Sprite(10, 10);
    tri.poly(
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
      '#ffffff',
    );
    expect(tri.get(1, 1)).toBe('#ffffff');
    expect(tri.get(7, 7)).toBeNull();
  });

  it('bakes the sprite and its silhouette in each plate, margin included', () => {
    const s = new Sprite(2, 1);
    s.set(0, 0, '#102030');
    s.set(1, 0, '#405060');
    const baked = s.bake(PLATES);
    expect([baked.image.width, baked.image.height]).toEqual([
      2 + 2 * baked.margin,
      1 + 2 * baked.margin,
    ]);
    expect(pixelAt(baked.image, baked.margin, 0, 0)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(pixelAt(baked.image, baked.margin, 1, 0)).toEqual([0x40, 0x50, 0x60, 255]);
    expect(pixelAt(baked.cyan, baked.margin, 1, 0)).toEqual([0x22, 0xd3, 0xee, 255]);
    expect(pixelAt(baked.magenta, baked.margin, 0, 0)).toEqual([0xf0, 0x46, 0x8f, 255]);
    expect(pixelAt(baked.cyan, baked.margin, -1, 0)[3]).toBe(0);
  });
});

describe('placing sprites', () => {
  const sprite = () => {
    const s = new Sprite(10, 6);
    s.rect(0, 0, 10, 6, '#ffffff');
    return s.bake(PLATES);
  };

  it('stands the box on its bottom centre, the plates set off either side', () => {
    const baked = sprite();
    const g = createFakeContext2d(makeCanvas(1, 1));
    // t = 0: the plates' jitter is at rest
    drawBaked(g, baked, 50, 40, 2, 0);
    const m = baked.margin;
    expect(g.draws.map((d) => d.args)).toEqual([
      [45 - m - 2, 34 - m],
      [45 - m + 2, 34 - m],
      [45 - m, 34 - m],
    ]);
  });

  it('lines the plates up under the sprite when there is no offset', () => {
    const g = createFakeContext2d(makeCanvas(1, 1));
    drawBaked(g, sprite(), 50, 40, 0, 0.3);
    const [cyan, magenta, image] = g.draws.map((d) => d.args);
    expect(cyan).toEqual(image);
    expect(magenta).toEqual(image);
  });

  it('draws a glitch one row at a time, each row shifted', () => {
    const baked = sprite();
    const g = createFakeContext2d(makeCanvas(1, 1));
    drawBaked(g, baked, 50, 40, 0, 0, (row) => (row % 2 ? 3 : 0));
    const rows = baked.image.height;
    expect(g.draws).toHaveLength(rows * 3);
    const [, , , , dx0] = g.draws[0].args;
    const [, , , , dx1] = g.draws[1].args;
    expect(dx1 - dx0).toBe(3);
  });

  it('puts a plain sprite with its box at the given top left', () => {
    const baked = sprite();
    const g = createFakeContext2d(makeCanvas(1, 1));
    drawPlain(g, baked, 12, 7);
    expect(g.draws[0].args).toEqual([12 - baked.margin, 7 - baked.margin]);
  });
});

describe('drawStage', () => {
  const pairs = CAST.flatMap((cast) => BACKDROPS.map((backdrop) => [cast, backdrop]));

  it.each(pairs.map(([c, b]) => [c.key, b.key, c, b]))(
    '%s on %s: plays the whole loop and leaves the canvas as it found it',
    (_c, _b, cast, backdrop) => {
      const ctx = makeCanvas(1200, 480).getContext('2d');
      const buffers = new StageBuffers();
      for (let t = 0; t <= CYCLE; t += 0.05) {
        drawStage(ctx, t, {
          cast,
          backdrop,
          palette: PALETTE,
          buffers,
          scale: 2,
          bufferSeconds: 15,
        });
        expect(ctx.depth).toBe(0);
        expect(ctx.globalAlpha).toBe(1);
        expect(ctx.globalCompositeOperation).toBe('source-over');
      }
      expect(ctx.underflow).toBe(false);
      expect(ctx.draws.length).toBeGreaterThan(0);
    },
  );

  it('never cuts an outline: only outline reaches the edge of a baked sprite', () => {
    // the loops above baked every pose the cast takes; a sprite's outermost
    // ring may hold its outline (or the plates' copy of it), never its body
    const edge = new Set(['170f20', '07060b', '22d3ee', 'f0468f']);
    const hex = (d, i) =>
      [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    expect(putImages.length).toBeGreaterThan(60);
    for (const { image } of putImages) {
      const { width, height, data } = image;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (x > 0 && y > 0 && x < width - 1 && y < height - 1) continue;
          const i = (y * width + x) * 4;
          if (data[i + 3]) expect(edge).toContain(hex(data, i));
        }
      }
    }
  });

  it('cuts the character out with nothing behind it: no backdrop, no shadow', () => {
    const target = makeCanvas(LW, LH);
    const g = target.getContext('2d');
    for (const cast of CAST) {
      for (let t = -1; t < CYCLE; t += 0.1) {
        for (const backdrop of BACKDROPS) {
          g.fillStyles.clear();
          g.draws.length = 0;
          renderVideo(target, t, cast, backdrop, PLATES, false);
          expect(g.fillStyles.has(SHADOW)).toBe(false);
          expect(g.draws.some((d) => d.w === LW && d.h === LH)).toBe(false);
          expect(g.draws.length).toBeGreaterThan(0);
        }
      }
    }
    // the VHS's PLAY belongs to the clip, so the cut-out keeps it
    const vhs = CAST.find((c) => c.key === 'vhs');
    g.fillStyles.clear();
    renderVideo(target, 4, vhs, BACKDROPS[0], PLATES, false);
    expect(g.fillStyles.has('#ffffff')).toBe(true);
    g.fillStyles.clear();
    renderVideo(target, 1, vhs, BACKDROPS[0], PLATES, false);
    expect(g.fillStyles.size).toBe(0);
    // with the backdrop, both are there
    g.fillStyles.clear();
    g.draws.length = 0;
    renderVideo(target, 1, CAST[0], BACKDROPS[0], PLATES);
    expect(g.fillStyles.has(SHADOW)).toBe(true);
    expect(g.draws.some((d) => d.w === LW && d.h === LH)).toBe(true);
  });
});
