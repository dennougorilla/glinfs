import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVideoElement,
  startScreenCapture,
  stopScreenCapture,
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
