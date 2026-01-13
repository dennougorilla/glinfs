import { describe, it, expect } from 'vitest';
import {
  createClip,
  setFrameRange,
  validateFrameRange,
  calculateSelection,
  calculateSelectionInfo,
  getOutputDimensions,
  getHandlePositions,
  resizeCropByHandle,
  moveCrop,
  clampCropArea,
  constrainAspectRatio,
  centerCropAfterConstraint,
  detectBoundaryHit,
  normalizeSelectionRange,
  isFrameInRange,
  HANDLE_HIT_ZONE,
  HANDLE_SIZE,
} from '../../../src/features/editor/core.js';

/**
 * Create mock ImageData for testing
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function createMockImageData(width, height) {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

/**
 * Create a mock frame for testing
 * @param {string} id
 * @param {number} timestamp
 * @param {number} width
 * @param {number} height
 * @returns {import('../../../src/features/capture/types.js').Frame}
 */
function createMockFrame(id, timestamp = 0, width = 1920, height = 1080) {
  return {
    id,
    data: /** @type {ImageData} */ (createMockImageData(width, height)),
    timestamp,
    width,
    height,
  };
}

describe('createClip', () => {
  it('creates clip from frames', () => {
    const frames = [
      createMockFrame('1', 100),
      createMockFrame('2', 200),
      createMockFrame('3', 300),
    ];

    const clip = createClip(frames);

    expect(clip.id).toBeDefined();
    expect(clip.frames).toHaveLength(3);
    expect(clip.selectedRange).toEqual({ start: 0, end: 2 });
    expect(clip.cropArea).toBeNull();
    expect(clip.createdAt).toBeGreaterThan(0);
  });

  it('creates clip with empty frames array', () => {
    const clip = createClip([]);

    expect(clip.frames).toHaveLength(0);
    expect(clip.selectedRange).toEqual({ start: 0, end: 0 });
  });

  it('preserves frame references', () => {
    const frames = [createMockFrame('1')];
    const clip = createClip(frames);

    expect(clip.frames[0]).toBe(frames[0]);
  });
});

describe('setFrameRange', () => {
  it('updates frame range', () => {
    const clip = createClip([
      createMockFrame('1'),
      createMockFrame('2'),
      createMockFrame('3'),
      createMockFrame('4'),
      createMockFrame('5'),
    ]);

    const updated = setFrameRange(clip, { start: 1, end: 3 });

    expect(updated.selectedRange).toEqual({ start: 1, end: 3 });
    expect(updated.frames).toBe(clip.frames); // Same reference
  });

  it('returns new clip object (immutability)', () => {
    const clip = createClip([createMockFrame('1')]);
    const updated = setFrameRange(clip, { start: 0, end: 0 });

    expect(updated).not.toBe(clip);
  });
});

describe('validateFrameRange', () => {
  it('accepts valid range', () => {
    const result = validateFrameRange({ start: 0, end: 5 }, 10);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects start greater than end', () => {
    const result = validateFrameRange({ start: 5, end: 2 }, 10);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Start frame must be less than or equal to end frame');
  });

  it('rejects negative start', () => {
    const result = validateFrameRange({ start: -1, end: 5 }, 10);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Start frame cannot be negative');
  });

  it('rejects end beyond total frames', () => {
    const result = validateFrameRange({ start: 0, end: 15 }, 10);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('End frame exceeds total frames');
  });

  it('collects multiple errors', () => {
    const result = validateFrameRange({ start: -1, end: 100 }, 10);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('calculateSelection', () => {
  it('calculates frame count correctly', () => {
    const result = calculateSelection({ start: 2, end: 7 }, 30);

    // 7 - 2 + 1 = 6 frames
    expect(result.count).toBe(6);
  });

  it('calculates duration from fps', () => {
    const result = calculateSelection({ start: 0, end: 29 }, 30);

    // 30 frames at 30fps = 1 second
    expect(result.duration).toBeCloseTo(1, 2);
  });

  it('handles single frame selection', () => {
    const result = calculateSelection({ start: 5, end: 5 }, 30);

    expect(result.count).toBe(1);
    expect(result.duration).toBeCloseTo(1 / 30, 3);
  });
});

describe('getOutputDimensions', () => {
  const frame = createMockFrame('1', 0, 1920, 1080);

  it('returns frame dimensions when no crop', () => {
    const result = getOutputDimensions(null, frame);

    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('returns crop dimensions when crop is set', () => {
    const crop = { x: 0, y: 0, width: 640, height: 480, aspectRatio: 'free' };
    const result = getOutputDimensions(crop, frame);

    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });
});

describe('calculateSelectionInfo', () => {
  it('calculates frame count correctly', () => {
    const selection = { start: 0, end: 44 };
    const result = calculateSelectionInfo(selection, 30);
    expect(result.frameCount).toBe(45);
  });

  it('calculates duration correctly', () => {
    const selection = { start: 0, end: 29 };
    const result = calculateSelectionInfo(selection, 30);
    expect(result.duration).toBe(1);
  });

  it('formats duration in compact format', () => {
    const selection = { start: 0, end: 44 };
    const result = calculateSelectionInfo(selection, 30);
    expect(result.formattedDuration).toBe('1.5s');
  });

  it('handles single frame selection', () => {
    const selection = { start: 10, end: 10 };
    const result = calculateSelectionInfo(selection, 30);
    expect(result.frameCount).toBe(1);
    expect(result.formattedFrameCount).toBe('1 frame');
  });

  it('uses plural for multiple frames', () => {
    const selection = { start: 0, end: 44 };
    const result = calculateSelectionInfo(selection, 30);
    expect(result.formattedFrameCount).toBe('45 frames');
  });

  it('formats zero duration correctly', () => {
    // Single frame at 30fps = 1/30 = 0.033...s
    const selection = { start: 0, end: 0 };
    const result = calculateSelectionInfo(selection, 30);
    expect(result.formattedDuration).toBe('0.0s');
  });
});

describe('getHandlePositions', () => {
  const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };

  it('returns positions for all 8 handles', () => {
    const positions = getHandlePositions(crop);

    expect(Object.keys(positions)).toHaveLength(8);
    expect(positions['top-left']).toBeDefined();
    expect(positions['top']).toBeDefined();
    expect(positions['top-right']).toBeDefined();
    expect(positions['left']).toBeDefined();
    expect(positions['right']).toBeDefined();
    expect(positions['bottom-left']).toBeDefined();
    expect(positions['bottom']).toBeDefined();
    expect(positions['bottom-right']).toBeDefined();
  });

  it('calculates corner positions correctly', () => {
    const positions = getHandlePositions(crop);

    expect(positions['top-left']).toEqual({ x: 100, y: 100 });
    expect(positions['top-right']).toEqual({ x: 300, y: 100 });
    expect(positions['bottom-left']).toEqual({ x: 100, y: 250 });
    expect(positions['bottom-right']).toEqual({ x: 300, y: 250 });
  });

  it('calculates edge positions correctly', () => {
    const positions = getHandlePositions(crop);

    expect(positions['top']).toEqual({ x: 200, y: 100 });
    expect(positions['bottom']).toEqual({ x: 200, y: 250 });
    expect(positions['left']).toEqual({ x: 100, y: 175 });
    expect(positions['right']).toEqual({ x: 300, y: 175 });
  });
});

describe('resizeCropByHandle', () => {
  const frame = createMockFrame('1', 0, 800, 600);

  it('should expand bottom-right handle correctly', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const start = { x: 300, y: 250 };
    const current = { x: 350, y: 300 };

    const result = resizeCropByHandle(crop, 'bottom-right', start, current, frame);

    expect(result.width).toBe(250);
    expect(result.height).toBe(200);
    expect(result.x).toBe(100); // unchanged
    expect(result.y).toBe(100); // unchanged
  });

  it('should expand top-left handle correctly', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const start = { x: 100, y: 100 };
    const current = { x: 50, y: 50 };

    const result = resizeCropByHandle(crop, 'top-left', start, current, frame);

    expect(result.x).toBe(50);
    expect(result.y).toBe(50);
    expect(result.width).toBe(250);
    expect(result.height).toBe(200);
  });

  it('should clamp to frame bounds', () => {
    const crop = { x: 700, y: 500, width: 100, height: 100, aspectRatio: 'free' };
    const start = { x: 800, y: 600 };
    const current = { x: 900, y: 700 }; // Beyond frame

    const result = resizeCropByHandle(crop, 'bottom-right', start, current, frame);

    expect(result.x + result.width).toBeLessThanOrEqual(800);
    expect(result.y + result.height).toBeLessThanOrEqual(600);
  });

  it('should enforce minimum size', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const start = { x: 300, y: 250 };
    const current = { x: 105, y: 105 }; // Try to make it tiny

    const result = resizeCropByHandle(crop, 'bottom-right', start, current, frame);

    expect(result.width).toBeGreaterThanOrEqual(10);
    expect(result.height).toBeGreaterThanOrEqual(10);
  });

  it('should not mutate input crop', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const originalX = crop.x;
    const start = { x: 300, y: 250 };
    const current = { x: 350, y: 300 };

    resizeCropByHandle(crop, 'bottom-right', start, current, frame);

    expect(crop.x).toBe(originalX);
    expect(crop.width).toBe(200);
  });

  it('should resize top edge correctly', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const start = { x: 200, y: 100 };
    const current = { x: 200, y: 50 };

    const result = resizeCropByHandle(crop, 'top', start, current, frame);

    expect(result.y).toBe(50);
    expect(result.height).toBe(200);
    expect(result.x).toBe(100); // unchanged
    expect(result.width).toBe(200); // unchanged
  });

  it('should resize right edge correctly', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const start = { x: 300, y: 175 };
    const current = { x: 400, y: 175 };

    const result = resizeCropByHandle(crop, 'right', start, current, frame);

    expect(result.width).toBe(300);
    expect(result.x).toBe(100); // unchanged
    expect(result.y).toBe(100); // unchanged
    expect(result.height).toBe(150); // unchanged
  });

  describe('with aspect ratio constraint', () => {
    it('should maintain 1:1 aspect ratio when resizing bottom-right', () => {
      const crop = { x: 100, y: 100, width: 100, height: 100, aspectRatio: '1:1' };
      const start = { x: 200, y: 200 };
      const current = { x: 250, y: 220 }; // width change is larger

      const result = resizeCropByHandle(crop, 'bottom-right', start, current, frame);

      expect(result.width).toBe(result.height);
      expect(result.aspectRatio).toBe('1:1');
    });

    it('should maintain 16:9 aspect ratio when resizing right edge', () => {
      const crop = { x: 100, y: 100, width: 160, height: 90, aspectRatio: '16:9' };
      const start = { x: 260, y: 145 };
      const current = { x: 320, y: 145 }; // increase width by 60

      const result = resizeCropByHandle(crop, 'right', start, current, frame);

      expect(result.width / result.height).toBeCloseTo(16 / 9, 1);
      expect(result.aspectRatio).toBe('16:9');
    });

    it('should maintain 4:3 aspect ratio when resizing bottom edge', () => {
      const crop = { x: 100, y: 100, width: 160, height: 120, aspectRatio: '4:3' };
      const start = { x: 180, y: 220 };
      const current = { x: 180, y: 280 }; // increase height by 60

      const result = resizeCropByHandle(crop, 'bottom', start, current, frame);

      expect(result.width / result.height).toBeCloseTo(4 / 3, 1);
      expect(result.aspectRatio).toBe('4:3');
    });

    it('should maintain aspect ratio when resizing top-left corner', () => {
      const crop = { x: 200, y: 200, width: 100, height: 100, aspectRatio: '1:1' };
      const start = { x: 200, y: 200 };
      const current = { x: 150, y: 140 }; // expand towards top-left

      const result = resizeCropByHandle(crop, 'top-left', start, current, frame);

      expect(result.width).toBe(result.height);
      expect(result.aspectRatio).toBe('1:1');
    });

    it('should not apply constraint when aspect ratio is free', () => {
      const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
      const start = { x: 300, y: 250 };
      const current = { x: 350, y: 280 };

      const result = resizeCropByHandle(crop, 'bottom-right', start, current, frame);

      // Width and height can change independently
      expect(result.width).toBe(250);
      expect(result.height).toBe(180);
      expect(result.aspectRatio).toBe('free');
    });

    it('should maintain 9:16 vertical aspect ratio', () => {
      const crop = { x: 100, y: 50, width: 90, height: 160, aspectRatio: '9:16' };
      const start = { x: 190, y: 210 };
      const current = { x: 220, y: 210 }; // increase width by 30

      const result = resizeCropByHandle(crop, 'right', start, current, frame);

      expect(result.width / result.height).toBeCloseTo(9 / 16, 1);
      expect(result.aspectRatio).toBe('9:16');
    });
  });
});

describe('moveCrop', () => {
  const frame = createMockFrame('1', 0, 800, 600);

  it('should translate crop by delta', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const delta = { x: 50, y: 30 };

    const result = moveCrop(crop, delta, frame);

    expect(result.x).toBe(150);
    expect(result.y).toBe(130);
    expect(result.width).toBe(200); // unchanged
    expect(result.height).toBe(150); // unchanged
  });

  it('should clamp to keep crop within bounds', () => {
    const crop = { x: 700, y: 500, width: 100, height: 100, aspectRatio: 'free' };
    const delta = { x: 50, y: 50 }; // Would push beyond frame

    const result = moveCrop(crop, delta, frame);

    expect(result.x + result.width).toBeLessThanOrEqual(800);
    expect(result.y + result.height).toBeLessThanOrEqual(600);
  });

  it('should not allow negative position', () => {
    const crop = { x: 50, y: 50, width: 100, height: 100, aspectRatio: 'free' };
    const delta = { x: -100, y: -100 };

    const result = moveCrop(crop, delta, frame);

    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
  });

  it('should not mutate input crop', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const originalX = crop.x;
    const delta = { x: 50, y: 30 };

    moveCrop(crop, delta, frame);

    expect(crop.x).toBe(originalX);
  });
});

describe('clampCropArea - 8 handle scenarios', () => {
  it('should handle top-left resize beyond bounds', () => {
    const crop = { x: -50, y: -50, width: 200, height: 150, aspectRatio: 'free' };
    const result = clampCropArea(crop, 800, 600);

    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('should handle bottom-right resize beyond bounds', () => {
    const crop = { x: 700, y: 500, width: 200, height: 200, aspectRatio: 'free' };
    const result = clampCropArea(crop, 800, 600);

    expect(result.x + result.width).toBeLessThanOrEqual(800);
    expect(result.y + result.height).toBeLessThanOrEqual(600);
  });

  it('should enforce minimum size on width', () => {
    const crop = { x: 100, y: 100, width: 5, height: 150, aspectRatio: 'free' };
    const result = clampCropArea(crop, 800, 600);

    expect(result.width).toBeGreaterThanOrEqual(10);
  });

  it('should enforce minimum size on height', () => {
    const crop = { x: 100, y: 100, width: 200, height: 5, aspectRatio: 'free' };
    const result = clampCropArea(crop, 800, 600);

    expect(result.height).toBeGreaterThanOrEqual(10);
  });

  it('should preserve aspect ratio field', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: '16:9' };
    const result = clampCropArea(crop, 800, 600);

    expect(result.aspectRatio).toBe('16:9');
  });
});

describe('constrainAspectRatio', () => {
  it('should return unchanged crop for free aspect ratio', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const result = constrainAspectRatio(crop, 'free');

    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
    expect(result.aspectRatio).toBe('free');
  });

  it('should constrain to 1:1 (square)', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const result = constrainAspectRatio(crop, '1:1');

    expect(result.width).toBe(result.height);
    expect(result.aspectRatio).toBe('1:1');
  });

  it('should constrain to 16:9', () => {
    const crop = { x: 100, y: 100, width: 160, height: 90, aspectRatio: 'free' };
    const result = constrainAspectRatio(crop, '16:9');

    expect(result.width / result.height).toBeCloseTo(16 / 9, 1);
    expect(result.aspectRatio).toBe('16:9');
  });

  it('should reduce width when too wide', () => {
    const crop = { x: 100, y: 100, width: 300, height: 100, aspectRatio: 'free' };
    const result = constrainAspectRatio(crop, '1:1');

    // Width was 300, height was 100, for 1:1 should reduce width to 100
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('should reduce height when too tall', () => {
    const crop = { x: 100, y: 100, width: 100, height: 300, aspectRatio: 'free' };
    const result = constrainAspectRatio(crop, '1:1');

    // Width was 100, height was 300, for 1:1 should reduce height to 100
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('should preserve x and y position (does not center automatically)', () => {
    const crop = { x: 150, y: 200, width: 300, height: 100, aspectRatio: 'free' };
    const result = constrainAspectRatio(crop, '1:1');

    // constrainAspectRatio copies x/y unchanged from input
    // Callers must apply centerCropAfterConstraint separately if centering is needed
    expect(result.x).toBe(150);
    expect(result.y).toBe(200);
  });
});

describe('centerCropAfterConstraint', () => {
  it('should center crop when width is reduced (wide to square)', () => {
    // Arrange
    const original = { x: 100, y: 100, width: 300, height: 100, aspectRatio: 'free' };
    const constrained = { x: 100, y: 100, width: 100, height: 100, aspectRatio: '1:1' };

    // Act
    const result = centerCropAfterConstraint(original, constrained);

    // Assert - should shift right by (300-100)/2 = 100
    expect(result.x).toBe(200);
    expect(result.y).toBe(100);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('should center crop when height is reduced (tall to square)', () => {
    // Arrange
    const original = { x: 100, y: 100, width: 100, height: 300, aspectRatio: 'free' };
    const constrained = { x: 100, y: 100, width: 100, height: 100, aspectRatio: '1:1' };

    // Act
    const result = centerCropAfterConstraint(original, constrained);

    // Assert - should shift down by (300-100)/2 = 100
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('should not change position when dimensions unchanged', () => {
    // Arrange
    const original = { x: 50, y: 75, width: 160, height: 90, aspectRatio: 'free' };
    const constrained = { x: 50, y: 75, width: 160, height: 90, aspectRatio: '16:9' };

    // Act
    const result = centerCropAfterConstraint(original, constrained);

    // Assert - no change since dimensions are the same
    expect(result.x).toBe(50);
    expect(result.y).toBe(75);
  });

  it('should handle both width and height reduction', () => {
    // Arrange - crop that needs both dimensions adjusted
    const original = { x: 0, y: 0, width: 400, height: 300, aspectRatio: 'free' };
    const constrained = { x: 0, y: 0, width: 300, height: 200, aspectRatio: '3:2' };

    // Act
    const result = centerCropAfterConstraint(original, constrained);

    // Assert - shift by (400-300)/2=50 and (300-200)/2=50
    expect(result.x).toBe(50);
    expect(result.y).toBe(50);
  });

  it('should preserve aspectRatio from constrained crop', () => {
    // Arrange
    const original = { x: 0, y: 0, width: 200, height: 100, aspectRatio: 'free' };
    const constrained = { x: 0, y: 0, width: 100, height: 100, aspectRatio: '1:1' };

    // Act
    const result = centerCropAfterConstraint(original, constrained);

    // Assert
    expect(result.aspectRatio).toBe('1:1');
  });

  it('should return new object (immutability)', () => {
    // Arrange
    const original = { x: 100, y: 100, width: 200, height: 100, aspectRatio: 'free' };
    const constrained = { x: 100, y: 100, width: 100, height: 100, aspectRatio: '1:1' };

    // Act
    const result = centerCropAfterConstraint(original, constrained);

    // Assert
    expect(result).not.toBe(original);
    expect(result).not.toBe(constrained);
  });
});

describe('HANDLE constants', () => {
  it('should have HANDLE_HIT_ZONE of 15', () => {
    expect(HANDLE_HIT_ZONE).toBe(15);
  });

  it('should have HANDLE_SIZE of 10', () => {
    expect(HANDLE_SIZE).toBe(10);
  });
});

describe('detectBoundaryHit', () => {
  it('should detect no boundary hit when crop is centered', () => {
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(false);
    expect(result.bottom).toBe(false);
    expect(result.left).toBe(false);
    expect(result.right).toBe(false);
  });

  it('should detect top boundary hit', () => {
    const crop = { x: 100, y: 0, width: 200, height: 150, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(true);
    expect(result.bottom).toBe(false);
    expect(result.left).toBe(false);
    expect(result.right).toBe(false);
  });

  it('should detect bottom boundary hit', () => {
    const crop = { x: 100, y: 450, width: 200, height: 150, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(false);
    expect(result.bottom).toBe(true);
    expect(result.left).toBe(false);
    expect(result.right).toBe(false);
  });

  it('should detect left boundary hit', () => {
    const crop = { x: 0, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(false);
    expect(result.bottom).toBe(false);
    expect(result.left).toBe(true);
    expect(result.right).toBe(false);
  });

  it('should detect right boundary hit', () => {
    const crop = { x: 600, y: 100, width: 200, height: 150, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(false);
    expect(result.bottom).toBe(false);
    expect(result.left).toBe(false);
    expect(result.right).toBe(true);
  });

  it('should detect multiple boundary hits (corner)', () => {
    const crop = { x: 0, y: 0, width: 200, height: 150, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(true);
    expect(result.bottom).toBe(false);
    expect(result.left).toBe(true);
    expect(result.right).toBe(false);
  });

  it('should detect all boundaries when crop fills frame', () => {
    const crop = { x: 0, y: 0, width: 800, height: 600, aspectRatio: 'free' };
    const result = detectBoundaryHit(crop, 800, 600);

    expect(result.top).toBe(true);
    expect(result.bottom).toBe(true);
    expect(result.left).toBe(true);
    expect(result.right).toBe(true);
  });
});

// ============================================================
// Frame Grid Selection Tests
// ============================================================

describe('normalizeSelectionRange', () => {
  it('should return valid range for normal selection', () => {
    const result = normalizeSelectionRange(5, 10, 100);
    expect(result).toEqual({ start: 5, end: 10 });
  });

  it('should swap start and end when start > end', () => {
    const result = normalizeSelectionRange(10, 5, 100);
    expect(result).toEqual({ start: 5, end: 10 });
  });

  it('should return single frame selection when end is null', () => {
    const result = normalizeSelectionRange(5, null, 100);
    expect(result).toEqual({ start: 5, end: 5 });
  });

  it('should return null when start is null', () => {
    const result = normalizeSelectionRange(null, 10, 100);
    expect(result).toBeNull();
  });

  it('should clamp start to bounds when negative', () => {
    const result = normalizeSelectionRange(-5, 10, 100);
    expect(result).toEqual({ start: 0, end: 10 });
  });

  it('should clamp end to bounds when exceeds totalFrames', () => {
    const result = normalizeSelectionRange(5, 150, 100);
    expect(result).toEqual({ start: 5, end: 99 });
  });

  it('should clamp both start and end when out of bounds', () => {
    const result = normalizeSelectionRange(-10, 200, 100);
    expect(result).toEqual({ start: 0, end: 99 });
  });

  it('should handle single frame clip', () => {
    const result = normalizeSelectionRange(0, 0, 1);
    expect(result).toEqual({ start: 0, end: 0 });
  });

  it('should handle edge case with swapped out-of-bounds values', () => {
    // start=150, end=5, totalFrames=100 → swap → clamp → start=5, end=99
    const result = normalizeSelectionRange(150, 5, 100);
    expect(result).toEqual({ start: 5, end: 99 });
  });
});

describe('isFrameInRange', () => {
  it('should return true for frame within range', () => {
    expect(isFrameInRange(7, 5, 10)).toBe(true);
  });

  it('should return true for frame at start of range', () => {
    expect(isFrameInRange(5, 5, 10)).toBe(true);
  });

  it('should return true for frame at end of range', () => {
    expect(isFrameInRange(10, 5, 10)).toBe(true);
  });

  it('should return false for frame before range', () => {
    expect(isFrameInRange(3, 5, 10)).toBe(false);
  });

  it('should return false for frame after range', () => {
    expect(isFrameInRange(15, 5, 10)).toBe(false);
  });

  it('should return false when start is null', () => {
    expect(isFrameInRange(5, null, 10)).toBe(false);
  });

  it('should handle single frame selection when end is null', () => {
    // When end is null, only the start frame is "in range"
    expect(isFrameInRange(5, 5, null)).toBe(true);
    expect(isFrameInRange(6, 5, null)).toBe(false);
  });

  it('should handle swapped start/end values', () => {
    // start=10, end=5 → internally normalized → frame 7 is in range
    expect(isFrameInRange(7, 10, 5)).toBe(true);
  });

  it('should handle single frame selection with same start and end', () => {
    expect(isFrameInRange(5, 5, 5)).toBe(true);
    expect(isFrameInRange(4, 5, 5)).toBe(false);
    expect(isFrameInRange(6, 5, 5)).toBe(false);
  });
});
