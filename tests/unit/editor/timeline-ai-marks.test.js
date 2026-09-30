import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import { maskKey } from '../../../src/features/ai-cutout/segmentation-manager.js';
import {
  AI_MARK,
  attachTimelineAiMarks,
  bucketMarkStates,
  computeAiMarkSegments,
  computeFrameMarkStates,
  describeAiMarks,
  runLengthEncode,
} from '../../../src/features/editor/timeline-ai-marks.js';

const { OUTSIDE: O, PENDING: P, ANALYZED: A } = AI_MARK;

/** @param {number} n */
const makeFrames = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}` }));

describe('computeFrameMarkStates', () => {
  it('marks the selection analyzed/pending and leaves the rest outside', () => {
    const frames = makeFrames(6);
    const analyzed = new Set(['f2', 'f3']);
    const result = computeFrameMarkStates(frames, { start: 1, end: 4 }, (f) => analyzed.has(f.id));
    expect([...result.states]).toEqual([O, P, A, A, P, O]);
    expect(result.analyzed).toBe(2);
    expect(result.selected).toBe(4);
  });

  it('clamps a range beyond the clip', () => {
    const result = computeFrameMarkStates(makeFrames(3), { start: -2, end: 9 }, () => true);
    expect([...result.states]).toEqual([A, A, A]);
    expect(result.selected).toBe(3);
  });

  it('handles an empty clip', () => {
    const result = computeFrameMarkStates([], { start: 0, end: 0 }, () => true);
    expect(result.states.length).toBe(0);
    expect(result.selected).toBe(0);
  });
});

describe('runLengthEncode', () => {
  it('merges consecutive equal states', () => {
    expect(runLengthEncode([O, P, P, A, A, A, P, O])).toEqual([
      { start: 0, end: 0, state: O },
      { start: 1, end: 2, state: P },
      { start: 3, end: 5, state: A },
      { start: 6, end: 6, state: P },
      { start: 7, end: 7, state: O },
    ]);
  });

  it('returns no runs for no frames and one run for uniform states', () => {
    expect(runLengthEncode([])).toEqual([]);
    expect(runLengthEncode(new Uint8Array(3600).fill(A))).toEqual([
      { start: 0, end: 3599, state: A },
    ]);
  });
});

describe('bucketMarkStates', () => {
  it('covers every column when frames are denser than pixels', () => {
    const states = new Uint8Array(3600).fill(A);
    const buckets = bucketMarkStates(states, 997);
    expect(buckets.length).toBe(997);
    expect(buckets.every((s) => s === A)).toBe(true);
  });

  it('lets pending win over analyzed inside a column', () => {
    // 9 frames -> 2 columns; one pending frame in the right half
    const states = [A, A, A, A, A, A, A, P, A];
    expect([...bucketMarkStates(states, 2)]).toEqual([A, P]);
  });

  it('keeps columns outside the selection transparent', () => {
    const states = new Uint8Array(100);
    states.fill(A, 50);
    const buckets = bucketMarkStates(states, 10);
    expect([...buckets.slice(0, 4)]).toEqual([O, O, O, O]);
    expect([...buckets.slice(6)]).toEqual([A, A, A, A]);
  });
});

describe('computeAiMarkSegments', () => {
  it('draws per-frame runs with half-frame edges when frames fit', () => {
    // 5 frames at 0, .25, .5, .75, 1 -> frame i spans (i - .5) / 4 .. (i + .5) / 4
    const segments = computeAiMarkSegments([O, A, A, P, O], 100);
    expect(segments).toEqual([
      { x0: 0.125, x1: 0.625, state: A },
      { x0: 0.625, x1: 0.875, state: P },
    ]);
  });

  it('spans the whole track for a full selection', () => {
    expect(computeAiMarkSegments([A, A, A], 10)).toEqual([{ x0: 0, x1: 1, state: A }]);
  });

  it('handles a single frame', () => {
    expect(computeAiMarkSegments([P], 10)).toEqual([{ x0: 0, x1: 1, state: P }]);
  });

  it('buckets 3,600 frames into at most one run per column pair', () => {
    const states = new Uint8Array(3600).fill(P);
    states.fill(A, 0, 1200);
    const segments = computeAiMarkSegments(states, 1000);
    expect(segments.length).toBe(2);
    expect(segments[0].state).toBe(A);
    expect(segments[0].x0).toBe(0);
    expect(segments[1].state).toBe(P);
    expect(segments[1].x1).toBe(1);
    // The boundary lands near a third of the track
    expect(segments[0].x1).toBeCloseTo(1 / 3, 2);
  });

  it('returns nothing without frames or width', () => {
    expect(computeAiMarkSegments([], 100)).toEqual([]);
    expect(computeAiMarkSegments([A], 0)).toEqual([]);
  });
});

describe('describeAiMarks', () => {
  it('says how many frames of the selection are analyzed', () => {
    expect(describeAiMarks(34, 60)).toBe('34 of 60 frames analyzed');
    expect(describeAiMarks(1, 1)).toBe('1 of 1 frame analyzed');
  });
});

describe('attachTimelineAiMarks', () => {
  /** @type {FrameRequestCallback[]} */
  let rafQueue;
  const flush = () => {
    const queue = rafQueue;
    rafQueue = [];
    for (const cb of queue) cb(0);
  };

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function setup(background) {
    const container = document.createElement('div');
    container.innerHTML =
      '<div class="tl"><div class="tl-track"><div class="tl-filmstrip"></div><div class="tl-selection-layer"></div></div></div>';
    document.body.appendChild(container);
    const frames = makeFrames(10);
    let state = { clip: { frames }, selectedRange: { start: 2, end: 7 }, edits: { background } };
    const listeners = new Set();
    const editorStore = {
      getState: () => state,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      setState: (next) => {
        const prev = state;
        state = { ...state, ...next };
        for (const fn of listeners) fn(state, prev);
      },
    };
    const maskStore = createMaskStore();
    const cleanup = attachTimelineAiMarks(container, {
      getState: editorStore.getState,
      subscribe: editorStore.subscribe,
      maskStore,
    });
    const holder = /** @type {HTMLElement} */ (
      container.querySelector('.editor-timeline-ai-marks')
    );
    return { container, frames, editorStore, maskStore, cleanup, holder };
  }

  const mask = { width: 1, height: 1, data: new Uint8Array(1) };
  const aiOn = { enabled: true, method: 'ai', ai: { model: 'anime' } };

  it('sits right after the filmstrip, hidden until an AI subject is on', () => {
    const { holder, editorStore } = setup({ enabled: false, method: 'color' });
    expect(holder.previousElementSibling?.className).toBe('tl-filmstrip');
    expect(holder.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    flush();
    expect(holder.hidden).toBe(true);

    editorStore.setState({ edits: { background: aiOn } });
    flush();
    expect(holder.hidden).toBe(false);
    expect(holder.getAttribute('aria-description')).toBe('0 of 6 frames analyzed');
  });

  it('follows the mask store of the current model, once per animation frame', () => {
    const { holder, frames, maskStore } = setup(aiOn);
    flush();
    maskStore.set(maskKey(frames[2], 'anime'), mask);
    maskStore.set(maskKey(frames[3], 'anime'), mask);
    // Another model's mask and a frame outside the selection do not count
    maskStore.set(maskKey(frames[4], 'general'), mask);
    maskStore.set(maskKey(frames[0], 'anime'), mask);
    expect(rafQueue.length).toBe(1);
    flush();
    expect(holder.dataset.analyzed).toBe('2');
    expect(holder.dataset.selected).toBe('6');
  });

  it('hides for Solid color and Off, and repaints on selection changes', () => {
    const { holder, editorStore } = setup(aiOn);
    flush();
    editorStore.setState({ selectedRange: { start: 0, end: 9 } });
    flush();
    expect(holder.dataset.selected).toBe('10');

    editorStore.setState({ edits: { background: { ...aiOn, method: 'color' } } });
    flush();
    expect(holder.hidden).toBe(true);
    expect(holder.hasAttribute('aria-description')).toBe(false);

    editorStore.setState({ edits: { background: { ...aiOn, enabled: false } } });
    flush();
    expect(holder.hidden).toBe(true);
  });

  it('ignores playback ticks', () => {
    const { editorStore } = setup(aiOn);
    flush();
    editorStore.setState({ currentFrame: 5 });
    expect(rafQueue.length).toBe(0);
  });

  it('removes the track and stops listening on cleanup', () => {
    const { container, maskStore, frames, cleanup } = setup(aiOn);
    cleanup();
    expect(container.querySelector('.editor-timeline-ai-marks')).toBeNull();
    rafQueue = [];
    maskStore.set(maskKey(frames[2], 'anime'), mask);
    expect(rafQueue.length).toBe(0);
  });
});
