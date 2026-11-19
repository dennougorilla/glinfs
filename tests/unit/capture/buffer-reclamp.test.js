import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const managerInstances = vi.hoisted(() => []);
const uiCapture = vi.hoisted(() => ({ handlers: null, lastState: null }));
const tracks = vi.hoisted(() => []);

vi.mock('../../../src/workers/capture-worker-manager.js', () => {
  class FakeCaptureWorkerManager {
    constructor() {
      this.init = vi.fn();
      this.start = vi.fn();
      this.stop = vi.fn();
      this.clear = vi.fn();
      this.terminate = vi.fn();
      this.resize = vi.fn();
      this.terminateWithCleanup = vi.fn(() => Promise.resolve());
      this.requestFrames = vi.fn().mockResolvedValue([]);
      this.getEffectiveFrameDimensions = vi.fn(() => null);
      managerInstances.push(this);
    }
  }
  return { CaptureWorkerManager: FakeCaptureWorkerManager };
});
vi.mock('../../../src/features/capture/api.js', () => ({
  startScreenCapture: vi.fn(),
  createVideoElement: vi.fn(),
  stopScreenCapture: vi.fn(),
}));
vi.mock('../../../src/features/capture/ui.js', () => ({
  renderCaptureScreen: vi.fn((_c, state, handlers) => {
    uiCapture.handlers = handlers;
    uiCapture.lastState = state;
    return () => {};
  }),
  updateBufferStatus: vi.fn(),
  updateImportStatus: vi.fn(),
  updateSceneDetectionToggle: vi.fn(),
}));

/**
 * B5 (memory audit): the shared window grows after the share started. The
 * buffer capacity is computed again for the new frame size, so the buffer
 * keeps to its share of the memory budget.
 */

import { createVideoElement, startScreenCapture } from '../../../src/features/capture/api.js';

function createFakeTrack() {
  let endedHandler = null;
  const t = {
    readyState: 'live',
    addEventListener: vi.fn((type, h) => {
      if (type === 'ended') endedHandler = h;
    }),
    removeEventListener: vi.fn(),
    stop: vi.fn(() => {
      t.readyState = 'ended';
    }),
    fireEnded() {
      t.readyState = 'ended';
      endedHandler?.();
    },
  };
  return t;
}

const videoFrames = [];
class FakeVideoFrame {
  constructor(bitmap, opts) {
    this.codedWidth = bitmap.width;
    this.codedHeight = bitmap.height;
    this.timestamp = opts?.timestamp ?? 0;
    this.closed = false;
    videoFrames.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe('ring buffer re-clamp on a frame-size change (B5)', () => {
  beforeEach(() => {
    vi.resetModules();
    managerInstances.length = 0;
    tracks.length = 0;
    videoFrames.length = 0;
    localStorage.clear();
    document.body.innerHTML = '<div id="main-content"></div>';
    globalThis.VideoFrame = FakeVideoFrame;
    vi.mocked(startScreenCapture).mockImplementation(async () => {
      const t = createFakeTrack();
      tracks.push(t);
      return { getVideoTracks: () => [t], getTracks: () => [t] };
    });
    vi.mocked(createVideoElement).mockImplementation(async () => ({
      pause: vi.fn(),
      srcObject: null,
    }));
  });
  afterEach(() => {
    delete globalThis.VideoFrame;
  });

  async function startSharing() {
    const captureModule = await import('../../../src/features/capture/index.js');
    const cleanup = captureModule.initCapture();
    await uiCapture.handlers.onStart();
    return { captureModule, cleanup, manager: managerInstances.at(-1) };
  }

  it('re-clamps the buffer for the new frame size', async () => {
    const { captureModule, manager } = await startSharing();
    const { onFrameSizeChange } = manager.init.mock.calls.at(-1)[1];

    // 1920x1080 at the default 4000 MB budget: 60 % fits 303 frames of
    // 8.29 MB (MiB accounting on main), fewer than 30 fps x 15 s = 450
    onFrameSizeChange({ width: 1920, height: 1080, scaled: false });

    const expected = Math.floor((4000 * 0.6 * 1024 * 1024) / (1920 * 1080 * 4));
    expect(manager.resize).toHaveBeenCalledWith(expected);
    expect(captureModule.getCaptureState()?.bufferLimit).toMatchObject({
      maxFrames: expected,
      clamped: true,
    });

    // Smaller again: the full 450 frames fit
    onFrameSizeChange({ width: 1280, height: 720, scaled: false });
    expect(manager.resize).toHaveBeenLastCalledWith(450);
  });

  it('hands the new limit to the live stats, so the note follows it (#231 review)', async () => {
    vi.useFakeTimers();
    try {
      const { manager } = await startSharing();
      const { onFrameSizeChange } = manager.init.mock.calls.at(-1)[1];
      const { updateBufferStatus } = await import('../../../src/features/capture/ui.js');

      onFrameSizeChange({ width: 1920, height: 1080, scaled: false });
      await vi.advanceTimersByTimeAsync(200);
      expect(vi.mocked(updateBufferStatus).mock.calls.at(-1)?.[2]).toMatchObject({
        clamped: true,
      });

      onFrameSizeChange({ width: 1280, height: 720, scaled: false });
      await vi.advanceTimersByTimeAsync(200);
      expect(vi.mocked(updateBufferStatus).mock.calls.at(-1)?.[2]).toMatchObject({
        clamped: false,
        maxFrames: 450,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
