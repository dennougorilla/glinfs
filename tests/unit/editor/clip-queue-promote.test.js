import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, initEditor } from '../../../src/features/editor/index.js';
import {
  enqueueClip,
  getClipPayload,
  getClipQueue,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';

/**
 * Tests for #95: promote from the editor sidebar is an internal reinit that
 * preserves editor state across the swap, and an empty editor mount adopts
 * from the queue (1 clip: auto-promote; >=2: explicit selection screen).
 */

function createMockFrame(id) {
  return {
    id,
    data: { data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 },
    timestamp: Number(id) * 33,
    width: 100,
    height: 100,
  };
}

function createTestFrames(count, prefix = '') {
  return Array.from({ length: count }, (_, i) => createMockFrame(`${prefix}${i}`));
}

/** Click the first NON-active clip entry whose id matches */
function clickQueueEntry(id) {
  const entry = document.querySelector(`[data-testid="clip-entry"][data-clip-id="${id}"]`);
  expect(entry).not.toBeNull();
  const promoteBtn = entry?.querySelector('button.clip-entry-main');
  expect(promoteBtn).not.toBeNull();
  /** @type {HTMLButtonElement} */ (promoteBtn).click();
}

describe('Clip queue in the editor (#95)', () => {
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    // Fake timers keep auto-playback from advancing currentFrame mid-test
    vi.useFakeTimers();
    resetAppStore();
    localStorage.clear();
    window.__TEST_HOOKS__ = /** @type {any} */ ({});
    document.body.innerHTML = '<div id="main-content"></div>';
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetAppStore();
    delete window.__TEST_HOOKS__;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('renders the Clips section with the active clip first and queue entries after', () => {
    setClipPayload({ frames: createTestFrames(5, 'a'), fps: 30, capturedAt: Date.now() });
    enqueueClip({ frames: createTestFrames(5, 'b'), fps: 30, capturedAt: Date.now() });

    cleanup = initEditor();

    const entries = document.querySelectorAll('[data-testid="clip-entry"]');
    expect(entries).toHaveLength(2);
    expect(entries[0].hasAttribute('data-clip-active')).toBe(true);
    expect(entries[1].hasAttribute('data-clip-active')).toBe(false);
    // Active entry offers no promote/delete controls
    expect(entries[0].querySelector('button')).toBeNull();
  });

  it('promote A->B->A round-trips selection, crop, speed and current frame', () => {
    const framesA = createTestFrames(10, 'a');
    const framesB = createTestFrames(10, 'b');
    setClipPayload({ frames: framesA, fps: 30, capturedAt: Date.now() });
    const { entry: entryB } = enqueueClip({ frames: framesB, fps: 30, capturedAt: Date.now() });

    cleanup = initEditor();
    expect(getEditorState()?.clip?.frames).toBe(framesA);
    const idA = getClipPayload()?.id;

    // Give clip A a distinctive editor state
    const stateA = {
      selectedRange: { start: 2, end: 7 },
      cropArea: { x: 10, y: 10, width: 50, height: 50, aspectRatio: 'free' },
      playbackSpeed: 2,
      currentFrame: 4,
    };
    window.__TEST_HOOKS__.setEditorState(stateA);

    // A -> B via the sidebar entry (internal reinit)
    clickQueueEntry(entryB.id);
    expect(getEditorState()?.clip?.frames).toBe(framesB);
    // A now sits in the queue carrying stateA
    expect(getClipQueue()[0].savedEditorState).toMatchObject({
      selectedRange: stateA.selectedRange,
      playbackSpeed: 2,
      currentFrame: 4,
    });

    // B -> A: the editor restores A's saved state
    clickQueueEntry(/** @type {string} */ (idA));
    const restored = getEditorState();
    expect(restored?.clip?.frames).toBe(framesA);
    expect(restored?.selectedRange).toEqual({ start: 2, end: 7 });
    expect(restored?.cropArea).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
    expect(restored?.playbackSpeed).toBe(2);
    expect(restored?.currentFrame).toBe(4);

    // The saved snapshot was consumed — a later mount must not re-apply it
    expect(getClipPayload()?.savedEditorState).toBeNull();
  });

  it('auto-promotes on empty mount when exactly one clip is queued', () => {
    const frames = createTestFrames(5, 'q');
    const { entry } = enqueueClip({ frames, fps: 30, capturedAt: Date.now() });

    cleanup = initEditor();

    expect(getEditorState()?.clip?.frames).toBe(frames);
    expect(getClipPayload()?.id).toBe(entry.id);
    expect(getClipQueue()).toHaveLength(0);
  });

  it('shows "Select a clip to edit" on empty mount with two or more queued clips', () => {
    enqueueClip({ frames: createTestFrames(3, 'x'), fps: 30, capturedAt: Date.now() });
    const { entry: newest } = enqueueClip({
      frames: createTestFrames(3, 'y'),
      fps: 30,
      capturedAt: Date.now(),
    });

    cleanup = initEditor();

    // No clip was guessed into the editor
    expect(getEditorState()).toBeNull();
    const select = document.querySelector('.editor-clip-select');
    expect(select).not.toBeNull();
    expect(select?.textContent).toContain('Select a clip to edit');
    expect(document.querySelectorAll('[data-testid="clip-entry"]')).toHaveLength(2);

    // Picking one mounts the real editor against it
    clickQueueEntry(newest.id);
    expect(getEditorState()?.clip?.frames).toBe(newest.frames);
    expect(document.querySelector('.editor-clip-select')).toBeNull();
  });
});
