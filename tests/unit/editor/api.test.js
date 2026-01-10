import { describe, it, expect, vi } from 'vitest';
import {
  getCursorForHandle,
  hitTestCropHandle,
  renderCropOverlay,
} from '../../../src/features/editor/api.js';

describe('getCursorForHandle', () => {
  it('returns nwse-resize for top-left', () => {
    expect(getCursorForHandle('top-left')).toBe('nwse-resize');
  });

  it('returns nwse-resize for bottom-right', () => {
    expect(getCursorForHandle('bottom-right')).toBe('nwse-resize');
  });

  it('returns nesw-resize for top-right', () => {
    expect(getCursorForHandle('top-right')).toBe('nesw-resize');
  });

  it('returns nesw-resize for bottom-left', () => {
    expect(getCursorForHandle('bottom-left')).toBe('nesw-resize');
  });

  it('returns ns-resize for top', () => {
    expect(getCursorForHandle('top')).toBe('ns-resize');
  });

  it('returns ns-resize for bottom', () => {
    expect(getCursorForHandle('bottom')).toBe('ns-resize');
  });

  it('returns ew-resize for left', () => {
    expect(getCursorForHandle('left')).toBe('ew-resize');
  });

  it('returns ew-resize for right', () => {
    expect(getCursorForHandle('right')).toBe('ew-resize');
  });

  it('returns move for move', () => {
    expect(getCursorForHandle('move')).toBe('move');
  });

  it('returns crosshair for draw', () => {
    expect(getCursorForHandle('draw')).toBe('crosshair');
  });

  it('returns crosshair for null', () => {
    expect(getCursorForHandle(null)).toBe('crosshair');
  });
});

describe('hitTestCropHandle', () => {
  const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };
  const hitZone = 15;

  describe('corner detection', () => {
    it('detects top-left corner', () => {
      expect(hitTestCropHandle(100, 100, crop, hitZone)).toBe('top-left');
    });

    it('detects top-right corner', () => {
      expect(hitTestCropHandle(300, 100, crop, hitZone)).toBe('top-right');
    });

    it('detects bottom-left corner', () => {
      expect(hitTestCropHandle(100, 250, crop, hitZone)).toBe('bottom-left');
    });

    it('detects bottom-right corner', () => {
      expect(hitTestCropHandle(300, 250, crop, hitZone)).toBe('bottom-right');
    });
  });

  describe('edge detection', () => {
    it('detects top edge', () => {
      expect(hitTestCropHandle(200, 100, crop, hitZone)).toBe('top');
    });

    it('detects bottom edge', () => {
      expect(hitTestCropHandle(200, 250, crop, hitZone)).toBe('bottom');
    });

    it('detects left edge', () => {
      expect(hitTestCropHandle(100, 175, crop, hitZone)).toBe('left');
    });

    it('detects right edge', () => {
      expect(hitTestCropHandle(300, 175, crop, hitZone)).toBe('right');
    });
  });

  describe('move detection', () => {
    it('returns move when inside crop area', () => {
      expect(hitTestCropHandle(200, 175, crop, hitZone)).toBe('move');
    });

    it('returns move when inside but near center', () => {
      expect(hitTestCropHandle(180, 160, crop, hitZone)).toBe('move');
    });
  });

  describe('outside detection', () => {
    it('returns null when outside crop area', () => {
      expect(hitTestCropHandle(50, 50, crop, hitZone)).toBeNull();
    });

    it('returns null when far from crop', () => {
      expect(hitTestCropHandle(500, 500, crop, hitZone)).toBeNull();
    });
  });

  describe('priority', () => {
    it('prioritizes corner over edge when at exact corner', () => {
      // At exact corner, should return corner handle not edge
      expect(hitTestCropHandle(100, 100, crop, hitZone)).toBe('top-left');
    });
  });
});

describe('renderCropOverlay', () => {
  function createMockContext() {
    return {
      canvas: { width: 800, height: 600 },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      shadowColor: '',
      shadowBlur: 0,
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };
  }

  it('should draw 4 overlay regions', () => {
    const ctx = createMockContext();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };

    renderCropOverlay(ctx, crop);

    // Should draw 4 overlay regions (top, bottom, left, right)
    expect(ctx.fillRect).toHaveBeenCalledTimes(4);
  });

  it('should draw border with correct dimensions', () => {
    const ctx = createMockContext();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };

    renderCropOverlay(ctx, crop);

    // Border is drawn with strokeRect
    expect(ctx.strokeRect).toHaveBeenCalledWith(100, 100, 200, 150);
    // Note: lineWidth is modified by handle drawing after border, so we just verify strokeRect was called
  });

  it('should draw 8 handles as circles', () => {
    const ctx = createMockContext();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };

    renderCropOverlay(ctx, crop);

    // 8 handles are now drawn as circles using arc
    expect(ctx.arc).toHaveBeenCalledTimes(8);
    expect(ctx.fill).toHaveBeenCalledTimes(8);
    // Each handle has a white border
    expect(ctx.stroke).toHaveBeenCalledTimes(8);
  });

  it('should use save/restore for each handle', () => {
    const ctx = createMockContext();
    const crop = { x: 100, y: 100, width: 200, height: 150, aspectRatio: 'free' };

    renderCropOverlay(ctx, crop);

    // Each of the 8 handles calls save/restore
    expect(ctx.save).toHaveBeenCalledTimes(8);
    expect(ctx.restore).toHaveBeenCalledTimes(8);
  });
});
