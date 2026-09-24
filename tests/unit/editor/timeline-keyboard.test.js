import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClip } from '../../../src/features/editor/core.js';
import { renderTimeline } from '../../../src/features/editor/timeline.js';
import { countHotkeys, registerHotkey } from '../../../src/shared/hotkeys.js';

/**
 * #102 review: the focused timeline claims Arrow/Home/End only when the key
 * actually moves the range. Otherwise (full range, range against a clip
 * edge) the key falls through to the dispatcher's route hotkeys so the
 * playhead seeks — exactly one action per keypress. Ctrl/Meta/Alt combos
 * and IME keystrokes are never the timeline's.
 */

/**
 * @param {string} id
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id) {
  return {
    id,
    data: /** @type {ImageData} */ ({
      data: new Uint8ClampedArray(100 * 100 * 4),
      width: 100,
      height: 100,
    }),
    timestamp: 0,
    width: 100,
    height: 100,
  };
}

const TOTAL_FRAMES = 30;

/** @type {(() => void)[]} */
let cleanups = [];
/** @type {HTMLElement} */
let container;

/**
 * @param {import('../../../src/features/editor/types.js').FrameRange} [range]
 */
function mountTimeline(range) {
  const frames = Array.from({ length: TOTAL_FRAMES }, (_, i) => createMockFrame(String(i)));
  const clip = createClip(frames, 30);
  const onRangeChange = vi.fn();
  cleanups.push(
    renderTimeline(container, clip, 10, range ?? clip.selectedRange, { onRangeChange }),
  );
  const timeline = /** @type {HTMLElement} */ (container.querySelector('.tl'));
  return { timeline, onRangeChange };
}

/**
 * @param {HTMLElement} target
 * @param {KeyboardEventInit} init
 */
function press(target, init) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  cleanups = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanups.forEach((fn) => {
    fn();
  });
  document.body.innerHTML = '';
  expect(countHotkeys()).toBe(0);
});

describe('timeline range keys', () => {
  it('claims keys that move a partial range', () => {
    const { timeline, onRangeChange } = mountTimeline({ start: 11, end: 20 });

    const steps = [
      [{ key: 'ArrowRight' }, { start: 12, end: 21 }],
      [{ key: 'ArrowLeft' }, { start: 11, end: 20 }],
      [
        { key: 'ArrowLeft', shiftKey: true },
        { start: 1, end: 10 },
      ],
      [{ key: '[' }, { start: 0, end: 10 }],
      [{ key: ']' }, { start: 0, end: 11 }],
      [{ key: 'End' }, { start: 0, end: 29 }],
    ];
    for (const [init, range] of steps) {
      expect(press(timeline, init).defaultPrevented).toBe(true);
      expect(onRangeChange).toHaveBeenLastCalledWith(range);
    }
    expect(onRangeChange).toHaveBeenCalledTimes(steps.length);
  });

  it('declines keys that would not change the range', () => {
    const { timeline, onRangeChange } = mountTimeline();

    // Full range: nothing to shift or extend
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', '[', ']']) {
      expect(press(timeline, { key }).defaultPrevented).toBe(false);
    }
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('declines a shift that would run past the clip edge', () => {
    const { timeline, onRangeChange } = mountTimeline({ start: 6, end: 25 });

    expect(press(timeline, { key: 'ArrowRight', shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(timeline, { key: 'ArrowLeft', shiftKey: true }).defaultPrevented).toBe(false);
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('declines Ctrl/Meta/Alt combos so the browser keeps them', () => {
    const { timeline, onRangeChange } = mountTimeline({ start: 6, end: 20 });

    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(press(timeline, { key: 'ArrowLeft', [mod]: true }).defaultPrevented).toBe(false);
      expect(press(timeline, { key: 'Home', [mod]: true }).defaultPrevented).toBe(false);
    }
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('ignores IME composition keystrokes', () => {
    const { timeline, onRangeChange } = mountTimeline({ start: 6, end: 20 });

    expect(press(timeline, { key: 'ArrowLeft', isComposing: true }).defaultPrevented).toBe(false);
    expect(press(timeline, { key: 'Home', keyCode: 229 }).defaultPrevented).toBe(false);
    expect(onRangeChange).not.toHaveBeenCalled();
  });
});

describe('timeline + route hotkeys: one action per keypress', () => {
  /** @param {string} key */
  function registerSeek(key) {
    const seek = vi.fn((/** @type {KeyboardEvent} */ e) => e.preventDefault());
    cleanups.push(
      registerHotkey({ key, modifiers: { shift: 'any' }, scope: 'route', handler: seek }),
    );
    return seek;
  }

  it('full range: Arrow/Home/End reach the route seek exactly once', () => {
    const { timeline, onRangeChange } = mountTimeline();
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    const seeks = keys.map(registerSeek);

    for (const key of keys) press(timeline, { key });

    for (const seek of seeks) expect(seek).toHaveBeenCalledOnce();
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('partial range: the range moves and the route seek does not run', () => {
    const { timeline, onRangeChange } = mountTimeline({ start: 6, end: 20 });
    const seek = registerSeek('ArrowRight');

    press(timeline, { key: 'ArrowRight' });

    expect(onRangeChange).toHaveBeenCalledOnce();
    expect(seek).not.toHaveBeenCalled();
  });

  it('Home seeks once the range already starts at frame 0', () => {
    const { timeline, onRangeChange } = mountTimeline({ start: 6, end: 20 });
    const seek = registerSeek('Home');

    press(timeline, { key: 'Home' });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 0, end: 20 });
    expect(seek).not.toHaveBeenCalled();

    press(timeline, { key: 'Home' });
    expect(onRangeChange).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledOnce();
  });
});
