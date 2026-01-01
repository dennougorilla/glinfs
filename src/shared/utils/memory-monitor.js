/**
 * Memory Monitor
 * Real-time memory monitoring and alerts
 * @module shared/utils/memory-monitor
 */

/** @type {number} Warning threshold (MB) */
const WARNING_THRESHOLD_MB = 400;

/** @type {number} Critical threshold (MB) */
const CRITICAL_THRESHOLD_MB = 500;

/**
 * Memory status level
 * @typedef {'normal' | 'warning' | 'critical'} MemoryLevel
 */

/**
 * Memory status
 * @typedef {Object} MemoryStatus
 * @property {number} usedMB - Used memory (MB)
 * @property {number} limitMB - Memory limit (MB)
 * @property {MemoryLevel} level - Status level
 * @property {number} percent - Usage percentage (0-100)
 */

/**
 * Get current memory status
 * @returns {MemoryStatus | null} - null if performance.memory is not available
 */
export function getMemoryStatus() {
  // @ts-ignore - Chrome-specific API
  const memory = performance.memory;

  if (!memory) {
    return null;
  }

  const usedMB = memory.usedJSHeapSize / (1024 * 1024);
  const limitMB = memory.jsHeapSizeLimit / (1024 * 1024);
  const percent = Math.round((usedMB / limitMB) * 100);

  /** @type {MemoryLevel} */
  let level = 'normal';
  if (usedMB >= CRITICAL_THRESHOLD_MB) {
    level = 'critical';
  } else if (usedMB >= WARNING_THRESHOLD_MB) {
    level = 'warning';
  }

  return { usedMB, limitMB, level, percent };
}

/**
 * Start periodic memory monitoring
 * @param {(status: MemoryStatus) => void} callback - Status callback
 * @param {number} [intervalMs=1000] - Monitoring interval (ms)
 * @returns {() => void} - Stop function
 */
export function startMemoryMonitor(callback, intervalMs = 1000) {
  const interval = setInterval(() => {
    const status = getMemoryStatus();
    if (status) {
      callback(status);
    }
  }, intervalMs);

  return () => clearInterval(interval);
}

/**
 * Estimate memory usage for VideoFrame buffer
 * VideoFrames are stored in GPU memory, so CPU memory usage is lower
 * @param {number} frameCount - Number of frames
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @returns {number} - Estimated MB
 */
export function estimateBufferMemory(frameCount, width, height) {
  // VideoFrames are stored in GPU memory
  // CPU-side overhead is approximately 1/10
  const bytesPerFrame = (width * height * 4) / 10;
  return (frameCount * bytesPerFrame) / (1024 * 1024);
}

/**
 * Format memory usage
 * @param {number} mb - Memory (MB)
 * @returns {string}
 */
export function formatMemory(mb) {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

/**
 * Get color for memory level
 * @param {MemoryLevel} level
 * @returns {string} - CSS color
 */
export function getMemoryLevelColor(level) {
  switch (level) {
    case 'critical':
      return '#ff4444';
    case 'warning':
      return '#ffaa00';
    default:
      return '#44ff44';
  }
}

/**
 * Get message for memory level
 * @param {MemoryLevel} level
 * @returns {string}
 */
export function getMemoryLevelMessage(level) {
  switch (level) {
    case 'critical':
      return 'Memory usage critical. Please stop recording.';
    case 'warning':
      return 'Memory usage increasing. Consider shorter recording.';
    default:
      return 'Memory usage normal.';
  }
}

/**
 * Estimate maximum frame count based on memory limit
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {number} [targetMemoryMB=400] - Target memory usage
 * @returns {number} - Estimated maximum frame count
 */
export function estimateMaxFrames(width, height, targetMemoryMB = WARNING_THRESHOLD_MB) {
  const bytesPerFrame = (width * height * 4) / 10;
  const targetBytes = targetMemoryMB * 1024 * 1024;
  return Math.floor(targetBytes / bytesPerFrame);
}
