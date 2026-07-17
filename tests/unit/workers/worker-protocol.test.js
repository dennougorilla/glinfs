import { describe, expect, it, vi } from 'vitest';
import {
  Commands,
  createAddFrameMessage,
  createCancelMessage,
  createFinishMessage,
  createInitMessage,
  Events,
} from '../../../src/workers/worker-protocol.js';

describe('Worker Protocol', () => {
  describe('Commands enum', () => {
    it('should have all required command types', () => {
      // Assert
      expect(Commands.INIT).toBe('init');
      expect(Commands.ADD_FRAME).toBe('add-frame');
      expect(Commands.FINISH).toBe('finish');
      expect(Commands.CANCEL).toBe('cancel');
    });

    it('should have exactly 4 commands', () => {
      // Assert
      expect(Object.keys(Commands)).toHaveLength(4);
    });
  });

  describe('Events enum', () => {
    it('should have all required event types', () => {
      // Assert
      expect(Events.READY).toBe('ready');
      expect(Events.PROGRESS).toBe('progress');
      expect(Events.COMPLETE).toBe('complete');
      expect(Events.ERROR).toBe('error');
      expect(Events.CANCELLED).toBe('cancelled');
    });

    it('should have exactly 5 events', () => {
      // Assert
      expect(Object.keys(Events)).toHaveLength(5);
    });
  });

  describe('createInitMessage', () => {
    it('should create valid init message with all config properties', () => {
      // Arrange
      const config = {
        encoderId: 'gifenc-js',
        width: 640,
        height: 480,
        totalFrames: 100,
        maxColors: 256,
        frameDelayMs: 33,
        loopCount: 0,
      };

      // Act
      const message = createInitMessage(config);

      // Assert
      expect(message.command).toBe(Commands.INIT);
      expect(message.encoderId).toBe('gifenc-js');
      expect(message.width).toBe(640);
      expect(message.height).toBe(480);
      expect(message.totalFrames).toBe(100);
      expect(message.maxColors).toBe(256);
      expect(message.frameDelayMs).toBe(33);
      expect(message.loopCount).toBe(0);
    });

    it('should preserve all custom config values', () => {
      // Arrange
      const config = {
        encoderId: 'custom-encoder',
        width: 1920,
        height: 1080,
        totalFrames: 300,
        maxColors: 128,
        frameDelayMs: 50,
        loopCount: 3,
      };

      // Act
      const message = createInitMessage(config);

      // Assert
      expect(message).toEqual({
        command: Commands.INIT,
        ...config,
      });
    });
  });

  describe('createAddFrameMessage', () => {
    it('should create message with correct command', () => {
      // Arrange
      const rgba = new Uint8ClampedArray(100 * 100 * 4);

      // Act
      const { message } = createAddFrameMessage(rgba, 100, 100, 0);

      // Assert
      expect(message.command).toBe(Commands.ADD_FRAME);
    });

    it('should include frame dimensions and index', () => {
      // Arrange
      const rgba = new Uint8ClampedArray(50 * 75 * 4);

      // Act
      const { message } = createAddFrameMessage(rgba, 50, 75, 5);

      // Assert
      expect(message.width).toBe(50);
      expect(message.height).toBe(75);
      expect(message.frameIndex).toBe(5);
    });

    it('should create Transferable buffer', () => {
      // Arrange
      const rgba = new Uint8ClampedArray(10 * 10 * 4);

      // Act
      const { transfer } = createAddFrameMessage(rgba, 10, 10, 0);

      // Assert
      expect(transfer).toHaveLength(1);
      expect(transfer[0]).toBeInstanceOf(ArrayBuffer);
    });

    it('should transfer the original buffer directly without copying (regression #39)', () => {
      // Arrange - a view spanning its entire backing buffer (the shape
      // produced by getFrameRGBA)
      const rgba = new Uint8ClampedArray([1, 2, 3, 4]);
      const sliceSpy = vi.spyOn(ArrayBuffer.prototype, 'slice');

      // Act
      const { message, transfer } = createAddFrameMessage(rgba, 1, 1, 0);

      // Assert - zero-copy: the exact same buffer is posted and transferred.
      // Copying doubled peak memory (~8.3MB per 1080p frame).
      expect(message.rgbaData).toBe(rgba.buffer);
      expect(transfer[0]).toBe(rgba.buffer);
      expect(sliceSpy).not.toHaveBeenCalled();

      // Cleanup
      sliceSpy.mockRestore();
    });

    it('should copy only the viewed range for a view into a larger buffer', () => {
      // Arrange - a 16-byte view at offset 8 of a 32-byte buffer
      const backing = new ArrayBuffer(32);
      const full = new Uint8ClampedArray(backing);
      full.forEach((_, i) => {
        full[i] = i;
      });
      const rgba = new Uint8ClampedArray(backing, 8, 16);

      // Act
      const { message, transfer } = createAddFrameMessage(rgba, 2, 2, 0);

      // Assert - transferring the whole backing buffer would leak unrelated
      // bytes and detach the shared buffer, so the exact range is copied
      expect(message.rgbaData).not.toBe(backing);
      expect(message.rgbaData.byteLength).toBe(16);
      expect(Array.from(new Uint8ClampedArray(message.rgbaData))).toEqual(
        Array.from({ length: 16 }, (_, i) => i + 8),
      );
      expect(transfer[0]).toBe(message.rgbaData);
    });

    it('should have same byte length as original', () => {
      // Arrange
      const size = 64 * 64 * 4;
      const rgba = new Uint8ClampedArray(size);

      // Act
      const { message } = createAddFrameMessage(rgba, 64, 64, 0);

      // Assert
      expect(message.rgbaData.byteLength).toBe(size);
    });

    it('should include rgbaData in transfer array', () => {
      // Arrange
      const rgba = new Uint8ClampedArray(16);

      // Act
      const { message, transfer } = createAddFrameMessage(rgba, 2, 2, 0);

      // Assert
      expect(transfer[0]).toBe(message.rgbaData);
    });
  });

  describe('createFinishMessage', () => {
    it('should create finish command message', () => {
      // Act
      const message = createFinishMessage();

      // Assert
      expect(message).toEqual({ command: Commands.FINISH });
    });

    it('should have only command property', () => {
      // Act
      const message = createFinishMessage();

      // Assert
      expect(Object.keys(message)).toEqual(['command']);
    });
  });

  describe('createCancelMessage', () => {
    it('should create cancel command message', () => {
      // Act
      const message = createCancelMessage();

      // Assert
      expect(message).toEqual({ command: Commands.CANCEL });
    });

    it('should have only command property', () => {
      // Act
      const message = createCancelMessage();

      // Assert
      expect(Object.keys(message)).toEqual(['command']);
    });
  });
});
