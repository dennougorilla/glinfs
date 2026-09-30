import { describe, expect, it } from 'vitest';
import {
  buildPromptInputs,
  chooseCandidate,
  expandBox,
  getEncoderSize,
  interiorPoint,
  isTrackingLost,
  logitsToProbability,
  maskIoU,
  maskStats,
  planAnchors,
  SAM_LABEL,
  toEncoderPoint,
  trackingPrompt,
} from '../../../src/features/ai-cutout/sam-prompts.js';

/**
 * A w×h mask with a filled rectangle [x0, x1) × [y0, y1)
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number, number]} rect
 * @param {number} [value]
 */
function rectMask(w, h, [x0, y0, x1, y1], value = 255) {
  const data = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = value;
  return data;
}

/**
 * @param {Uint8Array} data
 * @param {number} score
 * @param {number} index
 * @param {number} [w]
 * @param {number} [h]
 */
const cand = (data, score, index, w = 10, h = 10) => ({ data, width: w, height: h, score, index });

describe('encoder geometry', () => {
  it('resizes the long side to 1024 and rounds the other like SAM', () => {
    expect(getEncoderSize(1920, 1080)).toEqual({ width: 1024, height: 576 });
    expect(getEncoderSize(1080, 1920)).toEqual({ width: 576, height: 1024 });
    // Small frames are scaled up (SAM always encodes at 1024)
    expect(getEncoderSize(480, 270)).toEqual({ width: 1024, height: 576 });
    // int(x * scale + 0.5): 333 * (1024 / 500) = 681.98 -> 682
    expect(getEncoderSize(500, 333)).toEqual({ width: 1024, height: 682 });
    expect(getEncoderSize(64, 64, 32)).toEqual({ width: 32, height: 32 });
  });

  it('maps a click in fractions of the frame to encoder pixels', () => {
    const enc = getEncoderSize(1920, 1080);
    // A click at canvas pixel (960, 270) of the 1920×1080 source
    expect(toEncoderPoint({ x: 960 / 1920, y: 270 / 1080 }, enc)).toEqual([512, 144]);
    expect(toEncoderPoint({ x: 1, y: 1 }, enc)).toEqual([1024, 576]);
  });
});

describe('buildPromptInputs', () => {
  const encoderSize = { width: 1000, height: 500 };

  it('encodes keep/remove points and a padding point when there is no box', () => {
    const { coords, labels, count } = buildPromptInputs({
      points: [
        { x: 0.5, y: 0.5, mode: 'keep' },
        { x: 0.1, y: 0.2, mode: 'remove' },
      ],
      encoderSize,
    });
    expect(count).toBe(3);
    expect([...coords]).toEqual([500, 250, 100, 100, 0, 0]);
    expect([...labels]).toEqual([SAM_LABEL.KEEP, SAM_LABEL.REMOVE, SAM_LABEL.PAD]);
  });

  it('encodes a box as its two corners (labels 2 and 3) after the points', () => {
    const { coords, labels, count } = buildPromptInputs({
      points: [{ x: 0.5, y: 0.5, mode: 'keep' }],
      box: [0.1, 0.2, 0.3, 0.4],
      encoderSize,
    });
    expect(count).toBe(3);
    expect([...coords].map((v) => Math.round(v))).toEqual([500, 250, 100, 100, 300, 200]);
    expect([...labels]).toEqual([1, 2, 3]);
    // A box alone is a prompt too
    expect(buildPromptInputs({ points: [], box: [0, 0, 1, 1], encoderSize }).count).toBe(2);
  });

  it('refuses an empty prompt and too many points', () => {
    expect(() => buildPromptInputs({ points: [], encoderSize })).toThrow(RangeError);
    const many = Array.from({ length: 3 }, () => ({
      x: 0,
      y: 0,
      mode: /** @type {const} */ ('keep'),
    }));
    expect(() => buildPromptInputs({ points: many, encoderSize, maxPoints: 2 })).toThrow(
      /at most 2/,
    );
  });
});

describe('masks', () => {
  it('turns logits into probabilities (0 -> 128, SAM’s threshold is the Fit default)', () => {
    const out = logitsToProbability(Float32Array.from([9, -9, 0, 100, -100, 1, 2]), 2, 5);
    expect([...out]).toEqual([128, 255, 0, 186, 225]);
  });

  it('measures area and bounding box (fractions, right/bottom exclusive)', () => {
    const data = rectMask(10, 5, [2, 1, 6, 4]);
    expect(maskStats(data, 10, 5)).toEqual({ area: 12 / 50, box: [0.2, 0.2, 0.6, 0.8] });
    expect(maskStats(new Uint8Array(50), 10, 5)).toEqual({ area: 0, box: null });
    // Below the threshold is outside
    expect(maskStats(rectMask(10, 5, [0, 0, 10, 5], 127), 10, 5).area).toBe(0);
  });

  it('grows a box and clamps it to the frame', () => {
    expect(expandBox([0.2, 0.2, 0.6, 0.4], 0.1).map((v) => +v.toFixed(3))).toEqual([
      0.16, 0.18, 0.64, 0.42,
    ]);
    expect(expandBox([0, 0.5, 1, 1], 0.5)).toEqual([0, 0.25, 1, 1]);
  });

  it('finds a point deep inside the mask, not its centroid', () => {
    // An L shape: the centroid falls outside it
    const w = 20;
    const h = 20;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 6; x++) data[y * w + x] = 255;
    for (let y = 14; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 255;
    const p = /** @type {{ x: number, y: number }} */ (interiorPoint(data, w, h));
    const px = Math.floor(p.x * w);
    const py = Math.floor(p.y * h);
    expect(data[py * w + px]).toBe(255);
    // The corner square is the thickest part
    expect(px).toBeLessThan(6);
    expect(py).toBeGreaterThanOrEqual(14);
    expect(interiorPoint(new Uint8Array(4), 2, 2)).toBeNull();
    // Centre of a filled rectangle
    const r = /** @type {{ x: number, y: number }} */ (
      interiorPoint(rectMask(11, 11, [0, 0, 11, 11]), 11, 11)
    );
    expect([r.x, r.y]).toEqual([5.5 / 11, 5.5 / 11]);
  });

  it('computes IoU', () => {
    const a = rectMask(10, 10, [0, 0, 5, 10]);
    const b = rectMask(10, 10, [0, 0, 10, 5]);
    expect(maskIoU(a, b)).toBeCloseTo(25 / 75);
    expect(maskIoU(a, a)).toBe(1);
    expect(maskIoU(new Uint8Array(4), new Uint8Array(4))).toBe(1);
    expect(() => maskIoU(a, new Uint8Array(3))).toThrow(RangeError);
  });

  it('maps a mask pixel back to the frame by plain scaling (mask at the mask resolution)', () => {
    // A 1920×1080 frame has a 1024×576 mask; the box of a mask rectangle
    // is the same fraction of the frame
    const data = rectMask(1024, 576, [512, 144, 768, 432]);
    const { box } = /** @type {{ box: number[] }} */ (maskStats(data, 1024, 576));
    expect([box[0] * 1920, box[1] * 1080, box[2] * 1920, box[3] * 1080]).toEqual([
      960, 270, 1440, 810,
    ]);
    // And a click there comes back as the same encoder pixel as the mask pixel
    const enc = getEncoderSize(1920, 1080);
    expect(toEncoderPoint({ x: box[0], y: box[1] }, enc)).toEqual([512, 144]);
  });
});

describe('chooseCandidate', () => {
  const whole = rectMask(10, 10, [0, 0, 8, 8]); // 64
  const part = rectMask(10, 10, [0, 0, 4, 4]); // 16
  const sub = rectMask(10, 10, [0, 0, 2, 2]); // 4
  const empty = new Uint8Array(100);

  it('whole: the largest mask among the confident ones', () => {
    const c = [cand(part, 0.9, 0), cand(sub, 0.8, 1), cand(part, 0.95, 2), cand(whole, 0.85, 3)];
    expect(chooseCandidate(c, { scope: 'whole' }).index).toBe(3);
    // A big mask with a poor score is not the whole
    const poor = [cand(part, 0.95, 1), cand(whole, 0.5, 3)];
    expect(chooseCandidate(poor, { scope: 'whole' }).index).toBe(1);
  });

  it('part: the best-scoring mask smaller than the whole', () => {
    const c = [cand(whole, 0.97, 0), cand(sub, 0.8, 1), cand(part, 0.9, 2), cand(whole, 0.96, 3)];
    expect(chooseCandidate(c, { scope: 'part' }).index).toBe(2);
    // Nothing smaller: the whole
    expect(
      chooseCandidate([cand(whole, 0.9, 1), cand(empty, 0.99, 2)], { scope: 'part' }).index,
    ).toBe(1);
  });

  it('never picks an empty mask while a non-empty one exists', () => {
    expect(chooseCandidate([cand(empty, 0.99, 0), cand(sub, 0.2, 1)]).index).toBe(1);
    expect(chooseCandidate([cand(empty, 0.5, 0)]).index).toBe(0);
    expect(() => chooseCandidate([])).toThrow(RangeError);
  });

  it('tracked frames: the mask overlapping the previous one most', () => {
    const previous = rectMask(10, 10, [0, 0, 5, 5]);
    const c = [cand(whole, 0.99, 0), cand(part, 0.5, 1), cand(sub, 0.7, 2)];
    expect(chooseCandidate(c, { previous }).index).toBe(1);
  });
});

describe('tracking', () => {
  it('prompts the next frame with the grown box and a point inside the previous mask', () => {
    const previous = rectMask(100, 50, [20, 10, 60, 30]);
    const prompt = /** @type {NonNullable<ReturnType<typeof trackingPrompt>>} */ (
      trackingPrompt(previous, 100, 50)
    );
    expect(prompt.box.map((v) => +v.toFixed(3))).toEqual([0.16, 0.16, 0.64, 0.64]);
    expect(prompt.points).toHaveLength(1);
    const [p] = prompt.points;
    expect(p.mode).toBe('keep');
    expect(p.x).toBeGreaterThan(0.2);
    expect(p.x).toBeLessThan(0.6);
    expect(p.y).toBeGreaterThan(0.2);
    expect(p.y).toBeLessThan(0.6);
    expect(trackingPrompt(new Uint8Array(100 * 50), 100, 50)).toBeNull();
  });

  it('flags a lost object when the area jumps by more than half or vanishes', () => {
    expect(isTrackingLost(0.2, 0.25)).toBe(false);
    expect(isTrackingLost(0.2, 0.11)).toBe(false);
    expect(isTrackingLost(0.2, 0.09)).toBe(true);
    expect(isTrackingLost(0.2, 0.31)).toBe(true);
    expect(isTrackingLost(0.2, 0)).toBe(true);
    expect(isTrackingLost(0, 0.1)).toBe(false);
    expect(isTrackingLost(0.2, 0.35, 1)).toBe(false);
  });

  it('plans one anchor per clicked frame in the selection, the frame on screen first', () => {
    const picks = [
      { frame: 2, x: 0.1, y: 0.1, mode: /** @type {const} */ ('keep') },
      { frame: 9, x: 0.2, y: 0.2, mode: /** @type {const} */ ('keep') },
      { frame: 5, x: 0.3, y: 0.3, mode: /** @type {const} */ ('keep') },
      { frame: 5, x: 0.4, y: 0.4, mode: /** @type {const} */ ('remove') },
      { frame: 30, x: 0.5, y: 0.5, mode: /** @type {const} */ ('keep') },
    ];
    const anchors = planAnchors(picks, { start: 0, end: 20 }, 5);
    expect(anchors.map((a) => a.frame)).toEqual([5, 2, 9]);
    expect(anchors[0].points).toEqual([
      { x: 0.3, y: 0.3, mode: 'keep' },
      { x: 0.4, y: 0.4, mode: 'remove' },
    ]);
    expect(planAnchors(picks, { start: 10, end: 20 }, 12)).toEqual([]);
  });
});
