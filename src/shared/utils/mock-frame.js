/**
 * Mock Frame Utilities for E2E Testing
 * @module shared/utils/mock-frame
 *
 * Creates VideoFrame-compatible objects using OffscreenCanvas for testing.
 * Allows testing Editor and Export features without Screen Capture API.
 *
 * Usage in Playwright:
 * ```javascript
 * await page.evaluate(() => {
 *   window.__TEST_HOOKS__.injectMockClipPayload({ frameCount: 30, fps: 30 });
 * });
 * await page.goto('#/editor');
 * ```
 */

/**
 * @typedef {Object} MockVideoFrame
 * @property {number} codedWidth - Width matching VideoFrame API
 * @property {number} codedHeight - Height matching VideoFrame API
 * @property {number} displayWidth - Display width
 * @property {number} displayHeight - Display height
 * @property {number} timestamp - Timestamp in microseconds
 * @property {boolean} closed - Whether frame has been closed
 * @property {() => void} close - Close the frame
 * @property {() => MockVideoFrame} clone - Clone the frame
 * @property {ImageBitmap} _bitmap - Internal bitmap for rendering
 */

/**
 * @typedef {Object} MockFrameOptions
 * @property {number} [width=640] - Frame width
 * @property {number} [height=480] - Frame height
 * @property {'gradient' | 'checkerboard' | 'solid' | 'numbered'} [pattern='gradient'] - Visual pattern
 * @property {string} [color='#4a90d9'] - Base color for patterns
 * @property {number} [frameIndex=0] - Frame index (used for numbered pattern)
 */

/** Default mock frame options */
const DEFAULT_OPTIONS = {
  width: 640,
  height: 480,
  pattern: 'gradient',
  color: '#4a90d9',
  frameIndex: 0,
};

/**
 * Create an ImageBitmap with the specified visual pattern
 * This creates a real renderable image that works with canvas.drawImage()
 *
 * @param {MockFrameOptions} options - Pattern options
 * @returns {Promise<ImageBitmap>} The created ImageBitmap
 */
async function createPatternBitmap(options) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { width, height, pattern, color, frameIndex } = opts;

  // Create OffscreenCanvas for pattern generation
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

  // Draw pattern based on type
  switch (pattern) {
    case 'gradient':
      drawGradientPattern(ctx, width, height, color, frameIndex);
      break;
    case 'checkerboard':
      drawCheckerboardPattern(ctx, width, height, color);
      break;
    case 'solid':
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      break;
    case 'numbered':
      drawNumberedPattern(ctx, width, height, color, frameIndex);
      break;
    default:
      drawGradientPattern(ctx, width, height, color, frameIndex);
  }

  // Convert to ImageBitmap for efficient rendering
  return createImageBitmap(canvas);
}

/**
 * Draw animated gradient pattern (changes with frameIndex)
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {string} baseColor
 * @param {number} frameIndex
 */
function drawGradientPattern(ctx, width, height, baseColor, frameIndex) {
  // Animate gradient angle based on frame index
  const angle = (frameIndex * 3) % 360;
  const radians = (angle * Math.PI) / 180;

  const x1 = width / 2 + Math.cos(radians) * width / 2;
  const y1 = height / 2 + Math.sin(radians) * height / 2;
  const x2 = width / 2 - Math.cos(radians) * width / 2;
  const y2 = height / 2 - Math.sin(radians) * height / 2;

  const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
  gradient.addColorStop(0, baseColor);
  gradient.addColorStop(0.5, '#ffffff');
  gradient.addColorStop(1, shiftHue(baseColor, 60));

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Add subtle animation indicator
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  const indicatorX = (frameIndex * 20) % width;
  ctx.fillRect(indicatorX, 0, 4, height);
}

/**
 * Draw checkerboard pattern
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {string} baseColor
 */
function drawCheckerboardPattern(ctx, width, height, baseColor) {
  const tileSize = 32;

  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const isEven = ((x / tileSize) + (y / tileSize)) % 2 === 0;
      ctx.fillStyle = isEven ? baseColor : '#ffffff';
      ctx.fillRect(x, y, tileSize, tileSize);
    }
  }
}

/**
 * Draw pattern with visible frame number
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {string} baseColor
 * @param {number} frameIndex
 */
function drawNumberedPattern(ctx, width, height, baseColor, frameIndex) {
  // Background
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  // Frame number
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.min(width, height) / 3}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(frameIndex), width / 2, height / 2);

  // Border to show frame boundaries
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, width - 4, height - 4);
}

/**
 * Shift hue of a hex color
 * @param {string} hex - Hex color
 * @param {number} degrees - Degrees to shift
 * @returns {string} New hex color
 */
function shiftHue(hex, degrees) {
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  // Convert to HSL
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  // Shift hue
  h = (h + degrees / 360) % 1;

  // Convert back to RGB
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const newR = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const newG = Math.round(hue2rgb(p, q, h) * 255);
  const newB = Math.round(hue2rgb(p, q, h - 1/3) * 255);

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

/**
 * Create a single mock VideoFrame-compatible object
 * Uses ImageBitmap internally for canvas compatibility
 *
 * @param {MockFrameOptions & { timestamp?: number }} options - Frame options
 * @returns {Promise<MockVideoFrame>} Mock VideoFrame object
 *
 * @example
 * const mockFrame = await createMockVideoFrame({ width: 1920, height: 1080 });
 * ctx.drawImage(mockFrame._bitmap, 0, 0); // Works like a real VideoFrame
 */
export async function createMockVideoFrame(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const bitmap = await createPatternBitmap(opts);

  let closed = false;

  /** @type {MockVideoFrame} */
  const mockVideoFrame = {
    codedWidth: opts.width,
    codedHeight: opts.height,
    displayWidth: opts.width,
    displayHeight: opts.height,
    timestamp: options.timestamp ?? opts.frameIndex * 33333, // ~30fps in microseconds

    get closed() {
      return closed;
    },

    close() {
      if (!closed) {
        closed = true;
        bitmap.close();
      }
    },

    clone() {
      // Note: This returns a new promise-based object
      // For sync clone, caller should create multiple frames upfront
      console.warn('[MockFrame] clone() called - mock frames should be pre-created');
      return this; // Return self for simplicity in tests
    },

    _bitmap: bitmap,
  };

  return mockVideoFrame;
}

/**
 * Create a mock Frame object (matching capture/types.js Frame type)
 *
 * @param {number} index - Frame index
 * @param {MockFrameOptions} [options] - Frame options
 * @returns {Promise<import('../../features/capture/types.js').Frame>} Mock Frame
 */
export async function createMockFrame(index, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options, frameIndex: index };
  const mockVideoFrame = await createMockVideoFrame(opts);

  return {
    id: `mock-frame-${index}-${Date.now()}`,
    frame: /** @type {VideoFrame} */ (/** @type {unknown} */ (mockVideoFrame)),
    timestamp: mockVideoFrame.timestamp,
    width: opts.width,
    height: opts.height,
  };
}

/**
 * Create multiple mock frames for testing
 *
 * @param {number} count - Number of frames to create
 * @param {Omit<MockFrameOptions, 'frameIndex'> & { fps?: number }} [options] - Options
 * @returns {Promise<import('../../features/capture/types.js').Frame[]>} Array of mock frames
 *
 * @example
 * const frames = await createMockFrames(30, { width: 1280, height: 720, pattern: 'numbered' });
 */
export async function createMockFrames(count, options = {}) {
  const { fps = 30, ...frameOptions } = options;
  const frameInterval = 1000000 / fps; // Interval in microseconds

  const frames = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      createMockFrame(i, {
        ...frameOptions,
        timestamp: i * frameInterval,
      })
    )
  );

  return frames;
}

/**
 * Create a mock ClipPayload for testing Editor
 *
 * @param {Object} options - Options
 * @param {number} [options.frameCount=30] - Number of frames
 * @param {15 | 30 | 60} [options.fps=30] - FPS setting
 * @param {number} [options.width=640] - Frame width
 * @param {number} [options.height=480] - Frame height
 * @param {'gradient' | 'checkerboard' | 'numbered'} [options.pattern='numbered'] - Visual pattern
 * @param {boolean} [options.sceneDetectionEnabled=false] - Enable scene detection
 * @returns {Promise<import('../app-store.js').ClipPayload>} Mock ClipPayload
 */
export async function createMockClipPayload(options = {}) {
  const {
    frameCount = 30,
    fps = 30,
    width = 640,
    height = 480,
    pattern = 'numbered',
    sceneDetectionEnabled = false,
  } = options;

  const frames = await createMockFrames(frameCount, { width, height, pattern, fps });

  return {
    frames,
    fps: /** @type {15 | 30 | 60} */ (fps),
    capturedAt: Date.now(),
    sceneDetectionEnabled,
  };
}

/**
 * Create a mock EditorPayload for testing Export
 *
 * @param {Object} options - Options
 * @param {number} [options.frameCount=30] - Number of frames
 * @param {15 | 30 | 60} [options.fps=30] - FPS setting
 * @param {number} [options.width=640] - Frame width
 * @param {number} [options.height=480] - Frame height
 * @param {{ start: number, end: number }} [options.selectedRange] - Selected frame range
 * @param {import('../../features/editor/types.js').CropArea | null} [options.cropArea=null] - Crop area
 * @returns {Promise<import('../app-store.js').EditorPayload>} Mock EditorPayload
 */
export async function createMockEditorPayload(options = {}) {
  const {
    frameCount = 30,
    fps = 30,
    width = 640,
    height = 480,
    selectedRange,
    cropArea = null,
  } = options;

  const frames = await createMockFrames(frameCount, { width, height, pattern: 'numbered', fps });
  const range = selectedRange || { start: 0, end: frameCount - 1 };

  return {
    selectedRange: range,
    cropArea,
    clip: {
      frames,
      fps: /** @type {15 | 30 | 60} */ (fps),
      duration: frameCount / fps,
      createdAt: Date.now(),
      selectedRange: range,
      cropArea,
    },
    fps,
  };
}

/**
 * Check if mock frames feature is supported in current environment
 * Requires OffscreenCanvas and createImageBitmap
 *
 * @returns {boolean} True if mock frames can be created
 */
export function isMockFrameSupported() {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

/**
 * Get a drawable source from a Frame object
 * Works with both real VideoFrames and mock frames
 *
 * @param {import('../../features/capture/types.js').Frame} frame - Frame to get drawable from
 * @returns {CanvasImageSource | null} Drawable source for canvas
 */
export function getDrawableSource(frame) {
  if (!frame?.frame) return null;

  // Check for mock frame (has _bitmap property)
  const maybeMock = /** @type {MockVideoFrame} */ (/** @type {unknown} */ (frame.frame));
  if (maybeMock?._bitmap) {
    return maybeMock._bitmap;
  }

  // Real VideoFrame - use directly
  if (!frame.frame.closed) {
    return frame.frame;
  }

  return null;
}
