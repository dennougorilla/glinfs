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

describe('source-monitor Live view overlay (#100 follow-up)', () => {
  /** @type {HTMLElement} */
  let host;

  function mountWithHost() {
    host = document.createElement('div');
    host.className = 'editor-preview-wrapper';
    document.body.appendChild(host);
    return initLiveMonitor(slot, host);
  }

  /** @type {HTMLElement} */
  let slot;
  /** @type {(() => void) | null} */
  let teardown = null;

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

  function goLive() {
    captureState.active = true;
    captureState.screenState = {
      stream: {},
      store: { getState: () => ({ stats: {}, settings: {} }), subscribe: () => () => {} },
    };
  }

  it('clicking the dock viewport opens the overlay in the preview host', () => {
    goLive();
    teardown = mountWithHost();

    /** @type {HTMLElement} */ (slot.querySelector('.live-monitor-viewport')).click();

    const overlay = host.querySelector('[data-testid="live-view-overlay"]');
    expect(overlay).not.toBeNull();
    expect(/** @type {HTMLElement} */ (overlay).hidden).toBe(false);
  });

  it('close button and Escape both hide the overlay', () => {
    goLive();
    teardown = mountWithHost();
    const viewport = /** @type {HTMLElement} */ (slot.querySelector('.live-monitor-viewport'));

    viewport.click();
    /** @type {HTMLElement} */ (host.querySelector('[data-testid="live-view-close"]')).click();
    expect(
      /** @type {HTMLElement} */ (host.querySelector('[data-testid="live-view-overlay"]')).hidden,
    ).toBe(true);

    viewport.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(
      /** @type {HTMLElement} */ (host.querySelector('[data-testid="live-view-overlay"]')).hidden,
    ).toBe(true);
  });

  it('overlay Clip Now calls the clip service', () => {
    goLive();
    teardown = mountWithHost();

    /** @type {HTMLElement} */ (slot.querySelector('.live-monitor-viewport')).click();
    /** @type {HTMLElement} */ (host.querySelector('[data-testid="live-view-clip-now"]')).click();

    expect(clipNow).toHaveBeenCalledTimes(1);
  });

  it('capture end closes the overlay along with the dock', () => {
    goLive();
    teardown = mountWithHost();
    /** @type {HTMLElement} */ (slot.querySelector('.live-monitor-viewport')).click();

    captureState.active = false;
    captureState.screenState = null;
    emit('capture:stopped', {});
    vi.advanceTimersByTime(2100);

    expect(
      /** @type {HTMLElement} */ (host.querySelector('[data-testid="live-view-overlay"]')).hidden,
    ).toBe(true);
    expect(slot.hidden).toBe(true);
  });
});
