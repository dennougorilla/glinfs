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
      this.terminateWithCleanup = vi.fn(() => Promise.resolve());
      this.requestFrames = vi.fn().mockResolvedValue([]);
      this.getEffectiveFrameDimensions = vi.fn(() => ({ width: 1440, height: 810, scaled: false }));
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
 * B2 (memory audit, PR C preview): the user presses the browser's "Stop
 * sharing" while on /capture. The kept buffer can still become a clip.
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

function fakeBitmaps(n, w = 1440, h = 810) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    timestamp: i * 33,
    bitmap: {
      width: w,
      height: h,
      closed: false,
      close() {
        this.closed = true;
      },
    },
  }));
}

describe('Create Clip after the browser stopped the share (B2)', () => {
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

  it('makes the kept buffer the active clip', async () => {
    const { manager } = await startSharing();
    manager.requestFrames.mockResolvedValue(fakeBitmaps(90));
    tracks.at(-1).fireEnded();
    expect(uiCapture.lastState.isSharing).toBe(false);

    const created = await uiCapture.handlers.onCreateClip();

    expect(created).toBe(true);
    expect(manager.requestFrames).toHaveBeenCalledOnce();
    const { getClipPayload } = await import('../../../src/shared/app-store.js');
    expect(getClipPayload()?.frames).toHaveLength(90);
    expect(videoFrames.some((f) => f.closed)).toBe(false);
  });

  it('checks the memory budget before draining the kept buffer', async () => {
    localStorage.setItem(
      'glinfs_user_settings',
      JSON.stringify({ capture: { memoryBudgetMB: 500 } }),
    );
    const { manager } = await startSharing();
    // The worker reported 450 buffered frames of 1440x810 RGBA: far over 500 MB
    manager.init.mock.calls.at(-1)[1].onStatsUpdate({ frameCount: 450, fps: 30 });
    tracks.at(-1).fireEnded();

    const created = await uiCapture.handlers.onCreateClip();

    expect(created).toBe(false);
    expect(manager.requestFrames).not.toHaveBeenCalled();
  });
});
