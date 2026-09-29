/**
 * The editor's right sidebar: tab and preview-view reducers, the Background
 * tab badge, and in the mounted editor the ARIA tabs (roving tabindex,
 * arrow keys that never reach the editor's shortcuts), the remembered tab,
 * the Background panel showing only what applies, the Touch up mode taking
 * the tabs' place, and the preview's Result / Original / Mask switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { getBackgroundTabBadge } from '../../../src/features/editor/panels/properties.js';
import {
  createAiCutoutStatus,
  createEditorStore,
  getEffectivePreviewView,
  setBackground,
  setPreviewView,
  setSidebarTab,
} from '../../../src/features/editor/state.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

function makeState() {
  const frames = Array.from({ length: 4 }, (_, i) => ({
    id: `f${i}`,
    timestamp: i,
    width: 10,
    height: 10,
  }));
  return createEditorStore(/** @type {any} */ (frames), 30).getState();
}

describe('sidebar tab and preview view reducers', () => {
  it('a new session opens on the Frame tab with the Result view', () => {
    const state = makeState();
    expect(state.sidebarTab).toBe('frame');
    expect(state.previewView).toBe('result');
  });

  it('setSidebarTab takes known tabs only and keeps the object when unchanged', () => {
    const state = makeState();
    expect(setSidebarTab(state, 'background').sidebarTab).toBe('background');
    expect(setSidebarTab(state, 'frame')).toBe(state);
    expect(setSidebarTab(state, 'nope')).toBe(state);
  });

  it('setPreviewView takes known views only', () => {
    const state = makeState();
    expect(setPreviewView(state, 'mask').previewView).toBe('mask');
    expect(setPreviewView(state, 'result')).toBe(state);
    expect(setPreviewView(state, 'matte')).toBe(state);
  });

  it('the effective view is Result while background removal is off', () => {
    const masked = setPreviewView(makeState(), 'mask');
    expect(getEffectivePreviewView(masked)).toBe('result');
    expect(getEffectivePreviewView(setBackground(masked, { enabled: true }))).toBe('mask');
  });

  it('the Background tab badge: nothing off, a dot on, the progress while analyzing', () => {
    const off = makeState();
    expect(getBackgroundTabBadge(off)).toEqual({ text: '', running: false, on: false });
    const on = setBackground(off, { enabled: true });
    expect(getBackgroundTabBadge(on)).toEqual({ text: '', running: false, on: true });
    const ai = setBackground(off, { enabled: true, method: 'ai' });
    const analyzing = {
      ...ai,
      aiCutout: { ...createAiCutoutStatus(), phase: 'analyzing', framesDone: 1, framesTotal: 4 },
    };
    expect(getBackgroundTabBadge(/** @type {any} */ (analyzing))).toMatchObject({
      running: true,
      on: true,
    });
    expect(getBackgroundTabBadge(/** @type {any} */ (analyzing)).text).toMatch(/^\d+%$/);
    const starting = { ...ai, aiCutout: { ...createAiCutoutStatus(), phase: 'starting' } };
    expect(getBackgroundTabBadge(/** @type {any} */ (starting)).text).toBe('…');
  });
});

/** @param {number} count */
function createTestFrames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    data: { data: new Uint8ClampedArray(20 * 10 * 4), width: 20, height: 10 },
    timestamp: i * 33,
    width: 20,
    height: 10,
  }));
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(20);
  await Promise.resolve();
}

/** @param {string} selector */
function $(selector) {
  return /** @type {HTMLElement} */ (document.querySelector(selector));
}

/**
 * @param {string} id
 * @param {boolean} [checked]
 */
function check(id, checked = true) {
  const input = /** @type {HTMLInputElement} */ ($(`#${id}`));
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * @param {HTMLElement} target
 * @param {string} key
 */
function keydown(target, key) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** @param {string} tab */
function tabButton(tab) {
  return $(`#editor-side-tab-${tab}`);
}

describe('sidebar in the mounted editor', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  const mount = () => {
    setClipPayload({
      frames: createTestFrames(6),
      fps: 10,
      capturedAt: Date.now(),
      id: `clip-${Math.random()}`,
    });
    cleanup = /** @type {() => void} */ (initEditor());
    window.__TEST_HOOKS__.setEditorState({ isPlaying: false });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
    mount();
  });

  afterEach(() => {
    // Leave the tab memory on Frame for the other tests
    tabButton('frame')?.click();
    cleanup?.();
    cleanup = null;
    resetAppStore();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('renders ARIA tabs with one tab in the Tab order and its panel shown', () => {
    const tablist = $('.editor-side-tabs');
    expect(tablist.getAttribute('aria-label')).toBe('Properties');
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Frame', 'Text', 'Background']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect($('#editor-side-panel-frame').hidden).toBe(false);
    expect($('#editor-side-panel-text').hidden).toBe(true);
    expect($('#editor-side-panel-background').getAttribute('aria-labelledby')).toBe(
      'editor-side-tab-background',
    );
    // The Frame tab holds the speed and aspect controls
    expect($('#editor-side-panel-frame').querySelector('#editor-speed')).not.toBeNull();
    expect($('#editor-side-panel-frame').querySelector('.aspect-btn')).not.toBeNull();
  });

  it('arrow keys, Home and End move between tabs without stepping frames', async () => {
    const frame = tabButton('frame');
    frame.focus();
    const before = getEditorState()?.currentFrame;
    const event = keydown(frame, 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tabButton('text'));
    expect(tabButton('text').getAttribute('aria-selected')).toBe('true');
    expect($('#editor-side-panel-text').hidden).toBe(false);
    await settle();
    expect(getEditorState()?.sidebarTab).toBe('text');
    expect(getEditorState()?.currentFrame).toBe(before);

    keydown(tabButton('text'), 'End');
    expect(document.activeElement).toBe(tabButton('background'));
    keydown(tabButton('background'), 'ArrowRight');
    expect(document.activeElement).toBe(tabButton('frame'));
    keydown(tabButton('frame'), 'ArrowLeft');
    expect(document.activeElement).toBe(tabButton('background'));
    keydown(tabButton('background'), 'Home');
    expect(document.activeElement).toBe(tabButton('frame'));
    expect(tabButton('frame').getAttribute('tabindex')).toBe('0');
    expect(tabButton('background').getAttribute('tabindex')).toBe('-1');
  });

  it('remembers the tab for the next clip in this page session', async () => {
    tabButton('background').click();
    await settle();
    cleanup?.();
    document.body.innerHTML = '<div id="main-content"></div>';
    mount();
    expect(getEditorState()?.sidebarTab).toBe('background');
    expect(tabButton('background').getAttribute('aria-selected')).toBe('true');
    expect($('#editor-side-panel-background').hidden).toBe(false);
  });

  it('Background: off shows only the switch; on shows one method, a badge and the view switch', async () => {
    tabButton('background').click();
    await settle();
    expect($('#background-enabled').getAttribute('role')).toBe('switch');
    expect($('#background-settings').hidden).toBe(true);
    expect($('#background-lead').hidden).toBe(false);
    expect($('#editor-side-tab-badge').hidden).toBe(true);
    expect($('#preview-view').hidden).toBe(true);

    check('background-enabled');
    await settle();
    expect($('#background-settings').hidden).toBe(false);
    expect($('#background-lead').hidden).toBe(true);
    expect($('#ai-color-fields').hidden).toBe(false);
    expect($('#ai-section').hidden).toBe(true);
    expect($('#editor-side-tab-badge').hidden).toBe(false);
    expect(tabButton('background').getAttribute('aria-label')).toBe('Background (on)');
    expect($('#preview-view').hidden).toBe(false);
    // The rarely needed settings are collapsed
    expect($('#background-mode').closest('details')?.open).toBe(false);

    check('ai-method-ai');
    await settle();
    expect($('#ai-color-fields').hidden).toBe(true);
    expect($('#ai-section').hidden).toBe(false);
    expect($('#ai-intro').closest('details')?.open).toBe(false);
    expect($('#ai-threshold').closest('details')?.id).toBe('ai-advanced');
  });

  it('leaving the Background tab ends the eyedropper', async () => {
    tabButton('background').click();
    check('background-enabled');
    await settle();
    check('background-pick');
    await settle();
    expect(getEditorState()?.pickingKeyColor).toBe(true);
    tabButton('frame').click();
    await settle();
    expect(getEditorState()?.pickingKeyColor).toBe(false);
  });

  it('Touch up mode replaces the tabs; Done leaves it and focus returns to its entry', async () => {
    tabButton('background').click();
    check('background-enabled');
    await settle();
    $('#touchup-brush').focus();
    check('touchup-brush');
    await settle();
    expect(getEditorState()?.brush.on).toBe(true);
    expect($('.editor-side-tabs').hidden).toBe(true);
    expect($('.editor-side-panels').hidden).toBe(true);
    expect($('#touchup-section').hidden).toBe(false);
    expect(document.activeElement).toBe($('#touchup-done'));

    $('#touchup-done').click();
    await settle();
    expect(getEditorState()?.brush.on).toBe(false);
    expect($('.editor-side-tabs').hidden).toBe(false);
    expect($('#touchup-section').hidden).toBe(true);
    expect(tabButton('background').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('#touchup-brush'));
  });

  it('the view switch sets the preview view; removal off shows the result again', async () => {
    tabButton('background').click();
    check('background-enabled');
    await settle();
    check('preview-view-mask');
    await settle();
    expect(getEditorState()?.previewView).toBe('mask');
    expect($('.editor-canvas-container').dataset.previewView).toBe('mask');
    check('background-enabled', false);
    await settle();
    expect($('.editor-canvas-container').dataset.previewView).toBe('result');
    expect(/** @type {HTMLInputElement} */ ($('#preview-view-result')).checked).toBe(true);
  });
});
