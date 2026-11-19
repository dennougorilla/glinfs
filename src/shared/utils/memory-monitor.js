/**
 * Memory accounting units and frame estimates
 * @module shared/utils/memory-monitor
 */

/**
 * The one memory unit of the app: the budget setting, every estimate it is
 * compared with, and every number shown are MB of 1,000,000 bytes, and a GB
 * is 1000 MB. "4000" in Settings is 4.0 GB in the footer and in refusals.
 */
export const BYTES_PER_MB = 1_000_000;

/**
 * Memory estimate for VideoFrames held on the main thread (active clip,
 * queue).
 *
 * A frame counts at its known size when its wrapper carries one
 * (`byteLength`: a decoded clip's frames are CPU I420 / NV12 at 1.5 bytes
 * per pixel, measured with allocationSize() when they are made), else at
 * raw RGBA w*h*4: frames made from the capture buffer are RGBA textures.
 *
 * Frames that share pixels carry the same `sharedKey` (an imported GIF's
 * held frame becomes several slots holding clones of ONE decoded
 * VideoFrame): each distinct key is counted once, so repeated slots do not
 * inflate the estimate. Frames without a key count individually.
 *
 * @param {Array<{width?: number, height?: number, sharedKey?: string, byteLength?: number}>} frames
 * @returns {number} - Estimated MB
 */
export function estimateFramesMemoryMB(frames) {
  let bytes = 0;
  /** @type {Set<string>} */
  const seenKeys = new Set();
  for (const frame of frames) {
    const key = frame?.sharedKey;
    if (key !== undefined && key !== null) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    bytes += frame?.byteLength ?? (frame?.width ?? 0) * (frame?.height ?? 0) * 4;
  }
  return bytes / BYTES_PER_MB;
}

/**
 * Format a memory figure in the app's unit (see BYTES_PER_MB)
 * @param {number} mb - Memory (MB)
 * @returns {string}
 */
export function formatMemory(mb) {
  if (mb >= 1000) {
    return `${(mb / 1000).toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}
