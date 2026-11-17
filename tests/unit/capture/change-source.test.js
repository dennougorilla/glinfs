import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Change source while sharing (owner feedback 2026-11-17, item 4): the
 * running capture moves onto a newly picked source, and a cancelled picker
 * leaves the current share untouched.
 */

const managerInstances = vi.hoisted(() => /** @type {any[]} */ ([]));
const ui = vi.hoisted(
  () => /** @type {{ handlers: any, state: any }} */ ({ handlers: null, state: null }),
);

vi.mock('../../../src/workers/capture-worker-manager.js', () => {
  class FakeCaptureWorkerManager {
    constructor() {
      this.calls = /** @type {string[]} */ ([]);
      this.init = vi.fn((video) => {
        this.video = video;
        this.calls.push('init');
      });
      this.start = vi.fn(() => this.calls.push('start'));
      this.stop = vi.fn(() => this.calls.push('stop'));
      this.clear = vi.fn(() => this.calls.push('clear'));
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
  renderCaptureScreen: vi.fn((_container, state, handlers) => {
    ui.handlers = handlers;
    ui.state = state;
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
  return { track, getVideoTracks: () => [track], getTracks: () => [track] };
}

describe('Change source while sharing', () => {
  beforeEach(() => {
    vi.resetModules();
    managerInstances.length = 0;
    ui.handlers = null;
    ui.state = null;
    document.body.innerHTML = '<div id="main-content"></div>';
    vi.mocked(startScreenCapture).mockImplementation(
      async () => /** @type {any} */ (createFakeStream(createFakeTrack())),
    );
    vi.mocked(createVideoElement).mockImplementation(
      async (stream) => /** @type {any} */ ({ pause: vi.fn(), srcObject: stream }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  async function startSharing() {
    const { initCapture } = await import('../../../src/features/capture/index.js');
    initCapture();
    await ui.handlers.onStart();
    expect(ui.state.isSharing).toBe(true);
    return { stream: ui.state.stream, manager: managerInstances[0] };
  }

  it('moves the running capture onto the new source and releases the old one', async () => {
    const first = await startSharing();
    const firstVideo = first.manager.video;
    first.manager.calls.length = 0;

    const changed = await ui.handlers.onChangeSource();

    expect(changed).toBe(true);
    const second = ui.state.stream;
    expect(second).not.toBe(first.stream);
    expect(ui.state.isSharing).toBe(true);
    // Same worker, pointed at the new video; the buffer restarts at the switch
    expect(managerInstances).toHaveLength(1);
    expect(first.manager.video.srcObject).toBe(second);
    expect(first.manager.calls).toEqual(['stop', 'clear', 'init', 'start']);
    // The old share is stopped and its video released
    expect(stopScreenCapture).toHaveBeenCalledWith(first.stream);
    expect(stopScreenCapture).not.toHaveBeenCalledWith(second);
    expect(firstVideo.pause).toHaveBeenCalled();
    expect(firstVideo.srcObject).toBeNull();
    // Ending the new share from the browser bar is still caught
    expect(first.stream.track.removeEventListener).toHaveBeenCalledWith(
      'ended',
      expect.any(Function),
    );
    expect(second.track.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
  });

  it('keeps the current share when the picker is cancelled', async () => {
    const first = await startSharing();
    first.manager.calls.length = 0;
    vi.mocked(startScreenCapture).mockRejectedValueOnce(new Error('Permission denied'));

    const changed = await ui.handlers.onChangeSource();

    expect(changed).toBe(false);
    expect(ui.state.stream).toBe(first.stream);
    expect(ui.state.isSharing).toBe(true);
    expect(ui.state.error ?? null).toBeNull();
    expect(first.manager.calls).toEqual([]);
    expect(stopScreenCapture).not.toHaveBeenCalled();
    expect(first.stream.track.stop).not.toHaveBeenCalled();
  });

  it('releases the new stream when the share ended while the picker was open', async () => {
    const first = await startSharing();
    /** @type {(value: any) => void} */
    let resolvePicker = () => {};
    vi.mocked(startScreenCapture).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
    );

    const pending = ui.handlers.onChangeSource();
    ui.handlers.onStop(); // the browser bar ended the old share meanwhile
    const late = createFakeStream(createFakeTrack());
    resolvePicker(late);

    expect(await pending).toBe(false);
    expect(stopScreenCapture).toHaveBeenCalledWith(late);
    expect(ui.state.isSharing).toBe(false);
    expect(ui.state.stream).not.toBe(late);
    expect(first.manager.calls).not.toContain('clear');
  });
});

describe('Change source button', () => {
  /** @param {Record<string, unknown>} overrides */
  async function renderWith(overrides) {
    vi.doUnmock('../../../src/features/capture/ui.js');
    vi.resetModules();
    const { renderCaptureScreen } = await import('../../../src/features/capture/ui.js');
    const { initCaptureState } = await import('../../../src/features/capture/state.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handlers = {
      onStart: vi.fn(async () => {}),
      onStop: vi.fn(),
      onCreateClip: vi.fn(async () => false),
      onSettingsChange: vi.fn(),
      getSettings: vi.fn(() => null),
      ...overrides.handlers,
    };
    const state = { ...initCaptureState(), ...overrides.state };
    renderCaptureScreen(container, state, handlers);
    return { container, handlers };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows Change source next to Create Clip only while sharing', async () => {
    const onChangeSource = vi.fn(async () => false);
    const idle = await renderWith({ handlers: { onChangeSource } });
    expect(idle.container.querySelector('.capture-change-source-btn')).toBeNull();

    const sharing = await renderWith({
      handlers: { onChangeSource },
      state: { isSharing: true, isCapturing: true, stream: null },
    });
    const labels = [...sharing.container.querySelectorAll('.capture-actions button')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Create Clip', 'Change source']);
  });

  it('calls the handler and is usable again after a cancelled picker', async () => {
    const onChangeSource = vi.fn(async () => false);
    const { container } = await renderWith({
      handlers: { onChangeSource },
      state: { isSharing: true, isCapturing: true, stream: null },
    });
    const button = /** @type {HTMLButtonElement} */ (
      container.querySelector('.capture-change-source-btn')
    );

    button.click();
    expect(button.hasAttribute('disabled')).toBe(true);
    await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(onChangeSource).toHaveBeenCalledOnce();
  });
});
