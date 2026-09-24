import { describe, expect, it } from 'vitest';
import {
  clampFrameIndex,
  formatSelectionInfo,
  getAffectedRangeIndices,
  getFrameSelectionState,
  isSceneSelected,
  selectByClick,
  selectEnd,
  selectSingleFrame,
  selectStart,
} from '../../../src/features/editor/frame-grid/selection.js';

describe('clampFrameIndex', () => {
  it('clamps into [0, frameCount - 1]', () => {
    expect(clampFrameIndex(-3, 10)).toBe(0);
    expect(clampFrameIndex(4, 10)).toBe(4);
    expect(clampFrameIndex(10, 10)).toBe(9);
  });
});

describe('selectStart', () => {
  it('keeps an End that is still after the new Start', () => {
    expect(selectStart({ start: 2, end: 8 }, 5)).toEqual({ start: 5, end: 8 });
  });

  it('keeps an End equal to the new Start', () => {
    expect(selectStart({ start: 2, end: 5 }, 5)).toEqual({ start: 5, end: 5 });
  });

  it('clears an End that would precede the new Start', () => {
    expect(selectStart({ start: 2, end: 4 }, 6)).toEqual({ start: 6, end: null });
  });

  it('sets Start on an empty selection', () => {
    expect(selectStart({ start: null, end: null }, 3)).toEqual({ start: 3, end: null });
  });

  it('does not mutate the input', () => {
    const selection = { start: 2, end: 4 };
    selectStart(selection, 6);
    expect(selection).toEqual({ start: 2, end: 4 });
  });
});

describe('selectEnd', () => {
  it('keeps a Start before the new End', () => {
    expect(selectEnd({ start: 2, end: null }, 7)).toEqual({ start: 2, end: 7 });
  });

  it('collapses to IN=OUT when the End precedes Start', () => {
    expect(selectEnd({ start: 6, end: 9 }, 3)).toEqual({ start: 3, end: 3 });
  });

  it('collapses to IN=OUT when there is no Start', () => {
    expect(selectEnd({ start: null, end: null }, 4)).toEqual({ start: 4, end: 4 });
  });
});

describe('selectByClick', () => {
  it('sets Start on a plain click', () => {
    expect(selectByClick({ start: 2, end: 8 }, 5, false)).toEqual({ start: 5, end: 8 });
  });

  it('sets End on Shift+click once a Start exists', () => {
    expect(selectByClick({ start: 2, end: 8 }, 5, true)).toEqual({ start: 2, end: 5 });
  });

  it('Shift+click before Start collapses to that frame', () => {
    expect(selectByClick({ start: 4, end: 9 }, 1, true)).toEqual({ start: 1, end: 1 });
  });

  it('Shift+click without a Start falls back to setting Start', () => {
    expect(selectByClick({ start: null, end: null }, 5, true)).toEqual({ start: 5, end: null });
  });
});

describe('selectSingleFrame', () => {
  it('selects exactly one frame', () => {
    expect(selectSingleFrame(7)).toEqual({ start: 7, end: 7 });
  });
});

describe('isSceneSelected', () => {
  const scene = { startFrame: 3, endFrame: 9 };

  it('matches only the exact scene range', () => {
    expect(isSceneSelected({ start: 3, end: 9 }, scene)).toBe(true);
    expect(isSceneSelected({ start: 3, end: 8 }, scene)).toBe(false);
    expect(isSceneSelected({ start: 3, end: null }, scene)).toBe(false);
  });
});

describe('getFrameSelectionState', () => {
  const range = { start: 2, end: 5 };

  it('marks the Start with an IN badge', () => {
    expect(getFrameSelectionState(2, range)).toEqual({
      isStart: true,
      isEnd: false,
      inRange: true,
      badges: [{ variant: 'start', label: 'IN' }],
    });
  });

  it('marks the End with an OUT badge', () => {
    expect(getFrameSelectionState(5, range)).toEqual({
      isStart: false,
      isEnd: true,
      inRange: true,
      badges: [{ variant: 'end', label: 'OUT' }],
    });
  });

  it('marks frames between Start and End as in range without badges', () => {
    expect(getFrameSelectionState(3, range)).toEqual({
      isStart: false,
      isEnd: false,
      inRange: true,
      badges: [],
    });
    expect(getFrameSelectionState(6, range).inRange).toBe(false);
  });

  it('uses a single IN=OUT badge for a one-frame selection', () => {
    expect(getFrameSelectionState(4, { start: 4, end: 4 })).toEqual({
      isStart: true,
      isEnd: true,
      inRange: true,
      badges: [{ variant: 'single', label: 'IN=OUT' }],
    });
  });

  it('treats a Start without End as a one-frame range with only an IN badge', () => {
    const selection = { start: 4, end: null };
    expect(getFrameSelectionState(4, selection)).toEqual({
      isStart: true,
      isEnd: false,
      inRange: true,
      badges: [{ variant: 'start', label: 'IN' }],
    });
    expect(getFrameSelectionState(5, selection).inRange).toBe(false);
  });

  it('marks nothing when there is no selection', () => {
    expect(getFrameSelectionState(0, { start: null, end: null })).toEqual({
      isStart: false,
      isEnd: false,
      inRange: false,
      badges: [],
    });
  });
});

describe('getAffectedRangeIndices', () => {
  it('unions the old and new ranges', () => {
    expect([...getAffectedRangeIndices(1, 3, 6, 7)].sort((a, b) => a - b)).toEqual([1, 2, 3, 6, 7]);
  });

  it('treats a missing End as a single frame', () => {
    expect([...getAffectedRangeIndices(4, null, null, null)]).toEqual([4]);
  });

  it('is empty when neither range has a Start', () => {
    expect(getAffectedRangeIndices(null, null, null, null).size).toBe(0);
  });
});

describe('formatSelectionInfo', () => {
  it('prompts when nothing is selected', () => {
    expect(formatSelectionInfo({ start: null, end: null })).toBe(
      'Click [S] to set Start, [E] to set End',
    );
  });

  it('prompts for End when only Start is set', () => {
    expect(formatSelectionInfo({ start: 4, end: null })).toBe(
      'Start: Frame 5 — Click [E] on another frame',
    );
  });

  it('describes a range with a plural frame count', () => {
    expect(formatSelectionInfo({ start: 2, end: 7 })).toBe(
      'Selection: Frame 3 → Frame 8 (6 frames)',
    );
  });

  it('uses the singular for one frame', () => {
    expect(formatSelectionInfo({ start: 3, end: 3 })).toBe(
      'Selection: Frame 4 → Frame 4 (1 frame)',
    );
  });
});
