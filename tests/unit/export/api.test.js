import { describe, it, expect, vi } from 'vitest';
import {
  getFrameRGBA,
  checkEncoderStatus,
  downloadBlob,
  openInNewTab,
  copyToClipboard,
  getBlobSize,
  scaleFrame,
} from '../../../src/features/export/api.js';

// Helper to create mock VideoFrame
function createMockVideoFrame(width = 100, height = 100) {
  return {
    codedWidth: width,
    codedHeight: height,
    copyTo: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// Helper to create mock frame
function createMockFrame(width = 100, height = 100) {
  return {
    id: 'test-frame',
    frame: createMockVideoFrame(width, height),
    timestamp: 0,
    width,
    height,
  };
}

describe('getFrameRGBA', () => {
  it('should throw when frame is null', async () => {
    // Act & Assert
    await expect(getFrameRGBA(null, null)).rejects.toThrow(
      'Invalid frame: VideoFrame is missing or closed'
    );
  });

  it('should throw when frame.frame is undefined', async () => {
    // Arrange
    const frame = { id: 'test', frame: undefined };

    // Act & Assert
    await expect(getFrameRGBA(frame, null)).rejects.toThrow(
      'Invalid frame: VideoFrame is missing or closed'
    );
  });

  it('should use copyTo for full-frame extraction (no crop)', async () => {
    // Arrange
    const frame = createMockFrame(200, 150);

    // Act
    const result = await getFrameRGBA(frame, null);

    // Assert
    expect(frame.frame.copyTo).toHaveBeenCalledWith(
      expect.any(Uint8ClampedArray),
      {
        rect: { x: 0, y: 0, width: 200, height: 150 },
        format: 'RGBA',
      }
    );
    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
    expect(result.data).toBeInstanceOf(Uint8ClampedArray);
    expect(result.data.length).toBe(200 * 150 * 4);
  });

  it('should use OffscreenCanvas for cropped extraction', async () => {
    // Arrange
    const frame = createMockFrame(200, 150);
    const crop = { x: 10, y: 20, width: 50, height: 40 };

    const mockImageData = {
      data: new Uint8ClampedArray(50 * 40 * 4),
      width: 50,
      height: 40,
    };

    const mockCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue(mockImageData),
    };

    // Mock OffscreenCanvas as a class
    global.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return mockCtx;
      }
    };

    // Act
    const result = await getFrameRGBA(frame, crop);

    // Assert
    expect(mockCtx.drawImage).toHaveBeenCalledWith(
      frame.frame,
      10, 20, 50, 40,
      0, 0, 50, 40
    );
    expect(mockCtx.getImageData).toHaveBeenCalledWith(0, 0, 50, 40);
    expect(result.width).toBe(50);
    expect(result.height).toBe(40);
    expect(result.data).toBe(mockImageData.data);
  });

  it('should throw when OffscreenCanvas context fails', async () => {
    // Arrange
    const frame = createMockFrame(200, 150);
    const crop = { x: 10, y: 20, width: 50, height: 40 };

    // Mock OffscreenCanvas with null context as a class
    global.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return null;
      }
    };

    // Act & Assert
    await expect(getFrameRGBA(frame, crop)).rejects.toThrow(
      'Failed to get OffscreenCanvas 2d context'
    );
  });
});

describe('checkEncoderStatus', () => {
  it('should return gifenc-js as default encoder', async () => {
    // Act
    const result = await checkEncoderStatus();

    // Assert - returns encoder ID, not generic 'js'
    expect(result).toBe('gifenc-js');
  });
});

describe('downloadBlob', () => {
  it('should create download link and trigger click', () => {
    // Arrange
    const mockBlob = new Blob(['test'], { type: 'image/gif' });
    const mockUrl = 'blob:http://localhost/test';

    const mockLink = {
      href: '',
      download: '',
      click: vi.fn(),
    };

    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockUrl);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockReturnValue(mockLink);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => {});
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => {});

    // Act
    downloadBlob(mockBlob, 'test.gif');

    // Assert
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(mockLink.href).toBe(mockUrl);
    expect(mockLink.download).toBe('test.gif');
    expect(mockLink.click).toHaveBeenCalled();
    expect(document.body.appendChild).toHaveBeenCalledWith(mockLink);
    expect(document.body.removeChild).toHaveBeenCalledWith(mockLink);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(mockUrl);
  });
});

describe('openInNewTab', () => {
  it('should open blob URL in new tab', () => {
    // Arrange
    vi.useFakeTimers();
    const mockBlob = new Blob(['test'], { type: 'image/gif' });
    const mockUrl = 'blob:http://localhost/test';

    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockUrl);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(window, 'open').mockImplementation(() => {});

    // Act
    openInNewTab(mockBlob);

    // Assert
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(window.open).toHaveBeenCalledWith(mockUrl, '_blank');

    // Cleanup
    vi.useRealTimers();
  });

  it('should schedule URL revocation after delay', () => {
    // Arrange
    const mockBlob = new Blob(['test'], { type: 'image/gif' });
    const mockUrl = 'blob:http://localhost/test';
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockUrl);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(window, 'open').mockImplementation(() => {});

    // Act
    openInNewTab(mockBlob);

    // Assert - setTimeout was called with a 60 second delay
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60000);

    // Cleanup
    setTimeoutSpy.mockRestore();
  });
});

describe('copyToClipboard', () => {
  it('should copy blob to clipboard when supported', async () => {
    // Arrange
    const mockBlob = new Blob(['test'], { type: 'image/gif' });
    const mockWrite = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, 'clipboard', {
      value: { write: mockWrite },
      writable: true,
      configurable: true,
    });

    // Mock ClipboardItem as a class on both global and window
    class MockClipboardItem {
      constructor(obj) {
        this.data = obj;
      }
    }
    global.ClipboardItem = MockClipboardItem;
    window.ClipboardItem = MockClipboardItem;

    // Act
    const result = await copyToClipboard(mockBlob);

    // Assert
    expect(result).toBe(true);
    expect(mockWrite).toHaveBeenCalled();
  });

  it('should return false when clipboard API not supported', async () => {
    // Arrange
    const mockBlob = new Blob(['test'], { type: 'image/gif' });

    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    // Act
    const result = await copyToClipboard(mockBlob);

    // Assert
    expect(result).toBe(false);
  });

  it('should return false when ClipboardItem not supported', async () => {
    // Arrange
    const mockBlob = new Blob(['test'], { type: 'image/gif' });

    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn() },
      writable: true,
      configurable: true,
    });

    global.ClipboardItem = undefined;
    window.ClipboardItem = undefined;

    // Act
    const result = await copyToClipboard(mockBlob);

    // Assert
    expect(result).toBe(false);
  });

  it('should return false when write fails', async () => {
    // Arrange
    const mockBlob = new Blob(['test'], { type: 'image/gif' });
    const mockWrite = vi.fn().mockRejectedValue(new Error('Write failed'));

    Object.defineProperty(navigator, 'clipboard', {
      value: { write: mockWrite },
      writable: true,
      configurable: true,
    });

    // Mock ClipboardItem as a class on both global and window
    class MockClipboardItem {
      constructor(obj) {
        this.data = obj;
      }
    }
    global.ClipboardItem = MockClipboardItem;
    window.ClipboardItem = MockClipboardItem;

    // Act
    const result = await copyToClipboard(mockBlob);

    // Assert
    expect(result).toBe(false);
  });
});

describe('getBlobSize', () => {
  it('should return bytes and formatted size for small files', () => {
    // Arrange
    const blob = new Blob(['test']); // 4 bytes

    // Act
    const result = getBlobSize(blob);

    // Assert
    expect(result.bytes).toBe(4);
    expect(result.formatted).toBe('4 B');
  });

  it('should format KB correctly', () => {
    // Arrange
    const data = new Uint8Array(2048); // 2 KB
    const blob = new Blob([data]);

    // Act
    const result = getBlobSize(blob);

    // Assert
    expect(result.bytes).toBe(2048);
    expect(result.formatted).toBe('2.0 KB');
  });

  it('should format MB correctly', () => {
    // Arrange
    const data = new Uint8Array(1.5 * 1024 * 1024); // 1.5 MB
    const blob = new Blob([data]);

    // Act
    const result = getBlobSize(blob);

    // Assert
    expect(result.bytes).toBe(1.5 * 1024 * 1024);
    expect(result.formatted).toBe('1.5 MB');
  });

  it('should format GB correctly', () => {
    // Arrange - Create a mock blob with large size
    const mockBlob = { size: 2.5 * 1024 * 1024 * 1024 };

    // Act
    const result = getBlobSize(mockBlob);

    // Assert
    expect(result.bytes).toBe(2.5 * 1024 * 1024 * 1024);
    expect(result.formatted).toBe('2.5 GB');
  });
});

describe('scaleFrame', () => {
  it('should scale image data to target dimensions', () => {
    // Arrange
    const sourceData = new Uint8ClampedArray(100 * 100 * 4);
    const sourceImageData = {
      data: sourceData,
      width: 100,
      height: 100,
    };

    const mockSrcCtx = {
      putImageData: vi.fn(),
    };

    const scaledData = new Uint8ClampedArray(50 * 50 * 4);
    const mockDstCtx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: '',
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: scaledData,
        width: 50,
        height: 50,
      }),
    };

    let canvasCount = 0;
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'canvas') {
        canvasCount++;
        const canvas = {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(canvasCount === 1 ? mockSrcCtx : mockDstCtx),
        };
        return canvas;
      }
      return {};
    });

    // Act
    const result = scaleFrame(sourceImageData, 50, 50);

    // Assert
    expect(mockSrcCtx.putImageData).toHaveBeenCalledWith(sourceImageData, 0, 0);
    expect(mockDstCtx.imageSmoothingEnabled).toBe(true);
    expect(mockDstCtx.imageSmoothingQuality).toBe('high');
    expect(mockDstCtx.drawImage).toHaveBeenCalled();
    expect(mockDstCtx.getImageData).toHaveBeenCalledWith(0, 0, 50, 50);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });

  it('should throw when source canvas context fails', () => {
    // Arrange
    const sourceImageData = {
      data: new Uint8ClampedArray(100),
      width: 10,
      height: 10,
    };

    vi.spyOn(document, 'createElement').mockImplementation(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(null),
    }));

    // Act & Assert
    expect(() => scaleFrame(sourceImageData, 5, 5)).toThrow(
      'Failed to get source canvas context'
    );
  });
});
