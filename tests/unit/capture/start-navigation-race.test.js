import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for #168: leaving the Capture screen while "Select Screen"
 * is still in flight (share picker open, or stream metadata loading).
 *
 * cleanup() nulls the module `store`. Before the fix, handleStart() resumed
 * after its await and called store.setState() on null; the catch block did
 * the same and threw again before it could stop the track, so the acquired
 * MediaStream was never stopped and the browser kept sharing until reload.
 */

const managerInstances = vi.hoisted(() => /** @type {any[]} */ ([]));
const uiCapture = vi.hoisted(() => /** @type {{ handlers: any }} */ ({ handlers: null }));

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
      // null = video metadata unknown -> budget clamp is skipped (#96)
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
  renderCaptureScreen: vi.fn((_container, _state, handlers) => {
    uiCapture.handlers = handlers;
    return () => {};
  }),
  updateBufferStatus: vi.fn(),
  updateSceneDetectionToggle: vi.fn(),
}));

import {
  createVideoElement,
  startScreenCapture,
  stopScreenCapture,
} from '../../../src/features/capture/api.js';

/** @param {string} kind */
function createFakeTrack(kind) {
  return {
    kind,
    readyState: 'live',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(function () {
      this.readyState = 'ended';
    }),
  };
}

/** A shared screen with system audio: both tracks must be stopped */
function createFakeStream() {
  const video = createFakeTrack('video');
  const audio = createFakeTrack('audio');
  return {
    getVideoTracks: () => [video],
    getTracks: () => [video, audio],
  };
}

function createFakeVideoElement() {
  return { pause: vi.fn(), srcObject: /** @type {unknown} */ ('stream') };
}

/**
 * @template T
 * @returns {{ promise: Promise<T>, resolve: (value: T) => void, reject: (err: unknown) => void }}
 */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(err: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('leaving the Capture screen while a start is in flight (#168)', () => {
  beforeEach(() => {
    vi.resetModules();
    managerInstances.length = 0;
    uiCapture.handlers = null;
    localStorage.clear();
    document.body.innerHTML = '<div id="main-content"></div>';

    // The real stopScreenCapture: stop every track of the stream
    vi.mocked(stopScreenCapture).mockImplementation((stream) => {
      for (const track of stream?.getTracks() ?? []) track.stop();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function mountCapture() {
    const captureModule = await import('../../../src/features/capture/index.js');
    const cleanup = captureModule.initCapture();
    return { captureModule, cleanup, handlers: uiCapture.handlers };
  }

  it('stops every track when the screen is left while the share picker is open', async () => {
    const stream = createFakeStream();
    const picker = deferred();
    vi.mocked(startScreenCapture).mockReturnValue(/** @type {any} */ (picker.promise));
    vi.mocked(createVideoElement).mockImplementation(
      async () => /** @type {any} */ (createFakeVideoElement()),
    );

    const { cleanup, handlers } = await mountCapture();
    const starting = handlers.onStart();
    await vi.waitFor(() => expect(startScreenCapture).toHaveBeenCalled());

    cleanup(); // navigate away
    picker.resolve(stream); // the user picks a screen anyway

    await expect(starting).resolves.toBeUndefined();
    for (const track of stream.getTracks()) {
      expect(track.stop).toHaveBeenCalled();
    }
    expect(createVideoElement).not.toHaveBeenCalled();
    expect(managerInstances).toHaveLength(0);
  });

  it('stops every track and releases the video element when left while metadata loads', async () => {
    const stream = createFakeStream();
    const video = createFakeVideoElement();
    const metadata = deferred();
    vi.mocked(startScreenCapture).mockResolvedValue(/** @type {any} */ (stream));
    vi.mocked(createVideoElement).mockReturnValue(/** @type {any} */ (metadata.promise));

    const { cleanup, handlers } = await mountCapture();
    const starting = handlers.onStart();
    await vi.waitFor(() => expect(createVideoElement).toHaveBeenCalled());

    cleanup(); // navigate away
    metadata.resolve(video);

    await expect(starting).resolves.toBeUndefined();
    for (const track of stream.getTracks()) {
      expect(track.stop).toHaveBeenCalled();
    }
    expect(video.pause).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(managerInstances).toHaveLength(0);
  });

  it('settles quietly when the picker is cancelled after the screen was left', async () => {
    const picker = deferred();
    vi.mocked(startScreenCapture).mockReturnValue(/** @type {any} */ (picker.promise));
    const errors = vi.fn();
    const { on } = await import('../../../src/shared/bus.js');
    const unsubscribe = on('capture:error', errors);

    const { cleanup, handlers } = await mountCapture();
    const starting = handlers.onStart();
    await vi.waitFor(() => expect(startScreenCapture).toHaveBeenCalled());

    cleanup();
    picker.reject(new Error('Permission denied'));

    await expect(starting).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not touch the screen mounted after returning, and that screen can still start', async () => {
    const staleStream = createFakeStream();
    const picker = deferred();
    vi.mocked(startScreenCapture).mockReturnValueOnce(/** @type {any} */ (picker.promise));
    vi.mocked(createVideoElement).mockImplementation(
      async () => /** @type {any} */ (createFakeVideoElement()),
    );

    const { captureModule, cleanup, handlers } = await mountCapture();
    const staleStart = handlers.onStart();
    await vi.waitFor(() => expect(startScreenCapture).toHaveBeenCalled());

    cleanup(); // navigate away...
    captureModule.initCapture(); // ...and back while the picker is still open
    picker.resolve(staleStream);

    await expect(staleStart).resolves.toBeUndefined();
    for (const track of staleStream.getTracks()) {
      expect(track.stop).toHaveBeenCalled();
    }
    // The new screen is untouched by the abandoned start
    expect(captureModule.getCaptureState()?.isSharing).toBe(false);
    expect(captureModule.getCaptureState()?.error).toBeNull();
    expect(managerInstances).toHaveLength(0);

    // A fresh start on the new screen works normally
    const freshStream = createFakeStream();
    vi.mocked(startScreenCapture).mockResolvedValueOnce(/** @type {any} */ (freshStream));
    await uiCapture.handlers.onStart();

    expect(captureModule.getCaptureState()?.isSharing).toBe(true);
    expect(managerInstances).toHaveLength(1);
    for (const track of freshStream.getTracks()) {
      expect(track.stop).not.toHaveBeenCalled();
    }
  });

  it('still reports a failed start and stops the stream while the screen is mounted', async () => {
    const stream = createFakeStream();
    vi.mocked(startScreenCapture).mockResolvedValue(/** @type {any} */ (stream));
    vi.mocked(createVideoElement).mockRejectedValue(new Error('Failed to load video stream'));

    const { captureModule, handlers } = await mountCapture();

    await expect(handlers.onStart()).rejects.toThrow('Failed to load video stream');
    expect(captureModule.getCaptureState()?.error).toBe('Failed to load video stream');
    for (const track of stream.getTracks()) {
      expect(track.stop).toHaveBeenCalled();
    }
  });
});
