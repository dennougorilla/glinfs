import { describe, expect, it, vi } from 'vitest';

/**
 * D3: the I420 converter starts (worker, GPU device, shader) when sharing
 * starts, so Create Clip does not pay for it.
 */

vi.mock('../../../src/workers/i420-converter.js', () => ({
  convertBitmapsToI420: vi.fn(),
  isCpuFrameConversionAvailable: vi.fn(() => true),
  warmI420Converter: vi.fn(),
}));

const managers = vi.hoisted(() => /** @type {any[]} */ ([]));
vi.mock('../../../src/workers/capture-worker-manager.js', () => ({
  CaptureWorkerManager: class {
    constructor() {
      this.init = vi.fn();
      this.start = vi.fn();
      this.stop = vi.fn();
      this.clear = vi.fn();
      this.terminate = vi.fn();
      this.terminateWithCleanup = vi.fn(async () => {});
      this.getEffectiveFrameDimensions = vi.fn(() => ({ width: 640, height: 360, scaled: false }));
      this.isRunning = true;
      managers.push(this);
    }
  },
}));

vi.mock('../../../src/features/capture/api.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    startScreenCapture: vi.fn(async () => ({
      getVideoTracks: () => [
        { addEventListener: vi.fn(), removeEventListener: vi.fn(), stop: vi.fn() },
      ],
      getTracks: () => [],
    })),
    createVideoElement: vi.fn(async () => ({ videoWidth: 640, videoHeight: 360, pause: vi.fn() })),
  };
});

import { warmI420Converter } from '../../../src/workers/i420-converter.js';

describe('converter warm-up', () => {
  it('warms the converter when sharing starts', async () => {
    document.body.innerHTML = '<main id="main-content"></main>';
    const { initCapture } = await import('../../../src/features/capture/index.js');
    const cleanup = initCapture();
    expect(warmI420Converter).not.toHaveBeenCalled();

    await /** @type {any} */ (document.querySelector('.btn-capture-start'))?.click();
    await vi.waitFor(() => expect(managers.at(-1)?.start).toHaveBeenCalled());

    expect(warmI420Converter).toHaveBeenCalledOnce();
    cleanup?.();
  });
});
