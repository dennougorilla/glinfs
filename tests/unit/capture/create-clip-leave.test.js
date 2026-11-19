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
 * B4 (memory audit): the user leaves /capture (Back, Shift+C) while Create
 * Clip waits for the worker's frames. The frames become a queued clip; the
 * mounted screen is not touched and nothing throws.
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

describe('leaving /capture during Create Clip (B4)', () => {
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

  it('keeps the frames as a queued clip, without throwing', async () => {
    const { cleanup, manager } = await startSharing();
    let resolveFrames;
    manager.requestFrames.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFrames = r;
        }),
    );
    const bitmaps = fakeBitmaps(450);
    const created = uiCapture.handlers.onCreateClip();
    cleanup(); // route change while sharing: the session is preserved, the screen is gone
    resolveFrames(bitmaps);

    // Not created as the active clip: the caller must not navigate
    await expect(created).resolves.toBe(false);
    const { getClipPayload, getClipQueue } = await import('../../../src/shared/app-store.js');
    expect(getClipPayload()).toBeNull();
    const queue = getClipQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].frames).toHaveLength(450);
    expect(videoFrames.some((f) => f.closed)).toBe(false);
    expect(bitmaps.every((b) => b.bitmap.closed)).toBe(true);
  });

  it('closes the frames when the queue refuses them', async () => {
    localStorage.setItem(
      'glinfs_user_settings',
      JSON.stringify({ capture: { clipQueueLimit: 1, autoRemoveOldClips: false } }),
    );
    const { enqueueClip } = await import('../../../src/shared/app-store.js');
    enqueueClip({
      frames: [
        { id: 'x', frame: { close() {}, closed: false }, timestamp: 0, width: 10, height: 10 },
      ],
      fps: 30,
      capturedAt: 0,
    });
    const { cleanup, manager } = await startSharing();
    let resolveFrames;
    manager.requestFrames.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFrames = r;
        }),
    );
    const created = uiCapture.handlers.onCreateClip();
    cleanup();
    resolveFrames(fakeBitmaps(30));

    await expect(created).resolves.toBe(false);
    expect(videoFrames).toHaveLength(30);
    expect(videoFrames.every((f) => f.closed)).toBe(true);
  });
});
