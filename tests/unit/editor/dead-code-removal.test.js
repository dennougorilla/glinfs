/**
 * Regression tests for the Biome dead-code sweep (#50).
 *
 * - openFrameGridModal() dropped its unused `container` parameter (it always
 *   rendered into document.body, never the passed-in container). This test
 *   guards the new 3-arg signature still opens the modal correctly from the
 *   "Open Grid" button in the timeline header.
 * - The empty `catch` block around scene-thumbnail creation now logs via
 *   console.warn instead of silently swallowing the error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/features/editor/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createThumbnailCanvas: vi.fn(() => {
      throw new Error('boom: no image data');
    }),
  };
});

const { initEditorState } = await import('../../../src/features/editor/state.js');
const { createClip } = await import('../../../src/features/editor/core.js');
const { renderEditorScreen } = await import('../../../src/features/editor/ui.js');

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

/**
 * @returns {import('../../../src/features/editor/ui.js').EditorUIHandlers}
 */
function createHandlers() {
  return {
    onTogglePlay: vi.fn(),
    onFrameChange: vi.fn(),
    onRangeChange: vi.fn(),
    onCropChange: vi.fn(),
    onToggleGrid: vi.fn(),
    onAspectRatioChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onExport: vi.fn(),
  };
}

describe('Editor dead-code sweep (#50)', () => {
  /** @type {HTMLElement} */
  let container;
  /** @type {(() => void) | null} */
  let cleanup = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('opens the frame grid modal via the container-less openFrameGridModal signature', () => {
    const state = initEditorState(createClip(createTestFrames(10), 30));
    const result = renderEditorScreen(container, state, createHandlers(), 30);
    cleanup = result.cleanup;

    const openBtn = /** @type {HTMLButtonElement} */ (
      container.querySelector('[aria-label="Open frame grid for selection"]')
    );
    expect(openBtn).toBeTruthy();

    openBtn.click();

    // openFrameGridModal renders into document.body (not the passed-in
    // container) — this is exactly why the `container` parameter it used to
    // take was dead.
    expect(document.querySelector('.frame-grid-modal')).not.toBeNull();
  });

  it('logs a warning instead of silently swallowing scene-thumbnail creation errors', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const clip = createClip(createTestFrames(10), 30);
    const state = {
      ...initEditorState(clip),
      sceneDetectionStatus: 'completed',
      scenes: [{ id: 'scene-0', startFrame: 0, endFrame: 9 }],
    };
    const result = renderEditorScreen(container, state, createHandlers(), 30);
    cleanup = result.cleanup;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('scene thumbnail'),
      expect.any(Error),
    );

    // The placeholder fallback still renders even though the thumbnail
    // canvas creation threw.
    expect(container.querySelector('.scene-thumbnail-placeholder')).not.toBeNull();

    warnSpy.mockRestore();
  });
});
