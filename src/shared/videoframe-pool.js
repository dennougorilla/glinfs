/**
 * VideoFrame Pool
 * Centralized ownership management for VideoFrame resources
 * @module shared/videoframe-pool
 *
 * This module manages VideoFrame lifecycle using an ownership model.
 * Multiple modules can "own" a frame, and the frame is only closed
 * when all owners have released it.
 *
 * Usage:
 * - Capture: register() when creating frames
 * - Capture→Editor: acquire('editor') to add ownership
 * - Editor→Export: acquire('export') to add ownership
 * - Cleanup: releaseAll(owner) to release all frames for that owner
 */

/**
 * @typedef {Object} PoolEntry
 * @property {VideoFrame} videoFrame - The GPU-resident VideoFrame
 * @property {Set<string>} owners - Set of owner identifiers
 * @property {number} width - Frame width
 * @property {number} height - Frame height
 */

/** @type {Map<string, PoolEntry>} */
const pool = new Map();

/**
 * Register a VideoFrame to the pool
 * @param {string} frameId - Unique frame ID
 * @param {VideoFrame} videoFrame - GPU-resident frame
 * @param {string} owner - Initial owner (e.g., 'capture', 'editor', 'export')
 */
export function register(frameId, videoFrame, owner) {
  if (pool.has(frameId)) {
    // Already registered - just add owner
    const entry = pool.get(frameId);
    entry.owners.add(owner);
    return;
  }

  pool.set(frameId, {
    videoFrame,
    owners: new Set([owner]),
    width: videoFrame.codedWidth,
    height: videoFrame.codedHeight,
  });
}

/**
 * Acquire ownership of a frame
 * @param {string} frameId - Frame ID to acquire
 * @param {string} owner - New owner identifier
 * @returns {VideoFrame | null} The VideoFrame, or null if not found
 */
export function acquire(frameId, owner) {
  const entry = pool.get(frameId);
  if (!entry) return null;

  entry.owners.add(owner);
  return entry.videoFrame;
}

/**
 * Release ownership of a frame
 * If no owners remain, close the VideoFrame and remove from pool
 * @param {string} frameId - Frame ID to release
 * @param {string} owner - Owner releasing the frame
 * @returns {boolean} True if the frame was closed (no owners left)
 */
export function release(frameId, owner) {
  const entry = pool.get(frameId);
  if (!entry) return false;

  entry.owners.delete(owner);

  if (entry.owners.size === 0) {
    try {
      entry.videoFrame.close();
    } catch {
      // Already closed - ignore
    }
    pool.delete(frameId);
    return true;
  }

  return false;
}

/**
 * Release all frames owned by a specific owner
 * Frames with other owners will not be closed
 * @param {string} owner - Owner identifier
 * @returns {number} Number of frames that were closed (had no other owners)
 */
export function releaseAll(owner) {
  let closedCount = 0;

  for (const [frameId, entry] of pool.entries()) {
    if (entry.owners.has(owner)) {
      entry.owners.delete(owner);

      if (entry.owners.size === 0) {
        try {
          entry.videoFrame.close();
        } catch {
          // Already closed - ignore
        }
        pool.delete(frameId);
        closedCount++;
      }
    }
  }

  return closedCount;
}

/**
 * Get VideoFrame without acquiring ownership (read-only access)
 * @param {string} frameId - Frame ID
 * @returns {VideoFrame | null} The VideoFrame, or null if not found
 */
export function getFrame(frameId) {
  return pool.get(frameId)?.videoFrame ?? null;
}

/**
 * Check if a frame exists in the pool
 * @param {string} frameId - Frame ID
 * @returns {boolean}
 */
export function hasFrame(frameId) {
  return pool.has(frameId);
}

/**
 * Get the owners of a frame
 * @param {string} frameId - Frame ID
 * @returns {Set<string> | null} Set of owners, or null if not found
 */
export function getOwners(frameId) {
  const entry = pool.get(frameId);
  if (!entry) return null;
  return new Set(entry.owners); // Return a copy to prevent external modification
}

/**
 * Get pool statistics (for debugging/monitoring)
 * @returns {{ totalFrames: number, totalOwners: number, byOwner: Record<string, number> }}
 */
export function getPoolStats() {
  const byOwner = {};

  for (const entry of pool.values()) {
    for (const owner of entry.owners) {
      byOwner[owner] = (byOwner[owner] || 0) + 1;
    }
  }

  return {
    totalFrames: pool.size,
    totalOwners: Object.keys(byOwner).length,
    byOwner,
  };
}

/**
 * Clear the entire pool (for testing or emergency cleanup)
 * Closes all VideoFrames regardless of owners
 * @returns {number} Number of frames closed
 */
export function clearPool() {
  let count = 0;

  for (const entry of pool.values()) {
    try {
      entry.videoFrame.close();
    } catch {
      // Already closed - ignore
    }
    count++;
  }

  pool.clear();
  return count;
}

/**
 * Get the pool size
 * @returns {number}
 */
export function getPoolSize() {
  return pool.size;
}
