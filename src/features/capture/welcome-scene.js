/**
 * Welcome scene for the empty capture stage
 * @module features/capture/welcome-scene
 *
 * A decorative, looping illustration of what Glinfs does, set in the
 * otherwise empty top of the capture viewfinder:
 *
 *   1. A video is playing on the shared screen: a little pixel short in
 *      which the Glinfs cursor runs across a scrolling night scene, then
 *      leaps with a full flip. That jump is the moment worth a GIF.
 *   2. Underneath, the rolling buffer keeps sliding by: frames enter at
 *      "now" (magenta, live) and fall off the past end. The frames that
 *      caught the jump show the runner in the air.
 *   3. "Create Clip" is pressed after the fact.
 *   4. A cyan bracket selects the last frames (selection), and they come
 *      into register as a GIF that loops the jump in a few hard cuts.
 *
 * All motion is CSS (capture.css, `ws-*` keyframes on one shared cycle). The
 * elements' resting styles are the story's last beat, so with reduced motion
 * the scene is a still of the finished clip. The whole scene is aria-hidden:
 * the title and steps next to it say the same thing in words.
 */

import { createElement } from '../../shared/utils/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Frames on the strip; the buffer slides by six of them each loop */
const STRIP_FRAMES = 16;
/** Strip frames recorded mid-jump (they reach "now" just after the leap;
 * the strip's timing is in capture.css, ws-strip) */
const AIRBORNE_FRAMES = new Map([
  [13, { y: 48, turn: 0.15 }],
  [14, { y: 34, turn: 0.85 }],
]);

/**
 * The Glinfs pixel cursor, cloned from the header logo so the artwork has
 * one source (scripts/generate-icons.mjs). Its cyan and magenta shadow
 * plates keep the logo's jitter (global.css animates them by class). Falls
 * back to an empty glyph when the header is absent (unit tests render the
 * screen on its own).
 * @param {string} className
 * @returns {SVGSVGElement}
 */
function createRunner(className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', className);
  const frame = document.querySelector('.app-logo-frame[data-frame="idle"]');
  if (frame) {
    for (const part of frame.children) svg.appendChild(part.cloneNode(true));
  }
  return svg;
}

/**
 * A night scene with a runner: the content of the playing video, and (in a
 * smaller copy) of the GIF
 * @param {string} modifier - 'screen' or 'gif'
 * @returns {HTMLElement}
 */
function createShot(modifier) {
  return createElement('div', { className: `ws-shot ws-shot--${modifier}` }, [
    createElement('div', { className: 'ws-stars' }),
    createElement('div', { className: 'ws-hills' }),
    createElement('div', { className: 'ws-ground' }),
    createElement('div', { className: 'ws-runner' }, [
      createElement('div', { className: 'ws-runner-gait' }, [createRunner('ws-runner-glyph')]),
    ]),
    createElement(
      'span',
      { className: 'ws-dust' },
      Array.from({ length: 6 }, (_, i) =>
        createElement('i', { className: 'ws-dust-bit', style: `--i: ${i}` }),
      ),
    ),
  ]);
}

/**
 * A strip frame: a thumbnail of the video at the moment it was recorded
 * @param {number} index
 * @returns {HTMLElement}
 */
function createStripFrame(index) {
  const airborne = AIRBORNE_FRAMES.get(index);
  // The runner drifts across the thumbnails as the video plays; mid-jump
  // frames show it lifted and turning
  const x = 18 + ((index * 23) % 60);
  return createElement(
    'div',
    {
      className: `ws-frame ${airborne ? 'ws-frame--airborne' : ''}`,
      style: `--x: ${x}%; --lift: ${airborne ? airborne.y : 0}%; --turn: ${airborne ? airborne.turn : 0}turn`,
    },
    [createElement('i', { className: 'ws-frame-runner' })],
  );
}

/**
 * Build the welcome scene
 * @param {number} bufferSeconds - Buffer length shown on the strip
 * @returns {HTMLElement}
 */
export function createWelcomeScene(bufferSeconds) {
  return createElement('div', { className: 'welcome', 'aria-hidden': 'true' }, [
    createElement('div', { className: 'welcome-scene' }, [
      createElement('div', { className: 'ws-screen' }, [
        createElement('div', { className: 'ws-titlebar' }, [
          createElement('i'),
          createElement('i'),
          createElement('i'),
          createElement('span', { className: 'ws-rec' }, [
            createElement('span', { className: 'ws-rec-dot' }),
            'REC',
          ]),
        ]),
        createShot('screen'),
        createElement('div', { className: 'ws-player' }, [
          createElement('span', { className: 'ws-player-play' }),
          createElement('span', { className: 'ws-player-track' }, [
            createElement('span', { className: 'ws-player-progress' }),
          ]),
          createElement('span', { className: 'ws-player-time' }, ['01:24']),
        ]),
      ]),

      createElement('div', { className: 'ws-chip' }, ['Create Clip']),

      createElement('div', { className: 'ws-gif' }, [
        createElement('div', { className: 'ws-gif-window' }, [createShot('gif')]),
        createElement('div', { className: 'ws-gif-meta' }, [
          createElement('span', { className: 'ws-gif-name' }, ['jump.gif']),
          createElement('span', { className: 'ws-gif-badge' }, ['GIF']),
        ]),
      ]),

      createElement('div', { className: 'ws-buffer' }, [
        createElement('div', { className: 'ws-strip-viewport' }, [
          createElement(
            'div',
            { className: 'ws-strip' },
            Array.from({ length: STRIP_FRAMES }, (_, i) => createStripFrame(i)),
          ),
        ]),
        createElement('div', { className: 'ws-bracket' }),
        createElement('div', { className: 'ws-now' }),
        createElement('span', { className: 'ws-tick ws-tick--past' }, [`−${bufferSeconds}s`]),
        createElement('span', { className: 'ws-tick ws-tick--now' }, ['now']),
      ]),
    ]),
  ]);
}
