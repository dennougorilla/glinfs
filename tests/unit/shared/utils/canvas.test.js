import { describe, it, expect, vi } from 'vitest';
import {
  getContext2D,
  syncCanvasSize,
  isVideoFrameValid,
  isFrameValid,
  renderFramePlaceholder,
} from '../../../../src/shared/utils/canvas.js';

describe('getContext2D', () => {
  it('returns 2D context from canvas', () => {
    const mockCtx = { type: '2d' };
    const canvas = {
      getContext: vi.fn(() => mockCtx),
    };

    const result = getContext2D(canvas);

    expect(result).toBe(mockCtx);
    expect(canvas.getContext).toHaveBeenCalledWith('2d', {});
  });

  it('passes options to getContext', () => {
    const mockCtx = { type: '2d' };
    const canvas = {
      getContext: vi.fn(() => mockCtx),
    };

    getContext2D(canvas, { willReadFrequently: true });

    expect(canvas.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
  });

  it('throws error when context is null', () => {
    const canvas = {
      getContext: vi.fn(() => null),
    };

    expect(() => getContext2D(canvas)).toThrow('Failed to get canvas 2D context');
  });
});

describe('syncCanvasSize', () => {
  it('updates canvas dimensions when different', () => {
    const canvas = { width: 100, height: 100 };

    const changed = syncCanvasSize(canvas, 200, 150);

    expect(changed).toBe(true);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(150);
  });

  it('returns false when dimensions match', () => {
    const canvas = { width: 200, height: 150 };

    const changed = syncCanvasSize(canvas, 200, 150);

    expect(changed).toBe(false);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(150);
  });

  it('updates when only width differs', () => {
    const canvas = { width: 100, height: 150 };

    const changed = syncCanvasSize(canvas, 200, 150);

    expect(changed).toBe(true);
  });

  it('updates when only height differs', () => {
    const canvas = { width: 200, height: 100 };

    const changed = syncCanvasSize(canvas, 200, 150);

    expect(changed).toBe(true);
  });
});

describe('isVideoFrameValid', () => {
  it('returns true for valid open VideoFrame', () => {
    const videoFrame = { closed: false };

    expect(isVideoFrameValid(videoFrame)).toBe(true);
  });

  it('returns false for closed VideoFrame', () => {
    const videoFrame = { closed: true };

    expect(isVideoFrameValid(videoFrame)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isVideoFrameValid(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isVideoFrameValid(undefined)).toBe(false);
  });
});

describe('isFrameValid', () => {
  it('returns true for valid frame with open VideoFrame', () => {
    const frame = { frame: { closed: false } };

    expect(isFrameValid(frame)).toBe(true);
  });

  it('returns false for frame with closed VideoFrame', () => {
    const frame = { frame: { closed: true } };

    expect(isFrameValid(frame)).toBe(false);
  });

  it('returns false for frame with null VideoFrame', () => {
    const frame = { frame: null };

    expect(isFrameValid(frame)).toBe(false);
  });

  it('returns false for null frame', () => {
    expect(isFrameValid(null)).toBe(false);
  });

  it('returns false for undefined frame', () => {
    expect(isFrameValid(undefined)).toBe(false);
  });
});

describe('renderFramePlaceholder', () => {
  function createMockContext() {
    return {
      canvas: { width: 0, height: 0 },
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      fillRect: vi.fn(),
      fillText: vi.fn(),
    };
  }

  it('syncs canvas size', () => {
    const ctx = createMockContext();

    renderFramePlaceholder(ctx, 640, 480);

    expect(ctx.canvas.width).toBe(640);
    expect(ctx.canvas.height).toBe(480);
  });

  it('fills background with default color', () => {
    const ctx = createMockContext();

    renderFramePlaceholder(ctx, 640, 480);

    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 640, 480);
  });

  it('renders centered message by default', () => {
    const ctx = createMockContext();

    renderFramePlaceholder(ctx, 640, 480);

    expect(ctx.fillText).toHaveBeenCalledWith('Frame unavailable', 320, 240);
    expect(ctx.textAlign).toBe('center');
    expect(ctx.textBaseline).toBe('middle');
  });

  it('uses custom options', () => {
    const ctx = createMockContext();

    renderFramePlaceholder(ctx, 640, 480, {
      backgroundColor: '#000',
      message: 'Custom message',
    });

    expect(ctx.fillText).toHaveBeenCalledWith('Custom message', 320, 240);
  });

  it('skips message when showMessage is false', () => {
    const ctx = createMockContext();

    renderFramePlaceholder(ctx, 640, 480, { showMessage: false });

    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});
