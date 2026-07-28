import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for #91: background capture (keep recording while on other screens).
 *
 * - cleanup() only pauses the worker's frame-grab loop when
 *   capture.backgroundCapture is disabled; with the (default) setting
 *   enabled it leaves the loop running across navigation.
 * - The restore path skips a redundant workerManager.start() when the
 *   loop was never paused (idempotent start).
 * - The "ended" listener attached in handleStart is route-independent: it
 *   still cleanly ends the session when the stream is stopped from the
 *   browser UI while navigated away, with no UI mounted to react to it.
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

import { createVideoElement, startScreenCapture } from '../../../src/features/capture/api.js';

/**
 * Create a fake live MediaStreamTrack that actually stores its "ended"
 * listener so tests can fire it, unlike a bare vi.fn() stub.
 */
function createFakeTrack() {
  /** @type {(() => void) | null} */
  let endedHandler = null;
  return {
    readyState: 'live',
    addEventListener: vi.fn((type, handler) => {
      if (type === 'ended') endedHandler = handler;
    }),
    removeEventListener: vi.fn((type, handler) => {
      if (type === 'ended' && endedHandler === handler) endedHandler = null;
    }),
    stop: vi.fn(),
    fireEnded() {
      endedHandler?.();
    },
  };
}

/** @param {ReturnType<typeof createFakeTrack>} track */
function createFakeStream(track) {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
}

describe('Background capture (#91)', () => {
  beforeEach(() => {
    vi.resetModules();
    managerInstances.length = 0;
    uiCapture.handlers = null;
    localStorage.clear();
    document.body.innerHTML = '<div id="main-content"></div>';

    vi.mocked(startScreenCapture).mockImplementation(
      async () => /** @type {any} */ (createFakeStream(createFakeTrack())),
    );
    vi.mocked(createVideoElement).mockImplementation(
      async () => /** @type {any} */ ({ pause: vi.fn(), srcObject: null }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function startSharing() {
    const captureModule = await import('../../../src/features/capture/index.js');
    const cleanup = captureModule.initCapture();
    await uiCapture.handlers.onStart();
    const manager = managerInstances[managerInstances.length - 1];
    return { captureModule, cleanup, manager };
  }

  describe('conditional cleanup', () => {
    it('leaves the worker running when capture.backgroundCapture is enabled (default)', async () => {
      const { captureModule, cleanup, manager } = await startSharing();

      cleanup();

      expect(manager.stop).not.toHaveBeenCalled();
      // The stashed store still reports an active session
      const { getScreenCaptureState } = await import('../../../src/shared/app-store.js');
      expect(getScreenCaptureState()?.store.getState().isCapturing).toBe(true);
      expect(captureModule).toBeDefined();
    });

    it('pauses the worker when capture.backgroundCapture is disabled', async () => {
      const { updateSetting } = await import('../../../src/shared/user-settings.js');
      updateSetting('capture', 'backgroundCapture', false);

      const { cleanup, manager } = await startSharing();

      cleanup();

      expect(manager.stop).toHaveBeenCalledTimes(1);
      const { getScreenCaptureState } = await import('../../../src/shared/app-store.js');
      expect(getScreenCaptureState()?.store.getState().isCapturing).toBe(false);
      expect(getScreenCaptureState()?.store.getState().isPaused).toBe(true);
    });
  });

  describe('idempotent start', () => {
    it('does not re-issue workerManager.start() on restore when background capture kept the loop running', async () => {
      const { captureModule, cleanup, manager } = await startSharing();
      expect(manager.start).toHaveBeenCalledTimes(1);

      cleanup(); // navigate away with backgroundCapture enabled

      captureModule.initCapture(); // navigate back

      expect(manager.start).toHaveBeenCalledTimes(1);
    });

    it('does call workerManager.start() again on restore after a paused (backgroundCapture=false) navigation', async () => {
      const { updateSetting } = await import('../../../src/shared/user-settings.js');
      updateSetting('capture', 'backgroundCapture', false);

      const { captureModule, cleanup, manager } = await startSharing();
      expect(manager.start).toHaveBeenCalledTimes(1);

      cleanup();
      captureModule.initCapture();

      expect(manager.start).toHaveBeenCalledTimes(2);
    });
  });

  describe('app-level ended handling', () => {
    it('cleanly ends the session when the stream is stopped from the browser UI while mounted', async () => {
      const { on } = await import('../../../src/shared/bus.js');
      const stopped = vi.fn();
      const unsubscribe = on('capture:stopped', stopped);

      const { captureModule, manager } = await startSharing();
      const streamPromise = vi.mocked(startScreenCapture).mock.results[0].value;
      const track = (await streamPromise).getVideoTracks()[0];

      track.fireEnded();

      expect(stopped).toHaveBeenCalledTimes(1);
      expect(manager.stop).toHaveBeenCalled();
      expect(captureModule.getCaptureState()?.isCapturing).toBe(false);
      expect(captureModule.getCaptureState()?.isSharing).toBe(false);

      unsubscribe();
    });

    it('cleanly ends a backgrounded session (no mounted UI) with no zombie worker loop', async () => {
      // Mirrors main.js's startup wiring: registerScreenCaptureCleanup delegates
      // the actual teardown to whatever main.js hands it (cleanupScreenCaptureResources
      // in production); here a fake stands in so we can assert it fired.
      const { registerScreenCaptureCleanup } = await import('../../../src/shared/app-store.js');
      const delegatedCleanup = vi.fn((state) => state.workerManager?.terminateWithCleanup());
      registerScreenCaptureCleanup(delegatedCleanup);

      const { on } = await import('../../../src/shared/bus.js');
      const stopped = vi.fn();
      const unsubscribe = on('capture:stopped', stopped);

      const { cleanup, manager } = await startSharing();
      const streamPromise = vi.mocked(startScreenCapture).mock.results[0].value;
      const track = (await streamPromise).getVideoTracks()[0];

      cleanup(); // navigate away, backgroundCapture enabled - worker keeps running

      track.fireEnded();

      expect(stopped).toHaveBeenCalledTimes(1);
      expect(delegatedCleanup).toHaveBeenCalledTimes(1);
      expect(manager.terminateWithCleanup).toHaveBeenCalledTimes(1);

      // Nothing left to restore - the next mount must start a fresh session
      const { hasActiveScreenCapture } = await import('../../../src/shared/app-store.js');
      expect(hasActiveScreenCapture()).toBe(false);

      unsubscribe();
    });
  });

  describe('stats while backgrounded', () => {
    it('keeps writing worker stats into the stashed store after navigating away', async () => {
      // Regression: onStatsUpdate closed over the module-level `store`,
      // which cleanup() nulls on every navigation — so while background
      // capture kept recording, every stats update was dropped and the
      // PiP's buffer-fullness readout froze at its last pre-navigation
      // value. The callback must write through the session's own store,
      // which survives in screenCaptureState.
      const { cleanup, manager } = await startSharing();
      const onStatsUpdate = manager.init.mock.calls[0][1].onStatsUpdate;

      cleanup(); // navigate away; backgroundCapture (default) keeps recording

      onStatsUpdate({ frameCount: 120, fps: 30 });

      const { getScreenCaptureState } = await import('../../../src/shared/app-store.js');
      const stashedStats = getScreenCaptureState()?.store?.getState().stats;
      expect(stashedStats).toMatchObject({ frameCount: 120, fps: 30, duration: 4 });
    });
  });
});
