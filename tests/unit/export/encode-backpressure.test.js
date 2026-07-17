import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the worker manager module so encodeGif runs against a controllable
 * fake instead of a real Worker.
 */
const managerFactory = vi.hoisted(() => ({
  /** @type {(() => any) | null} */
  create: null,
}));

vi.mock('../../../src/workers/worker-manager.js', () => ({
  createEncoderManager: () => {
    if (!managerFactory.create) {
      throw new Error('Test did not install a fake manager factory');
    }
    return managerFactory.create();
  },
}));

import { encodeGif, MAX_IN_FLIGHT_FRAMES } from '../../../src/features/export/api.js';

/**
 * Fake encoder manager that simulates slow worker-side processing:
 * frames are "processed" (PROGRESS emitted) on a macrotask, i.e. strictly
 * slower than the microtask-based frame extraction on the main thread.
 */
class FakeEncoderManager {
  constructor({ autoProcess = true } = {}) {
    this.onProgress = null;
    this.onError = null;
    this.submitted = 0;
    this.processed = 0;
    this.maxInFlight = 0;
    this.totalFrames = 0;
    this.disposed = false;
    this.cancelled = false;
    this.autoProcess = autoProcess;
  }

  async init(config) {
    this.totalFrames = config.totalFrames;
  }

  addFrame(_rgba, _width, _height, frameIndex) {
    this.submitted++;
    this.maxInFlight = Math.max(this.maxInFlight, this.submitted - this.processed);

    if (!this.autoProcess) return;

    // Emit PROGRESS on a macrotask: extraction (microtask) always wins the
    // race, so without backpressure every frame is submitted before any
    // PROGRESS arrives.
    setTimeout(() => {
      if (this.disposed) return;
      this.processed++;
      this.onProgress?.({
        percent: Math.round((this.processed / this.totalFrames) * 100),
        frameIndex,
        totalFrames: this.totalFrames,
      });
    }, 0);
  }

  async finish() {
    while (this.processed < this.submitted) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return new Blob(['gif'], { type: 'image/gif' });
  }

  cancel() {
    this.cancelled = true;
  }

  dispose() {
    this.disposed = true;
    this.onProgress = null;
    this.onError = null;
  }
}

/**
 * Create a mock frame whose VideoFrame supports copyTo
 * @param {number} index
 */
function createMockFrame(index) {
  return {
    id: `frame-${index}`,
    frame: {
      codedWidth: 8,
      codedHeight: 8,
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    },
    timestamp: index,
    width: 8,
    height: 8,
  };
}

const SETTINGS = {
  quality: 0.7,
  frameSkip: 1,
  playbackSpeed: 1,
  encoderPreset: 'balanced',
  loopCount: 0,
  encoderId: 'gifenc-js',
};

/**
 * @param {number} count
 */
function createFrames(count) {
  return Array.from({ length: count }, (_, i) => createMockFrame(i));
}

describe('encodeGif backpressure (regression #39)', () => {
  /** @type {FakeEncoderManager} */
  let fakeManager;

  beforeEach(() => {
    fakeManager = new FakeEncoderManager();
    managerFactory.create = () => fakeManager;
  });

  it('never exceeds the in-flight window while submitting frames', async () => {
    // Arrange - 3x the window size so the loop must wait repeatedly
    const totalFrames = MAX_IN_FLIGHT_FRAMES * 3;
    const frames = createFrames(totalFrames);

    // Act
    const blob = await encodeGif({
      frames,
      crop: null,
      settings: SETTINGS,
      fps: 30,
      onProgress: vi.fn(),
    });

    // Assert - before the fix every frame was submitted fire-and-forget, so
    // maxInFlight equaled totalFrames (12 here; multi-GB at 1080p scale)
    expect(fakeManager.submitted).toBe(totalFrames);
    expect(fakeManager.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT_FRAMES);
    expect(blob).toBeInstanceOf(Blob);
  });

  it('still reports UI progress for every processed frame', async () => {
    // Arrange
    const totalFrames = MAX_IN_FLIGHT_FRAMES * 2;
    const frames = createFrames(totalFrames);
    const onProgress = vi.fn();

    // Act
    await encodeGif({ frames, crop: null, settings: SETTINGS, fps: 30, onProgress });

    // Assert
    expect(onProgress).toHaveBeenCalledTimes(totalFrames);
    expect(onProgress).toHaveBeenLastCalledWith({
      percent: 100,
      current: totalFrames,
      total: totalFrames,
    });
  });

  it('rejects with AbortError when aborted while waiting for window space', async () => {
    // Arrange - the fake never processes frames, so the loop blocks once the
    // window is full
    fakeManager = new FakeEncoderManager({ autoProcess: false });
    managerFactory.create = () => fakeManager;

    const frames = createFrames(MAX_IN_FLIGHT_FRAMES + 2);
    const controller = new AbortController();

    const encodePromise = encodeGif(
      { frames, crop: null, settings: SETTINGS, fps: 30, onProgress: vi.fn() },
      controller.signal,
    );
    encodePromise.catch(() => {});

    // Wait until the window is saturated (loop is parked)
    await vi.waitFor(() => {
      expect(fakeManager.submitted).toBe(MAX_IN_FLIGHT_FRAMES);
    });

    // Act
    controller.abort();

    // Assert - abort must wake the parked loop instead of deadlocking
    await expect(encodePromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakeManager.cancelled).toBe(true);
    expect(fakeManager.disposed).toBe(true);
  });

  it('rejects when the worker reports a frame error while the loop is waiting', async () => {
    // Arrange - a failed frame emits ERROR instead of PROGRESS, so the
    // window would never drain without the onError wake-up
    fakeManager = new FakeEncoderManager({ autoProcess: false });
    managerFactory.create = () => fakeManager;

    const frames = createFrames(MAX_IN_FLIGHT_FRAMES + 2);

    const encodePromise = encodeGif({
      frames,
      crop: null,
      settings: SETTINGS,
      fps: 30,
      onProgress: vi.fn(),
    });
    encodePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(fakeManager.submitted).toBe(MAX_IN_FLIGHT_FRAMES);
    });

    // Act - simulate the worker posting an ERROR event for a frame
    fakeManager.onError?.(new Error('quantization failed'));

    // Assert
    await expect(encodePromise).rejects.toThrow('quantization failed');
    expect(fakeManager.disposed).toBe(true);
  });
});
