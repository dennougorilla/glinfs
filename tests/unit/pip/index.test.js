import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for #94: the persistent live-capture PiP.
 *
 * Covers the visibility rule (active capture && route !== '/capture'),
 * route-aware bottom offset, the "Capture ended" terminal state, the
 * minimize/collapse toggle, actions (Clip Now / Open Capture), the
 * clip:queued shutter flash, and — most importantly — that the buffer-text
 * subscription to the stashed capture store is created on show and torn
 * down on hide, never leaking across cycles.
 *
 * The router and app-store seams are mocked (matching clip-service.test.js's
 * style); the real bus.js is used so onBus/emit behave exactly as in prod.
 * Each test gets a fresh module instance via vi.resetModules() since
 * features/pip/index.js is a module-singleton (initPip() is a once-mount).
 */

const routeState = vi.hoisted(() => ({
  current: /** @type {string} */ ('/editor'),
  listeners: /** @type {((route: string) => void)[]} */ ([]),
}));

vi.mock('../../../src/shared/router.js', () => ({
  getCurrentRoute: () => routeState.current,
  navigate: vi.fn(),
  onRouteChange: (fn) => {
    routeState.listeners.push(fn);
    return () => {
      routeState.listeners = routeState.listeners.filter((l) => l !== fn);
    };
  },
}));

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

vi.mock('../../../src/shared/live-region.js', () => ({
  announce: vi.fn(),
}));

/** Fake observable capture store, matching shared/store.js's Store shape */
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

function changeRoute(route) {
  routeState.current = route;
  for (const fn of [...routeState.listeners]) fn(route);
}

/** Fresh module graph per test: pip is a once-mount singleton */
async function loadPip() {
  vi.resetModules();
  const pipMod = await import('../../../src/features/pip/index.js');
  const busMod = await import('../../../src/shared/bus.js');
  const routerMod = await import('../../../src/shared/router.js');
  const clipServiceMod = await import('../../../src/features/capture/clip-service.js');
  return { ...pipMod, ...busMod, navigate: routerMod.navigate, clipNow: clipServiceMod.clipNow };
}

beforeEach(() => {
  routeState.current = '/editor';
  routeState.listeners = [];
  captureState.active = false;
  captureState.screenState = null;
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('visibility', () => {
  it('stays hidden with no active capture', async () => {
    const { initPip } = await loadPip();
    initPip();

    const root = document.getElementById('pip-root');
    expect(root).not.toBeNull();
    expect(root.hidden).toBe(true);
  });

  it('shows once a capture is live and the route is not /capture', async () => {
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    const { initPip } = await loadPip();
    initPip();

    expect(document.getElementById('pip-root').hidden).toBe(false);
  });

  it('hides on /capture even with an active capture', async () => {
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    routeState.current = '/capture';
    const { initPip } = await loadPip();
    initPip();

    expect(document.getElementById('pip-root').hidden).toBe(true);
  });

  it('reacts to capture:started / capture:restored without a route change', async () => {
    const { initPip, emit } = await loadPip();
    initPip();
    const root = document.getElementById('pip-root');
    expect(root.hidden).toBe(true);

    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    emit('capture:started', {});

    expect(root.hidden).toBe(false);
  });

  it('hides again when navigating to /capture', async () => {
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    const { initPip } = await loadPip();
    initPip();
    const root = document.getElementById('pip-root');
    expect(root.hidden).toBe(false);

    changeRoute('/capture');
    expect(root.hidden).toBe(true);
  });
});

describe('route-aware bottom offset (spec amendment 1)', () => {
  it('applies pip-root--above-dock on /editor and /export, not elsewhere', async () => {
    const { initPip } = await loadPip();
    initPip();
    const root = document.getElementById('pip-root');

    expect(root.classList.contains('pip-root--above-dock')).toBe(true); // starts on /editor

    changeRoute('/export');
    expect(root.classList.contains('pip-root--above-dock')).toBe(true);

    changeRoute('/settings');
    expect(root.classList.contains('pip-root--above-dock')).toBe(false);
  });
});

describe('buffer-text subscription hygiene', () => {
  it('subscribes to the stashed store on show and unsubscribes on hide', async () => {
    const store = makeCaptureStore({ stats: { duration: 4 }, settings: { bufferDuration: 15 } });
    captureState.active = true;
    captureState.screenState = { stream: {}, store };
    const { initPip } = await loadPip();
    initPip();

    expect(store.subscribe).toHaveBeenCalledTimes(1);
    expect(store._subscriberCount()).toBe(1);
    expect(document.querySelector('.pip-buffer-text').textContent).toBe('4s / 15s');

    store._set({ stats: { duration: 9 }, settings: { bufferDuration: 15 } });
    expect(document.querySelector('.pip-buffer-text').textContent).toBe('9s / 15s');

    // Navigating to /capture hides the PiP and must drop the subscription
    changeRoute('/capture');
    expect(store._subscriberCount()).toBe(0);
  });

  it('never double-subscribes across repeated show/hide cycles', async () => {
    const store = makeCaptureStore({ stats: { duration: 0 }, settings: { bufferDuration: 15 } });
    captureState.active = true;
    captureState.screenState = { stream: {}, store };
    const { initPip } = await loadPip();
    initPip();

    changeRoute('/capture'); // hide
    changeRoute('/editor'); // show again
    changeRoute('/capture'); // hide again

    expect(store.subscribe).toHaveBeenCalledTimes(2);
    expect(store._subscriberCount()).toBe(0);
  });
});

describe('actions', () => {
  it('Clip Now button calls clipNow()', async () => {
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    const { initPip, clipNow } = await loadPip();
    initPip();

    document.querySelector('[data-testid="pip-clip-now"]').click();
    expect(clipNow).toHaveBeenCalledTimes(1);
  });

  it('Open Capture button navigates to /capture', async () => {
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    const { initPip, navigate } = await loadPip();
    initPip();

    document.querySelector('[data-testid="pip-open-capture"]').click();
    expect(navigate).toHaveBeenCalledWith('/capture');
  });

  it('does not navigate on a plain video click (no whole-card click target, spec amendment 2)', async () => {
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    const { initPip, navigate } = await loadPip();
    initPip();

    document.querySelector('.pip-video').click();
    document.querySelector('.pip-card').click();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('minimize toggle', () => {
  it('toggles aria-expanded and the collapsed class', async () => {
    const { initPip } = await loadPip();
    initPip();

    const root = document.getElementById('pip-root');
    const minimizeBtn = document.querySelector('[data-testid="pip-minimize"]');
    expect(minimizeBtn.getAttribute('aria-expanded')).toBe('true');

    minimizeBtn.click();
    expect(minimizeBtn.getAttribute('aria-expanded')).toBe('false');
    expect(root.classList.contains('pip-root--collapsed')).toBe(true);

    minimizeBtn.click();
    expect(minimizeBtn.getAttribute('aria-expanded')).toBe('true');
    expect(root.classList.contains('pip-root--collapsed')).toBe(false);
  });
});

describe('clip:queued shutter flash', () => {
  it('restarts the flash animation class on every clip:queued event', async () => {
    const { initPip, emit } = await loadPip();
    initPip();

    const shutter = document.querySelector('.pip-shutter');
    expect(shutter.classList.contains('pip-shutter--flash')).toBe(false);

    emit('clip:queued', {});
    expect(shutter.classList.contains('pip-shutter--flash')).toBe(true);
  });
});

describe('"Capture ended" terminal state (spec amendment 4)', () => {
  it('stays visible ~2s after capture:stopped, then hides', async () => {
    vi.useFakeTimers();
    captureState.active = true;
    captureState.screenState = { stream: {}, store: makeCaptureStore({ stats: {}, settings: {} }) };
    const { initPip, emit } = await loadPip();
    initPip();
    const root = document.getElementById('pip-root');
    expect(root.hidden).toBe(false);

    // The share ends: hasActiveScreenCapture() would now report false
    captureState.active = false;
    emit('capture:stopped', {});

    expect(root.hidden).toBe(false);
    expect(root.classList.contains('pip-root--ended')).toBe(true);

    vi.advanceTimersByTime(1999);
    expect(root.hidden).toBe(false);

    vi.advanceTimersByTime(1);
    expect(root.hidden).toBe(true);
    expect(root.classList.contains('pip-root--ended')).toBe(false);
  });

  it('does nothing when capture:stopped fires while already hidden', async () => {
    const { initPip, emit } = await loadPip();
    initPip();
    const root = document.getElementById('pip-root');
    expect(root.hidden).toBe(true);

    emit('capture:stopped', {});
    expect(root.hidden).toBe(true);
    expect(root.classList.contains('pip-root--ended')).toBe(false);
  });
});

describe('accessibility', () => {
  it('exposes role=region with an accessible name and a decorative video', async () => {
    const { initPip } = await loadPip();
    initPip();

    const root = document.getElementById('pip-root');
    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('aria-label')).toBe('Live capture preview');
    expect(document.querySelector('.pip-video').getAttribute('aria-hidden')).toBe('true');
  });
});
