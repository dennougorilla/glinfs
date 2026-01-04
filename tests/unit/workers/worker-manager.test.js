import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Events } from '../../../src/workers/worker-protocol.js';

/**
 * Mock Worker class for testing
 */
class MockWorker {
  constructor() {
    /** @type {Map<string, Array<{handler: Function, options?: {once?: boolean}}>>} */
    this.listeners = new Map();
    this.terminated = false;
    /** @type {any} */
    this._lastMessage = null;
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @param {{ once?: boolean }} [options]
   */
  addEventListener(event, handler, options) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)?.push({ handler, options });
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  removeEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    const index = handlers.findIndex((h) => h.handler === handler);
    if (index !== -1) handlers.splice(index, 1);
  }

  /**
   * @param {any} message
   */
  postMessage(message) {
    this._lastMessage = message;
  }

  terminate() {
    this.terminated = true;
  }

  /**
   * Test helper to simulate worker messages
   * @param {any} data
   */
  _simulateMessage(data) {
    const handlers = this.listeners.get('message') || [];
    handlers.forEach(({ handler, options }) => {
      handler({ data });
      if (options?.once) {
        this.removeEventListener('message', handler);
      }
    });
  }

  /**
   * Test helper to simulate worker errors
   * @param {string} message
   */
  _simulateError(message) {
    const handlers = this.listeners.get('error') || [];
    handlers.forEach(({ handler, options }) => {
      handler({ message });
      if (options?.once) {
        this.removeEventListener('error', handler);
      }
    });
  }
}

// Store original Worker
const OriginalWorker = globalThis.Worker;

describe('GifEncoderManager', () => {
  /** @type {typeof import('../../../src/workers/worker-manager.js')} */
  let workerManagerModule;

  /** @type {MockWorker | null} */
  let mockWorkerInstance = null;

  beforeEach(async () => {
    // Mock Worker constructor
    // @ts-ignore - Mock Worker
    globalThis.Worker = class extends MockWorker {
      constructor() {
        super();
        mockWorkerInstance = this;
      }
    };

    // Re-import module to get fresh instances with mocked Worker
    vi.resetModules();
    workerManagerModule = await import('../../../src/workers/worker-manager.js');
  });

  afterEach(() => {
    // Restore original Worker
    globalThis.Worker = OriginalWorker;
    mockWorkerInstance = null;
  });

  describe('init', () => {
    it('should initialize worker and resolve on READY event', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const config = {
        width: 100,
        height: 100,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act
      const initPromise = manager.init(config);

      // Simulate worker ready after a tick
      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY, encoderId: 'gifenc-js' });

      // Assert
      await expect(initPromise).resolves.toBeUndefined();
      expect(manager._isInitialized).toBe(true);

      // Cleanup
      manager.dispose();
    });

    it('should reject on ERROR event during init', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const config = {
        width: 100,
        height: 100,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act
      const initPromise = manager.init(config);

      // Simulate worker error after a tick
      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({
        event: Events.ERROR,
        message: 'Failed to load encoder',
      });

      // Assert
      await expect(initPromise).rejects.toThrow();

      // Cleanup
      manager.dispose();
    });

    it('should reject on timeout', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const config = {
        width: 100,
        height: 100,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act & Assert - use short timeout for test
      await expect(manager.init(config, 50)).rejects.toThrow(/timed out/);

      // Cleanup
      manager.dispose();
    });

    it('should send init message to worker', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const config = {
        encoderId: 'test-encoder',
        width: 640,
        height: 480,
        totalFrames: 50,
        maxColors: 128,
        frameDelayMs: 33,
        loopCount: 2,
      };

      // Act
      const initPromise = manager.init(config);
      await Promise.resolve();

      // Assert
      expect(mockWorkerInstance?._lastMessage).toEqual({
        command: 'init',
        encoderId: 'test-encoder',
        width: 640,
        height: 480,
        totalFrames: 50,
        maxColors: 128,
        frameDelayMs: 33,
        loopCount: 2,
      });

      // Cleanup
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise.catch(() => {});
      manager.dispose();
    });

    it('should use default encoderId when not provided', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const config = {
        width: 100,
        height: 100,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      };

      // Act
      const initPromise = manager.init(config);
      await Promise.resolve();

      // Assert
      expect(mockWorkerInstance?._lastMessage.encoderId).toBe('gifenc-js');

      // Cleanup
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise.catch(() => {});
      manager.dispose();
    });
  });

  describe('addFrame', () => {
    it('should throw if not initialized', () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const rgba = new Uint8ClampedArray(100);

      // Act & Assert
      expect(() => manager.addFrame(rgba, 10, 10, 0)).toThrow(/not initialized/i);

      // Cleanup
      manager.dispose();
    });

    it('should post message with frame data when initialized', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act
      const rgba = new Uint8ClampedArray(10 * 10 * 4);
      manager.addFrame(rgba, 10, 10, 0);

      // Assert
      expect(mockWorkerInstance?._lastMessage.command).toBe('add-frame');
      expect(mockWorkerInstance?._lastMessage.width).toBe(10);
      expect(mockWorkerInstance?._lastMessage.height).toBe(10);
      expect(mockWorkerInstance?._lastMessage.frameIndex).toBe(0);

      // Cleanup
      manager.dispose();
    });
  });

  describe('finish', () => {
    it('should return Blob on COMPLETE event', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act
      const finishPromise = manager.finish();

      await Promise.resolve();
      const gifData = new Uint8Array([0x47, 0x49, 0x46]).buffer;
      mockWorkerInstance?._simulateMessage({
        event: Events.COMPLETE,
        gifData,
        duration: 100,
      });

      // Assert
      const blob = await finishPromise;
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/gif');

      // Cleanup
      manager.dispose();
    });

    it('should reject if not initialized', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();

      // Act & Assert
      await expect(manager.finish()).rejects.toThrow(/not initialized/i);

      // Cleanup
      manager.dispose();
    });

    it('should reject on ERROR event', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act
      const finishPromise = manager.finish();

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({
        event: Events.ERROR,
        message: 'Encoding failed',
      });

      // Assert
      await expect(finishPromise).rejects.toThrow();

      // Cleanup
      manager.dispose();
    });
  });

  describe('cancel', () => {
    it('should send cancel command', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act
      manager.cancel();

      // Assert
      expect(mockWorkerInstance?._lastMessage).toEqual({ command: 'cancel' });

      // Cleanup
      manager.dispose();
    });

    it('should not throw if not initialized', () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();

      // Act & Assert
      expect(() => manager.cancel()).not.toThrow();

      // Cleanup
      manager.dispose();
    });
  });

  describe('dispose', () => {
    it('should terminate worker', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      const worker = mockWorkerInstance;

      // Act
      manager.dispose();

      // Assert
      expect(worker?.terminated).toBe(true);
      expect(manager.worker).toBeNull();
    });

    it('should reset state', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      manager.onProgress = vi.fn();

      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 1,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act
      manager.dispose();

      // Assert
      expect(manager.onProgress).toBeNull();
      expect(manager._isInitialized).toBe(false);
    });

    it('should be safe to call multiple times', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();

      // Act & Assert
      expect(() => {
        manager.dispose();
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
    });
  });

  describe('progress callback', () => {
    it('should call onProgress when PROGRESS event received', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();
      const onProgress = vi.fn();
      manager.onProgress = onProgress;

      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act
      mockWorkerInstance?._simulateMessage({
        event: Events.PROGRESS,
        frameIndex: 5,
        totalFrames: 10,
        percent: 50,
      });

      // Assert
      expect(onProgress).toHaveBeenCalledWith({
        event: Events.PROGRESS,
        frameIndex: 5,
        totalFrames: 10,
        percent: 50,
      });

      // Cleanup
      manager.dispose();
    });

    it('should not throw if onProgress is not set', async () => {
      // Arrange
      const manager = new workerManagerModule.GifEncoderManager();

      const initPromise = manager.init({
        width: 10,
        height: 10,
        totalFrames: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      await Promise.resolve();
      mockWorkerInstance?._simulateMessage({ event: Events.READY });
      await initPromise;

      // Act & Assert
      expect(() => {
        mockWorkerInstance?._simulateMessage({
          event: Events.PROGRESS,
          frameIndex: 5,
          totalFrames: 10,
          percent: 50,
        });
      }).not.toThrow();

      // Cleanup
      manager.dispose();
    });
  });

  describe('createEncoderManager', () => {
    it('should create GifEncoderManager instance', () => {
      // Act
      const manager = workerManagerModule.createEncoderManager();

      // Assert
      expect(manager).toBeInstanceOf(workerManagerModule.GifEncoderManager);

      // Cleanup
      manager.dispose();
    });
  });

  describe('WorkerErrorCode', () => {
    it('should have all error codes', () => {
      // Assert
      expect(workerManagerModule.WorkerErrorCode.INIT_TIMEOUT).toBe('INIT_TIMEOUT');
      expect(workerManagerModule.WorkerErrorCode.INIT_FAILED).toBe('INIT_FAILED');
      expect(workerManagerModule.WorkerErrorCode.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
      expect(workerManagerModule.WorkerErrorCode.ENCODING_FAILED).toBe('ENCODING_FAILED');
      expect(workerManagerModule.WorkerErrorCode.WORKER_TERMINATED).toBe('WORKER_TERMINATED');
    });
  });
});
