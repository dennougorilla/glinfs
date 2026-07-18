import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Commands, Events } from '../../../src/workers/worker-protocol.js';

const mockEncoder = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  addFrame: vi.fn(),
  finish: vi.fn(() => new Uint8Array([0x47, 0x49, 0x46])),
  dispose: vi.fn(),
}));

vi.mock('../../../src/features/export/encoders/gifenc-encoder.js', () => ({
  createGifencEncoder: () => mockEncoder,
}));

vi.mock('../../../src/features/export/encoders/gifsicle-encoder.js', () => ({
  createGifsicleEncoder: () => mockEncoder,
}));

describe('gif-encoder-worker production entry', () => {
  /** @type {(event: {data: any}) => Promise<void>} */
  let onmessage;
  /** @type {ReturnType<typeof vi.fn>} */
  let postMessage;
  /** @type {any} */
  let originalOnMessage;
  /** @type {any} */
  let originalPostMessage;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockEncoder.init.mockResolvedValue(undefined);
    mockEncoder.finish.mockReturnValue(new Uint8Array([0x47, 0x49, 0x46]));

    originalOnMessage = self.onmessage;
    originalPostMessage = self.postMessage;
    postMessage = vi.fn();
    // @ts-expect-error - worker global shim in jsdom
    self.postMessage = postMessage;

    await import('../../../src/workers/gif-encoder-worker.js');
    onmessage = /** @type {any} */ (self.onmessage);
  });

  afterEach(() => {
    self.onmessage = originalOnMessage;
    // @ts-expect-error - restore worker global shim
    self.postMessage = originalPostMessage;
  });

  it('keeps a frame failure sticky through queued frames and FINISH (#45)', async () => {
    await onmessage({
      data: {
        command: Commands.INIT,
        encoderId: 'gifenc-js',
        width: 2,
        height: 2,
        totalFrames: 2,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      },
    });
    mockEncoder.addFrame.mockImplementationOnce(() => {
      throw new Error('Quantization failed');
    });
    postMessage.mockClear();

    const failedFrame = {
      command: Commands.ADD_FRAME,
      rgbaData: new ArrayBuffer(16),
      width: 2,
      height: 2,
      frameIndex: 0,
    };
    await onmessage({ data: failedFrame });
    await onmessage({ data: { ...failedFrame, rgbaData: new ArrayBuffer(16), frameIndex: 1 } });
    await onmessage({ data: { command: Commands.FINISH } });

    expect(mockEncoder.addFrame).toHaveBeenCalledOnce();
    expect(mockEncoder.finish).not.toHaveBeenCalled();
    expect(mockEncoder.dispose).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: Events.COMPLETE }),
      expect.anything(),
    );
    expect(postMessage).toHaveBeenLastCalledWith({
      event: Events.ERROR,
      message: 'Quantization failed',
      code: 'FRAME_ERROR',
    });
  });
});
