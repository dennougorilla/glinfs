/**
 * Mock Frame Utilities Tests
 * @module tests/unit/shared/utils/mock-frame
 *
 * Note: These tests run in jsdom environment where VideoFrame API
 * is not available. In this environment, createMockVideoFrame returns
 * legacy mock objects with _bitmap property for canvas compatibility.
 *
 * In browser environments (E2E tests), createMockVideoFrame returns
 * REAL VideoFrame objects that are indistinguishable from captured frames.
 * E2E tests verify the real VideoFrame behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock OffscreenCanvas for jsdom
class MockOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._ctx = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      strokeRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({
        addColorStop: vi.fn(),
      })),
      fillStyle: '',
      strokeStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      lineWidth: 1,
      canvas: this,
    };
  }

  getContext(type) {
    if (type === '2d') {
      return this._ctx;
    }
    return null;
  }
}

// Mock ImageBitmap
class MockImageBitmap {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._closed = false;
  }

  close() {
    this._closed = true;
  }
}

// Setup global mocks
beforeEach(() => {
  global.OffscreenCanvas = MockOffscreenCanvas;
  global.createImageBitmap = vi.fn((canvas) => {
    return Promise.resolve(new MockImageBitmap(canvas.width, canvas.height));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mock-frame utilities', () => {
  describe('isMockFrameSupported', () => {
    it('should return true when OffscreenCanvas is available', async () => {
      const { isMockFrameSupported } = await import('../../../../src/shared/utils/mock-frame.js');
      expect(isMockFrameSupported()).toBe(true);
    });

    it('should return false when OffscreenCanvas is not available', async () => {
      delete global.OffscreenCanvas;
      // Re-import to get fresh module state
      vi.resetModules();
      const { isMockFrameSupported } = await import('../../../../src/shared/utils/mock-frame.js');
      expect(isMockFrameSupported()).toBe(false);
      // Restore for other tests
      global.OffscreenCanvas = MockOffscreenCanvas;
    });
  });

  describe('isRealVideoFrameSupported', () => {
    it('should return false in jsdom environment', async () => {
      const { isRealVideoFrameSupported } = await import('../../../../src/shared/utils/mock-frame.js');
      // jsdom doesn't have VideoFrame API
      expect(isRealVideoFrameSupported()).toBe(false);
    });
  });

  describe('createMockVideoFrame', () => {
    it('should create a legacy mock VideoFrame with correct dimensions in jsdom', async () => {
      const { createMockVideoFrame, isRealVideoFrameSupported } = await import('../../../../src/shared/utils/mock-frame.js');

      // Verify we're testing the legacy mock path
      expect(isRealVideoFrameSupported()).toBe(false);

      const frame = await createMockVideoFrame({ width: 800, height: 600 });

      expect(frame.codedWidth).toBe(800);
      expect(frame.codedHeight).toBe(600);
      expect(frame.displayWidth).toBe(800);
      expect(frame.displayHeight).toBe(600);
      expect(frame.closed).toBe(false);
      // Legacy mock has _bitmap for canvas compatibility
      expect(frame._bitmap).toBeDefined();
    });

    it('should use default dimensions when not specified', async () => {
      const { createMockVideoFrame } = await import('../../../../src/shared/utils/mock-frame.js');

      const frame = await createMockVideoFrame();

      expect(frame.codedWidth).toBe(640);
      expect(frame.codedHeight).toBe(480);
    });

    it('should allow closing the frame', async () => {
      const { createMockVideoFrame } = await import('../../../../src/shared/utils/mock-frame.js');

      const frame = await createMockVideoFrame();
      expect(frame.closed).toBe(false);

      frame.close();
      expect(frame.closed).toBe(true);
    });

    it('should calculate correct timestamp based on frameIndex', async () => {
      const { createMockVideoFrame } = await import('../../../../src/shared/utils/mock-frame.js');

      // Default: 30fps, so frameIndex 30 = 1 second = 1000000 microseconds
      const frame = await createMockVideoFrame({ frameIndex: 30 });
      expect(frame.timestamp).toBe(30 * 33333); // ~1 second at 30fps
    });
  });

  describe('createMockFrame', () => {
    it('should create a Frame object with correct structure', async () => {
      const { createMockFrame } = await import('../../../../src/shared/utils/mock-frame.js');

      const frame = await createMockFrame(5, { width: 1280, height: 720 });

      expect(frame.id).toMatch(/^mock-frame-5-/);
      expect(frame.width).toBe(1280);
      expect(frame.height).toBe(720);
      expect(frame.frame).toBeDefined();
      expect(frame.timestamp).toBeDefined();
    });
  });

  describe('createMockFrames', () => {
    it('should create array of frames with correct count', async () => {
      const { createMockFrames } = await import('../../../../src/shared/utils/mock-frame.js');

      const frames = await createMockFrames(10);

      expect(frames).toHaveLength(10);
      frames.forEach((frame, i) => {
        expect(frame.id).toMatch(new RegExp(`^mock-frame-${i}-`));
      });
    });

    it('should calculate correct timestamps based on fps', async () => {
      const { createMockFrames } = await import('../../../../src/shared/utils/mock-frame.js');

      const frames = await createMockFrames(3, { fps: 30 });

      // At 30fps, interval is 1000000/30 = 33333.33 microseconds
      const interval = 1000000 / 30;
      expect(frames[0].timestamp).toBe(0);
      expect(frames[1].timestamp).toBeCloseTo(interval, -2);
      expect(frames[2].timestamp).toBeCloseTo(interval * 2, -2);
    });
  });

  describe('createMockClipPayload', () => {
    it('should create valid ClipPayload structure', async () => {
      const { createMockClipPayload } = await import('../../../../src/shared/utils/mock-frame.js');

      const payload = await createMockClipPayload({
        frameCount: 20,
        fps: 30,
      });

      expect(payload.frames).toHaveLength(20);
      expect(payload.fps).toBe(30);
      expect(payload.capturedAt).toBeDefined();
      expect(typeof payload.capturedAt).toBe('number');
    });

    it('should include sceneDetectionEnabled when specified', async () => {
      const { createMockClipPayload } = await import('../../../../src/shared/utils/mock-frame.js');

      const payload = await createMockClipPayload({
        sceneDetectionEnabled: true,
      });

      expect(payload.sceneDetectionEnabled).toBe(true);
    });
  });

  describe('createMockEditorPayload', () => {
    it('should create valid EditorPayload structure', async () => {
      const { createMockEditorPayload } = await import('../../../../src/shared/utils/mock-frame.js');

      const payload = await createMockEditorPayload({
        frameCount: 30,
        fps: 30,
      });

      expect(payload.selectedRange).toEqual({ start: 0, end: 29 });
      expect(payload.cropArea).toBeNull();
      expect(payload.clip).toBeDefined();
      expect(payload.clip.frames).toHaveLength(30);
      expect(payload.fps).toBe(30);
    });

    it('should use custom selectedRange when specified', async () => {
      const { createMockEditorPayload } = await import('../../../../src/shared/utils/mock-frame.js');

      const payload = await createMockEditorPayload({
        frameCount: 30,
        selectedRange: { start: 5, end: 20 },
      });

      expect(payload.selectedRange).toEqual({ start: 5, end: 20 });
    });

    it('should include cropArea when specified', async () => {
      const { createMockEditorPayload } = await import('../../../../src/shared/utils/mock-frame.js');

      const cropArea = { x: 100, y: 100, width: 400, height: 300, aspectRatio: 'free' };
      const payload = await createMockEditorPayload({
        cropArea,
      });

      expect(payload.cropArea).toEqual(cropArea);
    });
  });

  describe('getDrawableSource', () => {
    it('should return bitmap for legacy mock frames in jsdom', async () => {
      const { createMockFrame, getDrawableSource, isRealVideoFrameSupported } = await import('../../../../src/shared/utils/mock-frame.js');

      // Verify we're testing the legacy mock path
      expect(isRealVideoFrameSupported()).toBe(false);

      const frame = await createMockFrame(0);
      const source = getDrawableSource(frame);

      expect(source).toBeDefined();
      // In jsdom, legacy mock uses _bitmap
      expect(source).toBe(frame.frame._bitmap);
    });

    it('should return null for null frame', async () => {
      const { getDrawableSource } = await import('../../../../src/shared/utils/mock-frame.js');

      expect(getDrawableSource(null)).toBeNull();
      expect(getDrawableSource(undefined)).toBeNull();
    });

    it('should return null for frame without frame property', async () => {
      const { getDrawableSource } = await import('../../../../src/shared/utils/mock-frame.js');

      expect(getDrawableSource({ id: 'test' })).toBeNull();
    });

    it('should return null for closed frame', async () => {
      const { createMockFrame, getDrawableSource } = await import('../../../../src/shared/utils/mock-frame.js');

      const frame = await createMockFrame(0);
      frame.frame.close();
      const source = getDrawableSource(frame);

      expect(source).toBeNull();
    });
  });
});

describe('test-mode utilities', () => {
  beforeEach(() => {
    // Reset module state
    vi.resetModules();

    // Setup window mock for jsdom
    if (typeof window !== 'undefined') {
      delete window.__PLAYWRIGHT_TEST__;
      // Reset URL
      Object.defineProperty(window, 'location', {
        value: { search: '', hash: '' },
        writable: true,
      });
    }
  });

  describe('isTestMode', () => {
    it('should detect testMode URL parameter', async () => {
      if (typeof window !== 'undefined') {
        window.location.search = '?testMode=true';
      }

      vi.resetModules();
      const { isTestMode, initTestMode } = await import('../../../../src/shared/test-mode.js');
      initTestMode();

      expect(isTestMode()).toBe(true);
    });

    it('should detect Playwright flag', async () => {
      if (typeof window !== 'undefined') {
        window.__PLAYWRIGHT_TEST__ = true;
      }

      vi.resetModules();
      const { isTestMode, initTestMode } = await import('../../../../src/shared/test-mode.js');
      initTestMode();

      expect(isTestMode()).toBe(true);
    });
  });

  describe('getDefaultMockOptions', () => {
    it('should return default options', async () => {
      vi.resetModules();
      const { getDefaultMockOptions, initTestMode } = await import('../../../../src/shared/test-mode.js');
      initTestMode();

      const options = getDefaultMockOptions();

      expect(options.frameCount).toBe(30);
      expect(options.fps).toBe(30);
      expect(options.width).toBe(640);
      expect(options.height).toBe(480);
      expect(options.pattern).toBe('numbered');
    });

    it('should include URL parameter overrides', async () => {
      if (typeof window !== 'undefined') {
        window.location.search = '?testMode=true&mockFrames=60&mockFps=60&mockWidth=1920';
      }

      vi.resetModules();
      const { getDefaultMockOptions, initTestMode } = await import('../../../../src/shared/test-mode.js');
      initTestMode();

      const options = getDefaultMockOptions();

      expect(options.frameCount).toBe(60);
      expect(options.fps).toBe(60);
      expect(options.width).toBe(1920);
    });
  });
});
