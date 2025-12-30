/**
 * Mock data generators for E2E tests
 * @module tests/e2e/helpers/mock-data
 */

/**
 * Create mock ImageData-like object for testing
 * Generates a gradient pattern for visual verification
 * @param {number} [width=640]
 * @param {number} [height=480]
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function createMockImageData(width = 640, height = 480) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Create gradient pattern for visual testing
      data[i] = Math.floor((x / width) * 255); // R: horizontal gradient
      data[i + 1] = Math.floor((y / height) * 255); // G: vertical gradient
      data[i + 2] = 128; // B: constant
      data[i + 3] = 255; // A: opaque
    }
  }

  return { data, width, height };
}

/**
 * Create mock frames for testing
 * @param {number} [count=30]
 * @param {Object} [options]
 * @param {number} [options.width=640]
 * @param {number} [options.height=480]
 * @param {number} [options.fps=30]
 * @returns {Array<{id: string, data: Object, timestamp: number, width: number, height: number}>}
 */
export function createMockFrames(count = 30, options = {}) {
  const { width = 640, height = 480, fps = 30 } = options;

  return Array.from({ length: count }, (_, i) => ({
    id: `mock-frame-${i}`,
    data: createMockImageData(width, height),
    timestamp: (i / fps) * 1000,
    width,
    height,
  }));
}

/**
 * Create a mock ClipPayload for editor screen testing
 * @param {number} [frameCount=30]
 * @param {15|30|60} [fps=30]
 * @returns {Object} ClipPayload
 */
export function createMockClipPayload(frameCount = 30, fps = 30) {
  return {
    frames: createMockFrames(frameCount, { fps }),
    fps,
    capturedAt: Date.now(),
  };
}

/**
 * Create a mock EditorPayload for export screen testing
 * @param {number} [frameCount=30]
 * @param {Object} [options]
 * @param {number} [options.fps=30]
 * @param {Object|null} [options.cropArea=null]
 * @returns {Object} EditorPayload
 */
export function createMockEditorPayload(frameCount = 30, options = {}) {
  const { fps = 30, cropArea = null } = options;
  const frames = createMockFrames(frameCount, { fps });

  return {
    frames,
    cropArea,
    clip: {
      frames,
      fps,
      duration: frameCount / fps,
      createdAt: Date.now(),
    },
    fps,
  };
}

/**
 * Create mock capture stats for UI display
 * @param {Object} [overrides]
 * @returns {Object} CaptureStats
 */
export function createMockCaptureStats(overrides = {}) {
  return {
    frameCount: 90,
    duration: 3.0,
    memoryMB: 12.5,
    fps: 30,
    ...overrides,
  };
}

/**
 * Create mock export job state
 * @param {'idle'|'encoding'|'complete'|'error'} status
 * @param {Object} [overrides]
 * @returns {Object} ExportJob
 */
export function createMockExportJob(status, overrides = {}) {
  const baseJob = {
    status,
    progress: 0,
    currentFrame: 0,
    totalFrames: 30,
    result: null,
    error: null,
  };

  switch (status) {
    case 'encoding':
      return {
        ...baseJob,
        progress: 65,
        currentFrame: 20,
        ...overrides,
      };
    case 'complete':
      return {
        ...baseJob,
        progress: 100,
        currentFrame: 30,
        result: { size: 256000, blob: null },
        ...overrides,
      };
    case 'error':
      return {
        ...baseJob,
        error: 'WASM module failed to load',
        ...overrides,
      };
    default:
      return { ...baseJob, ...overrides };
  }
}
