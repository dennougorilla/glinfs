import { describe, expect, it } from 'vitest';
import {
  frameToPercent,
  frameToThumbnailSlot,
  getThumbnailFrameIndices,
  percentToFrame,
} from '../../../src/features/editor/timeline-mapping.js';

describe('timeline-mapping (issue #99, fix 1)', () => {
  describe('getThumbnailFrameIndices', () => {
    it('the 117-frame example: last thumbnail must be frame 116', () => {
      const indices = getThumbnailFrameIndices(117, 30);

      expect(indices.length).toBe(30);
      expect(indices[0]).toBe(0);
      expect(indices[indices.length - 1]).toBe(116);
    });

    it('produces monotonically non-decreasing frame indices', () => {
      const indices = getThumbnailFrameIndices(117, 30);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
      }
    });

    it('returns exactly totalFrames indices when totalFrames < thumbnailCount', () => {
      const indices = getThumbnailFrameIndices(5, 30);
      expect(indices).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns a single index [0] for a 1-frame clip', () => {
      expect(getThumbnailFrameIndices(1, 30)).toEqual([0]);
    });

    it('returns [] for 0 frames', () => {
      expect(getThumbnailFrameIndices(0, 30)).toEqual([]);
    });

    it('always includes the last frame when totalFrames > 1', () => {
      for (const total of [2, 3, 31, 60, 200, 450]) {
        const indices = getThumbnailFrameIndices(total, 30);
        expect(indices[indices.length - 1]).toBe(total - 1);
        expect(indices[0]).toBe(0);
      }
    });
  });

  describe('frameToPercent / percentToFrame agree with the filmstrip mapping', () => {
    it('selection at 100% aligns with the last thumbnail slot right edge (117 frames)', () => {
      const totalFrames = 117;
      const indices = getThumbnailFrameIndices(totalFrames, 30);
      const lastThumbnailFrame = indices[indices.length - 1];

      // The filmstrip lays out `indices.length` equal-width flex boxes over
      // the full 0-100% track, so the last thumbnail's right edge is at 100%.
      // The selection layer must land on that exact same 100% for its end
      // frame to be the last thumbnail's frame.
      expect(frameToPercent(lastThumbnailFrame, totalFrames)).toBe(100);
      expect(frameToPercent(0, totalFrames)).toBe(0);
    });

    it('round-trips frame -> percent -> frame', () => {
      const totalFrames = 117;
      for (const frame of [0, 1, 50, 116]) {
        const percent = frameToPercent(frame, totalFrames);
        expect(percentToFrame(percent, totalFrames)).toBe(frame);
      }
    });

    it('percentToFrame clamps to [0, totalFrames - 1]', () => {
      expect(percentToFrame(-10, 117)).toBe(0);
      expect(percentToFrame(110, 117)).toBe(116);
    });

    it('single-frame clip: frameToPercent never divides by zero', () => {
      expect(frameToPercent(0, 1)).toBe(0);
      expect(percentToFrame(50, 1)).toBe(0);
    });
  });

  describe('frameToThumbnailSlot', () => {
    it('maps frame 116 (last frame, 117-frame clip) to the last slot (29)', () => {
      expect(frameToThumbnailSlot(116, 117, 30)).toBe(29);
    });

    it('maps frame 0 to slot 0', () => {
      expect(frameToThumbnailSlot(0, 117, 30)).toBe(0);
    });

    it('returns -1 for an empty clip', () => {
      expect(frameToThumbnailSlot(0, 0, 30)).toBe(-1);
    });
  });
});
