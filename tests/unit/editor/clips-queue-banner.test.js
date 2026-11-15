import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isClipsQueueBannerOnScreen,
  showClipsQueueFullBanner,
} from '../../../src/features/editor/ui.js';

/**
 * #186: an automatic removal is told on ONE surface — the editor's Clips
 * banner when it is really on screen, else a toast. These cover the "on
 * screen" decision the editor reports back through markShown().
 */

/** The Clips/Scenes panes as the left sidebar renders them */
function mountSidebar() {
  document.body.innerHTML = `
    <div class="editor-screen">
      <div class="sidebar-pane" data-pane="clips">
        <div class="clips-queue-banner" role="status" hidden></div>
      </div>
      <div class="sidebar-pane" data-pane="scenes" hidden></div>
    </div>`;
  return /** @type {HTMLElement} */ (document.querySelector('.editor-screen'));
}

/** Give the banner a layout box (jsdom has no layout engine) */
function stubLayout(
  banner,
  { visible = true, rect = { top: 100, left: 20, bottom: 160, right: 220 } },
) {
  banner.checkVisibility = vi.fn(() => visible);
  banner.getBoundingClientRect = vi.fn(() => ({ ...rect, width: 200, height: 60, x: 0, y: 0 }));
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('isClipsQueueBannerOnScreen', () => {
  it('is true once the banner is shown in the open Clips pane', () => {
    const container = mountSidebar();
    expect(isClipsQueueBannerOnScreen(container)).toBe(false);
    showClipsQueueFullBanner(container, 'removed');
    expect(isClipsQueueBannerOnScreen(container)).toBe(true);
  });

  it('is false while the Scenes tab hides the Clips pane', () => {
    const container = mountSidebar();
    showClipsQueueFullBanner(container, 'removed');
    /** @type {HTMLElement} */ (container.querySelector('[data-pane="clips"]')).hidden = true;
    expect(isClipsQueueBannerOnScreen(container)).toBe(false);
  });

  it('is false without a banner slot', () => {
    document.body.innerHTML = '<div class="editor-screen"></div>';
    expect(
      isClipsQueueBannerOnScreen(/** @type {HTMLElement} */ (document.body.firstElementChild)),
    ).toBe(false);
  });

  it('is false when the browser reports the banner as not rendered', () => {
    const container = mountSidebar();
    showClipsQueueFullBanner(container, 'removed');
    stubLayout(/** @type {HTMLElement} */ (container.querySelector('.clips-queue-banner')), {
      visible: false,
    });
    expect(isClipsQueueBannerOnScreen(container)).toBe(false);
  });

  it('is false when the banner is scrolled out of the viewport', () => {
    const container = mountSidebar();
    showClipsQueueFullBanner(container, 'removed');
    const banner = /** @type {HTMLElement} */ (container.querySelector('.clips-queue-banner'));
    stubLayout(banner, { rect: { top: 1200, left: 20, bottom: 1260, right: 220 } });
    expect(isClipsQueueBannerOnScreen(container)).toBe(false);
    stubLayout(banner, {});
    expect(isClipsQueueBannerOnScreen(container)).toBe(true);
  });
});
