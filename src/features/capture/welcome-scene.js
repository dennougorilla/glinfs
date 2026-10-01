/**
 * Welcome scene for the empty capture stage
 * @module features/capture/welcome-scene
 *
 * A decorative, looping illustration of what Glinfs does, set in the
 * otherwise empty top of the capture viewfinder:
 *
 *   1. On a screen, the cursor presses "Publish": the moment worth a GIF.
 *   2. Underneath, the rolling buffer keeps sliding by: frames enter at
 *      "now" (magenta, live) and fall off the past end.
 *   3. "Create Clip" is pressed after the fact.
 *   4. A cyan bracket selects the last few frames (selection), and they come
 *      into register as a GIF that loops the moment.
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
/** Strip frames that caught the moment: the ones that reach "now" after
 * the click (the strip's timing is in capture.css, ws-strip) */
const MOMENT_FRAMES = new Set([14, 15]);

/**
 * The brand's pixel cursor, cloned from the header logo so the artwork has
 * one source (scripts/generate-icons.mjs). Falls back to an empty glyph
 * when the header is absent (unit tests render the screen on its own).
 * @returns {SVGSVGElement}
 */
function createCursor() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'ws-cursor-glyph');
  const body = document.querySelector('.app-logo-frame[data-frame="idle"] .app-logo-body');
  if (body) svg.appendChild(body.cloneNode(true));
  return svg;
}

/**
 * A "Publish" button that flips to "Published" with a small pixel burst
 * @param {string} className - Extra class for where it sits
 * @returns {HTMLElement}
 */
function createMomentButton(className) {
  return createElement('div', { className: `ws-button ${className}` }, [
    createElement('span', { className: 'ws-button-label ws-button-label--before' }, ['Publish']),
    createElement('span', { className: 'ws-button-label ws-button-label--after' }, ['Published']),
    createElement(
      'span',
      { className: 'ws-burst' },
      Array.from({ length: 6 }, (_, i) =>
        createElement('i', { className: 'ws-burst-bit', style: `--i: ${i}` }),
      ),
    ),
  ]);
}

/**
 * A window with a title bar and a few lines of content
 * @param {string} className
 * @param {HTMLElement[]} [extra]
 * @returns {HTMLElement}
 */
function createWindow(className, extra = []) {
  return createElement('div', { className }, [
    createElement('div', { className: 'ws-titlebar' }, [
      createElement('i'),
      createElement('i'),
      createElement('i'),
    ]),
    createElement('div', { className: 'ws-lines' }, [
      createElement('i'),
      createElement('i'),
      createElement('i'),
    ]),
    ...extra,
  ]);
}

/**
 * Build the welcome scene
 * @param {number} bufferSeconds - Buffer length shown on the strip
 * @returns {HTMLElement}
 */
export function createWelcomeScene(bufferSeconds) {
  const frames = Array.from({ length: STRIP_FRAMES }, (_, i) =>
    createElement('div', {
      className: `ws-frame ${MOMENT_FRAMES.has(i) ? 'ws-frame--moment' : ''}`,
    }),
  );

  return createElement('div', { className: 'welcome', 'aria-hidden': 'true' }, [
    createElement('div', { className: 'welcome-scene' }, [
      createWindow('ws-screen', [
        createMomentButton('ws-button--screen'),
        createElement('div', { className: 'ws-rec' }, [
          createElement('span', { className: 'ws-rec-dot' }),
          'REC',
        ]),
        createElement('div', { className: 'ws-cursor' }, [createCursor()]),
      ]),

      createElement('div', { className: 'ws-chip' }, ['Create Clip']),

      createElement('div', { className: 'ws-gif' }, [
        createWindow('ws-gif-window', [createMomentButton('ws-button--gif')]),
        createElement('div', { className: 'ws-gif-meta' }, [
          createElement('span', { className: 'ws-gif-name' }, ['clip.gif']),
          createElement('span', { className: 'ws-gif-badge' }, ['GIF']),
        ]),
      ]),

      createElement('div', { className: 'ws-buffer' }, [
        createElement('div', { className: 'ws-strip-viewport' }, [
          createElement('div', { className: 'ws-strip' }, frames),
        ]),
        createElement('div', { className: 'ws-bracket' }),
        createElement('div', { className: 'ws-now' }),
        createElement('span', { className: 'ws-tick ws-tick--past' }, [`−${bufferSeconds}s`]),
        createElement('span', { className: 'ws-tick ws-tick--now' }, ['now']),
      ]),
    ]),
  ]);
}
