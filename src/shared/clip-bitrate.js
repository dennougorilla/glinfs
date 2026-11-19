/**
 * The bitrate queued clips are compressed at, shared by the codec worker
 * (which encodes at it) and the memory budget (which counts a clip headed
 * for the queue at the size it will have).
 * @module shared/clip-bitrate
 */

/** Bitrate cap in bits/s */
export const MAX_CLIP_BITRATE = 20_000_000;

/**
 * Quality-biased target bitrate: min(20 Mb/s, w*h*fps*0.15)
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {number} bits/s
 */
export function clipBitrate(width, height, fps) {
  return Math.min(MAX_CLIP_BITRATE, Math.round(width * height * fps * 0.15));
}

/**
 * Bytes a clip takes once compressed at clipBitrate
 * @param {{ width: number, height: number, fps: number, frameCount: number }} clip
 * @returns {number}
 */
export function estimateCompressedClipBytes({ width, height, fps, frameCount }) {
  if (!fps || fps <= 0) return 0;
  return (clipBitrate(width, height, fps) / 8) * (frameCount / fps);
}
