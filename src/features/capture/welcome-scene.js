/**
 * Welcome scene for the empty capture stage
 * @module features/capture/welcome-scene
 *
 * A decorative, looping illustration of what Glinfs does, set in the
 * otherwise empty top of the capture viewfinder. A pixel-art character
 * plays a short clip on a shared screen (the run, the jump, the punchline);
 * underneath, the rolling buffer slides past "now"; "Create Clip" is pressed
 * after the fact, a cyan selection takes the last frames, the crop closes in
 * on the character, and the clip comes into register as a GIF that loops
 * the moment and then clears its background. The scene itself lives in
 * ./welcome/ (timeline, pixel toolkit, backdrops, cast, compositor).
 *
 * Each loop deals a different character (cat, CRT TV, VHS, skater) and a
 * random backdrop (synthwave or night city). A re-render of the capture
 * screen continues the story where it was; a new visit starts it over with
 * the next character.
 *
 * Cost: the video is 149x71 pixels, sprites and backdrops are cached, frames
 * are capped at 30fps, and nothing draws while the scene is off screen or
 * the tab is hidden. With reduced motion the scene is one still: the
 * finished GIF. It is aria-hidden; the title and steps beside it say the
 * same thing in words.
 */

import { createElement } from '../../shared/utils/dom.js';
import { BACKDROPS } from './welcome/backdrops.js';
import { CAST } from './welcome/cast.js';
import { drawStage, StageBuffers } from './welcome/stage.js';
import { CYCLE, pickForLoop, STILL_TIME } from './welcome/timeline.js';

/** Frame cap */
const FPS = 30;
/** A remount within this window is a re-render, not a new visit */
const RESUME_MS = 1000;

/**
 * The story's clock and casting, shared by every mount in this page load so
 * a re-render does not restart or recast the scene
 */
const session = {
  seed: Math.floor(Math.random() * 2 ** 31),
  elapsed: 0,
  loopOffset: 0,
  lastSeen: Number.NEGATIVE_INFINITY,
};

const currentLoop = () => session.loopOffset + Math.floor(session.elapsed / CYCLE);

/**
 * The scene's colours and fonts, from the design tokens
 * @returns {import('./welcome/stage.js').Palette}
 */
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  // sprites bake their plates from '#rrggbb' values
  const hex = (name, fallback) => {
    const value = token(name, fallback);
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  return {
    paper: token('--ink-paper', '#ececef'),
    onPaper: token('--color-on-primary', '#0c0d10'),
    cyan: hex('--ink-cyan', '#22d3ee'),
    magenta: hex('--ink-magenta', '#f0468f'),
    rec: token('--color-recording', '#ff3d71'),
    panel: token('--color-panel', '#121317'),
    window: token('--color-bg-tertiary', '#17181d'),
    line: token('--color-border', '#24262c'),
    lineStrong: token('--color-border-strong', '#33353c'),
    text2: token('--color-text-secondary', '#a3a5ad'),
    muted: token('--color-text-muted', '#85878f'),
    track: token('--color-surface-hover', '#292b32'),
    mono: token('--font-mono', 'monospace'),
    sans: token('--font-family', 'sans-serif'),
  };
}

/**
 * Start drawing into the canvas
 * @param {HTMLCanvasElement} canvas
 * @param {number} bufferSeconds
 * @returns {() => void} Stop (idempotent)
 */
function start(canvas, bufferSeconds) {
  // Needs real layout and canvas; without them (jsdom in unit tests) the
  // scene stays an empty, inert box
  if (typeof IntersectionObserver !== 'function' || typeof ResizeObserver !== 'function') {
    return () => {};
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const now = performance.now();
  if (now - session.lastSeen > RESUME_MS) {
    // a new visit: start the story over, with the next character
    session.loopOffset = Number.isFinite(session.lastSeen) ? currentLoop() + 1 : 0;
    session.elapsed = 0;
  }

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const palette = readPalette();
  const buffers = new StageBuffers();
  // the backing store is sized from layout; until then (a new canvas is
  // 300x150) there is nothing worth drawing
  let sized = false;
  let scale = 1;
  let raf = 0;
  let visible = false;
  let stopped = false;
  /** @type {number | null} */
  let lastTime = null;
  let lastFrame = -1;

  const render = () => {
    if (!sized) return;
    const t = reduce ? STILL_TIME : session.elapsed % CYCLE;
    const pick = pickForLoop(session.seed, currentLoop(), CAST.length, BACKDROPS.length);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawStage(ctx, t, {
      cast: CAST[pick.cast],
      backdrop: BACKDROPS[pick.backdrop],
      palette,
      buffers,
      scale,
      bufferSeconds,
    });
  };

  const resize = () => {
    const width = canvas.getBoundingClientRect().width;
    if (!width) return;
    const w = Math.round(width * (window.devicePixelRatio || 1));
    const h = Math.round((w * 240) / 600);
    if (sized && canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    scale = w / 600;
    sized = true;
    buffers.reset();
    render();
  };

  const tick = (time) => {
    raf = 0;
    if (stopped || !visible || document.hidden) return;
    if (!canvas.isConnected) {
      stop();
      return;
    }
    // the clock only runs while the scene is shown; a long gap (a hidden
    // tab) resumes where it was instead of skipping ahead
    session.elapsed += lastTime === null ? 0 : Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    const frame = Math.floor(session.elapsed * FPS);
    if (frame !== lastFrame) {
      lastFrame = frame;
      render();
    }
    raf = requestAnimationFrame(tick);
  };
  const play = () => {
    if (reduce || raf || stopped) return;
    lastTime = null;
    raf = requestAnimationFrame(tick);
  };
  const pause = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const io = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) play();
    else pause();
  });
  const ro = new ResizeObserver(resize);
  const onVisibility = () => {
    if (document.hidden) pause();
    else if (visible) play();
  };
  io.observe(canvas);
  ro.observe(canvas);
  document.addEventListener('visibilitychange', onVisibility);
  // canvas text does not wait for web fonts: ask for the faces the scene
  // uses, and draw again once they are in (a still frame would otherwise
  // keep the fallback font)
  const fonts = document.fonts;
  if (fonts?.load) {
    Promise.all([
      fonts.load(`500 10px ${palette.mono}`),
      fonts.load(`600 10px ${palette.mono}`),
      fonts.load(`600 11px ${palette.sans}`),
    ]).then(
      () => {
        if (!stopped) render();
      },
      () => {},
    );
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    pause();
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    session.lastSeen = performance.now();
  }
  return stop;
}

/**
 * Build the welcome scene
 * @param {number} bufferSeconds - Buffer length shown on the strip
 * @param {(() => void)[]} [cleanups] - Receives the function that stops it
 * @returns {HTMLElement}
 */
export function createWelcomeScene(bufferSeconds, cleanups) {
  const canvas = /** @type {HTMLCanvasElement} */ (
    createElement('canvas', { className: 'welcome-canvas' })
  );
  const root = createElement('div', { className: 'welcome', 'aria-hidden': 'true' }, [
    createElement('div', { className: 'welcome-scene' }, [canvas]),
  ]);
  const stop = start(canvas, bufferSeconds);
  cleanups?.push(stop);
  return root;
}
