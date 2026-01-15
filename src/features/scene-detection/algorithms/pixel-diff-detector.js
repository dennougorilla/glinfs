/**
 * Pixel Difference Scene Detector
 *
 * Detects scene changes by comparing pixel-level differences between consecutive frames.
 * Uses Mean Absolute Difference (MAD) to quantify frame-to-frame changes.
 *
 * Algorithm:
 * 1. Convert frames to grayscale for faster comparison
 * 2. Calculate MAD between consecutive frames: sum(|pixel_i - prev_pixel_i|) / total_pixels
 * 3. Detect scene change when MAD exceeds threshold
 * 4. Filter short scenes based on minimum duration
 *
 * Characteristics:
 * - Very fast and simple
 * - Excellent for hard cuts
 * - Sensitive to camera motion (may cause false positives)
 * - Not suitable for gradual transitions (dissolves, fades)
 *
 * @module scene-detection/algorithms/pixel-diff-detector
 */

/**
 * Convert RGBA imageData to grayscale values
 * @param {ImageData} imageData - Frame image data
 * @returns {Uint8Array} Grayscale pixel values
 */
function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const grayscale = new Uint8Array(width * height);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // ITU-R BT.709 coefficients for perceptual luminance
    grayscale[j] = Math.round(
      0.2126 * data[i] +     // R
      0.7152 * data[i + 1] + // G
      0.0722 * data[i + 2]   // B
    );
  }

  return grayscale;
}

/**
 * Calculate Mean Absolute Difference between two grayscale frames
 * @param {Uint8Array} frame1 - First frame grayscale data
 * @param {Uint8Array} frame2 - Second frame grayscale data
 * @returns {number} MAD value (0-1, normalized)
 */
function calculateMAD(frame1, frame2) {
  if (frame1.length !== frame2.length) {
    throw new Error('Frames must have the same dimensions');
  }

  let sum = 0;
  for (let i = 0; i < frame1.length; i++) {
    sum += Math.abs(frame1[i] - frame2[i]);
  }

  // Normalize to 0-1 range (max possible difference is 255 per pixel)
  return sum / (frame1.length * 255);
}

/**
 * Detect scene breaks using pixel difference
 * @param {Array} frames - Array of frame data with imageData
 * @param {Object} options - Detection options
 * @param {number} options.threshold - MAD threshold for scene detection (0-1, default: 0.20)
 * @param {number} options.minSceneDuration - Minimum frames per scene (default: 5)
 * @param {number} options.sampleInterval - Process every N frames (default: 1)
 * @param {Function} options.onProgress - Progress callback
 * @param {Function} options.checkCancellation - Cancellation check callback
 * @returns {Array<Object>} Array of detected scenes with metadata
 */
function detectScenes(frames, options = {}) {
  const {
    threshold = 0.20,
    minSceneDuration = 5,
    sampleInterval = 1,
    onProgress = null,
    checkCancellation = null
  } = options;

  if (!frames || frames.length === 0) {
    return [];
  }

  const sceneBreaks = [0]; // First frame is always a scene start
  let prevGrayscale = null;

  // Process frames and detect scene breaks
  for (let i = 0; i < frames.length; i += sampleInterval) {
    // Check cancellation every 10 frames
    if (checkCancellation && i % 10 === 0 && checkCancellation()) {
      throw new Error('Detection cancelled');
    }

    // Report progress
    if (onProgress && i % 10 === 0) {
      onProgress(i, frames.length);
    }

    const frame = frames[i];
    if (!frame || !frame.imageData) {
      continue;
    }

    // Convert to grayscale
    const currentGrayscale = toGrayscale(frame.imageData);

    // Compare with previous frame
    if (prevGrayscale) {
      const mad = calculateMAD(prevGrayscale, currentGrayscale);

      // Detect scene break
      if (mad > threshold) {
        sceneBreaks.push(i);
      }
    }

    prevGrayscale = currentGrayscale;
  }

  // Last frame marks end of final scene
  if (sceneBreaks[sceneBreaks.length - 1] !== frames.length - 1) {
    sceneBreaks.push(frames.length - 1);
  }

  // Convert break points to scenes
  const scenes = [];
  for (let i = 0; i < sceneBreaks.length - 1; i++) {
    const startFrame = sceneBreaks[i];
    const endFrame = sceneBreaks[i + 1];
    const duration = endFrame - startFrame;

    scenes.push({
      startFrame,
      endFrame,
      duration,
      timestamp: frames[startFrame]?.timestamp || 0,
      confidence: 1.0 // Pixel diff doesn't provide confidence scores
    });
  }

  // Filter out short scenes
  const filteredScenes = filterShortScenes(scenes, minSceneDuration);

  // Report completion
  if (onProgress) {
    onProgress(frames.length, frames.length);
  }

  return filteredScenes;
}

/**
 * Filter and merge scenes shorter than minimum duration
 * @param {Array<Object>} scenes - Array of scenes
 * @param {number} minDuration - Minimum scene duration in frames
 * @returns {Array<Object>} Filtered scenes
 */
function filterShortScenes(scenes, minDuration) {
  if (scenes.length === 0) {
    return [];
  }

  const filtered = [];
  let currentScene = { ...scenes[0] };

  for (let i = 1; i < scenes.length; i++) {
    const scene = scenes[i];

    if (currentScene.duration < minDuration) {
      // Merge short scene with next scene
      currentScene.endFrame = scene.endFrame;
      currentScene.duration = currentScene.endFrame - currentScene.startFrame;
    } else {
      // Current scene is long enough, save it
      filtered.push(currentScene);
      currentScene = { ...scene };
    }
  }

  // Add the last scene
  filtered.push(currentScene);

  return filtered;
}

/**
 * Create a pixel difference detector instance
 * @param {Object} config - Detector configuration
 * @returns {Object} Detector interface with detect method
 */
export function createPixelDiffDetector(config = {}) {
  return {
    id: 'pixel-diff',
    name: 'Pixel Difference',
    description: 'Fast scene detection using pixel-level frame comparison',

    /**
     * Detect scenes in frames
     * @param {Array} frames - Array of frame data
     * @param {Object} options - Detection options
     * @returns {Array<Object>} Detected scenes
     */
    detect(frames, options = {}) {
      return detectScenes(frames, {
        ...config,
        ...options
      });
    },

    /**
     * Get default options for this detector
     * @returns {Object} Default options
     */
    getDefaultOptions() {
      return {
        threshold: 0.20,
        minSceneDuration: 5,
        sampleInterval: 1
      };
    },

    /**
     * Get parameter info for UI configuration
     * @returns {Array<Object>} Parameter definitions
     */
    getParameters() {
      return [
        {
          name: 'threshold',
          label: 'Sensitivity Threshold',
          type: 'number',
          min: 0.05,
          max: 0.5,
          step: 0.01,
          default: 0.20,
          description: 'MAD threshold for scene detection (lower = more sensitive)'
        },
        {
          name: 'minSceneDuration',
          label: 'Minimum Scene Duration',
          type: 'number',
          min: 1,
          max: 30,
          step: 1,
          default: 5,
          description: 'Minimum number of frames per scene'
        },
        {
          name: 'sampleInterval',
          label: 'Sample Interval',
          type: 'number',
          min: 1,
          max: 10,
          step: 1,
          default: 1,
          description: 'Process every N frames (higher = faster but less accurate)'
        }
      ];
    }
  };
}

export default createPixelDiffDetector;
