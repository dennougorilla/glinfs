import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A capture session that is still sharing survives navigation: the store is
 * stashed in the app store and adopted again on the next mount. That store
 * predates anything the user changed on the Settings screen in between, so
 * Scene Detection has to be re-read from the persisted settings — otherwise
 * the only screen that can change it (the Settings screen) has no effect
 * whenever a screen is being shared, and the Capture toggle shows a value
 * that "Create Clip" will not act on.
 */

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

function createFakeTrack() {
  return {
    readyState: 'live',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
}

/** @param {ReturnType<typeof createFakeTrack>} track */
function createFakeStream(track) {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
}

describe('Capture adopts Settings-screen changes on restore', () => {
  beforeEach(() => {
    vi.resetModules();
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

  /**
   * Mount Capture, start sharing, then navigate away — leaving a live
   * session stashed for the next mount. Returns the module plus the settings
   * the session is actually running with (the store is gone after cleanup).
   */
  async function shareThenLeave() {
    const captureModule = await import('../../../src/features/capture/index.js');
    const cleanup = captureModule.initCapture();
    await uiCapture.handlers.onStart();

    const sharedSettings = { ...captureModule.getCaptureState().settings };
    expect(sharedSettings.sceneDetection).toBe(true);

    cleanup();
    return { captureModule, sharedSettings };
  }

  it('picks up a Scene Detection change made while the session was suspended', async () => {
    const { captureModule } = await shareThenLeave();

    // What the Settings screen does: persist, then navigate back
    const { loadSettings, updateSetting } = await import('../../../src/shared/user-settings.js');
    updateSetting('capture', 'sceneDetection', false);
    expect(loadSettings().capture.sceneDetection).toBe(false);

    captureModule.initCapture();

    expect(captureModule.getCaptureState()?.settings.sceneDetection).toBe(false);
  });

  it('leaves the running session on the fps it was started with', async () => {
    const { captureModule, sharedSettings } = await shareThenLeave();
    const startedFps = sharedSettings.fps;

    const { updateSetting } = await import('../../../src/shared/user-settings.js');
    updateSetting('capture', 'fps', startedFps === 60 ? 30 : 60);

    captureModule.initCapture();

    // fps drives the capture worker that is restarted on restore; changing it
    // under a live session would make the UI describe frames it isn't taking
    expect(captureModule.getCaptureState()?.settings.fps).toBe(startedFps);
  });

  it('keeps the restored session otherwise intact', async () => {
    const { captureModule } = await shareThenLeave();

    const { updateSetting } = await import('../../../src/shared/user-settings.js');
    updateSetting('capture', 'sceneDetection', false);

    captureModule.initCapture();

    const state = captureModule.getCaptureState();
    expect(state?.isSharing).toBe(true);
    expect(state?.stream).not.toBeNull();
  });
});
