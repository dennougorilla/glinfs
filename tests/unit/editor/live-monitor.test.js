import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #100 Layout A: the docked live source monitor that replaced the floating
 * PiP. Covers visibility (live capture only), the buffer-text subscription
 * hygiene, Clip Now wiring, the "Capture ended" terminal state, and that
 * teardown leaves the slot empty.
 */

const captureState = vi.hoisted(() => ({
  active: false,
  screenState: /** @type {any} */ (null),
}));

vi.mock('../../../src/shared/app-store.js', () => ({
  hasActiveScreenCapture: () => captureState.active,
  getScreenCaptureState: () => captureState.screenState,
}));

vi.mock('../../../src/features/capture/clip-service.js', () => ({
  clipNow: vi.fn(),
}));

import { clipNow } from '../../../src/features/capture/clip-service.js';
import { initLiveMonitor } from '../../../src/features/editor/live-monitor.js';
import { emit } from '../../../src/shared/bus.js';

/** Fake observable capture store matching shared/store.js's shape */
function makeCaptureStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    getState: () => state,
    subscribe: vi.fn((fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    }),
    _set: (next) => {
      state = next;
      subs.forEach((fn) => {
        fn(state);
      });
    },
    _subscriberCount: () => subs.size,
  };
}

describe('live source monitor dock (#100)', () => {
  /** @type {HTMLElement} */
  let slot;
  /** @type {(() => void) | null} */
  let teardown = null;

  function goLive() {
    const store = makeCaptureStore({
      stats: { duration: 7.2, frameCount: 216, fps: 30 },
      settings: { bufferDuration: 15 },
    });
    captureState.active = true;
    captureState.screenState = { stream: {}, store };
    return store;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    captureState.active = false;
    captureState.screenState = null;
    document.body.innerHTML = '<div data-live-monitor></div>';
    slot = /** @type {HTMLElement} */ (document.querySelector('[data-live-monitor]'));
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    vi.useRealTimers();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('stays hidden without a live capture', () => {
    teardown = initLiveMonitor(slot);
    expect(slot.hidden).toBe(true);
  });

  it('shows with buffer text when a capture is live, and updates on stats', () => {
    const store = goLive();
    teardown = initLiveMonitor(slot);

    expect(slot.hidden).toBe(false);
    expect(slot.querySelector('.live-monitor-buffer')?.textContent).toBe('7s / 15s');

    store._set({
      stats: { duration: 12.6, frameCount: 378, fps: 30 },
      settings: { bufferDuration: 15 },
    });
    expect(slot.querySelector('.live-monitor-buffer')?.textContent).toBe('13s / 15s');
  });

  it('appears when capture starts after mount (bus capture:started)', () => {
    teardown = initLiveMonitor(slot);
    expect(slot.hidden).toBe(true);

    goLive();
    emit('capture:started', {});

    expect(slot.hidden).toBe(false);
  });

  it('Clip Now button calls the clip service', () => {
    goLive();
    teardown = initLiveMonitor(slot);

    /** @type {HTMLButtonElement} */ (
      slot.querySelector('[data-testid="monitor-clip-now"]')
    ).click();

    expect(clipNow).toHaveBeenCalledTimes(1);
  });

  it('shows "Capture ended" for ~2s then hides when the share stops', () => {
    goLive();
    teardown = initLiveMonitor(slot);
    expect(slot.hidden).toBe(false);

    captureState.active = false;
    captureState.screenState = null;
    emit('capture:stopped', {});

    // Terminal state visible, slot still shown
    expect(slot.hidden).toBe(false);
    expect(slot.querySelector('.live-monitor--ended')).not.toBeNull();

    vi.advanceTimersByTime(2100);
    expect(slot.hidden).toBe(true);
  });

  it('unsubscribes from the capture store on teardown and empties the slot', () => {
    const store = goLive();
    teardown = initLiveMonitor(slot);
    expect(store._subscriberCount()).toBe(1);

    teardown();
    teardown = null;

    expect(store._subscriberCount()).toBe(0);
    expect(slot.innerHTML).toBe('');
  });
});
