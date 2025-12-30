import { describe, it, expect } from 'vitest';
import {
  initEditorState,
  goToFrame,
  nextFrame,
  previousFrame,
  togglePlayback,
  updateCrop,
  clearCrop,
  toggleGrid,
} from '../../../src/features/editor/state.js';
import { createClip } from '../../../src/features/editor/core.js';

/**
 * Create mock ImageData for testing
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function createMockImageData(width, height) {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

/**
 * Create a mock frame for testing
 * @param {string} id
 * @param {number} width
 * @param {number} height
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id, width = 800, height = 600) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(width, height)),
    timestamp: 0,
    width,
    height,
  };
}

function createTestState() {
  const frames = [
    createMockFrame('1'),
    createMockFrame('2'),
    createMockFrame('3'),
  ];
  const clip = createClip(frames, 30);
  return initEditorState(clip);
}

describe('initEditorState', () => {
  it('initializes with clip data', () => {
    const state = createTestState();

    expect(state.clip).toBeDefined();
    expect(state.currentFrame).toBe(0);
    expect(state.selectedRange).toEqual({ start: 0, end: 2 });
    expect(state.cropArea).toBeNull();
    expect(state.isPlaying).toBe(true);
    expect(state.playbackSpeed).toBe(1);
    expect(state.showGrid).toBe(false);
  });
});

describe('goToFrame', () => {
  it('navigates to specific frame', () => {
    const state = createTestState();
    const newState = goToFrame(state, 1);

    expect(newState.currentFrame).toBe(1);
  });

  it('clamps to valid range', () => {
    const state = createTestState();

    expect(goToFrame(state, -5).currentFrame).toBe(0);
    expect(goToFrame(state, 100).currentFrame).toBe(2);
  });
});

describe('nextFrame / previousFrame', () => {
  it('navigates forward', () => {
    const state = createTestState();
    const newState = nextFrame(state);

    expect(newState.currentFrame).toBe(1);
  });

  it('navigates backward', () => {
    const state = goToFrame(createTestState(), 2);
    const newState = previousFrame(state);

    expect(newState.currentFrame).toBe(1);
  });
});

describe('togglePlayback', () => {
  it('toggles isPlaying', () => {
    const state = createTestState();

    expect(state.isPlaying).toBe(true); // Default is playing
    expect(togglePlayback(state).isPlaying).toBe(false);
    expect(togglePlayback(togglePlayback(state)).isPlaying).toBe(true);
  });
});

describe('updateCrop', () => {
  it('sets crop area', () => {
    const state = createTestState();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };

    const newState = updateCrop(state, crop);

    expect(newState.cropArea).toEqual(crop);
    expect(newState.clip.cropArea).toEqual(crop);
  });

  it('clamps crop to frame bounds', () => {
    const state = createTestState();
    const crop = { x: 700, y: 500, width: 200, height: 200, aspectRatio: 'free' };

    const newState = updateCrop(state, crop);

    expect(newState.cropArea.x + newState.cropArea.width).toBeLessThanOrEqual(800);
    expect(newState.cropArea.y + newState.cropArea.height).toBeLessThanOrEqual(600);
  });

  it('clears crop when passed null', () => {
    const state = createTestState();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const stateWithCrop = updateCrop(state, crop);

    const newState = updateCrop(stateWithCrop, null);

    expect(newState.cropArea).toBeNull();
    expect(newState.clip.cropArea).toBeNull();
  });
});

describe('clearCrop', () => {
  it('sets cropArea to null', () => {
    const state = createTestState();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const stateWithCrop = updateCrop(state, crop);

    const newState = clearCrop(stateWithCrop);

    expect(newState.cropArea).toBeNull();
  });
});

describe('toggleGrid', () => {
  it('toggles showGrid', () => {
    const state = createTestState();

    expect(state.showGrid).toBe(false);
    expect(toggleGrid(state).showGrid).toBe(true);
    expect(toggleGrid(toggleGrid(state)).showGrid).toBe(false);
  });
});
