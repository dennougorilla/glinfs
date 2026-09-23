import { describe, expect, it } from 'vitest';
import { getPlaybackFrame } from '../../../src/features/editor/core.js';

/**
 * Reference model: the old loop, stepping one frame per tick and wrapping
 * past range.end back to range.start
 * @param {number} frame
 * @param {number} steps
 * @param {{ start: number, end: number }} range
 * @returns {number}
 */
function stepOneAtATime(frame, steps, range) {
  let current = frame;
  for (let i = 0; i < steps; i++) {
    current = current + 1 > range.end ? range.start : current + 1;
  }
  return current;
}

describe('getPlaybackFrame (issue #99a playback clock)', () => {
  const fullRange = { start: 0, end: 9 };

  it('stays on the anchor frame before one frame interval has elapsed', () => {
    expect(getPlaybackFrame({ anchorFrame: 3, elapsedMs: 0, fps: 30, range: fullRange })).toBe(3);
    expect(getPlaybackFrame({ anchorFrame: 3, elapsedMs: 33, fps: 30, range: fullRange })).toBe(3);
  });

  it('advances one frame per 1/fps of elapsed time', () => {
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 34, fps: 30, range: fullRange })).toBe(1);
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 100, fps: 30, range: fullRange })).toBe(3);
  });

  it('lands exactly on frame boundaries despite float error', () => {
    const range = { start: 0, end: 999 };
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 30, range })).toBe(30);
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000 / 3, fps: 30, range })).toBe(10);
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 60, range })).toBe(60);
  });

  it('catches up multiple frames after a long gap between ticks', () => {
    const range = { start: 0, end: 299 };
    // A single tick delayed by 500ms at 30fps must skip ahead 15 frames
    expect(getPlaybackFrame({ anchorFrame: 10, elapsedMs: 500, fps: 30, range })).toBe(25);
  });

  it('wraps within the selected range, matching one-frame-at-a-time stepping', () => {
    const range = { start: 5, end: 14 };
    for (const anchorFrame of [5, 9, 14]) {
      for (let steps = 0; steps <= 35; steps++) {
        const elapsedMs = (steps * 1000) / 20;
        expect(getPlaybackFrame({ anchorFrame, elapsedMs, fps: 20, range })).toBe(
          stepOneAtATime(anchorFrame, steps, range),
        );
      }
    }
  });

  it('wraps correctly after a gap spanning many loops', () => {
    const range = { start: 5, end: 14 };
    // 10s at 30fps = 300 frames = 30 full loops of 10 frames
    expect(getPlaybackFrame({ anchorFrame: 7, elapsedMs: 10_000, fps: 30, range })).toBe(7);
    expect(getPlaybackFrame({ anchorFrame: 7, elapsedMs: 10_100, fps: 30, range })).toBe(10);
  });

  it('keeps the old semantics for a playhead outside the range', () => {
    const range = { start: 5, end: 14 };
    for (const anchorFrame of [0, 3, 18]) {
      for (let steps = 0; steps <= 25; steps++) {
        const elapsedMs = (steps * 1000) / 10;
        expect(getPlaybackFrame({ anchorFrame, elapsedMs, fps: 10, range })).toBe(
          stepOneAtATime(anchorFrame, steps, range),
        );
      }
    }
  });

  it('honors fps variations', () => {
    const range = { start: 0, end: 999 };
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 15, range })).toBe(15);
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 24, range })).toBe(24);
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 60, range })).toBe(60);
    expect(getPlaybackFrame({ anchorFrame: 0, elapsedMs: 50, fps: 15, range })).toBe(0);
  });

  it('scales with playback speed', () => {
    const range = { start: 0, end: 999 };
    expect(
      getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 30, playbackSpeed: 2, range }),
    ).toBe(60);
    expect(
      getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 30, playbackSpeed: 0.5, range }),
    ).toBe(15);
  });

  it('never steps backward when the tick timestamp precedes the anchor', () => {
    expect(getPlaybackFrame({ anchorFrame: 4, elapsedMs: -8, fps: 30, range: fullRange })).toBe(4);
  });

  it('keeps position across pause/resume by re-anchoring at the paused frame', () => {
    const range = { start: 0, end: 99 };
    // Play 1s at 30fps, pause for 10s (clock stopped), resume from the paused frame
    const paused = getPlaybackFrame({ anchorFrame: 0, elapsedMs: 1000, fps: 30, range });
    expect(paused).toBe(30);
    expect(getPlaybackFrame({ anchorFrame: paused, elapsedMs: 0, fps: 30, range })).toBe(30);
    expect(getPlaybackFrame({ anchorFrame: paused, elapsedMs: 500, fps: 30, range })).toBe(45);
  });

  it('handles a single-frame range', () => {
    const range = { start: 4, end: 4 };
    expect(getPlaybackFrame({ anchorFrame: 4, elapsedMs: 5000, fps: 30, range })).toBe(4);
  });
});
