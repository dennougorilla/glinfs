/**
 * Format Utilities
 * @module shared/utils/format
 */

/**
 * Format bytes to human readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g., "2.5 MB")
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Format duration in seconds to mm:ss string
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted string (e.g., "1:30")
 */
export function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format timecode with frame-accurate precision
 * Professional video editing format: MM:SS:FF or SS:FF for short clips
 * @param {number} seconds - Time in seconds
 * @param {number} fps - Frames per second (default 30)
 * @returns {string} Formatted timecode (e.g., "01:23:15" = 1min 23sec 15frames)
 */
export function formatTimecode(seconds, fps = 30) {
  const totalFrames = Math.round(seconds * fps);
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const frames = totalFrames % fps;

  if (mins > 0) {
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  }
  return `${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Format frame index to timecode
 * @param {number} frameIndex - Frame index (0-based)
 * @param {number} fps - Frames per second
 * @returns {string} Formatted timecode
 */
export function frameToTimecode(frameIndex, fps = 30) {
  const seconds = frameIndex / fps;
  return formatTimecode(seconds, fps);
}

/**
 * Format duration with sub-second precision
 * Shows seconds with decimal for precise duration display
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted string (e.g., "1.5s", "0.23s")
 */
export function formatDurationPrecise(seconds) {
  if (seconds < 10) {
    return `${seconds.toFixed(2)}s`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins}m ${secs}s`;
}

/**
 * Format remaining time
 * @param {number} ms - Milliseconds remaining
 * @returns {string} Human readable remaining time
 */
export function formatRemaining(ms) {
  if (ms < 1000) return 'Less than a second remaining';

  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `About ${seconds} second${seconds !== 1 ? 's' : ''} remaining`;
  }

  const minutes = Math.ceil(seconds / 60);
  return `About ${minutes} minute${minutes !== 1 ? 's' : ''} remaining`;
}

/**
 * Format percentage
 * @param {number} value - Value between 0 and 1
 * @returns {string} Formatted percentage (e.g., "75%")
 */
export function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * Format timestamp to ISO string
 * @param {number} ms - Milliseconds since epoch
 * @returns {string} ISO date string
 */
export function formatTimestamp(ms) {
  return new Date(ms).toISOString();
}

/**
 * Format duration in compact seconds format
 * Always shows one decimal place, used for timeline and selection display
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration (e.g., "1.5s")
 */
export function formatCompactDuration(seconds) {
  return `${seconds.toFixed(1)}s`;
}
