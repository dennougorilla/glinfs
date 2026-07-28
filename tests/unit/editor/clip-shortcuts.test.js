import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initEditor } from '../../../src/features/editor/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';

/**
 * #100 round 7: browser-tab-style clip shortcuts. Entries carry a visible
 * position badge, and the digit keys address clips BY THAT POSITION —
 * 1-9 switches, Shift+1-9 deletes, Delete/Backspace deletes the active
 * clip. e.code is used so the mapping survives keyboard layouts.
 */

function createMockFrame(id) {
  return {
    id,
    data: { data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 },
    timestamp: Number.parseInt(String(id).replace(/\D/g, '') || '0', 10) * 33,
    width: 100,
    height: 100,
  };
}

function createTestFrames(count, prefix = '') {
  return Array.from({ length: count }, (_, i) => createMockFrame(`${prefix}${i}`));
}

function pressDigit(digit, { shift = false, meta = false } = {}) {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: shift ? '!' : String(digit),
      code: `Digit${digit}`,
      shiftKey: shift,
      metaKey: meta,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('Clip position badges and shortcuts (#100 r7)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  function mountWithClips() {
    // capturedAt spread so ordering (newest first) is deterministic
    setClipPayload({ frames: createTestFrames(5, 'a'), fps: 30, capturedAt: 3000 });
    enqueueClip({ frames: createTestFrames(5, 'b'), fps: 30, capturedAt: 2000 });
    enqueueClip({ frames: createTestFrames(5, 'c'), fps: 30, capturedAt: 1000 });
    cleanup = initEditor();
  }

  it('numbers every entry by its visual position, active included', () => {
    mountWithClips();

    const badges = [...document.querySelectorAll('.clip-entry-num')].map((el) => el.textContent);
    expect(badges).toEqual(['1', '2', '3']);
    // Active clip has the newest capturedAt, so it sits at position 1
    const first = document.querySelector('[data-testid="clip-entry"]');
    expect(first?.hasAttribute('data-clip-active')).toBe(true);
    expect(first?.querySelector('.clip-entry-num')?.textContent).toBe('1');
  });

  it('a digit key switches to the clip at that position', () => {
    mountWithClips();
    const position2Id = document.querySelectorAll('[data-testid="clip-entry"]')[1].dataset.clipId;

    pressDigit(2);

    expect(getClipPayload()?.id ?? null).not.toBeNull();
    const active = document.querySelector('[data-testid="clip-entry"][data-clip-active]');
    expect(active?.dataset.clipId).toBe(position2Id);
  });

  it("the active clip's own digit is a no-op", () => {
    mountWithClips();
    const before = document.querySelector('[data-testid="clip-entry"][data-clip-active]')?.dataset
      .clipId;

    pressDigit(1);

    const after = document.querySelector('[data-testid="clip-entry"][data-clip-active]')?.dataset
      .clipId;
    expect(after).toBe(before);
    expect(getClipQueue()).toHaveLength(2);
  });

  it('Cmd/Ctrl+digit is left to the browser (no clip switch)', () => {
    mountWithClips();
    const before = document.querySelector('[data-testid="clip-entry"][data-clip-active]')?.dataset
      .clipId;

    pressDigit(2, { meta: true });

    const after = document.querySelector('[data-testid="clip-entry"][data-clip-active]')?.dataset
      .clipId;
    expect(after).toBe(before);
  });

  it('Shift+digit deletes the queued clip at that position (deferred, undoable)', () => {
    mountWithClips();
    const position2Id = document.querySelectorAll('[data-testid="clip-entry"]')[1].dataset.clipId;

    pressDigit(2, { shift: true });

    expect(getClipQueue().map((c) => c.id)).not.toContain(position2Id);
    expect(getClipQueue()).toHaveLength(1);
  });

  it('Delete removes the active clip and promotes the successor', () => {
    mountWithClips();
    const activeBefore = getClipPayload()?.id;

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Delete',
        code: 'Delete',
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(getClipPayload()?.id).not.toBe(activeBefore);
    expect(getClipQueue()).toHaveLength(1);
  });

  it('digits typed into a form field never touch the queue', () => {
    mountWithClips();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const before = document.querySelector('[data-testid="clip-entry"][data-clip-active]')?.dataset
      .clipId;

    pressDigit(2);

    const after = document.querySelector('[data-testid="clip-entry"][data-clip-active]')?.dataset
      .clipId;
    expect(after).toBe(before);
    input.remove();
  });
});
