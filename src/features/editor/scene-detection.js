/**
 * Scene Detection Algorithm
 * Detects scene changes based on frame-to-frame visual differences
 * @module features/editor/scene-detection
 */

import { isVideoFrameValid } from '../../shared/utils/canvas.js';

/**
 * @typedef {Object} Scene
 * @property {number} startFrame - Start frame index (inclusive)
 * @property {number} endFrame - End frame index (inclusive)
 * @property {number} frameCount - Number of frames in the scene
 * @property {number} thumbnailIndex - Representative frame index for thumbnail (middle frame)
 */

/**
 * @typedef {Object} SceneDetectionResult
 * @property {Scene[]} scenes - Detected scenes
 * @property {number} totalFrames - Total number of frames analyzed
 */

/**
 * @typedef {Object} SceneDetectionOptions
 * @property {number} [threshold=0.15] - Difference threshold (0-1) for scene change detection
 * @property {number} [minSceneFrames=3] - Minimum frames per scene to avoid micro-scenes
 * @property {number} [sampleSize=16] - Sample grid size (NxN) for faster comparison
 */

/** Default detection options */
const DEFAULT_OPTIONS = {
  threshold: 0.15,
  minSceneFrames: 3,
  sampleSize: 16,
};

/**
 * Calculate visual difference between two frames using sampled pixels
 * Uses a grid sampling approach for performance
 * @param {import('../capture/types.js').Frame} frame1
 * @param {import('../capture/types.js').Frame} frame2
 * @param {number} sampleSize - Grid size for sampling
 * @returns {number} Difference score (0-1, where 0 = identical, 1 = completely different)
 */
function calculateFrameDifference(frame1, frame2, sampleSize) {
  // Handle invalid frames
  if (!frame1?.frame || !frame2?.frame ||
      !isVideoFrameValid(frame1.frame) || !isVideoFrameValid(frame2.frame)) {
    return 1; // Treat as scene change if frames are invalid
  }

  // Create temporary canvases at sample size for comparison
  const canvas1 = document.createElement('canvas');
  const canvas2 = document.createElement('canvas');
  canvas1.width = canvas2.width = sampleSize;
  canvas1.height = canvas2.height = sampleSize;

  const ctx1 = canvas1.getContext('2d', { willReadFrequently: true });
  const ctx2 = canvas2.getContext('2d', { willReadFrequently: true });

  if (!ctx1 || !ctx2) return 1;

  try {
    // Draw frames scaled down to sample size
    ctx1.drawImage(frame1.frame, 0, 0, sampleSize, sampleSize);
    ctx2.drawImage(frame2.frame, 0, 0, sampleSize, sampleSize);

    // Get pixel data
    const data1 = ctx1.getImageData(0, 0, sampleSize, sampleSize).data;
    const data2 = ctx2.getImageData(0, 0, sampleSize, sampleSize).data;

    // Calculate average difference
    let totalDiff = 0;
    const pixelCount = sampleSize * sampleSize;

    for (let i = 0; i < data1.length; i += 4) {
      // Compare RGB channels (ignore alpha)
      const rDiff = Math.abs(data1[i] - data2[i]) / 255;
      const gDiff = Math.abs(data1[i + 1] - data2[i + 1]) / 255;
      const bDiff = Math.abs(data1[i + 2] - data2[i + 2]) / 255;

      // Average of RGB differences
      totalDiff += (rDiff + gDiff + bDiff) / 3;
    }

    return totalDiff / pixelCount;
  } catch {
    return 1; // Treat errors as scene change
  }
}

/**
 * Detect scenes in a sequence of frames
 * @param {import('../capture/types.js').Frame[]} frames - Array of frames to analyze
 * @param {SceneDetectionOptions} [options] - Detection options
 * @returns {SceneDetectionResult} Detected scenes
 */
export function detectScenes(frames, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { threshold, minSceneFrames, sampleSize } = opts;

  if (!frames || frames.length === 0) {
    return { scenes: [], totalFrames: 0 };
  }

  if (frames.length === 1) {
    return {
      scenes: [{
        startFrame: 0,
        endFrame: 0,
        frameCount: 1,
        thumbnailIndex: 0,
      }],
      totalFrames: 1,
    };
  }

  /** @type {number[]} */
  const sceneChangeIndices = [0]; // First frame always starts a scene

  // Detect scene changes
  for (let i = 1; i < frames.length; i++) {
    const diff = calculateFrameDifference(frames[i - 1], frames[i], sampleSize);
    if (diff >= threshold) {
      sceneChangeIndices.push(i);
    }
  }

  // Build scenes from change indices
  /** @type {Scene[]} */
  const rawScenes = [];

  for (let i = 0; i < sceneChangeIndices.length; i++) {
    const startFrame = sceneChangeIndices[i];
    const endFrame = i < sceneChangeIndices.length - 1
      ? sceneChangeIndices[i + 1] - 1
      : frames.length - 1;

    const frameCount = endFrame - startFrame + 1;
    const thumbnailIndex = startFrame + Math.floor(frameCount / 2);

    rawScenes.push({
      startFrame,
      endFrame,
      frameCount,
      thumbnailIndex,
    });
  }

  // Merge small scenes with previous scene
  /** @type {Scene[]} */
  const scenes = [];

  for (const scene of rawScenes) {
    if (scenes.length === 0) {
      scenes.push(scene);
    } else if (scene.frameCount < minSceneFrames) {
      // Merge with previous scene
      const prev = scenes[scenes.length - 1];
      prev.endFrame = scene.endFrame;
      prev.frameCount = prev.endFrame - prev.startFrame + 1;
      prev.thumbnailIndex = prev.startFrame + Math.floor(prev.frameCount / 2);
    } else {
      scenes.push(scene);
    }
  }

  // Handle edge case: if last scene is too small, merge it
  if (scenes.length > 1) {
    const lastScene = scenes[scenes.length - 1];
    if (lastScene.frameCount < minSceneFrames) {
      scenes.pop();
      const prev = scenes[scenes.length - 1];
      prev.endFrame = lastScene.endFrame;
      prev.frameCount = prev.endFrame - prev.startFrame + 1;
      prev.thumbnailIndex = prev.startFrame + Math.floor(prev.frameCount / 2);
    }
  }

  return {
    scenes,
    totalFrames: frames.length,
  };
}

/**
 * Async version of scene detection with progress callback
 * Useful for large frame counts to avoid blocking UI
 * @param {import('../capture/types.js').Frame[]} frames
 * @param {SceneDetectionOptions & { onProgress?: (progress: number) => void }} [options]
 * @returns {Promise<SceneDetectionResult>}
 */
export async function detectScenesAsync(frames, options = {}) {
  const { onProgress, ...detectionOptions } = options;
  const opts = { ...DEFAULT_OPTIONS, ...detectionOptions };
  const { threshold, minSceneFrames, sampleSize } = opts;

  if (!frames || frames.length === 0) {
    return { scenes: [], totalFrames: 0 };
  }

  if (frames.length === 1) {
    return {
      scenes: [{
        startFrame: 0,
        endFrame: 0,
        frameCount: 1,
        thumbnailIndex: 0,
      }],
      totalFrames: 1,
    };
  }

  /** @type {number[]} */
  const sceneChangeIndices = [0];

  // Process in batches to avoid blocking
  const batchSize = 10;

  for (let i = 1; i < frames.length; i++) {
    const diff = calculateFrameDifference(frames[i - 1], frames[i], sampleSize);
    if (diff >= threshold) {
      sceneChangeIndices.push(i);
    }

    // Yield to event loop and report progress
    if (i % batchSize === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      onProgress?.(i / frames.length);
    }
  }

  onProgress?.(1);

  // Build scenes (same logic as sync version)
  /** @type {Scene[]} */
  const rawScenes = [];

  for (let i = 0; i < sceneChangeIndices.length; i++) {
    const startFrame = sceneChangeIndices[i];
    const endFrame = i < sceneChangeIndices.length - 1
      ? sceneChangeIndices[i + 1] - 1
      : frames.length - 1;

    const frameCount = endFrame - startFrame + 1;
    const thumbnailIndex = startFrame + Math.floor(frameCount / 2);

    rawScenes.push({
      startFrame,
      endFrame,
      frameCount,
      thumbnailIndex,
    });
  }

  // Merge small scenes
  /** @type {Scene[]} */
  const scenes = [];

  for (const scene of rawScenes) {
    if (scenes.length === 0) {
      scenes.push(scene);
    } else if (scene.frameCount < minSceneFrames) {
      const prev = scenes[scenes.length - 1];
      prev.endFrame = scene.endFrame;
      prev.frameCount = prev.endFrame - prev.startFrame + 1;
      prev.thumbnailIndex = prev.startFrame + Math.floor(prev.frameCount / 2);
    } else {
      scenes.push(scene);
    }
  }

  if (scenes.length > 1) {
    const lastScene = scenes[scenes.length - 1];
    if (lastScene.frameCount < minSceneFrames) {
      scenes.pop();
      const prev = scenes[scenes.length - 1];
      prev.endFrame = lastScene.endFrame;
      prev.frameCount = prev.endFrame - prev.startFrame + 1;
      prev.thumbnailIndex = prev.startFrame + Math.floor(prev.frameCount / 2);
    }
  }

  return {
    scenes,
    totalFrames: frames.length,
  };
}
