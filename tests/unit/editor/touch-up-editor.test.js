/**
 * The mask brush wired into a mounted editor: the Touch up section
 * (disabled while removal is off, controls, counts), strokes painted with
 * pointer events on the preview (priority over the crop, playback pauses,
 * scope ranges), Undo / Clear on this frame / Clear all with its toast
 * Undo, and Escape leaving the brush first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { updateEditsPanel } from '../../../src/features/editor/panels/edits-panel.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

// Count full edits-panel updates (the Touch up section alone follows the playhead)
vi.mock('../../../src/features/editor/panels/edits-panel.js', async (importOriginal) => {
  const actual =
    /** @type {typeof import('../../../src/features/editor/panels/edits-panel.js')} */ (
      await importOriginal()
    );
  return { ...actual, updateEditsPanel: vi.fn(actual.updateEditsPanel) };
});

/**
 * @param {number} count
 */
function createTestFrames(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    data: { data: new Uint8ClampedArray(20 * 10 * 4), width: 20, height: 10 },
    timestamp: i * 33,
    width: 20,
    height: 10,
  }));
}

/** @param {string} key */
function press(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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
 * @param {string} type
 * @param {number} x - Client x (the preview is stubbed to 200x100 at 0,0)
 * @param {number} y
 */
function pointer(type, x, y) {
  $('.editor-canvas-overlay').dispatchEvent(
    new PointerEvent(type, {
      pointerId: 7,
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Paint a horizontal stroke from (x0, y) to (x1, y), client pixels */
function paint(x0, x1, y) {
  pointer('pointerdown', x0, y);
  $('.editor-canvas-overlay').dispatchEvent(
    new MouseEvent('mousedown', { clientX: x0, clientY: y, bubbles: true, cancelable: true }),
  );
  for (let x = x0; x <= x1; x += 5) pointer('pointermove', x, y);
  pointer('pointerup', x1, y);
}

describe('Mask brush in the mounted editor', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
    setClipPayload({
      frames: createTestFrames(6),
      fps: 10,
      capturedAt: Date.now(),
      id: 'clip-t',
    });
    cleanup = /** @type {() => void} */ (initEditor());
    window.__TEST_HOOKS__.setEditorState({ isPlaying: false });
    const rect = /** @type {DOMRect} */ ({ left: 0, top: 0, width: 200, height: 100 });
    /** @type {HTMLElement} */ ($('.editor-canvas')).getBoundingClientRect = () => rect;
    $('.editor-canvas-container').getBoundingClientRect = () => rect;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('the section is disabled until background removal is on', async () => {
    const controls = /** @type {HTMLFieldSetElement} */ ($('#touchup-controls'));
    expect(controls.disabled).toBe(true);
    // The Brush tool lives in the settings, shown once removal is on
    expect($('#background-settings').hidden).toBe(true);
    expect($('#touchup-summary').textContent).toBe('No touch-ups yet.');

    check('subject-color');
    await settle();
    expect(controls.disabled).toBe(false);
    expect($('#background-settings').hidden).toBe(false);
    expect(/** @type {HTMLInputElement} */ ($('#touchup-brush')).disabled).toBe(false);
    expect(/** @type {HTMLInputElement} */ ($('#touchup-mode-erase')).checked).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('#touchup-scope-frame')).checked).toBe(true);
    expect($('#touchup-size-value').textContent).toBe('1 px');
    expect(/** @type {HTMLButtonElement} */ ($('#touchup-undo')).disabled).toBe(true);
  });

  it('paints strokes with the pointer (not a crop), pausing playback, over the chosen scope', async () => {
    check('subject-color');
    await settle();
    check('touchup-brush');
    await settle();
    expect(getEditorState()?.brush.on).toBe(true);
    expect($('.editor-canvas-container').classList.contains('editor-brush-painting')).toBe(true);
    expect($('#touchup-status').textContent).toContain(
      'Paint on the preview to erase on this frame',
    );

    // Size: slider value 40 = radius 0.1 of the 10 px side = 2 px diameter
    const size = /** @type {HTMLInputElement} */ ($('#touchup-size'));
    size.value = '40';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(getEditorState()?.brush.radius).toBe(0.1);
    expect($('#touchup-size-value').textContent).toBe('2 px');

    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2, isPlaying: true });
    paint(20, 120, 50);
    await settle();
    let state = getEditorState();
    expect(state?.isPlaying).toBe(false);
    expect(state?.cropArea).toBeNull();
    expect(state?.edits.touchUps).toHaveLength(1);
    const [first] = state?.edits.touchUps ?? [];
    expect(first).toMatchObject({ mode: 'erase', radius: 0.1, start: 2, end: 2 });
    expect(first.points[0]).toEqual({ x: 0.1, y: 0.5 });
    expect(first.points.at(-1)).toEqual({ x: 0.6, y: 0.5 });
    expect($('#touchup-summary').textContent).toBe('1 stroke on this frame, 1 stroke in total.');

    // The cursor showed over the preview and hides when the pointer leaves
    pointer('pointermove', 50, 50);
    expect($('.editor-brush-cursor').hidden).toBe(false);
    expect($('.editor-brush-cursor').style.width).toBe('20px');
    pointer('pointerleave', 50, 50);
    expect($('.editor-brush-cursor').hidden).toBe(true);

    // Restore over the selection
    check('touchup-mode-restore');
    check('touchup-scope-selection');
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 1, end: 4 } });
    await settle();
    paint(150, 190, 20);
    await settle();
    state = getEditorState();
    expect(state?.edits.touchUps[1]).toMatchObject({ mode: 'restore', start: 1, end: 4 });

    // Clear on this frame (2): the first stroke goes, the second is split
    $('#touchup-clear-frame').click();
    await settle();
    state = getEditorState();
    expect(state?.edits.touchUps.map((s) => [s.mode, s.start, s.end])).toEqual([
      ['restore', 1, 1],
      ['restore', 3, 4],
    ]);
    expect(/** @type {HTMLButtonElement} */ ($('#touchup-clear-frame')).disabled).toBe(true);

    // Undo last stroke
    $('#touchup-undo').click();
    await settle();
    expect(getEditorState()?.edits.touchUps).toHaveLength(1);

    // Clear all, and its toast's Undo
    $('#touchup-clear-all').click();
    await settle();
    expect(getEditorState()?.edits.touchUps).toEqual([]);
    const undo = /** @type {HTMLElement} */ ($('.app-toast-action'));
    expect(undo.textContent).toBe('Undo');
    undo.click();
    await settle();
    expect(getEditorState()?.edits.touchUps).toHaveLength(1);
  });

  it('a pointer that leaves the preview breaks the stroke instead of painting along the edge', async () => {
    check('subject-color');
    check('touchup-brush');
    await settle();
    // Inside, out past the right edge (the preview is 200x100), down, and back in
    pointer('pointerdown', 100, 50);
    for (const [x, y] of [
      [150, 50],
      [250, 50],
      [260, 60],
      [250, 80],
      [150, 80],
    ]) {
      pointer('pointermove', x, y);
    }
    pointer('pointerup', 150, 80);
    await settle();
    const strokes = getEditorState()?.edits.touchUps ?? [];
    expect(strokes).toHaveLength(2);
    const [out, back] = strokes;
    // The first stroke stops where the pointer crossed the edge, the second
    // starts where it came back: nothing is painted between them
    expect(out.points[0]).toEqual({ x: 0.5, y: 0.5 });
    expect(out.points.at(-1)).toEqual({ x: 1, y: 0.5 });
    expect(back.points[0]).toEqual({ x: 1, y: 0.8 });
    expect(back.points.at(-1)).toEqual({ x: 0.75, y: 0.8 });
    const onEdge = strokes.flatMap((s) => s.points).filter((p) => p.x === 1);
    expect(onEdge).toEqual([
      { x: 1, y: 0.5 },
      { x: 1, y: 0.8 },
    ]);
    // Both belong to the same gesture: same settings, same frame
    expect(back).toMatchObject({ mode: out.mode, radius: out.radius, start: 0, end: 0 });

    // A gesture that never crosses the frame paints nothing
    pointer('pointerdown', 100, 50);
    pointer('pointermove', 250, 50);
    pointer('pointermove', 250, 120);
    pointer('pointerup', 250, 120);
    await settle();
    expect(getEditorState()?.edits.touchUps).toHaveLength(3);
    pointer('pointerdown', 250, 50);
    pointer('pointermove', 260, 50);
    pointer('pointerup', 260, 50);
    await settle();
    expect(getEditorState()?.edits.touchUps).toHaveLength(3);
  });

  it('Escape during a stroke cancels that stroke; the next Escape leaves the brush', async () => {
    check('subject-color');
    check('touchup-brush');
    await settle();
    pointer('pointerdown', 20, 50);
    pointer('pointermove', 60, 50);
    pointer('pointermove', 100, 50);
    press('Escape');
    // Still pressed: moving on paints nothing, and the release adds nothing
    pointer('pointermove', 140, 50);
    pointer('pointerup', 140, 50);
    await settle();
    expect(getEditorState()?.edits.touchUps).toEqual([]);
    expect(getEditorState()?.brush.on).toBe(true);
    press('Escape');
    expect(getEditorState()?.brush.on).toBe(false);

    // The same from a focused panel control
    check('touchup-brush');
    await settle();
    pointer('pointerdown', 20, 50);
    pointer('pointermove', 60, 50);
    $('#touchup-size').focus();
    press('Escape');
    pointer('pointerup', 60, 50);
    await settle();
    expect(getEditorState()?.edits.touchUps).toEqual([]);
    expect(getEditorState()?.brush.on).toBe(true);
  });

  it('a played frame updates the Touch up section only, not the whole edits panel', async () => {
    check('subject-color');
    check('touchup-brush');
    await settle();
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 2 });
    paint(20, 60, 50);
    await settle();
    vi.mocked(updateEditsPanel).mockClear();
    for (const frame of [3, 2, 4]) {
      window.__TEST_HOOKS__.setEditorState({ currentFrame: frame });
      await settle();
      expect($('#touchup-summary').textContent).toBe(
        `${frame === 2 ? 1 : 0} stroke${frame === 2 ? '' : 's'} on this frame, 1 stroke in total.`,
      );
    }
    expect(updateEditsPanel).not.toHaveBeenCalled();
  });

  it('Selection scope on a frame outside IN..OUT paints that frame only and says so', async () => {
    check('subject-color');
    check('touchup-brush');
    check('touchup-scope-selection');
    window.__TEST_HOOKS__.setEditorState({ selectedRange: { start: 1, end: 3 }, currentFrame: 2 });
    await settle();
    expect($('#touchup-status').textContent).toContain('across the selection');
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 5 });
    await settle();
    expect($('#touchup-status').textContent).toContain(
      'This frame is outside the selection (IN to OUT), so strokes apply to this frame only.',
    );
    paint(20, 60, 50);
    await settle();
    expect(getEditorState()?.edits.touchUps[0]).toMatchObject({ start: 5, end: 5 });
    expect($('#touchup-summary').textContent).toBe('1 stroke on this frame, 1 stroke in total.');

    // Back inside the selection: the whole selection again
    window.__TEST_HOOKS__.setEditorState({ currentFrame: 1 });
    await settle();
    expect($('#touchup-status').textContent).toContain('across the selection');
    expect($('#touchup-summary').textContent).toBe('0 strokes on this frame, 1 stroke in total.');
    paint(20, 60, 50);
    await settle();
    expect(getEditorState()?.edits.touchUps[1]).toMatchObject({ start: 1, end: 3 });
  });

  it('Escape leaves the brush first, then the crop; removal off switches the brush off', async () => {
    check('subject-color');
    window.__TEST_HOOKS__.setEditorState({
      cropArea: { x: 2, y: 1, width: 10, height: 6, aspectRatio: 'free' },
    });
    check('touchup-brush');
    await settle();

    // The eyedropper leaves the brush, and the brush leaves the eyedropper
    check('background-pick');
    await settle();
    expect(getEditorState()).toMatchObject({ pickingKeyColor: true, brush: { on: false } });
    check('touchup-brush');
    await settle();
    expect(getEditorState()).toMatchObject({ pickingKeyColor: false, brush: { on: true } });

    press('Escape');
    await settle();
    expect(getEditorState()?.brush.on).toBe(false);
    expect(getEditorState()?.cropArea).not.toBeNull();
    expect($('.editor-canvas-container').classList.contains('editor-brush-painting')).toBe(false);
    // Leaving the mode from Done (focused on entering) returns focus to the
    // Touch up entry, a form control where Escape only leaves tools; from
    // outside the panel the next Escape clears the crop
    expect(document.activeElement?.id).toBe('touchup-brush');
    /** @type {HTMLElement} */ (document.activeElement).blur();
    press('Escape');
    expect(getEditorState()?.cropArea).toBeNull();

    // Escape from a focused panel control leaves the brush too
    check('touchup-brush');
    $('#touchup-size').focus();
    press('Escape');
    expect(getEditorState()?.brush.on).toBe(false);

    check('touchup-brush');
    await settle();
    check('subject-none');
    await settle();
    expect(getEditorState()?.brush.on).toBe(false);
    expect(/** @type {HTMLFieldSetElement} */ ($('#touchup-controls')).disabled).toBe(true);
  });
});
