import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCanvas } from './fake-context-2d.js';

/**
 * When the welcome scene draws and when it stops: layout, visibility,
 * the frame cap, reduced motion, cleanup, and how its story carries over a
 * re-render but starts over on a new visit. The compositor is mocked; each
 * call is one drawn frame, with its time and character.
 */

vi.mock('../../../src/features/capture/welcome/stage.js', () => ({
  drawStage: vi.fn(),
  StageBuffers: class {
    reset() {}
  },
}));

/** @type {{ io: any[], ro: any[] }} */
let observers;
/** @type {Map<number, FrameRequestCallback>} */
let frames;
let now;
let hidden;
/** Stops of every scene mounted in the current test */
let mounted;

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnect = vi.fn();
    observers.io.push(this);
  }
  observe(el) {
    this.el = el;
  }
  show(isIntersecting = true) {
    this.callback([{ isIntersecting, target: this.el }]);
  }
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnect = vi.fn();
    observers.ro.push(this);
  }
  observe(el) {
    this.el = el;
  }
  layout() {
    this.callback([]);
  }
}

/** Run the queued animation frames at `time` (ms) */
function frame(time) {
  now = time;
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(time);
}

async function load() {
  const scene = await import('../../../src/features/capture/welcome-scene.js');
  const stage = await import('../../../src/features/capture/welcome/stage.js');
  const { STILL_TIME } = await import('../../../src/features/capture/welcome/timeline.js');
  const drawStage = /** @type {import('vitest').Mock} */ (stage.drawStage);
  // a mocked module outlives vi.resetModules(): start each test with no calls
  drawStage.mockClear();
  /** Mount a scene on the page, as the capture screen does */
  const mount = () => {
    const cleanups = [];
    const root = scene.createWelcomeScene(15, cleanups);
    document.body.appendChild(root);
    mounted.push(cleanups[0]);
    return {
      root,
      stop: cleanups[0],
      io: observers.io.at(-1),
      ro: observers.ro.at(-1),
    };
  };
  /** The last drawn frame: its time in the loop and its character */
  const last = () => {
    const [, t, options] = drawStage.mock.calls.at(-1);
    return { t, cast: options.cast.key, scale: options.scale };
  };
  return { mount, drawStage, last, STILL_TIME };
}

beforeEach(() => {
  vi.resetModules();
  observers = { io: [], ro: [] };
  frames = new Map();
  mounted = [];
  now = 1000;
  hidden = false;
  let nextId = 1;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    /** @type {DOMRect} */ ({ width: 600, height: 240 }),
  );
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  installFakeCanvas();
});

afterEach(() => {
  for (const stop of mounted) stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.hidden;
  delete document.fonts;
  document.body.innerHTML = '';
});

describe('welcome scene lifecycle', () => {
  it('draws once laid out, and animates only while on screen', async () => {
    const { mount, drawStage, last } = await load();
    const { io, ro } = mount();
    expect(drawStage).not.toHaveBeenCalled();

    ro.layout();
    expect(drawStage).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    io.show();
    frame(1000);
    frame(1100);
    frame(1200);
    expect(drawStage).toHaveBeenCalledTimes(4);
    expect(last().t).toBeCloseTo(0.2);

    io.show(false);
    expect(frames.size).toBe(0);
    frame(1300);
    expect(drawStage).toHaveBeenCalledTimes(4);
  });

  it('draws at most 30 frames a second', async () => {
    const { mount, drawStage } = await load();
    const { io, ro } = mount();
    ro.layout();
    io.show();
    drawStage.mockClear();
    // six display frames 10ms apart: two scene frames (at 0 and 1/30s)
    for (let i = 0; i < 6; i++) frame(1000 + i * 10);
    expect(drawStage).toHaveBeenCalledTimes(2);
  });

  it('pauses while the tab is hidden', async () => {
    const { mount, drawStage } = await load();
    const { io, ro } = mount();
    ro.layout();
    io.show();
    frame(1000);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    const drawn = drawStage.mock.calls.length;

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    frame(5000);
    frame(5100);
    expect(drawStage.mock.calls.length).toBeGreaterThan(drawn);
  });

  it('does nothing before layout, even when fonts arrive first', async () => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => Promise.resolve([]) },
    });
    const { mount, drawStage } = await load();
    mount();
    await Promise.resolve();
    await Promise.resolve();
    expect(drawStage).not.toHaveBeenCalled();
  });

  it('stops for good when cleaned up, and only once', async () => {
    const { mount, drawStage } = await load();
    const { io, ro, stop } = mount();
    ro.layout();
    io.show();
    frame(1000);
    const drawn = drawStage.mock.calls.length;

    stop();
    stop();
    expect(io.disconnect).toHaveBeenCalledTimes(1);
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    io.show();
    document.dispatchEvent(new Event('visibilitychange'));
    frame(2000);
    expect(frames.size).toBe(0);
    expect(drawStage).toHaveBeenCalledTimes(drawn);
  });

  it('stops by itself if its canvas leaves the page without a cleanup', async () => {
    const { mount, drawStage } = await load();
    const { root, io, ro } = mount();
    ro.layout();
    io.show();
    frame(1000);
    const drawn = drawStage.mock.calls.length;

    root.remove();
    frame(1100);
    expect(drawStage).toHaveBeenCalledTimes(drawn);
    expect(io.disconnect).toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it('shows one still frame, the finished GIF, when motion is reduced', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { mount, drawStage, last, STILL_TIME } = await load();
    const { io, ro } = mount();
    ro.layout();
    io.show();
    expect(frames.size).toBe(0);
    expect(drawStage).toHaveBeenCalledTimes(1);
    expect(last().t).toBe(STILL_TIME);
  });

  it('carries the story over a re-render, and starts over with the next character on a new visit', async () => {
    const { mount, last } = await load();

    const first = mount();
    first.ro.layout();
    first.io.show();
    for (let i = 0; i <= 20; i++) frame(1000 + i * 100);
    const before = last();
    expect(before.t).toBeCloseTo(2);
    first.stop();
    first.root.remove();

    // the capture screen re-renders a moment later: same story, same moment
    now += 100;
    const second = mount();
    second.ro.layout();
    expect(last().t).toBeCloseTo(before.t);
    expect(last().cast).toBe(before.cast);
    second.stop();
    second.root.remove();

    // back on the capture screen later: from the top, with someone else
    now += 5000;
    const third = mount();
    third.ro.layout();
    expect(last().t).toBe(0);
    expect(last().cast).not.toBe(before.cast);
  });

  it('follows reduced motion switched on or off while it runs', async () => {
    const queries = stubMediaQueries();
    const { mount, drawStage, last, STILL_TIME } = await load();
    const { io, ro, stop } = mount();
    ro.layout();
    io.show();
    frame(1000);
    frame(1100);

    queries.set('(prefers-reduced-motion: reduce)', true);
    expect(frames.size).toBe(0);
    expect(last().t).toBe(STILL_TIME);
    const drawn = drawStage.mock.calls.length;
    frame(1200);
    expect(drawStage).toHaveBeenCalledTimes(drawn);

    queries.set('(prefers-reduced-motion: reduce)', false);
    expect(frames.size).toBe(1);

    stop();
    expect(queries.listening()).toBe(0);
  });

  it('sizes the canvas again when the pixel ratio changes without a resize', async () => {
    const queries = stubMediaQueries();
    vi.stubGlobal('devicePixelRatio', 1);
    const { mount, last } = await load();
    const { root, ro } = mount();
    ro.layout();
    const canvas = root.querySelector('canvas');
    expect(canvas.width).toBe(600);

    vi.stubGlobal('devicePixelRatio', 2);
    queries.set('(resolution: 1dppx)', false);
    expect(canvas.width).toBe(1200);
    expect(last().scale).toBe(2);
    // now watching the new ratio
    expect(queries.watched()).toContain('(resolution: 2dppx)');
  });
});

/**
 * matchMedia with lists that can change: set(query, matches) updates a
 * query and tells its listeners
 */
function stubMediaQueries() {
  /** @type {Map<string, { matches: boolean, listeners: Set<() => void> }>} */
  const lists = new Map();
  const list = (query) => {
    if (!lists.has(query)) lists.set(query, { matches: false, listeners: new Set() });
    return lists.get(query);
  };
  vi.stubGlobal('matchMedia', (query) => {
    const entry = list(query);
    return {
      get matches() {
        return entry.matches;
      },
      addEventListener: (_type, fn) => entry.listeners.add(fn),
      removeEventListener: (_type, fn) => entry.listeners.delete(fn),
    };
  });
  return {
    set(query, matches) {
      const entry = list(query);
      entry.matches = matches;
      for (const fn of [...entry.listeners]) fn();
    },
    /** How many listeners are attached, over all queries */
    listening: () => [...lists.values()].reduce((n, entry) => n + entry.listeners.size, 0),
    /** Queries with a listener attached */
    watched: () => [...lists].filter(([, entry]) => entry.listeners.size).map(([query]) => query),
  };
}
