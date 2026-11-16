import { describe, expect, it } from 'vitest';
import {
  createObjectSeeds,
  dequantizeLogits,
  extendsPrompts,
  quantizeLogits,
} from '../../../src/features/ai-cutout/object-seeds.js';

const k0 = { frame: 0, x: 0.5, y: 0.5, mode: 'keep' };
const k3 = { frame: 3, x: 0.2, y: 0.4, mode: 'keep' };
const r3 = { frame: 3, x: 0.6, y: 0.4, mode: 'remove' };
const b5 = { frame: 5, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.5 };
const mask = (n = 8) => ({ data: new Uint8Array(n * n).fill(255), width: n, height: n });

describe('extendsPrompts', () => {
  const base = { clicks: [k0], boxes: [], scope: 'part' };
  it('is true for one more click or box with the same scope', () => {
    expect(extendsPrompts(base, { clicks: [k0, k3], boxes: [], scope: 'part' })).toBe(true);
    expect(extendsPrompts(base, { clicks: [k0, r3], boxes: [], scope: 'part' })).toBe(true);
    expect(extendsPrompts(base, { clicks: [k0], boxes: [b5], scope: 'part' })).toBe(true);
  });
  it('is false for the same prompts (a retry), a changed scope, or an undone click', () => {
    expect(extendsPrompts(base, { clicks: [k0], boxes: [], scope: 'part' })).toBe(false);
    expect(extendsPrompts(base, { clicks: [k0, k3], boxes: [], scope: 'whole' })).toBe(false);
    expect(
      extendsPrompts(
        { clicks: [k0, k3], boxes: [], scope: 'part' },
        { clicks: [k0], boxes: [], scope: 'part' },
      ),
    ).toBe(false);
    // As many prompts, one replaced: not an extension
    expect(
      extendsPrompts(
        { clicks: [k0, k3], boxes: [], scope: 'part' },
        { clicks: [k0, r3], boxes: [], scope: 'part' },
      ),
    ).toBe(false);
  });
  it('counts repeated clicks (a multiset)', () => {
    expect(
      extendsPrompts(
        { clicks: [k0, k0], boxes: [], scope: 'part' },
        { clicks: [k0, k3], boxes: [], scope: 'part' },
      ),
    ).toBe(false);
  });
});

describe('quantizeLogits', () => {
  it('keeps logits to a quarter step and clamps at about ±32', () => {
    const logits = Float32Array.of(-100, -3.3, 0, 0.1, 2.6, 31.9, 100);
    const back = dequantizeLogits(quantizeLogits(logits));
    expect([...back]).toEqual([-31.75, -3.25, 0, 0, 2.5, 31.75, 31.75]);
  });
});

describe('createObjectSeeds', () => {
  const made = { clicks: [k0], boxes: [], scope: 'whole' };
  const corrected = { clicks: [k0, k3], boxes: [], scope: 'whole' };

  it('hands a seed only to prompts that extend the ones that made it', () => {
    const seeds = createObjectSeeds();
    const logits = Float32Array.from({ length: 16 }, (_, i) => i - 8);
    seeds.set('o1', 'f3', mask(), logits, made);
    expect(seeds.get('o1', 'f3', made)).toBeNull();
    expect(seeds.get('o1', 'f3', { ...corrected, scope: 'part' })).toBeNull();
    const seed = seeds.get('o1', 'f3', corrected);
    expect(seed?.mask.width).toBe(8);
    expect([...(seed?.lowRes ?? [])]).toEqual([...logits]);
    expect(seeds.get('o2', 'f3', corrected)).toBeNull();
    expect(seeds.get('o1', 'f4', corrected)).toBeNull();
  });

  it('copies the prompts it was made with (later edits of the arrays do not change it)', () => {
    const seeds = createObjectSeeds();
    const clicks = [k0];
    seeds.set('o1', 'f3', mask(), null, { clicks, boxes: [], scope: 'whole' });
    clicks.push(k3);
    expect(seeds.get('o1', 'f3', { clicks: [k0, k3], boxes: [], scope: 'whole' })).not.toBeNull();
  });

  it('deletes the seed of a frame the last run cleared', () => {
    const seeds = createObjectSeeds();
    seeds.set('o1', 'f3', mask(), null, made);
    seeds.set('o1', 'f4', mask(), null, made);
    seeds.delete('o1', 'f3');
    expect(seeds.get('o1', 'f3', corrected)).toBeNull();
    expect(seeds.get('o1', 'f4', corrected)).not.toBeNull();
  });

  it("drops an object's seeds, and the oldest past the cap", () => {
    const seeds = createObjectSeeds({ capBytes: 3 * (64 + 256) });
    for (let f = 0; f < 3; f++) seeds.set('o1', `f${f}`, mask(), null, made);
    seeds.set('o2', 'f0', mask(), null, made);
    // Past the cap: the least recently used (o1 f0) went
    expect(seeds.get('o1', 'f0', corrected)).toBeNull();
    expect(seeds.get('o1', 'f2', corrected)).not.toBeNull();
    seeds.dropObject('o1');
    expect(seeds.get('o1', 'f2', corrected)).toBeNull();
    expect(seeds.get('o2', 'f0', corrected)).not.toBeNull();
    seeds.clear();
    expect(seeds.bytes).toBe(0);
  });
});
