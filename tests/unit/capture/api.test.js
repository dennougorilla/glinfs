import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startScreenCapture,
  stopScreenCapture,
  createVideoElement,
  createCaptureCanvas,
  createFrameProcessor,
  createVideoFrameFromElement,
} from '../../../src/features/capture/api.js';

// Mock browser APIs
const mockGetDisplayMedia = vi.fn();
const mockGetUserMedia = vi.fn();

beforeEach(() => {
  // Reset mocks
  vi.clearAllMocks();

  // Setup navigator.mediaDevices mock
  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: {
      getDisplayMedia: mockGetDisplayMedia,
      getUserMedia: mockGetUserMedia,
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startScreenCapture', () => {
  it('should request screen capture with correct options', async () => {
    // Arrange
    const mockStream = {
      getTracks: () => [],
    };
    mockGetDisplayMedia.mockResolvedValue(mockStream);

    // Act
    const result = await startScreenCapture();

    // Assert
    expect(mockGetDisplayMedia).toHaveBeenCalledWith({
      video: {
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    });
    expect(result).toBe(mockStream);
  });

  it('should throw NOT_SUPPORTED when getDisplayMedia is unavailable', async () => {
    // Arrange
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    // Act & Assert
    await expect(startScreenCapture()).rejects.toMatchObject({
      message: 'Screen capture not supported',
      code: 'NOT_SUPPORTED',
    });
  });

  it('should throw PERMISSION_DENIED when user denies permission', async () => {
    // Arrange
    const error = new Error('Permission denied');
    error.name = 'NotAllowedError';
    mockGetDisplayMedia.mockRejectedValue(error);

    // Act & Assert
    await expect(startScreenCapture()).rejects.toMatchObject({
      message: 'Screen sharing permission denied',
      code: 'PERMISSION_DENIED',
    });
  });

  it('should propagate other errors', async () => {
    // Arrange
    const error = new Error('Network error');
    mockGetDisplayMedia.mockRejectedValue(error);

    // Act & Assert
    await expect(startScreenCapture()).rejects.toThrow('Network error');
  });
});

describe('stopScreenCapture', () => {
  it('should stop all tracks in the stream', () => {
    // Arrange
    const mockTrack1 = { stop: vi.fn() };
    const mockTrack2 = { stop: vi.fn() };
    const mockStream = {
      getTracks: () => [mockTrack1, mockTrack2],
    };

    // Act
    stopScreenCapture(mockStream);

    // Assert
    expect(mockTrack1.stop).toHaveBeenCalledOnce();
    expect(mockTrack2.stop).toHaveBeenCalledOnce();
  });

  it('should handle null stream gracefully', () => {
    // Act & Assert - should not throw
    expect(() => stopScreenCapture(null)).not.toThrow();
  });

  it('should handle undefined stream gracefully', () => {
    // Act & Assert - should not throw
    expect(() => stopScreenCapture(undefined)).not.toThrow();
  });

  it('should handle empty tracks array', () => {
    // Arrange
    const mockStream = {
      getTracks: () => [],
    };

    // Act & Assert - should not throw
    expect(() => stopScreenCapture(mockStream)).not.toThrow();
  });
});

describe('createVideoElement', () => {
  it('should create video element with correct properties', async () => {
    // Arrange
    const mockStream = {};
    const mockVideo = {
      srcObject: null,
      muted: false,
      playsInline: false,
      onloadedmetadata: null,
      onerror: null,
      play: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(document, 'createElement').mockReturnValue(mockVideo);

    // Act
    const promise = createVideoElement(mockStream);

    // Trigger loadedmetadata event
    mockVideo.onloadedmetadata();

    const result = await promise;

    // Assert
    expect(result.srcObject).toBe(mockStream);
    expect(result.muted).toBe(true);
    expect(result.playsInline).toBe(true);
    expect(mockVideo.play).toHaveBeenCalled();
  });

  it('should reject when video fails to load', async () => {
    // Arrange
    const mockStream = {};
    const mockVideo = {
      srcObject: null,
      muted: false,
      playsInline: false,
      onloadedmetadata: null,
      onerror: null,
    };

    vi.spyOn(document, 'createElement').mockReturnValue(mockVideo);

    // Act
    const promise = createVideoElement(mockStream);

    // Trigger error event
    mockVideo.onerror();

    // Assert
    await expect(promise).rejects.toThrow('Failed to load video stream');
  });

  it('should reject when play() fails', async () => {
    // Arrange
    const mockStream = {};
    const mockVideo = {
      srcObject: null,
      muted: false,
      playsInline: false,
      onloadedmetadata: null,
      onerror: null,
      play: vi.fn().mockRejectedValue(new Error('Autoplay blocked')),
    };

    vi.spyOn(document, 'createElement').mockReturnValue(mockVideo);

    // Act
    const promise = createVideoElement(mockStream);
    mockVideo.onloadedmetadata();

    // Assert
    await expect(promise).rejects.toThrow('Autoplay blocked');
  });
});

describe('createCaptureCanvas', () => {
  it('should create hidden canvas element', () => {
    // Act
    const canvas = createCaptureCanvas();

    // Assert
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.style.display).toBe('none');
  });
});

describe('createFrameProcessor', () => {
  it('should throw when track is not live', () => {
    // Arrange
    const mockTrack = {
      readyState: 'ended',
      id: 'test-track',
      label: 'Test Track',
    };

    // Act & Assert
    expect(() => createFrameProcessor(mockTrack)).toThrow(
      'Cannot create frame processor: track state is "ended" (expected "live")'
    );
  });

  it('should throw when MediaStreamTrackProcessor is not supported', () => {
    // Arrange
    const mockTrack = {
      readyState: 'live',
      id: 'test-track',
      label: 'Test Track',
    };

    // Ensure MediaStreamTrackProcessor is undefined
    global.MediaStreamTrackProcessor = undefined;

    // Act & Assert
    expect(() => createFrameProcessor(mockTrack)).toThrow(
      'MediaStreamTrackProcessor not supported in this browser'
    );
  });

  it('should create processor when track is live and API is available', () => {
    // Arrange
    const mockReader = { read: vi.fn() };
    const mockReadable = { getReader: () => mockReader };
    const mockTrack = {
      readyState: 'live',
      id: 'test-track',
      label: 'Test Track',
    };

    // Mock MediaStreamTrackProcessor as a class
    global.MediaStreamTrackProcessor = class {
      constructor(options) {
        this.track = options.track;
        this.readable = mockReadable;
      }
    };

    // Act
    const result = createFrameProcessor(mockTrack);

    // Assert
    expect(result).toBe(mockReader);
  });
});

describe('createVideoFrameFromElement', () => {
  it('should return null when video is null', () => {
    // Act
    const result = createVideoFrameFromElement(null);

    // Assert
    expect(result).toBeNull();
  });

  it('should return null when video is not ready', () => {
    // Arrange
    const mockVideo = { readyState: 1 };

    // Act
    const result = createVideoFrameFromElement(mockVideo);

    // Assert
    expect(result).toBeNull();
  });

  it('should create VideoFrame when video is ready', () => {
    // Arrange
    const mockVideo = { readyState: 2 };
    const mockVideoFrame = { close: vi.fn() };

    // Mock VideoFrame as a class
    global.VideoFrame = class {
      constructor(source, options) {
        this.source = source;
        this.options = options;
        Object.assign(this, mockVideoFrame);
      }
    };

    // Act
    const result = createVideoFrameFromElement(mockVideo);

    // Assert
    expect(result).toBeInstanceOf(global.VideoFrame);
    expect(result.source).toBe(mockVideo);
    expect(result.options.timestamp).toEqual(expect.any(Number));
  });

  it('should return null when VideoFrame constructor throws', () => {
    // Arrange
    const mockVideo = { readyState: 3 };

    // Mock VideoFrame constructor to throw
    global.VideoFrame = vi.fn().mockImplementation(() => {
      throw new Error('GPU resource exhausted');
    });

    // Act
    const result = createVideoFrameFromElement(mockVideo);

    // Assert - should return null without crashing
    expect(result).toBeNull();
  });
});
