import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Capture screen's file-import handler (features/capture/index.js):
 * - a refused import shows its message without marking a running capture
 *   stopped (the REC badge must stay while the worker keeps capturing)
 * - a file chosen while another one is still opening is refused out loud
 */

const ui = vi.hoisted(() => /** @type {{ handlers: any, lastState: any }} */ ({}));

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
    ui.lastState = state;
    return () => {};
  }),
  updateBufferStatus: vi.fn(),
  updateImportStatus: vi.fn(),
  updateSceneDetectionToggle: vi.fn(),
}));

vi.mock('../../../src/features/import/index.js', () => ({
  importFile: vi.fn(),
  isImporting: vi.fn(() => false),
  reportImportBusy: vi.fn(),
}));

import { createVideoElement, startScreenCapture } from '../../../src/features/capture/api.js';
import { importFile, isImporting, reportImportBusy } from '../../../src/features/import/index.js';

function createFakeStream() {
  const track = {
    readyState: 'live',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
  return { getVideoTracks: () => [track], getTracks: () => [track] };
}

/** @param {string} name */
function gifFile(name = 'cat.gif') {
  return new File([new Uint8Array([1])], name, { type: 'image/gif' });
}

/** Let the fire-and-forget handler settle */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let cleanup = () => {};

beforeEach(async () => {
  vi.resetModules();
  ui.handlers = null;
  ui.lastState = null;
  document.body.innerHTML = '<div id="main-content"></div>';
  vi.mocked(startScreenCapture).mockImplementation(
    async () => /** @type {any} */ (createFakeStream()),
  );
  vi.mocked(createVideoElement).mockImplementation(
    async () => /** @type {any} */ ({ pause: vi.fn(), srcObject: null }),
  );
  vi.mocked(isImporting).mockReturnValue(false);
  const { initCapture } = await import('../../../src/features/capture/index.js');
  cleanup = initCapture();
});

afterEach(() => {
  cleanup?.();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('capture import handler', () => {
  it('a refused import while recording keeps the capture marked as running', async () => {
    await ui.handlers.onStart();
    expect(ui.lastState.isCapturing).toBe(true);

    vi.mocked(importFile).mockResolvedValue({
      ok: false,
      reason: 'unsupported-type',
      message: 'Can\'t open "notes.txt"',
    });
    ui.handlers.onImportFile(gifFile('notes.txt'));
    await flush();

    expect(importFile).toHaveBeenCalledTimes(1);
    expect(ui.lastState.error).toBe('Can\'t open "notes.txt"');
    expect(ui.lastState.isCapturing).toBe(true);
  });

  it('refuses a file out loud while another one is still opening', async () => {
    vi.mocked(isImporting).mockReturnValue(true);

    ui.handlers.onImportFile(gifFile('dog.gif'));
    await flush();

    expect(reportImportBusy).toHaveBeenCalledTimes(1);
    // The in-flight import keeps the screen's busy state: nothing new starts
    expect(importFile).not.toHaveBeenCalled();
  });
});
