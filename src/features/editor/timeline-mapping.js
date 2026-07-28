/**
 * Timeline coordinate mapping - single source of truth for frameIndex <->
 * percent <-> thumbnail-slot conversions used by BOTH the filmstrip layout
 * and the selection/playhead layers (issue #99, fix 1).
 *
 * Before this module, the filmstrip sampled every `sampleStep`-th frame
 * (`Math.floor(total / MAX_THUMBNAILS)`), so the last thumbnail rarely
 * landed on the last frame (e.g. 117 frames -> last thumb = frame 114),
 * while the selection/playhead layers positioned by `frame / (total - 1)`.
 * Two unrelated coordinate systems overlaid on the same track produced a
 * visible misalignment. Every caller must go through these helpers so the
 * filmstrip and the overlay layers agree on exactly one mapping.
 * @module features/editor/timeline-mapping
 */

/** Default number of thumbnail samples shown in the filmstrip */
export const DEFAULT_THUMBNAIL_COUNT = 30;

/**
 * Build the list of frame indices used to populate the filmstrip, evenly
 * distributed across [0, totalFrames - 1]. Always includes frame 0 and the
 * last frame (totalFrames - 1) when totalFrames > 1.
 * @param {number} totalFrames
 * @param {number} [thumbnailCount]
 * @returns {number[]}
 */
export function getThumbnailFrameIndices(totalFrames, thumbnailCount = DEFAULT_THUMBNAIL_COUNT) {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return [];
  if (totalFrames === 1) return [0];

  const n = Math.max(1, Math.min(totalFrames, thumbnailCount));
  if (n === 1) return [0];

  const indices = [];
  for (let k = 0; k < n; k++) {
    indices.push(Math.round((k * (totalFrames - 1)) / (n - 1)));
  }
  return indices;
}

/**
 * Convert a frame index to a percent position [0, 100] along the track.
 * Shared by the filmstrip's implicit flex layout (equal-width boxes over
 * the sampled indices), the selection layer, and the playhead so all three
 * agree on the same 0-100% reference box.
 * @param {number} frameIndex
 * @param {number} totalFrames
 * @returns {number}
 */
export function frameToPercent(frameIndex, totalFrames) {
  const divisor = Math.max(1, totalFrames - 1);
  return (frameIndex / divisor) * 100;
}

/**
 * Convert a percent position [0, 100] along the track back to a frame
 * index, clamped to [0, totalFrames - 1].
 * @param {number} percent
 * @param {number} totalFrames
 * @returns {number}
 */
export function percentToFrame(percent, totalFrames) {
  const divisor = Math.max(1, totalFrames - 1);
  const frame = Math.round((percent / 100) * divisor);
  return Math.max(0, Math.min(totalFrames - 1, frame));
}

/**
 * Find the thumbnail slot index (position within the array returned by
 * getThumbnailFrameIndices) whose frame is closest to frameIndex.
 * @param {number} frameIndex
 * @param {number} totalFrames
 * @param {number} [thumbnailCount]
 * @returns {number}
 */
export function frameToThumbnailSlot(
  frameIndex,
  totalFrames,
  thumbnailCount = DEFAULT_THUMBNAIL_COUNT,
) {
  const indices = getThumbnailFrameIndices(totalFrames, thumbnailCount);
  if (indices.length === 0) return -1;

  let closestSlot = 0;
  let closestDistance = Infinity;
  indices.forEach((frame, slot) => {
    const distance = Math.abs(frame - frameIndex);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestSlot = slot;
    }
  });
  return closestSlot;
}
