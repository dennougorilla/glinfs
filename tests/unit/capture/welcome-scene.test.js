import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKDROPS } from '../../../src/features/capture/welcome/backdrops.js';
import { CAST } from '../../../src/features/capture/welcome/cast.js';
import {
  BEATS,
  CYCLE,
  frameTime,
  mod,
  pickForLoop,
  STRIP,
} from '../../../src/features/capture/welcome/timeline.js';
import { createWelcomeScene } from '../../../src/features/capture/welcome-scene.js';

/**
 * The capture screen's welcome scene: who stars in which loop, when the
 * strip's frames were recorded, and the scene's DOM and lifecycle. The
 * drawing itself needs a real canvas and is covered end to end by
 * tests/e2e/welcome-scene.spec.js.
 */

describe('casting (pickForLoop)', () => {
  it('is deterministic for a seed and loop', () => {
    for (let loop = 0; loop < 50; loop++) {
      expect(pickForLoop(1234, loop, 4, 2)).toEqual(pickForLoop(1234, loop, 4, 2));
    }
  });

  it('never casts the same character in two loops in a row', () => {
    for (const seed of [1, 42, 99_991, 2 ** 30]) {
      let previous = -1;
      for (let loop = 0; loop < 400; loop++) {
        const { cast } = pickForLoop(seed, loop, 4, 2);
        expect(cast).not.toBe(previous);
        previous = cast;
      }
    }
  });

  it('gives every character a turn in every round of four loops', () => {
    for (let round = 0; round < 25; round++) {
      const casts = new Set();
      for (let i = 0; i < 4; i++) casts.add(pickForLoop(7, round * 4 + i, 4, 2).cast);
      expect(casts.size).toBe(4);
    }
  });

  it('picks backdrops from the available ones, and uses both', () => {
    const seen = new Set();
    for (let loop = 0; loop < 100; loop++) {
      const { backdrop } = pickForLoop(5, loop, 4, 2);
      expect(backdrop === 0 || backdrop === 1).toBe(true);
      seen.add(backdrop);
    }
    expect(seen.size).toBe(2);
  });

  it('handles casts of one and two', () => {
    expect(pickForLoop(3, 9, 1, 2).cast).toBe(0);
    const pair = Array.from({ length: 6 }, (_, loop) => pickForLoop(3, loop, 2, 2).cast);
    for (let i = 1; i < pair.length; i++) expect(pair[i]).not.toBe(pair[i - 1]);
  });

  it('casts the scene from the real cast and backdrops', () => {
    expect(CAST.map((c) => c.key)).toEqual(['cat', 'tv', 'vhs', 'skater']);
    expect(BACKDROPS.map((b) => b.key)).toEqual(['synthwave', 'night']);
    for (const member of CAST) {
      // the GIF loops the jump: the moment starts before the leap and ends after the landing
      expect(member.m0).toBeLessThan(2.8);
      expect(member.m1).toBeGreaterThan(3.4);
      expect(member.crop.w / member.crop.h).toBeCloseTo(4 / 3, 2);
    }
  });
});

describe('timeline', () => {
  it('dates the strip frame at "now" to the moment the strip stops', () => {
    // the frame that reaches "now" just as the strip stops was recorded at that moment
    const k = (STRIP.now + STRIP.scroll) / STRIP.pitch;
    expect(frameTime(k)).toBeCloseTo((BEATS.stripStop[1] / 100) * CYCLE, 5);
  });

  it('dates frames recorded before the loop with negative times', () => {
    expect(frameTime(0)).toBeLessThan(0);
    expect(frameTime(STRIP.frames - 1)).toBeLessThanOrEqual(CYCLE);
  });

  it('keeps mod positive for negative values', () => {
    expect(mod(-1, 4)).toBe(3);
    expect(mod(-8, 4)).toBe(0);
    expect(mod(5, 4)).toBe(1);
  });
});

describe('createWelcomeScene', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a decorative canvas box and hands back its stop', () => {
    const cleanups = [];
    const root = createWelcomeScene(15, cleanups);
    expect(root.classList.contains('welcome')).toBe(true);
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.welcome-scene > canvas.welcome-canvas')).not.toBeNull();
    expect(cleanups).toHaveLength(1);
    expect(() => {
      cleanups[0]();
      cleanups[0]();
    }).not.toThrow();
  });

  it('does not touch the canvas where it cannot draw (no layout observers)', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    createWelcomeScene(15, []);
    expect(getContext).not.toHaveBeenCalled();
  });

  it('works without a cleanup list', () => {
    expect(() => createWelcomeScene(30)).not.toThrow();
  });
});
