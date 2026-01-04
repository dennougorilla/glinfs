import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHandlers } from '../../../src/workers/gif-encoder-handlers.js';
import { Events, Commands } from '../../../src/workers/worker-protocol.js';

/**
 * Create a mock encoder for testing
 * @returns {ReturnType<typeof vi.fn> & { init: Function, addFrame: Function, finish: Function, dispose: Function }}
 */
function createMockEncoder() {
  return {
    init: vi.fn(),
    addFrame: vi.fn(),
    finish: vi.fn(() => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), // GIF89a
    dispose: vi.fn(),
  };
}

describe('GIF Encoder Handlers', () => {
  /** @type {ReturnType<typeof createMockEncoder>} */
  let mockEncoder;

  /** @type {ReturnType<typeof vi.fn>} */
  let postEvent;

  /** @type {ReturnType<typeof createHandlers>} */
  let handlers;

  beforeEach(() => {
    mockEncoder = createMockEncoder();
    postEvent = vi.fn();

    handlers = createHandlers({
      createEncoder: () => mockEncoder,
      postEvent,
    });
  });

  describe('handleInit', () => {
    it('should initialize encoder and post READY event', () => {
      // Arrange
      const message = {
        command: Commands.INIT,
        encoderId: 'gifenc-js',
        width: 100,
        height: 100,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act
      handlers.handleInit(message);

      // Assert
      expect(mockEncoder.init).toHaveBeenCalledWith({
        width: 100,
        height: 100,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.READY,
        encoderId: 'gifenc-js',
      });
    });

    it('should store totalFrames in state', () => {
      // Arrange
      const message = {
        command: Commands.INIT,
        encoderId: 'test',
        width: 50,
        height: 50,
        totalFrames: 25,
        maxColors: 128,
        frameDelayMs: 50,
        loopCount: 1,
      };

      // Act
      handlers.handleInit(message);

      // Assert
      const state = handlers.getState();
      expect(state.totalFrames).toBe(25);
      expect(state.framesProcessed).toBe(0);
    });

    it('should dispose existing encoder before creating new one', () => {
      // Arrange
      const message = {
        command: Commands.INIT,
        encoderId: 'test',
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act - initialize twice
      handlers.handleInit(message);
      handlers.handleInit(message);

      // Assert
      expect(mockEncoder.dispose).toHaveBeenCalledOnce();
    });

    it('should post ERROR event on init failure', () => {
      // Arrange
      const failingEncoder = {
        init: vi.fn(() => {
          throw new Error('Init failed');
        }),
        dispose: vi.fn(),
      };

      const failingHandlers = createHandlers({
        createEncoder: () => /** @type {any} */ (failingEncoder),
        postEvent,
      });

      const message = {
        command: Commands.INIT,
        encoderId: 'test',
        width: 100,
        height: 100,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act
      failingHandlers.handleInit(message);

      // Assert
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.ERROR,
        message: 'Init failed',
        code: 'INIT_ERROR',
      });
    });

    it('should handle non-Error exceptions', () => {
      // Arrange
      const failingEncoder = {
        init: vi.fn(() => {
          throw 'string error';
        }),
        dispose: vi.fn(),
      };

      const failingHandlers = createHandlers({
        createEncoder: () => /** @type {any} */ (failingEncoder),
        postEvent,
      });

      const message = {
        command: Commands.INIT,
        encoderId: 'test',
        width: 100,
        height: 100,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act
      failingHandlers.handleInit(message);

      // Assert
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.ERROR,
        message: 'Failed to initialize encoder',
        code: 'INIT_ERROR',
      });
    });
  });

  describe('handleAddFrame', () => {
    const initMessage = {
      command: Commands.INIT,
      encoderId: 'test',
      width: 10,
      height: 10,
      totalFrames: 3,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    };

    it('should add frame and post PROGRESS event', () => {
      // Arrange
      handlers.handleInit(initMessage);
      postEvent.mockClear();

      const frameMessage = {
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400), // 10x10x4
        width: 10,
        height: 10,
        frameIndex: 0,
      };

      // Act
      handlers.handleAddFrame(frameMessage);

      // Assert
      expect(mockEncoder.addFrame).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 10,
          height: 10,
        }),
        0
      );
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.PROGRESS,
        frameIndex: 0,
        totalFrames: 3,
        percent: 33, // 1/3 = 33%
      });
    });

    it('should update framesProcessed state', () => {
      // Arrange
      handlers.handleInit(initMessage);

      // Act
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 0,
      });

      // Assert
      const state = handlers.getState();
      expect(state.framesProcessed).toBe(1);
    });

    it('should calculate progress percentage correctly', () => {
      // Arrange
      handlers.handleInit(initMessage);

      // Act - add 2 frames
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 0,
      });
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 1,
      });

      // Assert
      expect(postEvent).toHaveBeenLastCalledWith({
        event: Events.PROGRESS,
        frameIndex: 1,
        totalFrames: 3,
        percent: 67, // 2/3 = 67%
      });
    });

    it('should post ERROR if encoder not initialized', () => {
      // Arrange - don't call handleInit

      // Act
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 0,
      });

      // Assert
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.ERROR,
        message: 'Encoder not initialized',
        code: 'FRAME_ERROR',
      });
    });

    it('should post ERROR on addFrame failure', () => {
      // Arrange
      handlers.handleInit(initMessage);
      mockEncoder.addFrame.mockImplementation(() => {
        throw new Error('Frame too large');
      });
      postEvent.mockClear();

      // Act
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 0,
      });

      // Assert
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.ERROR,
        message: 'Frame too large',
        code: 'FRAME_ERROR',
      });
    });

    it('should convert ArrayBuffer to Uint8ClampedArray', () => {
      // Arrange
      handlers.handleInit(initMessage);
      const buffer = new ArrayBuffer(400);

      // Act
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: buffer,
        width: 10,
        height: 10,
        frameIndex: 0,
      });

      // Assert
      expect(mockEncoder.addFrame).toHaveBeenCalledWith(
        expect.objectContaining({
          rgba: expect.any(Uint8ClampedArray),
        }),
        0
      );
    });
  });

  describe('handleFinish', () => {
    const initMessage = {
      command: Commands.INIT,
      encoderId: 'test',
      width: 10,
      height: 10,
      totalFrames: 1,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    };

    it('should finish encoding and post COMPLETE with Transferable', () => {
      // Arrange
      handlers.handleInit(initMessage);
      postEvent.mockClear();

      // Act
      handlers.handleFinish();

      // Assert
      expect(mockEncoder.finish).toHaveBeenCalled();
      expect(mockEncoder.dispose).toHaveBeenCalled();
      expect(postEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: Events.COMPLETE,
          gifData: expect.any(ArrayBuffer),
          duration: expect.any(Number),
        }),
        expect.any(Array) // Transferable array
      );
    });

    it('should include duration in COMPLETE event', () => {
      // Arrange
      handlers.handleInit(initMessage);
      postEvent.mockClear();

      // Act
      handlers.handleFinish();

      // Assert
      const completeCall = postEvent.mock.calls.find(
        (call) => call[0].event === Events.COMPLETE
      );
      expect(completeCall[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should reset state after finish', () => {
      // Arrange
      handlers.handleInit(initMessage);
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 0,
      });

      // Act
      handlers.handleFinish();

      // Assert
      const state = handlers.getState();
      expect(state.encoder).toBeNull();
      expect(state.totalFrames).toBe(0);
      expect(state.framesProcessed).toBe(0);
    });

    it('should post ERROR if encoder not initialized', () => {
      // Act
      handlers.handleFinish();

      // Assert
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.ERROR,
        message: 'Encoder not initialized',
        code: 'FINISH_ERROR',
      });
    });

    it('should post ERROR on finish failure', () => {
      // Arrange
      handlers.handleInit(initMessage);
      mockEncoder.finish.mockImplementation(() => {
        throw new Error('Encoding failed');
      });
      postEvent.mockClear();

      // Act
      handlers.handleFinish();

      // Assert
      expect(postEvent).toHaveBeenCalledWith({
        event: Events.ERROR,
        message: 'Encoding failed',
        code: 'FINISH_ERROR',
      });
    });
  });

  describe('handleCancel', () => {
    const initMessage = {
      command: Commands.INIT,
      encoderId: 'test',
      width: 10,
      height: 10,
      totalFrames: 5,
      maxColors: 256,
      frameDelayMs: 100,
      loopCount: 0,
    };

    it('should dispose encoder and post CANCELLED', () => {
      // Arrange
      handlers.handleInit(initMessage);
      postEvent.mockClear();

      // Act
      handlers.handleCancel();

      // Assert
      expect(mockEncoder.dispose).toHaveBeenCalled();
      expect(postEvent).toHaveBeenCalledWith({ event: Events.CANCELLED });
    });

    it('should reset state', () => {
      // Arrange
      handlers.handleInit(initMessage);
      handlers.handleAddFrame({
        command: Commands.ADD_FRAME,
        rgbaData: new ArrayBuffer(400),
        width: 10,
        height: 10,
        frameIndex: 0,
      });

      // Act
      handlers.handleCancel();

      // Assert
      const state = handlers.getState();
      expect(state.encoder).toBeNull();
      expect(state.totalFrames).toBe(0);
      expect(state.framesProcessed).toBe(0);
    });

    it('should handle cancel when encoder not initialized', () => {
      // Act
      handlers.handleCancel();

      // Assert
      expect(postEvent).toHaveBeenCalledWith({ event: Events.CANCELLED });
    });

    it('should not throw when cancelling twice', () => {
      // Arrange
      handlers.handleInit(initMessage);

      // Act & Assert
      expect(() => {
        handlers.handleCancel();
        handlers.handleCancel();
      }).not.toThrow();
    });
  });

  describe('getState', () => {
    it('should return initial state', () => {
      // Act
      const state = handlers.getState();

      // Assert
      expect(state.encoder).toBeNull();
      expect(state.totalFrames).toBe(0);
      expect(state.framesProcessed).toBe(0);
      expect(state.startTime).toBe(0);
    });

    it('should return encoder after init', () => {
      // Arrange
      handlers.handleInit({
        command: Commands.INIT,
        encoderId: 'test',
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      // Act
      const state = handlers.getState();

      // Assert
      expect(state.encoder).toBe(mockEncoder);
      expect(state.startTime).toBeGreaterThan(0);
    });
  });
});
