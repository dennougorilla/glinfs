/**
 * VideoFrame Utilities
 * @module shared/utils/videoframe
 *
 * Shared utilities for VideoFrame lifecycle management.
 * Used by capture, editor, and export features.
 */

/**
 * Safely close a VideoFrame, handling edge cases
 * Prevents errors when frame is already closed or invalid
 * @param {VideoFrame | null | undefined} videoFrame - VideoFrame to close
 * @returns {boolean} True if close was called, false if frame was invalid
 */
export function safeClose(videoFrame) {
  if (!videoFrame) return false;

  try {
    // Check if frame is already closed (accessing codedWidth throws if closed)
    // Note: There's no official "isClosed" property, so we try/catch
    videoFrame.close();
    return true;
  } catch {
    // Frame was already closed or invalid - ignore
    return false;
  }
}

/**
 * Safely close a Frame object (which contains a VideoFrame)
 * @param {import('../../features/capture/types.js').Frame | null | undefined} frame - Frame to close
 * @returns {boolean} True if close was called, false if frame was invalid
 */
export function safeCloseFrame(frame) {
  if (!frame?.frame) return false;
  return safeClose(frame.frame);
}

/**
 * Close all VideoFrames in an array of Frame objects
 * @param {import('../../features/capture/types.js').Frame[]} frames - Frames to close
 * @returns {number} Number of frames successfully closed
 */
export function closeAllFrames(frames) {
  let closed = 0;
  for (const frame of frames) {
    if (safeCloseFrame(frame)) {
      closed++;
    }
  }
  return closed;
}
