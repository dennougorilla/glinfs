/**
 * Regression tests for the issue #98 remainder:
 * - Zero detected scenes render one quiet hint line, not the old
 *   icon + two-line "Single scene clip" block.
 * - The CLIPS/SCENES sidebar tab choice survives a re-render / editor
 *   remount within the same session (sessionStorage-backed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import { resetAppStore, setClipPayload } from '../../../src/shared/app-store.js';

/**
 * @param {number} width
 * @param {number} height
 */
function createMockImageData(width, height) {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

/**
 * @param {string} id
 * @param {number} timestamp
 */
function createMockFrame(id, timestamp = 0) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(10, 10)),
    timestamp,
    width: 10,
    height: 10,
  };
}

/**
 * @param {number} count
 */
function createTestFrames(count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(createMockFrame(String(i), i * 33.33));
  }
  return frames;
}

describe('issue #98 remainder: zero-scenes hint + remembered sidebar tab', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    resetAppStore();
    document.body.innerHTML = '<div id="main-content"></div>';
    try {
      sessionStorage.clear();
    } catch {
      // sessionStorage unavailable in this environment - nothing to clear
    }
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    document.body.innerHTML = '';
    try {
      sessionStorage.clear();
    } catch {
      // sessionStorage unavailable in this environment - nothing to clear
    }
  });

  it('renders a single quiet hint line when scene detection completed with zero scenes', () => {
    setClipPayload({
      frames: createTestFrames(10),
      fps: 30,
      capturedAt: Date.now(),
      sceneDetectionEnabled: true,
      scenes: [],
    });

    cleanup = initEditor();

    const state = getEditorState();
    expect(state?.sceneDetectionStatus).toBe('completed');
    expect(state?.scenes).toEqual([]);

    const sidebar = document.querySelector('[data-scenes-container]');
    expect(sidebar).not.toBeNull();

    // Exactly one quiet hint line, styled like the detection-off hint -
    // not the old icon + text + subtext three-element block.
    const hints = sidebar?.querySelectorAll('.scenes-sidebar-hint');
    expect(hints?.length).toBe(1);
    expect(hints?.[0]?.textContent).toBe('No scene changes detected');
    expect(sidebar?.querySelector('.scenes-sidebar-icon')).toBeNull();
    expect(sidebar?.querySelector('.scenes-sidebar-empty')).toBeNull();
    expect(sidebar?.textContent).not.toContain('Single scene clip');
  });

  it('remembers the SCENES tab across a re-render triggered from CLIPS', () => {
    setClipPayload({
      frames: createTestFrames(10),
      fps: 30,
      capturedAt: Date.now(),
    });

    cleanup = initEditor();

    const scenesTab = /** @type {HTMLElement} */ (
      document.querySelector('[data-testid="tab-scenes"]')
    );
    const clipsPane = document.querySelector('[data-pane="clips"]');
    const scenesPane = document.querySelector('[data-pane="scenes"]');
    expect(scenesTab).not.toBeNull();

    // CLIPS is the default before any selection is made
    expect(/** @type {HTMLElement} */ (clipsPane)?.hidden).toBe(false);

    scenesTab.click();
    expect(/** @type {HTMLElement} */ (scenesPane)?.hidden).toBe(false);
    expect(/** @type {HTMLElement} */ (clipsPane)?.hidden).toBe(true);

    // Simulate a full editor remount (e.g. promote/demote or navigation
    // back into the editor) - it must restore SCENES, not reset to CLIPS.
    cleanup?.();
    cleanup = initEditor();

    const clipsPaneAfter = document.querySelector('[data-pane="clips"]');
    const scenesPaneAfter = document.querySelector('[data-pane="scenes"]');
    const scenesTabAfter = document.querySelector('[data-testid="tab-scenes"]');

    expect(/** @type {HTMLElement} */ (scenesPaneAfter)?.hidden).toBe(false);
    expect(/** @type {HTMLElement} */ (clipsPaneAfter)?.hidden).toBe(true);
    expect(scenesTabAfter?.classList.contains('sidebar-tab--active')).toBe(true);
  });
});
